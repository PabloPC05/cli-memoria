#!/usr/bin/env node
// memoria: la memoria de Pablo (notas Markdown en un repositorio git) como comandos.
//
// - Leer (buscar, leer, lista, recientes): directamente en el repositorio, que en lisa la terminal monta en solo
//   lectura y dice en MEMORIA_DIR. Con rg y git, sin pasar por el MCP: filtra con rg, jq o head.
// - Sin MEMORIA_DIR (el Mac): las mismas lecturas por el Badulaque (memoria_search, read, list, recent).
//   En el Mac no se lee la copia de Google Drive.
// - Escribir, en nativo (fase 4): una copia de trabajo (`memoria copia`, un git clone del repositorio de solo lectura)
//   que se edita con las herramientas de siempre y se commitea con git; `memoria publicar` lleva esos commits al servidor
//   de la memoria nota a nota (create, write, move, delete del Badulaque), con el hash de cada nota para no pisar cambios
//   ajenos. El servidor es el único que escribe en el repositorio real: firma con la clave del agente y aplica sus reglas.
//   `crear` y `editar` siguen siendo atajos de una sola nota por el Badulaque (y lo único que hay en el Mac).
//
// Uso: memoria --help. Sin dependencias. Ver kit/README.md.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Fallo, analizar, conBadulaque, correr, ejecutarCli, enUnaLinea, fechaCorta, imprimirJson, plano, simular, textoDe, usar, usarOFallar
} from "../badulaque/nativa.mjs";

const VERSION = "2.0.0";
const MEMORIA_DIR = (process.env.MEMORIA_DIR ?? "").trim();
const LOCAL = MEMORIA_DIR !== "" && existsSync(MEMORIA_DIR);
const COPIA = (process.env.MEMORIA_COPIA ?? "").trim() || join(process.env.HOME ?? "", "memoria");
const SERVIDOR = "refs/memoria/servidor";

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

Escribir como en un ordenador (copia de trabajo + git; hace falta MEMORIA_DIR, o sea, en lisa):
  memoria copia
      Crea tu copia de trabajo (un git clone de las notas) en ${COPIA} (cámbialo con MEMORIA_COPIA) y dice dónde está.
      Edítala con tus herramientas y haz git add / git commit (el asunto del commit es la razón del cambio).
  memoria estado [--json]
      Qué tienes sin commitear, qué commits faltan por publicar y si el servidor tiene cambios nuevos (y si chocan).
  memoria publicar [--razon <texto>] [--simular] [--confirmar-nueva] [--aplanar] [--json]
      Lleva tus commits al servidor, nota a nota y firmados por ti: nota nueva, cambio, movimiento o borrado, cada uno con el
      hash de la nota que viste, así que no pisa lo que otro cambió (si choca, para y te lo explica). Antes comprueba las
      reglas de la memoria. Con --razon hace antes un commit con todo lo pendiente. --simular no envía nada: lo enseña.
      --aplanar publica el resultado final de todos los commits (no uno a uno) con la razón hecha de sus asuntos: sirve si un
      commit intermedio no se puede publicar y otro posterior lo arregla.
      Al acabar, tu copia queda igual que el servidor. Solo notas .md: los adjuntos van con badulaque memoria attach.
  memoria actualizar
      Trae los cambios nuevos del servidor a tu copia (rebase de tus commits sin publicar; si choca, lo deja como estaba).

Escritura de una sola nota por el Badulaque (lo único que hay en el Mac), con la clave de tu agente:
  memoria crear <ruta> --razon <texto> (--archivo <f> | -) [--confirmar-nueva]
      Nota nueva con su frontmatter, desde un archivo o stdin. Si se parece a otra, falla y te la enseña.
  memoria editar <nota> --razon <texto> --viejo <texto> --nuevo <texto> [--todas] [--hash H]
  memoria editar <nota> --razon <texto> --ediciones <f.json>   (una lista de {old_string, new_string, replace_all})
      Reemplazo exacto: --viejo tiene que aparecer una sola vez (o --todas).
  --simular enseña la llamada sin hacerla. Para escribir una nota entera, moverla o borrarla: badulaque memoria write | move | delete.

