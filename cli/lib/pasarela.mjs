// El cliente de la pasarela MCP de la CLI memoria: una sesión MCP por HTTP (Streamable HTTP, JSON o SSE) con la clave de
// un agente, para llamar a herramientas (`tools/call`) y atender los formularios que pida el servidor (`elicitation/create`).
// La pasarela se configura por entorno: BADULAQUE_URL y BADULAQUE_CLAVE. Ver cli/README.md, «La pasarela».
// Sin dependencias.

import { request as pedirHttp } from "node:http";
import { request as pedirHttps } from "node:https";
import { createInterface } from "node:readline/promises";

const VERSION = "1.0.0";
const PROTOCOLO = "2025-06-18";
/** Sin noticias de la pasarela durante tanto, una llamada sencilla se da por perdida. */
const TIEMPO_SIMPLE_MS = 60_000;
/** Un «usar» puede esperar confirmación del usuario (un formulario): se da por perdido solo tras tanto silencio. */
const SILENCIO_USAR_MS = 30 * 60_000;

/** Un error con su código de salida: 1 herramienta, 2 uso o configuración, 3 red o protocolo. */
export class Fallo extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.codigo = codigo;
  }
}

/** Un error de red o de protocolo (código 3). */
const errorRed = mensaje => new Fallo(mensaje, 3);

let CLAVE = "";

const log = texto => process.stderr.write(texto.endsWith("\n") ? texto : `${texto}\n`);
/** Quita la clave de cualquier texto que vaya a salir: nunca se imprime. */
export const sanear = texto => (CLAVE ? String(texto).split(CLAVE).join("<clave>") : String(texto));

const leerJson = texto => {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
};
const esObjeto = v => v !== null && typeof v === "object" && !Array.isArray(v);

// --- hablar con la pasarela ----------------------------------------------

/** Parte un flujo SSE en sus mensajes completos; lo que queda sin acabar vuelve como `resto`. */
function partirSse(buffer) {
  const trozos = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const resto = trozos.pop();
  const mensajes = [];
  for (const evento of trozos) {
    const datos = evento.split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(l.startsWith("data: ") ? 6 : 5));
    if (!datos.length) continue;
    const mensaje = leerJson(datos.join("\n"));
    if (mensaje === undefined) continue; // un evento ilegible se ignora
    mensajes.push(mensaje);
  }
  return { mensajes, resto };
}

/**
 * Una petición HTTP. Si la respuesta es un flujo SSE, `alMensaje` recibe cada mensaje en cuanto llega;
 * si es JSON, lo recibe al final. Devuelve estado, cabeceras y todos los mensajes.
 */
function pedir(url, { metodo = "POST", cabeceras = {}, cuerpo, alMensaje, silencioMs = TIEMPO_SIMPLE_MS } = {}) {
  return new Promise((resolver, rechazar) => {
    const u = new URL(url);
    const texto = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
    const opciones = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: metodo,
      headers: {
        ...cabeceras,
        ...(texto === undefined ? {} : { "Content-Length": Buffer.byteLength(texto) })
      }
    };
    // node:http y no fetch: el de Node corta el cuerpo a los 300 s sin datos, y un formulario puede tardar más.
    const lib = u.protocol === "https:" ? pedirHttps : pedirHttp;
    let vigilante;
    const armar = () => {
      clearTimeout(vigilante);
      vigilante = setTimeout(() => req.destroy(errorRed("la pasarela dejó de dar señales")), silencioMs);
    };
    const req = lib(opciones, res => {
      const sse = (res.headers["content-type"] ?? "").includes("text/event-stream");
      const mensajes = [];
      const trozos = [];
      let pendiente = "";
      const recibir = m => {
        mensajes.push(m);
        alMensaje?.(m);
      };
      res.setEncoding("utf8");
      res.on("data", t => {
        armar();
        if (!sse) {
          trozos.push(t);
          return;
        }
        pendiente += t;
        const { mensajes: nuevos, resto } = partirSse(pendiente);
        pendiente = resto;
        nuevos.forEach(recibir);
      });
      res.on("end", () => {
        clearTimeout(vigilante);
        if (sse) {
          partirSse(`${pendiente}\n\n`).mensajes.forEach(recibir);
          resolver({ estado: res.statusCode, cabeceras: res.headers, texto: "", mensajes });
          return;
        }
        const cuerpoTexto = trozos.join("");
        // Un error (401, 500…) puede venir sin JSON: quien llama mira el estado antes que los mensajes.
        const exito = res.statusCode >= 200 && res.statusCode < 300;
        if (exito && cuerpoTexto.trim()) {
          const leido = leerJson(cuerpoTexto);
          if (leido === undefined) return rechazar(errorRed("respuesta ilegible de la pasarela"));
          (Array.isArray(leido) ? leido : [leido]).forEach(recibir);
        }
        resolver({ estado: res.statusCode, cabeceras: res.headers, texto: cuerpoTexto, mensajes });
      });
      res.on("error", e => rechazar(errorRed(`se cortó la respuesta (${e.code ?? e.message})`)));
    });
    req.on("error", e => {
      clearTimeout(vigilante);
      rechazar(errorRed(`no llego a la pasarela (${e.code ?? e.message})`));
    });
    armar();
    if (texto !== undefined) req.write(texto);
    req.end();
  });
}

