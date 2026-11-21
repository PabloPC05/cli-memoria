#!/usr/bin/env node
// memoria: la memoria de Pablo (notas Markdown en un repositorio git) como comandos.
//
// - Leer (buscar, leer, lista, recientes): directamente en el repositorio, que en lisa la terminal monta en solo
//   lectura y dice en MEMORIA_DIR. Con rg y git, sin pasar por el MCP: filtra con rg, jq o head.
// - Sin MEMORIA_DIR (el Mac): las mismas lecturas por el Badulaque (memoria_search, read, list, recent).
//   En el Mac no se lee la copia de Google Drive.
// - Escribir (crear, editar): siempre por el Badulaque (memoria_create, memoria_edit), para que la escritura la firme
//   el agente y el servidor aplique sus reglas. Nunca se escribe en el repositorio a mano.
//
// Uso: memoria --help. Sin dependencias. Ver kit/README.md.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Fallo, analizar, conBadulaque, correr, ejecutarCli, enUnaLinea, fechaCorta, imprimirJson, plano, simular, textoDe, usarOFallar
} from "../badulaque/nativa.mjs";

const VERSION = "1.0.0";
const MEMORIA_DIR = (process.env.MEMORIA_DIR ?? "").trim();
const LOCAL = MEMORIA_DIR !== "" && existsSync(MEMORIA_DIR);

const AYUDA = `memoria: la memoria de Pablo como comandos (versión ${VERSION}).

Lectura (${LOCAL ? `local, en ${MEMORIA_DIR}` : "por el Badulaque: no hay MEMORIA_DIR"}):
  memoria buscar <texto…> [--carpeta X] [--limite N] [--archivo] [--regex] [--json]
      Una línea por resultado: ruta:línea: fragmento. Varias palabras: todas en la misma línea, sin acentos ni
      mayúsculas. Un texto entre comillas con espacios es una frase. --archivo incluye archive/.
  memoria leer <nombre|ruta> [--seccion X]
      La nota entera (con su frontmatter) o una sección, por el texto de su encabezado.
  memoria lista [carpeta] [--json]
      Sin carpeta, las carpetas con su número de notas. Con carpeta, cada nota con su description.
  memoria recientes [N] [--json]
      Los últimos N cambios (15 por defecto): cuándo, quién, para qué y las notas que tocó.

Escritura (siempre por el Badulaque, con la clave de tu agente):
  memoria crear <ruta> --razon <texto> (--archivo <f> | -) [--confirmar-nueva]
      Nota nueva con su frontmatter, desde un archivo o stdin. Si se parece a otra, falla y te la enseña.
  memoria editar <nota> --razon <texto> --viejo <texto> --nuevo <texto> [--todas] [--hash H]
  memoria editar <nota> --razon <texto> --ediciones <f.json>   (una lista de {old_string, new_string, replace_all})
      Reemplazo exacto: --viejo tiene que aparecer una sola vez (o --todas).
  --simular enseña la llamada sin hacerla. Para escribir una nota entera, moverla o borrarla: badulaque memoria write | move | delete.

Variables: MEMORIA_DIR (la ruta de solo lectura; si falta, todo va por el Badulaque), BADULAQUE_CLAVE.
Códigos de salida: 0 bien, 1 error de la herramienta, 2 uso, 3 red o protocolo.
`;

// --- el repositorio local --------------------------------------------------

/** La ruta de una nota dentro del repositorio, sin salirse de él ni entrar en .git. */
function dentro(rel) {
  const absoluta = resolve(MEMORIA_DIR, rel);
  const relativa = relative(MEMORIA_DIR, absoluta);
  if (relativa === ".." || relativa.startsWith(`..${sep}`) || isAbsolute(relativa) || relativa.split(sep).includes(".git")) {
    throw new Fallo(`la ruta «${rel}» sale de la memoria`, 2);
  }
  return { absoluta, relativa };
}

