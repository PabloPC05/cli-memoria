// Lo común de la CLI memoria: leer opciones, hablar con la pasarela MCP (pasarela.mjs) y salir con los códigos de
// siempre. Sin dependencias. Ver cli/README.md.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Fallo, configurar, sanear } from "./pasarela.mjs";

export { Fallo };

/** Quita acentos y mayúsculas sin cambiar la longitud del texto (para buscar sin acentos y poder cortar por posición). */
export const plano = texto => String(texto).replace(/[À-ſ]/g, c => c.normalize("NFD")[0]).toLowerCase();

/** Una línea: espacios seguidos y saltos pasan a uno, recortada a `max` caracteres con «…». */
export function enUnaLinea(texto, max = 160) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Lee las opciones de un comando. `def` dice cuáles hay: { nombre: "bool" | "valor" | "lista" | "entero" }.
 * - `--nombre valor` o `--nombre=valor`; una "lista" se da repitiendo la opción (o con comas);
 * - los guiones de una opción valen como guion bajo (`--confirmar-nueva` es `confirmar_nueva`);
 * - `-` suelto es un posicional (leer de stdin); `--` termina las opciones.
 * Devuelve { pos, op }. Una opción desconocida es un error de uso (código 2).
 */
export function analizar(tokens, def, uso = "") {
  const pos = [];
  const op = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (!t.startsWith("--")) {
      pos.push(t);
      continue;
    }
    const igual = t.indexOf("=");
    // `--no-leidos` y `--no_leidos` son la misma opción (en `def` y en el resultado, con guion bajo).
    const nombre = (igual === -1 ? t.slice(2) : t.slice(2, igual)).replace(/-/g, "_");
    const tipo = def[nombre];
    if (!tipo) {
      const validas = Object.keys(def).map(o => `--${o.replace(/_/g, "-")}`);
      throw new Fallo(`opción desconocida --${nombre}.${validas.length ? ` Opciones: ${validas.join(", ")}.` : ""}${uso ? ` ${uso}` : ""}`, 2);
    }
    if (tipo === "bool") {
      op[nombre] = true;
      continue;
    }
    const valor = igual === -1 ? tokens[++i] : t.slice(igual + 1);
    if (valor === undefined) throw new Fallo(`--${nombre} necesita un valor`, 2);
    if (tipo === "entero") {
      const n = Number(valor);
      if (!Number.isInteger(n) || n < 0) throw new Fallo(`--${nombre} tiene que ser un entero`, 2);
      op[nombre] = n;
    } else if (tipo === "lista") {
      op[nombre] = [...(op[nombre] ?? []), ...String(valor).split(",").map(s => s.trim()).filter(Boolean)];
    } else {
      op[nombre] = valor;
    }
  }
  return { pos, op };
}

// --- subcomandos: alias en inglés y errores que corrigen (lo comparten todas las CLIs nativas) ---------------------------------------
// Los modelos prueban `memoria search` antes que `memoria buscar`. En vez de fallar, el nombre en inglés vale como alias del
// español SOLO si la CLI tiene ese comando (la primera opción de cada lista que exista en su tabla de subcomandos); y si no
// se entiende, el error dice en una línea qué querías decir y qué comandos hay. No se admiten alias de comandos que borran.
const SINONIMOS = {
  search: ["buscar"], find: ["buscar"], query: ["buscar"],
  read: ["leer", "ver"], show: ["leer", "ver"], cat: ["leer", "ver"], get: ["leer", "ver"], view: ["leer", "ver"], open: ["leer", "ver"],
  list: ["lista", "listar", "eventos", "buscar"], ls: ["lista", "listar", "eventos", "buscar"], lista: ["listar", "eventos", "buscar"],
  lists: ["listas"], events: ["eventos"], calendars: ["calendarios"], recent: ["recientes"], history: ["historial"], links: ["enlaces"],
  status: ["estado"], accounts: ["cuentas"], folders: ["carpetas", "libretas"], drafts: ["borradores"], rules: ["reglas"],
  attachments: ["adjuntos"], attachment: ["adjunto"], thread: ["hilo"], birthdays: ["cumples"], slots: ["huecos"], free: ["huecos"],
  create: ["crear"], add: ["crear"], new: ["nueva", "crear"], edit: ["editar"], update: ["editar", "actualizar"],
  move: ["mover"], mv: ["mover"], copy: ["copiar"], cp: ["copiar"], upload: ["subir"], send: ["enviar"], reply: ["responder"],
  forward: ["reenviar"], archive: ["archivar"], mark: ["marcar"], label: ["etiquetar"], ask: ["preguntar"],
  done: ["completar"], complete: ["completar"], publish: ["publicar"], write: ["escribir"], recover: ["recuperar"], restore: ["recuperar"]
};

/** ¿Es la petición de ayuda? (`--help`, `-h`, `help`, `ayuda`) */
export const esAyuda = orden => ["--help", "-h", "help", "ayuda"].includes(orden);