/** Un formulario que pide la pasarela (`elicitation/create`): en una terminal, se pregunta; si no, se rechaza. */
async function elicitar(params) {
  const mensaje = String(params.message ?? "Badulaque pide una confirmación.");
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    log(`badulaque: la pasarela pide una confirmación («${mensaje}») que esta terminal no puede dar. ` +
      "Se rechaza: ese paso necesita confirmación interactiva en un cliente con formularios.");
    return { action: "decline" };
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });
  try {
    log(`\nBadulaque pide confirmación: ${mensaje}`);
    const eleccion = (await rl.question("¿Aceptar? [s] sí · [n] rechazar · [c] cancelar: ")).trim().toLowerCase();
    if (eleccion.startsWith("n")) return { action: "decline" };
    if (!eleccion.startsWith("s")) return { action: "cancel" };
    const esquema = params.requestedSchema ?? {};
    const requeridos = esquema.required ?? [];
    const contenido = {};
    for (const [campo, definicion] of Object.entries(esquema.properties ?? {})) {
      const valor = await preguntarCampo(rl, campo, definicion, requeridos.includes(campo));
      if (valor !== undefined) contenido[campo] = valor;
    }
    return { action: "accept", content: contenido };
  } finally {
    rl.close();
  }
}

async function preguntarCampo(rl, campo, definicion, requerido) {
  const titulo = definicion.title ?? campo;
  const descripcion = definicion.description ? ` (${definicion.description})` : "";
  log(`${titulo}${descripcion}${requerido ? "" : " — Intro para omitir"}`);
  const opciones = Array.isArray(definicion.enum)
    ? definicion.enum.map((valor, i) => ({ valor, texto: definicion.enumNames?.[i] ?? String(valor) }))
    : null;
  for (;;) {
    if (opciones) {
      opciones.forEach((o, i) => log(`  ${i + 1}) ${o.texto}`));
      const r = (await rl.question("Número: ")).trim();
      if (!r) {
        if (!requerido) return undefined;
        continue;
      }
      const opcion = opciones[Number(r) - 1];
      if (opcion) return opcion.valor;
      log("Elige un número de la lista.");
      continue;
    }
    if (definicion.type === "boolean") {
      const r = (await rl.question("[s/n]: ")).trim().toLowerCase();
      if (!r) {
        if (!requerido) return undefined;
        continue;
      }
      if (r.startsWith("s")) return true;
      if (r.startsWith("n")) return false;
      continue;
    }
    const r = (await rl.question("> ")).trim();
    if (!r) {
      if (!requerido) return undefined;
      continue;
    }
    if (definicion.type === "number" || definicion.type === "integer") {
      const n = Number(r);
      if (!Number.isFinite(n) || (definicion.type === "integer" && !Number.isInteger(n))) {
        log("Tiene que ser un número.");
        continue;
      }
      return n;
    }
    return r;
  }
}

function comprobarEstado(estado) {
  if (estado === 401 || estado === 403) {
    throw new Fallo("la pasarela no acepta la clave (BADULAQUE_CLAVE): ¿es la de tu agente?", 2);
  }
  if (estado < 200 || estado >= 300) throw errorRed(`la pasarela contestó ${estado}`);
}

/** Una sesión MCP con la pasarela: una por invocación de la CLI, o las que haga falta. */
export class Pasarela {
  constructor(url, clave) {
    this.url = url;
    this.clave = clave;
    this.id = null;
    this.version = PROTOCOLO;
    this.contador = 0;
    /** Las peticiones del servidor (formularios) se atienden una a una. */
    this.cola = Promise.resolve();
  }