/** Todas las notas .md del repositorio (rutas relativas), sin .git ni carpetas ocultas. */
function todasLasNotas(desde = "") {
  const salida = [];
  const raiz = desde ? dentro(desde).absoluta : MEMORIA_DIR;
  const recorrer = carpeta => {
    let entradas;
    try {
      entradas = readdirSync(carpeta, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (e.name.startsWith(".")) continue;
      const ruta = join(carpeta, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else if (e.isFile() && e.name.endsWith(".md")) salida.push(relative(MEMORIA_DIR, ruta));
    }
  };
  recorrer(raiz);
  return salida.sort();
}

/** El frontmatter de una nota (lo básico: valores en una línea, entre comillas o en bloque). */
function frontmatter(texto) {
  const lineas = texto.split("\n");
  if (lineas[0]?.trim() !== "---") return {};
  const fin = lineas.indexOf("---", 1);
  if (fin === -1) return {};
  const datos = {};
  for (let i = 1; i < fin; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lineas[i]);
    if (!m) continue;
    let valor = m[2].trim();
    if (/^[>|][+-]?$/.test(valor)) {
      const bloque = [];
      while (i + 1 < fin && /^\s+\S/.test(lineas[i + 1])) bloque.push(lineas[++i].trim());
      valor = bloque.join(" ");
    } else if (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) {
      try {
        valor = JSON.parse(valor);
      } catch {
        valor = valor.slice(1, -1);
      }
    } else if (valor.startsWith("'") && valor.endsWith("'") && valor.length >= 2) {
      valor = valor.slice(1, -1).replace(/''/g, "'");
    }
    datos[m[1]] = valor;
  }
  return datos;
}

/** Resuelve «nombre», «[[nombre]]» o una ruta a la ruta relativa de una nota. */
function resolverNota(referencia) {
  let ref = referencia.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
  if (ref === "") throw new Fallo("dime qué nota: un nombre o una ruta", 2);
  if (ref.includes("/") || ref.endsWith(".md")) {
    const { absoluta, relativa } = dentro(ref.endsWith(".md") ? ref : `${ref}.md`);
    if (!existsSync(absoluta) || !statSync(absoluta).isFile()) throw new Fallo(`no existe la nota ${relativa}`, 2);
    return relativa;
  }
  const buscado = plano(ref);
  const notas = todasLasNotas();
  const nombre = r => plano(r.split("/").pop().replace(/\.md$/, ""));
  const iguales = notas.filter(r => nombre(r) === buscado);
  const candidatas = iguales.filter(r => !r.startsWith("archive/"));
  if (candidatas.length === 1) return candidatas[0];
  if (iguales.length === 1) return iguales[0];
  if (iguales.length > 1) {
    throw new Fallo(`«${ref}» es ambigua; usa la ruta:\n${iguales.map(r => `  ${r}`).join("\n")}`, 2);
  }
  const parecidas = notas.filter(r => nombre(r).includes(buscado)).slice(0, 8);
  throw new Fallo(
    `no hay ninguna nota llamada «${ref}».${parecidas.length ? ` ¿Alguna de estas?\n${parecidas.map(r => `  ${r}`).join("\n")}` : ""}`,
    2
  );
}

/** Los encabezados de una nota fuera de los bloques de código: { nivel, texto, linea } (línea desde 0). */
function encabezados(lineas) {
  const lista = [];
  let cerca = null;
  lineas.forEach((l, i) => {
    const valla = /^\s*(```+|~~~+)/.exec(l);
    if (valla) {
      if (cerca === null) cerca = valla[1][0];
      else if (valla[1][0] === cerca) cerca = null;
      return;
    }
    if (cerca !== null) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) lista.push({ nivel: m[1].length, texto: m[2], linea: i });
  });
  return lista;
}

/** La sección de un encabezado, hasta el siguiente del mismo nivel o superior. */
function seccionDe(contenido, pedida) {
  const lineas = contenido.split("\n");
  const lista = encabezados(lineas);
  const quiere = plano(pedida.replace(/^#+\s*/, "").trim());
  const e = lista.find(h => plano(h.texto) === quiere) ?? lista.find(h => plano(h.texto).startsWith(quiere));
  if (!e) {
    throw new Fallo(
      `no hay ninguna sección «${pedida}». Hay:\n${lista.map(h => `  ${"#".repeat(h.nivel)} ${h.texto}`).join("\n")}`,
      2
    );
  }
  const siguiente = lista.find(h => h.linea > e.linea && h.nivel <= e.nivel);
  return lineas.slice(e.linea, siguiente ? siguiente.linea : lineas.length).join("\n").replace(/\s+$/, "\n");
}

// --- patrón de búsqueda sin acentos ------------------------------------------

const CLASES = { a: "aáàäâã", e: "eéèëê", i: "iíìïî", o: "oóòöôõ", u: "uúùüû", n: "nñ", c: "cç" };

/** Un texto literal como regex que ignora acentos (las mayúsculas las ignora rg con -i). */
function regexSinAcentos(texto) {
  const escapado = plano(texto).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  return escapado.replace(/[aeiounc]/g, c => `[${CLASES[c]}]`);
}

// --- comandos de lectura locales ----------------------------------------------

function buscarLocal(pos, op) {
  const terminos = pos.map(t => t.trim()).filter(Boolean);
  if (!terminos.length) throw new Fallo("dime qué buscas: memoria buscar <texto…>", 2);
  const limite = op.limite ?? 30;
  const rgArgs = ["--no-heading", "--with-filename", "--line-number", "--color", "never", "--no-messages", "--ignore-case", "--max-count", "5", "-g", "*.md"];
  if (!op.archivo) rgArgs.push("-g", "!archive/**");
  if (op.regex) {
    rgArgs.push("-e", terminos.join(" "));
  } else if (terminos.length === 1) {
    rgArgs.push("-e", regexSinAcentos(terminos[0]));
  } else {
    // Todas las palabras en la misma línea, en cualquier orden (PCRE2: miradas hacia delante).
    rgArgs.push("-P", "-e", `^${terminos.map(t => `(?=.*${regexSinAcentos(t)})`).join("")}.*$`);
  }
  const donde = op.carpeta ? dentro(op.carpeta.replace(/\/+$/, "")).relativa || "." : ".";
  const r = correr("rg", [...rgArgs, "--", donde], { cwd: MEMORIA_DIR });
  if (r.estado === 2 && !r.salida) throw new Fallo(`rg falló: ${enUnaLinea(r.error, 300)}`, 1);
  const aciertos = [];
  for (const l of r.salida.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    aciertos.push({ ruta: m[1].replace(/^\.\//, ""), linea: Number(m[2]), texto: m[3] });
  }
  const primero = plano(terminos[0]);
  const fragmento = texto => {
    const i = op.regex ? 0 : Math.max(0, plano(texto).indexOf(primero) - 40);
    return enUnaLinea(texto.slice(i), 160);
  };
  const vistos = aciertos.slice(0, limite).map(a => ({ ...a, texto: fragmento(a.texto) }));
  if (op.json) imprimirJson(vistos);
  else for (const a of vistos) console.log(`${a.ruta}:${a.linea}: ${a.texto}`);
  if (!aciertos.length) process.stderr.write("memoria: sin resultados\n");
  else if (aciertos.length > limite) process.stderr.write(`memoria: ${aciertos.length - limite} resultados más (sube --limite o afina el texto)\n`);
  return 0;
}

function leerLocal(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria leer <nombre|ruta> [--seccion X]", 2);
  const ruta = resolverNota(pos[0]);
  const contenido = readFileSync(resolve(MEMORIA_DIR, ruta), "utf8");
  process.stdout.write(op.seccion ? seccionDe(contenido, op.seccion) : contenido.endsWith("\n") ? contenido : `${contenido}\n`);
  return 0;
}

function listaLocal(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria lista [carpeta]", 2);
  if (!pos.length) {
    const cuentas = new Map();
    for (const r of todasLasNotas()) {
      const carpeta = r.includes("/") ? r.split("/")[0] : ".";
      cuentas.set(carpeta, (cuentas.get(carpeta) ?? 0) + 1);
    }
    const filas = [...cuentas].sort(([a], [b]) => a.localeCompare(b)).map(([carpeta, notas]) => ({ carpeta, notas }));
    if (op.json) imprimirJson(filas);
    else for (const f of filas) console.log(`${f.carpeta === "." ? "(raíz)" : `${f.carpeta}/`}  ${f.notas} notas`);
    return 0;
  }
  const carpeta = pos[0].replace(/\/+$/, "");
  const { absoluta } = dentro(carpeta);
  if (!existsSync(absoluta) || !statSync(absoluta).isDirectory()) throw new Fallo(`no existe la carpeta ${carpeta}`, 2);
  const filas = todasLasNotas(carpeta).map(ruta => {
    const texto = readFileSync(resolve(MEMORIA_DIR, ruta), "utf8");
    const f = frontmatter(texto);
    return { ruta, nombre: ruta.split("/").pop().replace(/\.md$/, ""), description: f.description ?? "", actualizada: statSync(resolve(MEMORIA_DIR, ruta)).mtime.toISOString() };
  });
  if (op.json) imprimirJson(filas);
  else for (const f of filas) console.log(f.description ? `${f.ruta} — ${enUnaLinea(f.description, 140)}` : f.ruta);
  return 0;
}

function recientesLocal(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria recientes [N]", 2);
  const n = pos.length ? Number(pos[0]) : 15;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Fallo("N tiene que ser un entero entre 1 y 200", 2);
  // safe.directory: el repositorio es de otro usuario (my-memory) y git, si no, se niega a leerlo.
  const r = correr("git", [
    "-c", "safe.directory=*", "-C", MEMORIA_DIR, "log", `-${n}`, "--name-status", "--date=format:%Y-%m-%d %H:%M",
    "--format=%x1e%h%x1f%ad%x1f%s%x1f%(trailers:key=Client,valueonly,unfold)%x1f%(trailers:key=Tool,valueonly,unfold)%x1d"
  ]);
  if (r.estado !== 0) throw new Fallo(`git log falló: ${enUnaLinea(r.error, 300)}`, 1);
  const commits = [];
  for (const registro of r.salida.split("\x1e").filter(x => x.trim())) {
    const [cabecera, resto = ""] = registro.split("\x1d");
    const [commit, fecha, motivo, cliente, herramienta] = cabecera.split("\x1f").map(s => s.trim());
    const notas = resto.split("\n").filter(Boolean).map(l => {
      const [estado, ...rutas] = l.split("\t");
      return { estado: estado[0], ruta: rutas[rutas.length - 1], ...(rutas.length > 1 ? { antes: rutas[0] } : {}) };
    });
    commits.push({ commit, fecha, cliente, herramienta, motivo, notas });
  }
  if (op.json) {
    imprimirJson(commits);
    return 0;
  }
  for (const c of commits) {
    console.log([c.fecha, c.cliente || "-", c.herramienta || "-", enUnaLinea(c.motivo, 100)].join(" · "));
    for (const nota of c.notas) console.log(`  ${nota.estado} ${nota.ruta}${nota.antes ? ` (antes ${nota.antes})` : ""}`);
  }
  return 0;
}

// --- lectura por el Badulaque (sin MEMORIA_DIR: el Mac) -------------------------

const lineaDeHit = h => `${h.path}:${h.section?.line_start ?? 1}: ${enUnaLinea(h.snippet ?? h.description ?? "", 160)}`;

async function buscarRemoto(pos, op) {
  const consulta = pos.join(" ").trim();
  if (!consulta) throw new Fallo("dime qué buscas: memoria buscar <texto…>", 2);
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_search", {
    query: consulta, limit: op.limite ?? 10,
    ...(op.carpeta ? { folder: op.carpeta.replace(/\/+$/, "") } : {}), ...(op.archivo ? { include_archive: true } : {})
  }));
  const hits = r.json?.hits ?? [];
  if (op.json) imprimirJson(hits);
  else for (const h of hits) console.log(lineaDeHit(h));
  if (!hits.length) process.stderr.write("memoria: sin resultados\n");
  return 0;
}

async function leerRemoto(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria leer <nombre|ruta> [--seccion X]", 2);
  const ref = pos[0].replace(/^\[\[|\]\]$/g, "");
  const argumentos = ref.includes("/") || ref.endsWith(".md") ? { path: ref.endsWith(".md") ? ref : `${ref}.md` } : { name: ref };
  if (op.seccion) argumentos.section = op.seccion.replace(/^#+\s*/, "");
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_read", argumentos));
  const texto = typeof r.json?.content === "string" ? r.json.content : r.texto;
  process.stdout.write(texto.endsWith("\n") ? texto : `${texto}\n`);
  return 0;
}

async function listaRemota(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria lista [carpeta]", 2);
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_list", pos.length ? { folder: pos[0].replace(/\/+$/, ""), limit: 200 } : {}));
  if (op.json || !pos.length) {
    // Sin carpeta, el índice corto del servidor: se deja tal cual, que es lo que trae.
    imprimirJson(r.json ?? r.texto);
    return 0;
  }
  const notas = Array.isArray(r.json) ? r.json : (r.json?.notes ?? []);
  for (const n of notas) console.log(n.description ? `${n.path} — ${enUnaLinea(n.description, 140)}` : n.path);
  return 0;
}

async function recientesRemoto(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria recientes [N]", 2);
  const n = pos.length ? Number(pos[0]) : 15;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Fallo("N tiene que ser un entero entre 1 y 200", 2);
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_recent", { limit: n }));
  const commits = r.json?.commits ?? [];
  if (op.json) {
    imprimirJson(commits);
    return 0;
  }
  for (const c of commits) {
    console.log([c.date ? fechaCorta(c.date) : "", c.client ?? c.author ?? "-", c.tool ?? "-", enUnaLinea(c.reason ?? "", 100)].join(" · "));
    for (const nota of c.notes ?? []) console.log(`  ${(nota.change ?? "?")[0].toUpperCase()} ${nota.path}`);
  }
  return 0;
}

// --- escritura: siempre por el Badulaque ----------------------------------------

async function crear(pos, op) {
  if (pos.length < 1 || pos.length > 2 || (pos[1] !== undefined && pos[1] !== "-")) {
    throw new Fallo("uso: memoria crear <ruta> --razon <texto> (--archivo <f> | -)", 2);
  }
  if (!op.razon) throw new Fallo("falta --razon: una línea que diga por qué (será el mensaje del commit)", 2);
  const ruta = pos[0].endsWith(".md") ? pos[0] : `${pos[0]}.md`;
  if (op.archivo === undefined && pos[1] !== "-") throw new Fallo("falta el contenido: --archivo <f>, o - para leerlo de la entrada", 2);
  const content = textoDe(pos[1], op.archivo);
  if (!content.trim()) throw new Fallo("el contenido está vacío", 2);
  const argumentos = { path: ruta, content, reason: op.razon, ...(op.confirmar_nueva ? { confirm_new: true } : {}) };
  if (simular(op, "memoria_create", argumentos)) return 0;
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_create", argumentos));
  console.log(r.texto);
  return 0;
}

async function editar(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria editar <nota> --razon <texto> --viejo <texto> --nuevo <texto>", 2);
  if (!op.razon) throw new Fallo("falta --razon: una línea que diga por qué (será el mensaje del commit)", 2);
  let ediciones;
  if (op.ediciones !== undefined) {
    try {
      ediciones = JSON.parse(readFileSync(op.ediciones, "utf8"));
    } catch (e) {
      throw new Fallo(`no pude leer las ediciones de ${op.ediciones}: ${e.message}`, 2);
    }
    if (!Array.isArray(ediciones) || !ediciones.length) throw new Fallo("--ediciones tiene que ser una lista no vacía", 2);
  } else {
    if (op.viejo === undefined || op.nuevo === undefined) throw new Fallo("faltan --viejo y --nuevo (o --ediciones <f.json>)", 2);
    ediciones = [{ old_string: textoDe(op.viejo), new_string: textoDe(op.nuevo), ...(op.todas ? { replace_all: true } : {}) }];
  }
  const ref = pos[0].replace(/^\[\[|\]\]$/g, "");
  const donde = ref.includes("/") || ref.endsWith(".md") ? { path: ref.endsWith(".md") ? ref : `${ref}.md` } : { name: ref };
  const argumentos = { ...donde, edits: ediciones, reason: op.razon, ...(op.hash ? { hash: op.hash } : {}) };
  if (simular(op, "memoria_edit", argumentos)) return 0;
  const r = await conBadulaque(ctx => usarOFallar(ctx, "memoria_edit", argumentos));
  console.log(r.texto);
  return 0;
}

// --- entrada --------------------------------------------------------------------

const OPCIONES = {
  buscar: { carpeta: "valor", limite: "entero", archivo: "bool", regex: "bool", json: "bool" },
  leer: { seccion: "valor" },
  lista: { json: "bool" },
  recientes: { json: "bool" },
  crear: { razon: "valor", archivo: "valor", confirmar_nueva: "bool", simular: "bool" },
  editar: { razon: "valor", viejo: "valor", nuevo: "valor", todas: "bool", hash: "valor", ediciones: "valor", simular: "bool" }
};

async function principal(argv) {
  const [orden, ...resto] = argv;
  if (orden === undefined || orden === "--help" || orden === "-h" || orden === "ayuda") {
    process.stdout.write(AYUDA);
    return 0;
  }
  if (orden === "--version") {
    console.log(VERSION);
    return 0;
  }
  const def = OPCIONES[orden];
  if (!def) throw new Fallo(`no conozco «${orden}». Mira memoria --help`, 2);
  if (resto.includes("--help") || resto.includes("-h")) {
    process.stdout.write(AYUDA);
    return 0;
  }
  const { pos, op } = analizar(resto, def, "Mira memoria --help");
  switch (orden) {
    case "buscar": return LOCAL ? buscarLocal(pos, op) : buscarRemoto(pos, op);
    case "leer": return LOCAL ? leerLocal(pos, op) : leerRemoto(pos, op);
    case "lista": return LOCAL ? listaLocal(pos, op) : listaRemota(pos, op);
    case "recientes": return LOCAL ? recientesLocal(pos, op) : recientesRemoto(pos, op);
    case "crear": return crear(pos, op);
    case "editar": return editar(pos, op);
  }
  return 2;
}

await ejecutarCli("memoria", principal);