const distancia = (a, b) => {
  const f = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) f[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) f[i][j] = Math.min(f[i - 1][j] + 1, f[i][j - 1] + 1, f[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return f[a.length][b.length];
};

/**
 * El subcomando de la CLI que pide `dado`: él mismo si está en `tabla`; si no, su alias en inglés (SINONIMOS, o los `extras` de la
 * CLI: { palabra: ["comando", …] }) que exista allí. Si no hay ninguno, un error de uso (código 2) en una línea:
 * «no existe «X»; ¿querías `memoria buscar`? Comandos: buscar, leer, lista…».
 */
export function resolverOrden(cli, dado, tabla, extras = {}) {
  const nombres = Object.keys(tabla);
  if (Object.hasOwn(tabla, dado)) return dado;
  const clave = String(dado ?? "").toLowerCase().replace(/^-+/, "");
  const alias = (extras[clave] ?? SINONIMOS[clave] ?? []).find(c => Object.hasOwn(tabla, c));
  if (alias) return alias;
  const cercano = nombres.find(n => clave.length >= 3 && (n.startsWith(clave) || clave.startsWith(n) || distancia(clave, n) <= 2));
  const todos = `${nombres.slice(0, 16).join(", ")}${nombres.length > 16 ? ", …" : ""}`;
  throw new Fallo(`no existe «${dado}»${cercano ? `; ¿querías \`${cli} ${cercano}\`?` : "."} Comandos: ${todos} (${cli} --help).`, 2);
}

/** Todo lo que llega por stdin, como texto. */
export function leerStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Un texto dado como valor: `-` es stdin; con `archivo`, el contenido de ese archivo. */
export function textoDe(valor, archivo) {
  if (archivo !== undefined) {
    try {
      return readFileSync(archivo, "utf8");
    } catch (e) {
      throw new Fallo(`no pude leer ${archivo} (${e.code ?? e.message})`, 2);
    }
  }
  return valor === "-" ? leerStdin() : valor;
}

/**
 * Llama a una herramienta del Badulaque (`buscador_usar`) y devuelve { texto, bloques, json, error }. `bloques` son los
 * textos de cada contenido; `json` es el texto leído como JSON, o undefined si no lo es. No valida contra el esquema: estas CLIs saben qué pasan.
 */
export async function usar(ctx, nombre, argumentos = {}) {
  const r = await ctx.pasarela.llamar("buscador_usar", { nombre, argumentos });
  const partes = [];
  for (const c of r.content ?? []) {
    if (c?.type === "text") partes.push(c.text);
    else if (c) process.stderr.write(`[${c.type ?? "contenido"} omitido]\n`);
  }
  const texto = partes.join("\n");
  let json = r.structuredContent;
  if (json === undefined) {
    try {
      json = JSON.parse(texto);
    } catch {
      json = undefined;
    }
  }
  return { texto, bloques: partes, json, error: Boolean(r.isError) };
}

/** Como `usar`, pero un error de la herramienta sale como Fallo de código 1 con su texto. */
export async function usarOFallar(ctx, nombre, argumentos = {}) {
  const r = await usar(ctx, nombre, argumentos);
  if (r.error) throw new Fallo(r.texto || `${nombre} dio un error`, 1);
  return r;
}

/** Abre la sesión con el Badulaque (BADULAQUE_CLAVE), corre `fn(ctx)` y la cierra. */
export async function conBadulaque(fn) {
  const ctx = configurar();
  try {
    return await fn(ctx);
  } finally {
    await ctx.pasarela.cerrar();
  }
}

/** Corre un programa y devuelve { estado, salida, error }; la salida es texto. */
export function correr(programa, args, opciones = {}) {
  const r = spawnSync(programa, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opciones });
  if (r.error) {
    const falta = r.error.code === "ENOENT" ? ` (¿está ${programa} instalado?)` : "";
    throw new Fallo(`no pude ejecutar ${programa}: ${r.error.code ?? r.error.message}${falta}`, 3);
  }
  return { estado: r.status ?? 1, salida: r.stdout ?? "", error: r.stderr ?? "" };
}

/** `nombre: mensaje` por stderr y el código del Fallo (3 si no lo es). Pone la salida de `principal(argv)`. */
export async function ejecutarCli(nombre, principal) {
  try {
    process.exitCode = await principal(process.argv.slice(2));
  } catch (error) {
    if (error?.code === "EPIPE") return; // `| head` cerró la tubería: no es un error
    process.stderr.write(`${nombre}: ${sanear(error.message ?? error)}\n`);
    process.exitCode = error instanceof Fallo ? error.codigo : 3;
  }
}

// Si stdout se cierra antes de tiempo (`| head`), se acaba sin ruido.
process.stdout.on("error", e => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

/** La fecha de un ISO como `AAAA-MM-DD HH:MM` en hora de Madrid (o la misma cadena si no se entiende). */
export function fechaCorta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(d).map(x => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Imprime JSON con sangría (para `--json` y `jq`). Devuelve 0, el código de salida. */
export function imprimirJson(valor) {
  process.stdout.write(`${JSON.stringify(valor, null, 2)}\n`);
  return 0;
}

/**
 * Las escrituras aceptan --simular: enseñan qué herramienta llamarían y con qué argumentos, y no llaman a nada.
 * Devuelve true si simuló (el comando acaba ahí). Los textos muy largos (base64) se abrevian.
 */
export function simular(op, herramienta, argumentos) {
  if (!op.simular) return false;
  const corto = v => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 60)}… (${v.length} caracteres)` : v);
  imprimirJson({ simulado: true, herramienta, argumentos: Object.fromEntries(Object.entries(argumentos).map(([k, v]) => [k, corto(v)])) });
  return true;
}