Variables: MEMORIA_DIR (la ruta de solo lectura; si falta, todo va por el Badulaque), MEMORIA_COPIA, BADULAQUE_CLAVE.
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
    // Una línea corta se da entera; una larga, desde un poco antes del acierto.
    const i = op.regex || texto.trim().length <= 160 ? 0 : Math.max(0, plano(texto).indexOf(primero) - 40);
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
  // safe.directory: el repositorio es de otro usuario (my-memory) y git, si no, se niega a leerlo. Sin configuración
  // global ni del sistema: dentro de srt, ~/.gitconfig es un /dev/null que git no puede abrir y falla entero.
  const r = correr("git", [
    "-c", "safe.directory=*", "-C", MEMORIA_DIR, "log", `-${n}`, "--name-status", "--date=format:%Y-%m-%d %H:%M",
    "--format=%x1e%h%x1f%ad%x1f%s%x1f%(trailers:key=Client,valueonly,unfold)%x1f%(trailers:key=Tool,valueonly,unfold)%x1d"
  ], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
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
  if (!pos.length) {
    // Sin carpeta, el servidor da su índice corto: igual que en local, una línea por carpeta con su número de notas.
    const filas = (r.json?.index?.folders ?? []).map(f => ({ carpeta: f.folder, notas: f.count }));
    if (!filas.length) {
      imprimirJson(r.json ?? r.texto);
      return 0;
    }
    if (op.json) imprimirJson(filas);
    else for (const f of filas) console.log(`${f.carpeta === "." ? "(raíz)" : `${f.carpeta}/`}  ${f.notas} notas`);
    return 0;
  }
  const notas = Array.isArray(r.json) ? r.json : (r.json?.notes ?? []);
  if (op.json) {
    imprimirJson(notas.map(n => ({ ruta: n.path, nombre: n.name, description: n.description ?? "", actualizada: n.updated ?? n.modified ?? null })));
    return 0;
  }
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

// --- escribir en nativo: copia de trabajo, git y `memoria publicar` ------------------------------------------------

// git sin configuración global ni del sistema (dentro de srt, ~/.gitconfig es un /dev/null que git no puede abrir) y sin
// preguntar nada. LFS sin descargar: los adjuntos no están en la copia, solo sus punteros.
const ENTORNO_GIT = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true",
  GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0"
};

/**
 * Corre git en la copia de trabajo. `seguro` añade safe.directory=*, necesario para leer del repositorio de las notas
 * (es de otro usuario, my-memory). Si falla y no se pide `permitir`, es un Fallo con lo que dijo git.
 */
function git(args, { cwd = COPIA, seguro = false, permitir = false } = {}) {
  const r = correr("git", [...(seguro ? ["-c", "safe.directory=*"] : []), ...args], { cwd, env: ENTORNO_GIT });
  if (r.estado !== 0 && !permitir) throw new Fallo(`git ${args[0]} falló: ${enUnaLinea(r.error || r.salida, 400)}`, 1);
  return r;
}

const corto = h => String(h).slice(0, 7);
/** El hash (blob) de una ruta en una revisión, o null si no existe allí. Es el `hash` que usa la memoria. */
const blobEn = (rev, ruta) => {
  const r = git(["rev-parse", "--verify", "-q", `${rev}:${ruta}`], { permitir: true });
  return r.estado === 0 ? r.salida.trim() : null;
};

function requerirLocal() {
  if (!LOCAL) {
    throw new Fallo("esto trabaja sobre el repositorio de las notas (MEMORIA_DIR), que aquí no está. Sin él (el Mac) usa memoria crear y memoria editar", 2);
  }
}

function requerirCopia() {
  requerirLocal();
  if (!existsSync(join(COPIA, ".git"))) throw new Fallo(`no hay copia de trabajo en ${COPIA}. Créala con: memoria copia`, 2);
}

/** La versión del servidor: el HEAD del repositorio de las notas, en refs/memoria/servidor de la copia. Solo lee. */
function traerServidor() {
  git(["fetch", "--quiet", "--no-tags", "--force", MEMORIA_DIR, `+HEAD:${SERVIDOR}`], { seguro: true });
}

