// Cliente MCP por HTTP (Streamable HTTP, JSON o SSE) para la CLI memoria.
// Soporta dos modos sin dependencias externas:
// - Directo al servidor cli-memoria (sin sesión o con sesión): MEMORIA_URL y MEMORIA_TOKEN.
// - A través de una pasarela MCP compatible (envuelve herramientas en `buscador_usar`): BADULAQUE_URL y BADULAQUE_CLAVE.

import { request as pedirHttp } from "node:http";
import { request as pedirHttps } from "node:https";

const VERSION = "2.3.0";
const PROTOCOLO = "2025-06-18";
/** Sin noticias del servidor durante tanto, una llamada sencilla se da por perdida. */
const TIEMPO_SIMPLE_MS = 60_000;
/** Una llamada a herramienta puede tardar (OCR, publish grande): se da por perdida solo tras tanto silencio. */
const SILENCIO_USAR_MS = 5 * 60_000;

/** Un error con su código de salida: 1 herramienta, 2 uso o configuración, 3 red o protocolo. */
export class Fallo extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.codigo = codigo;
  }
}

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
    if (mensaje === undefined) continue;
    mensajes.push(mensaje);
  }
  return { mensajes, resto };
}

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
    const lib = u.protocol === "https:" ? pedirHttps : pedirHttp;
    let vigilante;
    const armar = () => {
      clearTimeout(vigilante);
      vigilante = setTimeout(() => req.destroy(errorRed("el servidor dejó de dar señales")), silencioMs);
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
        const exito = res.statusCode >= 200 && res.statusCode < 300;
        if (exito && cuerpoTexto.trim()) {
          const leido = leerJson(cuerpoTexto);
          if (leido === undefined) return rechazar(errorRed("respuesta ilegible del servidor"));
          (Array.isArray(leido) ? leido : [leido]).forEach(recibir);
        }
        resolver({ estado: res.statusCode, cabeceras: res.headers, texto: cuerpoTexto, mensajes });
      });
      res.on("error", e => rechazar(errorRed(`se cortó la respuesta (${e.code ?? e.message})`)));
    });
    req.on("error", e => {
      clearTimeout(vigilante);
      rechazar(errorRed(`no llego al servidor (${e.code ?? e.message})`));
    });
    armar();
    if (texto !== undefined) req.write(texto);
    req.end();
  });
}

function comprobarEstado(estado, varClave) {
  if (estado === 401 || estado === 403) {
    throw new Fallo(`el servidor no acepta la credencial (${varClave}): ¿es la de tu agente?`, 2);
  }
  if (estado < 200 || estado >= 300) throw errorRed(`el servidor contestó ${estado}`);
}

/**
 * Cliente MCP por HTTP. Funciona tanto con el servidor cli-memoria sin estado (sin Mcp-Session-Id)
 * como con pasarelas MCP con sesión (`initialize` + `Mcp-Session-Id`).
 */