  cabeceras(conSesion = true) {
    const c = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.clave}`
    };
    if (conSesion && this.id) {
      c["Mcp-Session-Id"] = this.id;
      c["MCP-Protocol-Version"] = this.version;
    }
    return c;
  }

  async abrir() {
    this.id = null;
    const id = ++this.contador;
    const r = await pedir(this.url, {
      cabeceras: this.cabeceras(false),
      cuerpo: {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOLO,
          capabilities: { elicitation: {} },
          clientInfo: { name: "badulaque-cli", version: VERSION }
        }
      }
    });
    comprobarEstado(r.estado);
    const respuesta = r.mensajes.find(m => m.id === id);
    if (!respuesta || respuesta.error) {
      throw errorRed(`la pasarela no abrió la sesión${respuesta?.error?.message ? `: ${respuesta.error.message}` : ""}`);
    }
    const sesion = r.cabeceras["mcp-session-id"];
    if (!sesion) throw errorRed("la pasarela no dio sesión");
    this.id = sesion;
    this.version = respuesta.result?.protocolVersion ?? PROTOCOLO;
    // La pasarela espera este aviso antes de atender nada más.
    await pedir(this.url, {
      cabeceras: this.cabeceras(),
      cuerpo: { jsonrpc: "2.0", method: "notifications/initialized" }
    });
  }

  /** Contesta a una petición del servidor (un formulario) por la misma sesión. */
  async responder(peticion) {
    const cuerpo = peticion.method === "elicitation/create"
      ? { jsonrpc: "2.0", id: peticion.id, result: await elicitar(peticion.params ?? {}) }
      : { jsonrpc: "2.0", id: peticion.id, error: { code: -32601, message: "método no soportado por esta CLI" } };
    try {
      await pedir(this.url, { cabeceras: this.cabeceras(), cuerpo, silencioMs: TIEMPO_SIMPLE_MS });
    } catch (error) {
      log(`badulaque: no se pudo contestar a la pasarela (${sanear(error.message)})`);
    }
  }

  /** Una petición JSON-RPC. Reabre la sesión una vez si la pasarela la olvidó. */
  async pedir(metodo, params, { silencioMs = TIEMPO_SIMPLE_MS } = {}) {
    for (let intento = 0; ; intento++) {
      if (!this.id) await this.abrir();
      const id = ++this.contador;
      let final = null;
      const recibir = m => {
        if (Array.isArray(m)) return m.forEach(recibir);
        if (!esObjeto(m)) return;
        if (m.method === undefined && m.id === id && ("result" in m || "error" in m)) {
          final = m;
        } else if (m.method !== undefined && m.id !== undefined && m.id !== null) {
          this.cola = this.cola.then(() => this.responder(m));
        }
      };
      const r = await pedir(this.url, {
        cabeceras: this.cabeceras(),
        cuerpo: { jsonrpc: "2.0", id, method: metodo, params },
        alMensaje: recibir,
        silencioMs
      });
      await this.cola;
      if ((r.estado === 404 || r.estado === 400) && intento === 0) {
        // La pasarela se reinició y olvidó la sesión: se abre otra y se repite una vez.
        this.id = null;
        continue;
      }
      comprobarEstado(r.estado);
      if (!final) throw errorRed("la pasarela cerró la conexión sin dar el resultado");
      if (final.error) throw errorRed(`la pasarela devolvió un error${final.error.message ? `: ${final.error.message}` : ""}`);
      return final.result ?? {};
    }
  }

  llamar(nombre, argumentos) {
    return this.pedir("tools/call", {
      name: nombre,
      arguments: argumentos ?? {},
      _meta: { progressToken: `badulaque-${Date.now()}` }
    }, { silencioMs: SILENCIO_USAR_MS });
  }

  async cerrar() {
    const id = this.id;
    this.id = null;
    if (!id) return;
    await pedir(this.url, {
      metodo: "DELETE",
      cabeceras: { "Mcp-Session-Id": id, "MCP-Protocol-Version": this.version, Authorization: `Bearer ${this.clave}` },
      silencioMs: 5000
    }).catch(() => {});
  }
}

// --- la configuración -------------------------------------------------------

/**
 * La sesión de una invocación, a partir de BADULAQUE_URL y BADULAQUE_CLAVE: { pasarela }.
 */
export function configurar() {
  const clave = (process.env.BADULAQUE_CLAVE ?? "").trim();
  if (!clave) {
    throw new Fallo("falta BADULAQUE_CLAVE: indica la clave del agente en la variable de entorno BADULAQUE_CLAVE.", 2);
  }
  const url = (process.env.BADULAQUE_URL ?? "").trim();
  if (!url) {
    throw new Fallo("falta BADULAQUE_URL: indica la dirección MCP de la pasarela en la variable de entorno BADULAQUE_URL.", 2);
  }
  try {
    new URL(url);
  } catch {
    throw new Fallo("BADULAQUE_URL no es una dirección válida", 2);
  }
  CLAVE = clave;
  return { pasarela: new Pasarela(url, clave) };
}