/** Rutas con cambios sin commitear (incluidas las nuevas). */
function pendientesSinCommit() {
  const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return r.salida.split("\0").filter(x => x.length > 3).map(x => x.slice(3));
}

function copiar(pos) {
  if (pos.length) throw new Fallo("uso: memoria copia", 2);
  requerirLocal();
  if (existsSync(join(COPIA, ".git"))) {
    console.log(`ya tienes copia de trabajo en ${COPIA} (memoria estado, memoria actualizar)`);
    return 0;
  }
  if (existsSync(COPIA) && readdirSync(COPIA).length) throw new Fallo(`${COPIA} existe y no está vacía: usa otra con MEMORIA_COPIA`, 2);
  mkdirSync(dirname(COPIA), { recursive: true });
  const r = correr("git", ["-c", "safe.directory=*", "clone", "--quiet", "--no-hardlinks", MEMORIA_DIR, COPIA], { env: ENTORNO_GIT });
  if (r.estado !== 0) throw new Fallo(`no pude clonar las notas: ${enUnaLinea(r.error, 400)}`, 1);
  // Identidad local de la copia (la firma de verdad la pone el servidor al publicar) y sin remoto: así un `git push`
  // no puede llegar nunca al repositorio de las notas, solo `memoria publicar`.
  for (const [k, v] of [["user.name", "memoria (copia de trabajo)"], ["user.email", "memoria@copia.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    git(["config", k, v]);
  }
  git(["remote", "remove", "origin"]);
  git(["update-ref", SERVIDOR, "HEAD"]);
  console.log(`copia de trabajo lista en ${COPIA}`);
  console.log("edita las notas, haz git add y git commit (el asunto es la razón), y memoria publicar");
  return 0;
}

// Las reglas de la memoria (memory.toml), las que se pueden comprobar sin el servidor. Los valores de TOML que usa la
// memoria (cadenas, números y listas en una línea) se leen como JSON; lo que no se entiende no se comprueba.
function convenciones() {
  const c = {
    carpetas: null, raiz: ["AGENTS.md", "README.md"], patron: /^[a-z0-9]+(-[a-z0-9]+)*\.md$/, requeridos: ["name", "description"]
  };
  const texto = git(["show", `${SERVIDOR}:memory.toml`], { permitir: true });
  if (texto.estado !== 0) return c;
  let seccion = "";
  for (const linea of texto.salida.split("\n")) {
    const s = /^\s*\[([\w.]+)\]\s*(#.*)?$/.exec(linea);
    if (s) {
      seccion = s[1];
      continue;
    }
    const m = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(linea);
    if (!m) continue;
    let valor;
    for (const candidato of [m[2], m[2].replace(/\s+#.*$/, "")]) {
      try {
        valor = JSON.parse(candidato);
        break;
      } catch {
        /* se prueba el siguiente */
      }
    }
    if (valor === undefined) continue;
    const llave = `${seccion}.${m[1]}`;
    if (llave === "folders.allowed" && Array.isArray(valor)) c.carpetas = valor;
    else if (llave === "folders.root_files" && Array.isArray(valor)) c.raiz = valor;
    else if (llave === "notes.required_fields" && Array.isArray(valor)) c.requeridos = valor;
    else if (llave === "notes.filename_pattern" && typeof valor === "string") {
      try {
        c.patron = new RegExp(valor, "u");
      } catch {
        /* patrón raro: lo valida el servidor */
      }
    }
  }
  return c;
}

/** Los cambios de un commit en notas: [{ estado: A|M|D|R, ruta, de? }] (detecta renombrados). */
function cambiosDe(commit, desde = null) {
  const r = git(desde
    ? ["diff-tree", "-r", "-M", "--name-status", "-z", desde, commit]
    : ["diff-tree", "--root", "-r", "-M", "--no-commit-id", "--name-status", "-z", commit]);
  const t = r.salida.split("\0");
  const lista = [];
  for (let i = 0; i < t.length && t[i] !== "";) {
    const estado = t[i++][0];
    if (estado === "R" || estado === "C") {
      const de = t[i++];
      lista.push({ estado: "R", de, ruta: t[i++] });
    } else {
      lista.push({ estado, ruta: t[i++] });
    }
  }
  // Primero los cambios, luego los movimientos, las notas nuevas y al final los borrados (borrar una nota exige que ya
  // nadie la enlace, y mover reescribe enlaces en otras: así lo que el commit cambió a mano va antes).
  const orden = { M: 0, R: 1, A: 2, D: 3 };
  return lista.sort((a, b) => (orden[a.estado] ?? 9) - (orden[b.estado] ?? 9));
}

const VERBOS = { A: "crear", M: "escribir", R: "mover", D: "borrar" };
const HERRAMIENTAS = { A: "memoria_create", M: "memoria_write", R: "memoria_move", D: "memoria_delete" };

/**
 * Los commits por publicar (del más antiguo al más nuevo), con sus cambios y la razón (su asunto). Con `aplanar`, uno
 * solo: el resultado final de todos (lo que cambió cada nota de la base a ahora), con la razón de cada nota hecha de
 * los asuntos de los commits que la tocaron. Sirve cuando un commit intermedio no se puede publicar tal cual.
 */
function porPublicar(base, aplanar = false) {
  const lista = git(["rev-list", "--reverse", `${base}..HEAD`]).salida.split("\n").filter(Boolean);
  if (git(["rev-list", "--merges", "--count", `${base}..HEAD`]).salida.trim() !== "0") {
    throw new Fallo("hay commits de fusión sin publicar: deja el historial lineal (git rebase refs/memoria/servidor) y vuelve a publicar", 1);
  }
  if (aplanar) {
    if (!lista.length) return [];
    const cambios = cambiosDe("HEAD", base).map(x => {
      const asuntos = git(["log", "--reverse", "--format=%s", ...(x.estado === "D" ? [] : ["--follow"]), `${base}..HEAD`, "--", x.ruta]).salida
        .split("\n").map(a => a.replace(/\s+/g, " ").trim()).filter(Boolean);
      const razon = [...new Set(asuntos)].join("; ");
      return { ...x, razon: razon.length > 300 ? `${razon.slice(0, 297)}...` : razon || "cambios de la copia de trabajo" };
    });
    return cambios.length ? [{ commit: git(["rev-parse", "HEAD"]).salida.trim(), razon: `${lista.length} commits aplanados`, cambios }] : [];
  }
  return lista
    .map(commit => ({
      commit,
      razon: git(["log", "-1", "--format=%s", commit]).salida.replace(/\s+/g, " ").trim(),
      cambios: cambiosDe(commit)
    }))
    .filter(c => c.cambios.length);
}

/** Lo que no pasaría las reglas de la memoria, antes de enviar nada. Lista de textos (vacía si todo bien). */
function comprobar(commits) {
  const reglas = convenciones();
  const problemas = [];
  for (const c of commits) {
    const donde = `${corto(c.commit)} «${enUnaLinea(c.razon, 50)}»`;
    if (c.razon.length > 300) problemas.push(`${donde}: la razón (el asunto del commit) pasa de 300 caracteres`);
    for (const x of c.cambios) {
      if ((x.razon ?? "").length > 300) problemas.push(`${donde}: ${x.ruta}: la razón pasa de 300 caracteres`);
      for (const ruta of x.estado === "R" ? [x.de, x.ruta] : [x.ruta]) {
        const mal = porque => problemas.push(`${donde}: ${ruta}: ${porque}`);
        const partes = ruta.split("/");
        if (!/\.md$/i.test(ruta)) mal("no es una nota .md (los adjuntos y el resto de archivos no se publican así: badulaque memoria attach)");
        else if (partes.some(p => p.startsWith("."))) mal("las rutas ocultas no valen");
        else if (partes.length === 1 && !reglas.raiz.includes(ruta)) mal(`en la raíz solo puede haber ${reglas.raiz.join(", ")}; ponla en una carpeta`);
        else if (partes.length > 1 && reglas.carpetas && !reglas.carpetas.includes(partes[0])) {
          mal(`«${partes[0]}» no es una carpeta permitida (${reglas.carpetas.join(", ")})`);
        }
      }
      if ((x.estado === "A" || x.estado === "R") && /\.md$/i.test(x.ruta)) {
        const partes = x.ruta.split("/");
        const nuevoNombre = partes[partes.length - 1];
        if (!(partes.length === 1 && reglas.raiz.includes(x.ruta)) && !reglas.patron.test(nuevoNombre)) {
          problemas.push(`${corto(c.commit)} «${enUnaLinea(c.razon, 50)}»: ${x.ruta}: el nombre no sigue el patrón de la memoria (${reglas.patron.source})`);
        }
      }
      if (x.estado === "A" && /\.md$/i.test(x.ruta) && !reglas.raiz.includes(x.ruta)) {
        const f = frontmatter(git(["show", `${c.commit}:${x.ruta}`]).salida);
        for (const campo of reglas.requeridos) {
          if (!f[campo]) problemas.push(`${corto(c.commit)} «${enUnaLinea(c.razon, 50)}»: ${x.ruta}: falta «${campo}» en el frontmatter`);
        }
      }
    }
  }
  return problemas;
}

/** Las notas que tocan mis commits y que el servidor cambió desde la base: [{ ruta, quien }]. */
function choques(base, commits) {
  if (git(["rev-parse", base]).salida.trim() === git(["rev-parse", SERVIDOR]).salida.trim()) return [];
  const rutas = new Set();
  for (const c of commits) for (const x of c.cambios) for (const r of x.estado === "R" ? [x.de, x.ruta] : [x.ruta]) rutas.add(r);
  const lista = [];
  for (const ruta of rutas) {
    if (blobEn(base, ruta) === blobEn(SERVIDOR, ruta)) continue;
    const l = git(["log", "-1", "--format=%h%x1f%s%x1f%(trailers:key=Client,valueonly,unfold)", SERVIDOR, "--", ruta], { permitir: true }).salida.trim();
    const [h, motivo, cliente] = l.split("\x1f");
    lista.push({ ruta, quien: cliente?.trim() || "otro", commit: h, motivo: enUnaLinea(motivo ?? "", 80) });
  }
  return lista;
}

function contarEntre(a, b) {
  return Number(git(["rev-list", "--count", `${a}..${b}`]).salida.trim());
}

function baseComun() {
  const r = git(["merge-base", "HEAD", SERVIDOR], { permitir: true });
  if (r.estado !== 0) throw new Fallo("tu copia y el servidor no comparten historia (¿se rehízo la memoria?): borra la copia y vuelve a hacer memoria copia", 1);
  return r.salida.trim();
}

function estado(pos, op) {
  if (pos.length) throw new Fallo("uso: memoria estado [--json]", 2);
  requerirCopia();
  traerServidor();
  const base = baseComun();
  const sin = pendientesSinCommit();
  const commits = porPublicar(base);
  const nuevos = contarEntre(base, SERVIDOR);
  const chocan = choques(base, commits);
  if (op.json) {
    imprimirJson({
      copia: COPIA, sin_commit: sin,
      por_publicar: commits.map(c => ({ commit: corto(c.commit), razon: c.razon, cambios: c.cambios.map(x => ({ operacion: VERBOS[x.estado], ruta: x.ruta, ...(x.de ? { de: x.de } : {}) })) })),
      cambios_nuevos_en_el_servidor: nuevos, chocan
    });
    return 0;
  }
  console.log(`copia: ${COPIA}`);
  console.log(sin.length ? `sin commitear: ${sin.length} archivos (${sin.slice(0, 5).join(", ")}${sin.length > 5 ? ", …" : ""})` : "sin commitear: nada");
  if (!commits.length) console.log("por publicar: nada");
  else {
    console.log(`por publicar: ${commits.length} commits`);
    for (const c of commits) {
      console.log(`  ${corto(c.commit)} ${enUnaLinea(c.razon, 100)}`);
      for (const x of c.cambios) console.log(`    ${VERBOS[x.estado]} ${x.de ? `${x.de} → ` : ""}${x.ruta}`);
    }
  }
  console.log(nuevos ? `servidor: ${nuevos} commits nuevos que tu copia no tiene (memoria actualizar)` : "servidor: sin cambios nuevos");
  for (const c of chocan) console.log(`  choca: ${c.ruta} la cambió ${c.quien} (${c.commit} ${c.motivo})`);
  return 0;
}

/** Pone los commits sin publicar encima de la versión del servidor. Si chocan, lo deja como estaba y lo cuenta. */
function rebasar(desde) {
  const r = git(desde ? ["rebase", "--quiet", "--onto", SERVIDOR, desde] : ["rebase", "--quiet", SERVIDOR], { permitir: true });
  if (r.estado === 0) return { bien: true };
  const archivos = git(["diff", "--name-only", "--diff-filter=U"], { permitir: true }).salida.split("\n").filter(Boolean);
  git(["rebase", "--abort"], { permitir: true });
  return { bien: false, archivos, detalle: enUnaLinea(r.error || r.salida, 300) };
}

function actualizar(pos) {
  if (pos.length) throw new Fallo("uso: memoria actualizar", 2);
  requerirCopia();
  const sin = pendientesSinCommit();
  if (sin.length) throw new Fallo(`tienes cambios sin commitear (${sin.slice(0, 5).join(", ")}${sin.length > 5 ? ", …" : ""}): haz git commit antes de actualizar`, 1);
  traerServidor();
  const base = baseComun();
  const nuevos = contarEntre(base, SERVIDOR);
  if (contarEntre(SERVIDOR, "HEAD") === 0) {
    if (git(["rev-parse", "HEAD"]).salida.trim() !== git(["rev-parse", SERVIDOR]).salida.trim()) git(["reset", "--hard", "--quiet", SERVIDOR]);
    console.log(nuevos ? `copia actualizada: ${nuevos} cambios nuevos del servidor` : "la copia ya está al día");
    return 0;
  }
  if (!nuevos) {
    console.log("la copia ya está al día (tus commits siguen sin publicar)");
    return 0;
  }
  const r = rebasar();
  if (!r.bien) {
    throw new Fallo(
      `tus commits chocan con los cambios nuevos del servidor${r.archivos.length ? ` en ${r.archivos.join(", ")}` : ""}; no he tocado nada. ` +
        `Resuélvelo con git: git rebase ${SERVIDOR}, arregla los archivos, git add y git rebase --continue (o git rebase --abort)`, 1
    );
  }
  console.log(`copia actualizada: ${nuevos} cambios nuevos del servidor, y tus ${contarEntre(SERVIDOR, "HEAD")} commits encima`);
  return 0;
}

/** Lo que dijo la memoria cuando una escritura falló, con qué hacer. */
function explicar(json, texto) {
  const codigo = json?.code ?? "ERROR";
  const mensaje = json?.message ?? enUnaLinea(texto, 300);
  const consejos = {
    CONFLICT: "la nota cambió en el servidor: memoria actualizar y vuelve a publicar",
    REMOTE_CONFLICT: "alguien cambió la memoria a la vez: memoria actualizar y vuelve a publicar",
    DUPLICATE_CANDIDATES: `se parece a ${(json?.candidates ?? []).map(c => c.path).join(", ") || "otra nota"}: léelas; si de verdad es nueva, memoria publicar --confirmar-nueva`,
    HAS_BACKLINKS: `otras notas la enlazan (${(json?.backlinks ?? []).map(b => b.src_path).join(", ")}): quita esos enlaces en un commit anterior`,
    NAME_TAKEN: "los nombres de nota son únicos en toda la memoria: elige otro",
    ALREADY_EXISTS: "ya existe una nota en esa ruta: memoria actualizar",
    INVALID_FRONTMATTER: `arregla el frontmatter (${(json?.problems ?? []).join("; ")}) y haz otro commit`
  };
  return `${codigo}: ${mensaje}${consejos[codigo] ? `. ${consejos[codigo]}` : ""}`;
}

async function publicar(pos, op) {
  if (pos.length) throw new Fallo("uso: memoria publicar [--razon <texto>] [--simular] [--confirmar-nueva]", 2);
  requerirCopia();
  let sin = pendientesSinCommit();
  if (sin.length && op.razon && !op.simular) {
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-verify", "-m", op.razon]);
    sin = [];
  }
  if (sin.length && !op.simular) {
    throw new Fallo(`tienes cambios sin commitear (${sin.slice(0, 5).join(", ")}${sin.length > 5 ? ", …" : ""}): haz git add y git commit (el asunto es la razón), o memoria publicar --razon "…"`, 1);
  }
  traerServidor();
  const base = baseComun();
  const commits = porPublicar(base, Boolean(op.aplanar));
  if (!commits.length) {
    console.log(sin.length ? "no hay commits que publicar (lo pendiente no está commiteado: --razon lo hace)" : "no hay nada que publicar");
    return 0;
  }
  const problemas = comprobar(commits);
  const chocan = choques(base, commits);
  if (op.simular) {
    if (op.json) {
      imprimirJson({
        simulado: true, problemas, chocan,
        commits: commits.map(c => ({ commit: corto(c.commit), razon: c.razon, llamadas: c.cambios.map(x => ({ herramienta: HERRAMIENTAS[x.estado], ruta: x.ruta, ...(x.de ? { de: x.de } : {}) })) }))
      });
      return 0;
    }
    for (const c of commits) {
      console.log(`${corto(c.commit)} ${enUnaLinea(c.razon, 100)}`);
      for (const x of c.cambios) console.log(`  ${HERRAMIENTAS[x.estado]} ${x.de ? `${x.de} → ` : ""}${x.ruta}`);
    }
    for (const p of problemas) console.log(`NO PASARÍA: ${p}`);
    for (const c of chocan) console.log(`CHOCA: ${c.ruta} la cambió ${c.quien} (${c.commit} ${c.motivo})`);
    if (!problemas.length && !chocan.length) console.log("todo en orden: sin choques y dentro de las reglas (el servidor aún puede objetar el frontmatter o los nombres)");
    return problemas.length || chocan.length ? 1 : 0;
  }
  if (problemas.length) throw new Fallo(`no publico nada; no pasaría las reglas de la memoria:\n${problemas.map(p => `  ${p}`).join("\n")}`, 1);
  if (chocan.length) {
    throw new Fallo(
      `no publico nada; el servidor tiene cambios de otros en notas que tocas:\n${chocan.map(c => `  ${c.ruta}: la cambió ${c.quien} (${c.commit} ${c.motivo})`).join("\n")}\n` +
        "memoria actualizar trae sus cambios y te enseña dónde chocan", 1
    );
  }

  const hashes = new Map(); // el hash que el servidor tiene ahora de cada nota que ya he tocado en esta tanda
  const hechos = [];
  const cabeza = git(["rev-parse", "HEAD"]).salida.trim();
  let fallo = null;
  await conBadulaque(async ctx => {
    for (const [i, c] of commits.entries()) {
      for (const x of c.cambios) {
        const hashDe = ruta => hashes.get(ruta) ?? blobEn(SERVIDOR, ruta);
        const contenido = () => git(["show", `${c.commit}:${x.ruta}`]).salida;
        const razon = x.razon ?? c.razon;
        const llamar = async (herramienta, argumentos) => {
          const r = await usar(ctx, herramienta, argumentos);
          return r;
        };
        let r;
        if (x.estado === "A") {
          r = await llamar("memoria_create", { path: x.ruta, content: contenido(), reason: razon, ...(op.confirmar_nueva ? { confirm_new: true } : {}) });
        } else if (x.estado === "M") {
          r = await llamar("memoria_write", { path: x.ruta, content: contenido(), hash: hashDe(x.ruta), reason: razon });
          // El servidor ya tiene exactamente eso (por ejemplo, un enlace que reescribió al mover otra nota).
          if (r.error && r.json?.code === "CONFLICT" && r.json.content === contenido()) r = { error: false, json: { hash: r.json.hash }, texto: "" };
        } else if (x.estado === "D") {
          r = await llamar("memoria_delete", { path: x.ruta, hash: hashDe(x.ruta), reason: razon });
        } else {
          r = await llamar("memoria_move", { from: x.de, to: x.ruta, hash: hashDe(x.de), reason: razon });
          if (!r.error && blobEn(c.commit, x.ruta) !== r.json?.hash) {
            r = await llamar("memoria_write", { path: x.ruta, content: contenido(), hash: r.json?.hash, reason: razon });
          }
        }
        if (r.error) {
          fallo = { i, commit: c, cambio: x, texto: explicar(r.json, r.texto) };
          return;
        }
        if (x.estado === "D") hashes.delete(x.ruta);
        else if (r.json?.hash) hashes.set(x.ruta, r.json.hash);
        if (x.estado === "R") hashes.delete(x.de);
        hechos.push({ commit: corto(c.commit), razon, operacion: VERBOS[x.estado], ruta: x.ruta, ...(x.de ? { de: x.de } : {}), servidor: r.json?.commit ? corto(r.json.commit) : null });
      }
    }
  });

  if (fallo) {
    let estadoCopia = "no he tocado tu copia";
    if (hechos.length) {
      // Algo ya está publicado: lo que falta se rehace sobre la versión nueva del servidor.
      traerServidor();
      const previo = fallo.i === 0 ? base : commits[fallo.i - 1].commit;
      const r = rebasar(previo);
      estadoCopia = r.bien
        ? `tu copia ya parte de lo publicado y conserva sin publicar ${contarEntre(SERVIDOR, "HEAD")} commits`
        : `tu copia queda como estaba; haz memoria actualizar y resuelve a mano (${r.detalle})`;
    }
    const pista = commits.length > 1 && !op.aplanar ? "\nSi un commit posterior arregla el problema, memoria publicar --aplanar publica el resultado final en vez de commit a commit." : "";
    throw new Fallo(
      `publicadas ${hechos.length} de ${commits.reduce((n, c) => n + c.cambios.length, 0)} operaciones. Falló ${VERBOS[fallo.cambio.estado]} ${fallo.cambio.ruta} ` +
        `(commit ${corto(fallo.commit.commit)} «${enUnaLinea(fallo.commit.razon, 60)}»): ${fallo.texto}.\n${estadoCopia}${pista}`, 1
    );
  }

  // Todo publicado: la copia pasa a ser la versión del servidor (que es la que tiene ahora las firmas), y los commits
  // locales quedan guardados en refs/memoria/publicado por si hiciera falta mirarlos.
  git(["update-ref", "refs/memoria/publicado", cabeza]);
  traerServidor();
  git(["reset", "--hard", "--quiet", SERVIDOR]);
  if (op.json) {
    imprimirJson({ publicado: true, commits: commits.length, operaciones: hechos });
    return 0;
  }
  console.log(`publicado: ${commits.length} commits, ${hechos.length} notas en el servidor, firmadas por ti`);
  for (const h of hechos) console.log(`  ${h.operacion} ${h.de ? `${h.de} → ` : ""}${h.ruta} — ${enUnaLinea(h.razon, 80)}`);
  console.log("tu copia queda igual que el servidor (tus commits locales siguen en refs/memoria/publicado)");
  return 0;
}

// --- entrada --------------------------------------------------------------------

const OPCIONES = {
  buscar: { carpeta: "valor", limite: "entero", archivo: "bool", regex: "bool", json: "bool" },
  leer: { seccion: "valor" },
  lista: { json: "bool" },
  recientes: { json: "bool" },
  copia: {},
  estado: { json: "bool" },
  actualizar: {},
  publicar: { razon: "valor", simular: "bool", confirmar_nueva: "bool", aplanar: "bool", json: "bool" },
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
    case "copia": return copiar(pos);
    case "estado": return estado(pos, op);
    case "actualizar": return actualizar(pos);
    case "publicar": return publicar(pos, op);
    case "crear": return crear(pos, op);
    case "editar": return editar(pos, op);
  }
  return 2;
}

await ejecutarCli("memoria", principal);