export class Pasarela {
  constructor(url, clave, { sinEstado = false, varClave = "MEMORIA_TOKEN" } = {}) {
    this.url = url;
    this.clave = clave;
    this.sinEstado = sinEstado;
    this.varClave = varClave;
    this.id = null;
    this.abierta = false;
    this.version = PROTOCOLO;
    this.contador = 0;
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
    this.abierta = false;
    const id = ++this.contador;
    const r = await pedir(this.url, {
      cabeceras: this.cabeceras(false),
      cuerpo: {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOLO,
          capabilities: {},
          clientInfo: { name: "memoria-cli", version: VERSION }
        }
      }
    });
    comprobarEstado(r.estado, this.varClave);
    const respuesta = r.mensajes.find(m => m.id === id);
    if (!respuesta || respuesta.error) {
      throw errorRed(`el servidor no abrió la sesión${respuesta?.error?.message ? `: ${respuesta.error.message}` : ""}`);
    }
    this.version = respuesta.result?.protocolVersion ?? PROTOCOLO;
    const sesion = r.cabeceras["mcp-session-id"];
    if (sesion) {
      this.id = sesion;
      await pedir(this.url, {
        cabeceras: this.cabeceras(),
        cuerpo: { jsonrpc: "2.0", method: "notifications/initialized" }
      });
    } else if (!this.sinEstado) {
      throw errorRed("la pasarela no dio sesión");
    }
    this.abierta = true;
  }

  async responder(peticion) {
    const cuerpo = peticion.method === "elicitation/create"
      ? { jsonrpc: "2.0", id: peticion.id, result: { action: "decline" } }
      : { jsonrpc: "2.0", id: peticion.id, error: { code: -32601, message: "método no soportado por esta CLI" } };
    try {
      await pedir(this.url, { cabeceras: this.cabeceras(), cuerpo, silencioMs: TIEMPO_SIMPLE_MS });
    } catch (error) {
      log(`memoria: no se pudo contestar al servidor (${sanear(error.message)})`);
    }
  }

  async pedir(metodo, params, { silencioMs = TIEMPO_SIMPLE_MS } = {}) {
    for (let intento = 0; ; intento++) {
      if (!this.sinEstado && !this.abierta) await this.abrir();
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
        // Si el servidor requiere sesión (o la reinició), abrimos una y reintentamos una vez.
        this.sinEstado = false;
        await this.abrir();
        continue;
      }
      comprobarEstado(r.estado, this.varClave);
      if (!final) throw errorRed("el servidor cerró la conexión sin dar el resultado");
      if (final.error) throw errorRed(`el servidor devolvió un error${final.error.message ? `: ${final.error.message}` : ""}`);
      return final.result ?? {};
    }
  }

  llamar(nombre, argumentos) {
    return this.pedir("tools/call", {
      name: nombre,
      arguments: argumentos ?? {}
    }, { silencioMs: SILENCIO_USAR_MS });
  }

  async cerrar() {
    const id = this.id;
    this.id = null;
    this.abierta = false;
    if (!id) return;
    await pedir(this.url, {
      metodo: "DELETE",
      cabeceras: { "Mcp-Session-Id": id, "MCP-Protocol-Version": this.version, Authorization: `Bearer ${this.clave}` },
      silencioMs: 5000
    }).catch(() => {});
  }
}

/** Qué modo de conexión se usaría con el entorno actual ("directo" o "pasarela"), sin abrir red. */
export function modoDeConexion() {
  if ((process.env.MEMORIA_URL ?? "").trim() || (process.env.MEMORIA_TOKEN ?? "").trim()) return "directo";
  return "pasarela";
}

/**
 * Configura el cliente a partir del entorno:
 * - Directo (preferido): MEMORIA_URL + MEMORIA_TOKEN (contra el servidor cli-memoria, `/mcp`).
 * - Pasarela (compatibilidad): BADULAQUE_URL + BADULAQUE_CLAVE (envuelve llamadas en `buscador_usar`).
 */
export function configurar() {
  const modo = modoDeConexion();
  if (modo === "directo") {
    const url = (process.env.MEMORIA_URL ?? "").trim();
    const token = (process.env.MEMORIA_TOKEN ?? "").trim();
    if (!url) throw new Fallo("falta MEMORIA_URL: indica la dirección /mcp del servidor cli-memoria.", 2);
    if (!token) throw new Fallo("falta MEMORIA_TOKEN: indica el token del agente para el servidor cli-memoria.", 2);
    try {
      new URL(url);
    } catch {
      throw new Fallo("MEMORIA_URL no es una dirección válida", 2);
    }
    CLAVE = token;
    return { modo, pasarela: new Pasarela(url, token, { sinEstado: true, varClave: "MEMORIA_TOKEN" }) };
  }
  const clave = (process.env.BADULAQUE_CLAVE ?? "").trim();
  const url = (process.env.BADULAQUE_URL ?? "").trim();
  if (!url && !clave) {
    throw new Fallo("falta configurar el servidor: define MEMORIA_URL y MEMORIA_TOKEN (o BADULAQUE_URL y BADULAQUE_CLAVE para pasarela).", 2);
  }
  if (!clave) throw new Fallo("falta BADULAQUE_CLAVE: indica la clave del agente en la variable de entorno BADULAQUE_CLAVE.", 2);
  if (!url) throw new Fallo("falta BADULAQUE_URL: indica la dirección MCP de la pasarela en la variable de entorno BADULAQUE_URL.", 2);
  try {
    new URL(url);
  } catch {
    throw new Fallo("BADULAQUE_URL no es una dirección válida", 2);
  }
  CLAVE = clave;
  return { modo, pasarela: new Pasarela(url, clave, { sinEstado: false, varClave: "BADULAQUE_CLAVE" }) };
}
