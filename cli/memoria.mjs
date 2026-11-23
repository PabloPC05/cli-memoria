#!/usr/bin/env node
// memoria: notas Markdown en un repositorio git como comandos de terminal.
//
// - Leer (buscar, leer, lista, recientes): directamente en una copia local de solo lectura del repositorio (MEMORIA_DIR).
//   Con rg y git, sin pasar por MCP: filtra con rg, jq o head. `buscar --en <nota>` busca dentro de una sola nota;
//   cada nota de los resultados lleva su description y la fecha de su último cambio (del historial de git, en una sola
//   pasada de git log).
// - Sin MEMORIA_DIR (acceso remoto): las mismas lecturas por la pasarela (memoria_search, read, list, recent).
// - Escribir una nota: `crear`, `editar`, `escribir`, `mover` y `borrar --si`, cada uno una herramienta del servidor por
//   la pasarela. El servidor es el único que escribe en el repositorio real: firma con la clave del agente y aplica sus reglas.
// - Cambios de varias notas a la vez, en nativo (fase 4): una copia de trabajo (`memoria copia`, un git clone del
//   repositorio de solo lectura) que se edita con las herramientas de siempre y se commitea con git; `memoria publicar`
//   lleva esos commits al servidor nota a nota (create, write, move, delete), con el hash de cada nota para no pisar
//   cambios ajenos.
//
// Uso: memoria --help. Sin dependencias (sus módulos van en cli/lib/). Ver cli/README.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Fallo, analizar, conServidor, correr, ejecutarCli, enUnaLinea, esAyuda, fechaCorta, imprimirJson, nombreHerramienta, plano, resolverOrden, simular, textoDe, usar, usarOFallar
} from "./lib/nativa.mjs";
import { VENTANA_CARACTERES, VENTANA_LINEAS, miles, paginaDe, rangoDe, trozoDeListado } from "./lib/paginas.mjs";

const VERSION = "2.3.0";
/** Una nota de más caracteres que esto es «larga»: `memoria leer` da su índice de secciones en vez de ella entera. */
const NOTA_LARGA = 4000;
const MEMORIA_DIR = (process.env.MEMORIA_DIR ?? "").trim();
const LOCAL = MEMORIA_DIR !== "" && existsSync(MEMORIA_DIR);
const COPIA = (process.env.MEMORIA_COPIA ?? "").trim() || join(process.env.HOME ?? "", "memoria");
const SERVIDOR = "refs/memoria/servidor";

const AYUDA = `memoria: notas Markdown en git como comandos (versión ${VERSION}).

Lectura (${LOCAL ? `local, en ${MEMORIA_DIR}` : "por la pasarela: no hay MEMORIA_DIR"}):
  memoria buscar <texto…> [--carpeta X | --en <nota>] [--limite N] [--pagina N] [--archivo] [--regex] [--json]
      Una línea por resultado: ruta:línea · sección · fragmento (la sección sirve para ir luego con leer --seccion) y,
      bajo el primer resultado de cada nota, «↳ (cambiada el AAAA-MM-DD) su description». Varias palabras: todas en la
      misma línea, sin acentos ni mayúsculas (si ninguna línea las tiene todas, por palabras sueltas). Un texto entre
      comillas con espacios es una frase. --archivo incluye archive/. Acaba con el total («12 resultados; mostrando
      1-5: --pagina 2»): --limite da los de cada página (20 por defecto).
      --en <nota>: solo dentro de esa nota (nombre o ruta), cada línea que coincide con su número y su sección: así se
      mira dentro de una nota sin leerla entera, y luego se lee lo que haga falta con leer --lineas A-B o --seccion S.
  memoria leer <nombre|ruta> [--seccion X | --lineas A-B] [--pagina N] [--todo]
      Una nota corta (hasta ~${miles(NOTA_LARGA)} caracteres) sale entera, con su frontmatter. Una larga da su cabecera (nombre,
      descripción, hash), el índice de sus secciones (línea de inicio y caracteres de cada una) y cómo seguir.
      --seccion X: esa sección con sus subsecciones, por el texto de su encabezado sin mayúsculas ni acentos y con
      un prefijo basta si es único (si no, lista las que encajan; «A > B» baja por subsecciones).
      --lineas A-B: esas líneas (de 1, las del índice). --todo: la nota entera, sin ventanas. Una ruta que no existe vale
      si su nombre es el de una sola nota: se lee esa y se dice dónde está (también en buscar --en).
      Lo que pasa de ~${VENTANA_LINEAS} líneas o ~${miles(VENTANA_CARACTERES)} caracteres sale por páginas: la primera, y el aviso
      «(página 1 de 3: --pagina 2)»; repite la misma orden con --pagina N. Sin --seccion ni --lineas, --pagina lee la nota
      seguida, de página en página.
  memoria lista [carpeta] [--limite N] [--pagina N] [--json]
      Sin carpeta, las carpetas con su número de notas. Con carpeta, cada nota con su description y el total (50 por página).
  memoria recientes [N] [--json]
      Los últimos N cambios (15 por defecto): cuándo, quién, para qué y las notas que tocó.
${LOCAL ? `  Las notas en bruto están en $MEMORIA_DIR (${MEMORIA_DIR}, solo lectura), para rg -n <texto> "$MEMORIA_DIR" si hace falta.\n` : ""}
Escribir una nota, con esta misma CLI (la escribe el servidor, firmada por tu agente y con las reglas de la memoria;
también sin MEMORIA_DIR). --razon es el mensaje del cambio; --simular enseña la llamada sin hacerla:
  memoria crear <ruta> --razon <texto> (--archivo <f> | -) [--confirmar-nueva]
      Nota nueva con su frontmatter (name, description), desde un archivo o stdin. Si se parece a otra, falla y te la enseña.
  memoria editar <nota> --razon <texto> --viejo <texto> --nuevo <texto> [--todas] [--hash H]
  memoria editar <nota> --razon <texto> --ediciones <f.json>   (una lista de {old_string, new_string, replace_all})
      Reemplazo exacto: --viejo tiene que aparecer una sola vez (o --todas).
  memoria escribir <nota> --razon <texto> (--archivo <f> | -) [--hash H]    La nota existente entera, reemplazada (sin --hash, el de ahora).
  memoria mover <nota> <destino> --razon <texto> [--hash H]                Mueve o renombra (los [[enlaces]] se reescriben); a archive/ la retira.
  memoria borrar <nota> --razon <texto> --si [--hash H]                    Borra (queda en el historial; falla mientras otras notas la enlacen).
      Sin --si no borra: solo si el usuario lo pidió.
  memoria adjuntar <ruta> --archivo <f> --descripcion <texto> --razon <texto> [--titulo T] [--nombre N] [--alias A] [--confirmar-nueva]
      Guarda un binario (PDF, imagen…) y crea al lado su nota con el texto. Hasta 6 MB.
  memoria revertir <commit> --razon <texto> [--nota X]                     Deshace un cambio de historial o recientes con otro.

Cambios de varias notas a la vez (copia de trabajo + git; requiere MEMORIA_DIR):
  memoria copia
      Crea tu copia de trabajo (un git clone de las notas) en ${COPIA} (cámbialo con MEMORIA_COPIA) y dice dónde está.
      Edítala con tus herramientas y haz git add / git commit (el asunto del commit es la razón del cambio).
  memoria estado [--json]
      Qué tienes sin commitear, qué commits faltan por publicar y si el servidor tiene cambios nuevos (y si chocan).
  memoria publicar [--razon <texto>] [--simular] [--confirmar-nueva] [--aplanar] [--json]
      Lleva tus commits al servidor, firmados por ti: nota nueva, cambio, movimiento o borrado, cada uno con el hash de la
      nota que viste, así que no pisa lo que otro cambió (si choca, para y te lo explica). Si el servidor tiene publish, va
      todo en un solo envío (un commit suyo por cada uno tuyo; si algo falla, no se guarda nada); si no, nota a nota. Antes
      comprueba las reglas de la memoria. Con --razon hace antes un commit con todo lo pendiente. --simular no envía nada: lo enseña.
      --aplanar publica el resultado final de todos los commits (no uno a uno) con la razón hecha de sus asuntos: sirve si un
      commit intermedio no se puede publicar y otro posterior lo arregla.
      Al acabar, tu copia queda igual que el servidor. Solo notas .md: los adjuntos van con memoria adjuntar.
  memoria actualizar
      Trae los cambios nuevos del servidor a tu copia (rebase de tus commits sin publicar; si choca, lo deja como estaba).

Lo demás del servidor de la memoria (cada comando llama a la herramienta correspondiente):
  memoria historial <nota> [--limite N] [--json]
      Los commits que tocaron la nota, del más nuevo al más viejo: cuándo, quién, con qué herramienta y para qué.
  memoria enlaces <nota> [--entrantes | --salientes] [--relacion R] [--json]
      Los [[enlaces]] que salen de la nota (con los rotos marcados) y los que llegan a ella, con la línea que los contiene.
  memoria revisar [--tipos a,b] [--carpeta X] [--limite N] [--json]
      Candidatos de mantenimiento (huérfanas, enlaces rotos, duplicadas, viejas…), de peor a menos malo. Solo candidatos: lee antes de escribir.

Variables:
  MEMORIA_DIR                  Carpeta local del repositorio (solo lectura; si falta, también las lecturas van al servidor).
  MEMORIA_COPIA                Carpeta de la copia de trabajo de memoria copia (por defecto ~/memoria).
  MEMORIA_URL / MEMORIA_TOKEN  Conexión directa al endpoint /mcp del servidor cli-memoria (recomendado).
  BADULAQUE_URL / BADULAQUE_CLAVE  Alternativa a través de una pasarela MCP compatible.
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

/** Las notas que se llaman `ref` (sin acentos ni mayúsculas): { una (la única, prefiriendo las de fuera de archive/), iguales, notas }. */
function notasLlamadas(ref) {
  const buscado = plano(ref);
  const notas = todasLasNotas();
  const nombre = r => plano(r.split("/").pop().replace(/\.md$/, ""));
  const iguales = notas.filter(r => nombre(r) === buscado);
  const candidatas = iguales.filter(r => !r.startsWith("archive/"));
  const una = candidatas.length === 1 ? candidatas[0] : iguales.length === 1 ? iguales[0] : null;
  return { una, iguales, notas, nombre, buscado };
}

/** Resuelve «nombre», «[[nombre]]» o una ruta a la ruta relativa de una nota. */
function resolverNota(referencia) {
  let ref = referencia.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
  if (ref === "") throw new Fallo("dime qué nota: un nombre o una ruta", 2);
  if (ref.includes("/") || ref.endsWith(".md")) {
    const { absoluta, relativa } = dentro(ref.endsWith(".md") ? ref : `${ref}.md`);
    if (existsSync(absoluta) && statSync(absoluta).isFile()) return relativa;
    // Una ruta que no existe, pero cuyo nombre es el de una sola nota: es esa (los agentes adivinan la carpeta). Se dice dónde está.
    const nombre = relativa.split(sep).pop().replace(/\.md$/, "");
    const { una } = nombre ? notasLlamadas(nombre) : { una: null };
    if (una) {
      process.stderr.write(`memoria: ${relativa} no existe; la nota «${nombre}» está en ${una}\n`);
      return una;
    }
    throw new Fallo(`no existe la nota ${relativa}`, 2);
  }
  const { una, iguales, notas, nombre, buscado } = notasLlamadas(ref);
  if (una) return una;
  if (iguales.length > 1) {
    throw new Fallo(`«${ref}» es ambigua; usa la ruta:\n${iguales.map(r => `  ${r}`).join("\n")}`, 2);
  }
  const parecidas = notas.filter(r => nombre(r).includes(buscado)).slice(0, 8);
  throw new Fallo(
    `no hay ninguna nota llamada «${ref}».${parecidas.length ? ` ¿Alguna de estas?\n${parecidas.map(r => `  ${r}`).join("\n")}` : ""}`,
    2
  );
}

/** Dónde acaba el frontmatter: el índice (desde 0) de la primera línea que ya no es suyo (0 si no hay). */
function finDeCabecera(lineas) {
  if (lineas[0]?.trim() !== "---") return 0;
  const fin = lineas.indexOf("---", 1);
  return fin === -1 ? 0 : fin + 1;
}

/** Los encabezados de una nota fuera de los bloques de código: { nivel, texto, linea } (línea desde 0). */
function encabezados(lineas) {
  const lista = [];
  let cerca = null;
  const inicio = finDeCabecera(lineas);
  lineas.forEach((l, i) => {
    if (i < inicio) return;
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

/**
 * Las secciones de una nota: cada encabezado con { nivel, texto, linea (desde 0), fin (exclusivo, desde 0), cadena }.
 * Una sección llega hasta el siguiente encabezado del mismo nivel o superior, así que incluye sus subsecciones.
 * `cadena` es el camino desde el encabezado de nivel más alto («Pendiente › Cola»).
 */
function secciones(lineas) {
  const lista = encabezados(lineas);
  const pila = [];
  return lista.map(h => {
    while (pila.length && pila[pila.length - 1].nivel >= h.nivel) pila.pop();
    pila.push(h);
    const siguiente = lista.find(o => o.linea > h.linea && o.nivel <= h.nivel);
    return { ...h, fin: siguiente ? siguiente.linea : lineas.length, cadena: pila.map(x => x.texto) };
  });
}

const rotulo = h => `${"#".repeat(h.nivel)} ${h.texto}`;

/** El camino de una sección sin el título de la nota (su encabezado de nivel 1) si hay otros debajo: es lo que sirve para ir a ella. */
const camino = (h, lista) => (h.cadena.length > 1 && lista[0]?.nivel === 1 ? h.cadena.slice(1) : h.cadena).join(" › ");

/** La sección que pide `pedida`: igual al encabezado, o con un prefijo único (sin mayúsculas ni acentos). */
function buscarSeccion(lista, pedida) {
  const limpio = t => plano(t.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim());
  const quiere = limpio(pedida);
  if (!quiere) throw new Fallo("--seccion necesita el texto de un encabezado", 2);
  const pasos = quiere.split(/\s*[>›]\s*/).filter(Boolean);
  // «A > B»: cada paso es el comienzo del encabezado de ese nivel de la cadena (los últimos pasos con los últimos niveles).
  const encaja = (h, exacto) => {
    if (pasos.length > h.cadena.length) return false;
    const cola = h.cadena.slice(h.cadena.length - pasos.length).map(limpio);
    return pasos.every((p, i) => (exacto ? cola[i] === p : cola[i].startsWith(p)));
  };
  const exactos = lista.filter(h => encaja(h, true));
  const candidatos = exactos.length ? exactos : lista.filter(h => encaja(h, false));
  if (candidatos.length === 1) return candidatos[0];
  const muestra = hs => hs.slice(0, 20).map(h => `  línea ${h.linea + 1} · ${"#".repeat(h.nivel)} ${camino(h, lista)}`).join("\n") + (hs.length > 20 ? `\n  … y ${hs.length - 20} más` : "");
  if (!candidatos.length) {
    throw new Fallo(`no hay ninguna sección «${pedida}». Hay:\n${muestra(lista)}\nLas ves con su tamaño con: memoria leer <nota>`, 2);
  }
  throw new Fallo(`«${pedida}» encaja con ${candidatos.length} secciones; di cuál (más texto, «Padre > Hija» o --lineas A-B):\n${muestra(candidatos)}`, 2);
}

/** Dónde está la línea `linea` (desde 0) de una nota: «cabecera», «inicio» o la cadena de encabezados que la contiene. */
function seccionDeLinea(lineas, lista, linea) {
  if (linea < finDeCabecera(lineas)) return "cabecera";
  let mejor = null;
  for (const h of lista) if (h.linea <= linea && linea < h.fin && (!mejor || h.nivel > mejor.nivel)) mejor = h;
  if (!mejor) return "inicio";
  return enUnaLinea(camino(mejor, lista), 70);
}

// git para leer el repositorio de las notas: safe.directory, porque es de otro usuario (cli-memoria) y git, si no, se niega a
// leerlo; sin configuración global ni del sistema (dentro de srt, ~/.gitconfig es un /dev/null que git no puede abrir y
// falla entero); y sin bloqueos opcionales, porque es de solo lectura.
const ENTORNO_LECTURA = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };

/** git sobre el repositorio de las notas, para leer; null si git no está o falla. */
function gitLectura(args) {
  try {
    const r = correr("git", ["-c", "safe.directory=*", "-c", "core.quotePath=false", "-C", MEMORIA_DIR, ...args], { env: ENTORNO_LECTURA });
    return r.estado === 0 ? r.salida : null;
  } catch {
    return null;
  }
}

/** El commit de HEAD del repositorio de las notas, leyendo .git sin lanzar git (es lo que se mira en cada orden); null si no se sabe. */
function cabezaDelRepo() {
  try {
    const dir = join(MEMORIA_DIR, ".git");
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").includes("..")) return null;
    if (existsSync(join(dir, ref))) return readFileSync(join(dir, ref), "utf8").trim() || null;
    const empaquetada = readFileSync(join(dir, "packed-refs"), "utf8").split("\n").find(l => l.endsWith(` ${ref}`));
    return empaquetada ? empaquetada.split(" ")[0] : null;
  } catch {
    return null;
  }
}

/** Las fechas de una salida de git log --format=%x1e%as --name-only (del más nuevo al más viejo): la primera de cada ruta. */
function leerFechas(salida, fechas, pisar) {
  const vistas = new Set();
  for (const bloque of salida.split("\x1e")) {
    const [fecha, ...rutas] = bloque.split("\n");
    for (const ruta of rutas) {
      if (!ruta || vistas.has(ruta)) continue;
      vistas.add(ruta);
      if (pisar || !fechas.has(ruta)) fechas.set(ruta, fecha.trim());
    }
  }
}

const CACHE_FECHAS = join(process.env.HOME ?? "", ".cache", "memoria", "fechas.json");
let fechas = null;
/**
 * La fecha (AAAA-MM-DD) del último cambio de cada archivo del repositorio de las notas, según su historial: una sola
 * pasada de git log para todas (unos 30 ms con 2.200 commits; lo mismo que hace el servidor al indexar, sin seguir
 * renombrados). Se guarda en ~/.cache/memoria/fechas.json con el HEAD del que sale: mientras HEAD no cambie, no se lanza
 * git; si avanza, solo se leen los commits nuevos. Se calcula una vez por orden y solo si hay algo que enseñar. Sin git o
 * sin historial, un Map vacío: los resultados salen sin fecha.
 */
function fechasDeNotas() {
  if (fechas) return fechas;
  fechas = new Map();
  const cabeza = cabezaDelRepo();
  let guardada = null;
  try {
    guardada = JSON.parse(readFileSync(CACHE_FECHAS, "utf8"));
  } catch {
    /* sin caché: se calcula */
  }
  const valida = cabeza && guardada?.dir === MEMORIA_DIR && typeof guardada.cabeza === "string" && guardada.fechas && typeof guardada.fechas === "object";
  if (valida && guardada.cabeza === cabeza) {
    fechas = new Map(Object.entries(guardada.fechas));
    return fechas;
  }
  // HEAD avanzó desde la caché (la historia no se reescribió): solo los commits nuevos, que pisan las fechas viejas.
  if (valida && gitLectura(["merge-base", "--is-ancestor", guardada.cabeza, cabeza]) !== null) {
    const nuevas = gitLectura(["log", "--no-renames", "--format=%x1e%as", "--name-only", `${guardada.cabeza}..${cabeza}`]);
    if (nuevas !== null) {
      fechas = new Map(Object.entries(guardada.fechas));
      leerFechas(nuevas, fechas, true);
    }
  }
  if (!fechas.size) {
    const todas = gitLectura(["log", "--no-renames", "--format=%x1e%as", "--name-only", cabeza ?? "HEAD"]);
    if (todas === null) return fechas;
    leerFechas(todas, fechas, false);
  }
  // La caché es una comodidad: si no se puede escribir (HOME de solo lectura…), no pasa nada.
  if (cabeza && fechas.size) {
    try {
      mkdirSync(dirname(CACHE_FECHAS), { recursive: true });
      const temporal = `${CACHE_FECHAS}.${process.pid}`;
      writeFileSync(temporal, JSON.stringify({ dir: MEMORIA_DIR, cabeza, fechas: Object.fromEntries(fechas) }));
      renameSync(temporal, CACHE_FECHAS);
    } catch {
      /* sin caché */
    }
  }
  return fechas;
}

/** La línea `↳` de una nota en los resultados: «(cambiada el AAAA-MM-DD) su description», o lo que haya de las dos. */
function resumenDeNota(cambiada, descripcion) {
  return [cambiada ? `(cambiada el ${cambiada})` : "", descripcion].filter(Boolean).join(" ");
}

/** El hash de una nota: el blob de git, el mismo `hash` que usa el servidor de la memoria. */
function hashDeNota(contenido) {
  const cuerpo = Buffer.from(contenido, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${cuerpo.length}\0`), cuerpo])).digest("hex");
}

/**
 * Lo que `memoria leer` saca de una nota, local o por el Badulaque:
 * corta → entera; larga → cabecera + índice de secciones + aviso; con --seccion, --lineas o --pagina, ese trozo en ventanas.
 */
function mostrarNota({ ruta, contenido, hash, cambiada }, op) {
  if (op.seccion !== undefined && op.lineas !== undefined) throw new Fallo("--seccion y --lineas no se combinan: elige una", 2);
  if (op.todo && op.pagina !== undefined) throw new Fallo("--todo y --pagina no se combinan: --todo da la nota entera sin ventanas", 2);
  const lineas = contenido.replace(/\n$/, "").split("\n");
  const total = lineas.length;
  const lista = secciones(lineas);
  const sale = (texto, pie) => {
    process.stdout.write(texto.endsWith("\n") ? texto : `${texto}\n`);
    if (pie) console.log(pie);
  };
  let trozo = lineas;
  let primera = 1;
  let que = "";
  if (op.seccion !== undefined) {
    const h = buscarSeccion(lista, op.seccion);
    trozo = lineas.slice(h.linea, h.fin);
    primera = h.linea + 1;
    que = `sección «${camino(h, lista)}», `;
  } else if (op.lineas !== undefined) {
    const { desde, hasta } = rangoDe(op.lineas, total);
    trozo = lineas.slice(desde - 1, hasta);
    primera = desde;
  } else if (op.pagina === undefined && !op.todo) {
    if (contenido.length <= NOTA_LARGA) {
      sale(contenido);
      return 0;
    }
    return indiceDeNota({ ruta, contenido, hash, cambiada }, lineas, lista, sale);
  }
  if (op.todo) {
    // Sin ventanas, pero diciendo dónde está lo que se ve.
    sale(trozo.join("\n"), op.seccion !== undefined || op.lineas !== undefined ? `(${que}líneas ${primera}-${primera + trozo.length - 1} de ${total})` : "");
    return 0;
  }
  const { texto, pie } = paginaDe(trozo, { primeraLinea: primera, lineasTotales: total, n: op.pagina ?? 1 });
  sale(texto, que ? pie.replace("(", `(${que}`) : pie);
  return 0;
}

/** El índice de una nota larga: cabecera, secciones (línea, caracteres, título) y cómo seguir. `cambiada`, si la hay, da la fecha de su último cambio. */
function indiceDeNota({ ruta, contenido, hash, cambiada }, lineas, lista, sale) {
  const f = frontmatter(contenido);
  const salida = [];
  salida.push(`${ruta}${f.name ? ` · ${f.name}` : ""}`);
  if (f.description) salida.push(`descripción: ${enUnaLinea(f.description, 200)}`);
  const fecha = cambiada?.();
  salida.push(`hash: ${hash ?? hashDeNota(contenido)}${fecha ? ` · cambiada el ${fecha}` : ""} · ${lineas.length} líneas · ${miles(contenido.length)} caracteres`);
  if (lista.length) {
    // Un índice enorme tampoco sirve: si hay muchos encabezados, solo los niveles de arriba (y lo dice).
    const nivelMin = Math.min(...lista.map(h => h.nivel));
    let hasta = 6;
    while (hasta > nivelMin && lista.filter(h => h.nivel <= hasta).length > 60) hasta--;
    const vistas = lista.filter(h => h.nivel <= hasta);
    salida.push("secciones (línea · caracteres con sus subsecciones · título):");
    for (const h of vistas) {
      const caracteres = lineas.slice(h.linea, h.fin).join("\n").length + 1;
      salida.push(`${"  ".repeat(h.nivel - nivelMin)}${h.linea + 1} · ${miles(caracteres)} · ${rotulo(h)}`);
    }
    if (vistas.length < lista.length) {
      salida.push(`(${lista.length - vistas.length} encabezados más profundos sin listar: --seccion '<título>' y su índice de subsecciones sale al leerla)`);
    }
  } else {
    salida.push("sin encabezados: léela por rangos con --lineas A-B");
  }
  salida.push(`nota larga: lee una sección con --seccion '<título>' o un rango con --lineas A-B (o --pagina N / --todo: ${miles(contenido.length)} caracteres)`);
  sale(salida.join("\n"));
  return 0;
}

// --- patrón de búsqueda sin acentos ------------------------------------------

const CLASES = { a: "aáàäâã", e: "eéèëê", i: "iíìïî", o: "oóòöôõ", u: "uúùüû", n: "nñ", c: "cç" };

/** Un texto literal como regex que ignora acentos (las mayúsculas las ignora rg con -i). */
function regexSinAcentos(texto) {
  const escapado = plano(texto).replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  return escapado.replace(/[aeiounc]/g, c => `[${CLASES[c]}]`);
}

/** Lo mismo para una RegExp de JavaScript con la bandera u, que no admite escapar «-» fuera de una clase. */
function regexSinAcentosJs(texto) {
  const escapado = plano(texto).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  return escapado.replace(/[aeiounc]/g, c => `[${CLASES[c]}]`);
}

/**
 * El patrón de una línea en JavaScript, el mismo que buscar le da a rg: sin acentos ni mayúsculas, un término de 3 letras
 * o menos solo entero y, con varios términos, todos en la misma línea en cualquier orden. Con --regex, la expresión tal cual.
 */
function patronDeLinea(terminos, op) {
  if (op.regex) {
    try {
      return new RegExp(terminos.join(" "), "iu");
    } catch (e) {
      throw new Fallo(`--regex: la expresión no vale (${e.message})`, 2);
    }
  }
  const parte = t => plano(t).length <= 3 ? `(?<![\\p{L}\\p{N}])${regexSinAcentosJs(t)}(?![\\p{L}\\p{N}])` : regexSinAcentosJs(t);
  return new RegExp(terminos.length === 1 ? parte(terminos[0]) : `^${terminos.map(t => `(?=.*${parte(t)})`).join("")}`, "iu");
}

/** El trozo de una línea que se enseña: entera si es corta; si es larga, desde un poco antes del primer término. */
function fragmentoDe(texto, primero, op) {
  const i = op.regex || texto.trim().length <= 160 ? 0 : Math.max(0, plano(texto).indexOf(primero) - 40);
  return enUnaLinea(texto.slice(i), 160);
}

// --- comandos de lectura locales ----------------------------------------------

const USO_LEER = "uso: memoria leer <nombre|ruta> [--seccion X | --lineas A-B] [--pagina N] [--todo]";

// Palabras que no sirven para buscar (una frase como «correo de la universidad» se busca por «correo» y «universidad»).
const PALABRAS_VACIAS = new Set(["de", "del", "la", "las", "el", "los", "un", "una", "unos", "unas", "y", "o", "en", "con", "por", "para", "que", "mi", "mis", "tu", "tus", "su", "sus", "a", "al", "lo", "se", "es", "me", "te"]);

/** Las palabras de una frase para buscarlas por separado: sin acentos, sin signos, sin palabras vacías y sin repetir. */
function palabrasDe(terminos) {
  const todas = plano(terminos.join(" ")).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const utiles = todas.filter(w => w.length > 1 && !PALABRAS_VACIAS.has(w));
  return [...new Set(utiles.length ? utiles : todas)];
}

/** ¿Está la palabra en el texto (ya sin acentos ni mayúsculas)? Las de 3 letras o menos, solo enteras: «usa» no es «causa». */
const tienePalabra = (texto, w) => {
  if (w.length > 3) return texto.includes(w);
  let i = texto.indexOf(w);
  while (i !== -1) {
    if (!/[a-z0-9]/.test(texto[i - 1] ?? " ") && !/[a-z0-9]/.test(texto[i + w.length] ?? " ")) return true;
    i = texto.indexOf(w, i + 1);
  }
  return false;
};

/**
 * Búsqueda por palabras sueltas, para cuando la frase exacta no da nada: cada nota puntúa por palabra según dónde la tiene (nombre 8,
 * descripción 5, títulos 3, cuerpo 1) y salen primero las que las tienen todas. Una línea por nota, con su `description` debajo.
 */
function buscarPorPalabras(palabras, op) {
  const notas = [];
  for (const ruta of todasLasNotas(op.carpeta ? op.carpeta.replace(/\/+$/, "") : "")) {
    if (!op.archivo && ruta.startsWith("archive/")) continue;
    let texto;
    try {
      texto = readFileSync(resolve(MEMORIA_DIR, ruta), "utf8");
    } catch {
      continue;
    }
    const lineas = texto.replace(/\n$/, "").split("\n");
    const lista = secciones(lineas);
    const f = frontmatter(texto);
    const nombre = plano(ruta.replace(/\.md$/, ""));
    const descripcion = plano(f.description ?? "");
    const titulos = plano(lista.map(h => h.texto).join("\n"));
    const planas = lineas.map(plano);
    let puntos = 0;
    let con = 0;
    for (const w of palabras) {
      const peso = tienePalabra(nombre, w) ? 8 : tienePalabra(descripcion, w) ? 5 : tienePalabra(titulos, w) ? 3 : planas.some(l => tienePalabra(l, w)) ? 1 : 0;
      if (peso) {
        con++;
        puntos += peso;
      }
    }
    if (con) notas.push({ ruta, lineas, lista, descripcion: f.description ?? "", planas, puntos, con });
  }
  const mejor = Math.max(0, ...notas.map(n => n.con));
  const minimo = mejor === palabras.length ? palabras.length : Math.max(1, Math.ceil(palabras.length / 2));
  const vistas = notas.filter(n => n.con >= minimo).sort((a, b) => b.con - a.con || b.puntos - a.puntos || a.ruta.localeCompare(b.ruta));
  return { vistas, todas: vistas.filter(n => n.con === palabras.length).length };
}

/**
 * `buscar --en <nota>`: las líneas de esa nota que coinciden, cada una con su número y su sección, y el total, con la misma
 * salida que buscar. Si la frase no está y son varias palabras, las líneas con más de ellas primero. Vale en local y por el
 * Badulaque: recibe la nota ya leída. `cambiada` es una función (la fecha solo se busca si hay algo que enseñar).
 */
function buscarEnNota({ ruta, contenido, descripcion, cambiada }, terminos, op) {
  const lineas = contenido.replace(/\n$/, "").split("\n");
  const patron = patronDeLinea(terminos, op);
  let aciertos = [];
  lineas.forEach((texto, i) => {
    if (patron.test(texto)) aciertos.push({ i, texto });
  });
  let sueltas = null;
  if (!aciertos.length && !op.regex) {
    const palabras = palabrasDe(terminos);
    if (palabras.length >= 2) {
      const contadas = [];
      lineas.forEach((texto, i) => {
        const plana = plano(texto);
        const n = palabras.filter(w => tienePalabra(plana, w)).length;
        if (n) contadas.push({ i, texto, n });
      });
      const mejor = Math.max(0, ...contadas.map(l => l.n));
      const minimo = mejor === palabras.length ? palabras.length : Math.max(1, Math.ceil(palabras.length / 2));
      aciertos = contadas.filter(l => l.n >= minimo).sort((a, b) => b.n - a.n || a.i - b.i);
      sueltas = { palabras, todas: contadas.filter(l => l.n === palabras.length).length };
    }
  }
  const { desde, hasta, pie } = trozoDeListado(aciertos.length, op.limite ?? 20, op.pagina ?? 1);
  const lista = secciones(lineas);
  const primero = plano(terminos[0]);
  const vistos = aciertos.slice(desde, hasta);
  const fecha = vistos.length ? cambiada() : null;
  const desc = enUnaLinea(descripcion ?? "", 110);
  const filas = vistos.map(a => ({ ruta, linea: a.i + 1, seccion: seccionDeLinea(lineas, lista, a.i), texto: fragmentoDe(a.texto, primero, op), descripcion: desc, cambiada: fecha }));
  // El pie dice en qué nota: «3 resultados en projects/x.md», o por palabras sueltas, cuántas líneas y cuántas con todas.
  const cuantos = aciertos.length;
  const total = sueltas
    ? cuantos
      ? `${cuantos} ${cuantos === 1 ? "línea" : "líneas"} por palabras sueltas en ${ruta} (${sueltas.todas} con todas: ${sueltas.palabras.join(", ")})`
      : `0 resultados en ${ruta}, ni con las palabras sueltas: ${sueltas.palabras.join(", ")}`
    : `${cuantos} ${cuantos === 1 ? "resultado" : "resultados"} en ${ruta}`;
  const resto = pie.replace(/^\d+ resultados?/, "");
  if (op.json) {
    imprimirJson(filas);
    process.stderr.write(`memoria: ${total}${resto}\n`);
    return 0;
  }
  if (sueltas && cuantos) console.log(`sin «${terminos.join(" ")}» exacto en ${ruta}; por palabras sueltas, primero las líneas con más:`);
  filas.forEach((a, n) => {
    console.log(`${a.ruta}:${a.linea} · ${a.seccion} · ${a.texto}`);
    const resumen = resumenDeNota(a.cambiada, a.descripcion);
    if (n === 0 && resumen) console.log(`  ↳ ${resumen}`);
  });
  console.log(`(${total}${resto})`);
  return 0;
}

/** `--en X`: la nota X (nombre o ruta) o, si X es una carpeta y no una nota, esa carpeta (como en `archivos buscar --en`). */
function notaOCarpeta(en) {
  try {
    return { nota: resolverNota(en) };
  } catch (error) {
    const carpeta = String(en).trim().replace(/\/+$/, "");
    let absoluta = null;
    try {
      absoluta = carpeta ? dentro(carpeta).absoluta : null;
    } catch {
      throw error;
    }
    if (absoluta && existsSync(absoluta) && statSync(absoluta).isDirectory()) return { carpeta };
    throw error;
  }
}

function buscarLocal(pos, opciones) {
  let op = opciones;
  const terminos = pos.map(t => t.trim()).filter(Boolean);
  if (!terminos.length) throw new Fallo("dime qué buscas: memoria buscar <texto…>", 2);
  if (op.en !== undefined) {
    if (op.carpeta) throw new Fallo("--en y --carpeta no se combinan: --en busca dentro de una nota; --carpeta, en una carpeta", 2);
    const destino = notaOCarpeta(op.en);
    if (destino.nota) {
      const contenido = readFileSync(resolve(MEMORIA_DIR, destino.nota), "utf8");
      return buscarEnNota({ ruta: destino.nota, contenido, descripcion: frontmatter(contenido).description, cambiada: () => fechasDeNotas().get(destino.nota) ?? null }, terminos, op);
    }
    op = { ...op, carpeta: destino.carpeta };
  }
  const limite = op.limite ?? 20;
  // --sort path: el orden es siempre el mismo, para que las páginas no se mezclen.
  const rgArgs = ["--no-heading", "--with-filename", "--line-number", "--color", "never", "--no-messages", "--ignore-case", "--sort", "path", "-g", "*.md"];
  if (!op.archivo) rgArgs.push("-g", "!archive/**");
  if (op.regex) {
    rgArgs.push("-e", terminos.join(" "));
  } else {
    // Un término de 3 letras o menos solo cuenta entero («usa» no es «causa» ni «usando»): 483 resultados no sirven a nadie.
    const parte = t => plano(t).length <= 3 ? `(?<![\\p{L}\\p{N}])${regexSinAcentos(t)}(?![\\p{L}\\p{N}])` : regexSinAcentos(t);
    if (terminos.length === 1 && plano(terminos[0]).length > 3) rgArgs.push("-e", regexSinAcentos(terminos[0]));
    else if (terminos.length === 1) rgArgs.push("-P", "-e", parte(terminos[0]));
    // Todas las palabras en la misma línea, en cualquier orden (PCRE2: miradas hacia delante).
    else rgArgs.push("-P", "-e", `^${terminos.map(t => `(?=.*${parte(t)})`).join("")}.*$`);
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
  // Sin nada con la frase exacta: las palabras por separado (si son dos o más), con las notas que las tienen todas primero.
  if (!aciertos.length && !op.regex) {
    const palabras = palabrasDe(terminos);
    if (palabras.length >= 2) return mostrarPorPalabras(palabras, terminos, op, op.limite ?? 10);
  }
  const primero = plano(terminos[0]);
  const { desde, hasta, pie } = trozoDeListado(aciertos.length, limite, op.pagina ?? 1);
  // La sección de cada resultado visible (se lee cada nota una sola vez).
  const notas = new Map();
  const seccionDe = a => {
    if (!notas.has(a.ruta)) {
      const lineas = readFileSync(resolve(MEMORIA_DIR, a.ruta), "utf8").replace(/\n$/, "").split("\n");
      notas.set(a.ruta, { lineas, lista: secciones(lineas) });
    }
    const n = notas.get(a.ruta);
    return seccionDeLinea(n.lineas, n.lista, a.linea - 1);
  };
  // La `description` de cada nota y la fecha de su último cambio, una vez, bajo su primer resultado: dicen de qué va la
  // nota y si está al día sin tener que abrirla.
  const descripciones = new Map();
  const descripcionDe = ruta => {
    if (!descripciones.has(ruta)) descripciones.set(ruta, enUnaLinea(frontmatter(notas.get(ruta).lineas.join("\n")).description ?? "", 110));
    return descripciones.get(ruta);
  };
  const vistos = aciertos.slice(desde, hasta).map(a => ({
    ruta: a.ruta, linea: a.linea, seccion: seccionDe(a), texto: fragmentoDe(a.texto, primero, op), descripcion: descripcionDe(a.ruta),
    cambiada: fechasDeNotas().get(a.ruta) ?? null
  }));
  if (op.json) {
    imprimirJson(vistos);
    process.stderr.write(`memoria: ${pie}\n`);
  } else {
    const dichas = new Set();
    for (const a of vistos) {
      console.log(`${a.ruta}:${a.linea} · ${a.seccion} · ${a.texto}`);
      const resumen = resumenDeNota(a.cambiada, a.descripcion);
      if (resumen && !dichas.has(a.ruta)) console.log(`  ↳ ${resumen}`);
      dichas.add(a.ruta);
    }
    console.log(`(${pie})`);
  }
  return 0;
}

function mostrarPorPalabras(palabras, terminos, op, limite) {
  const { vistas, todas } = buscarPorPalabras(palabras, op);
  const pagina = op.pagina ?? 1;
  if (!vistas.length) {
    if (op.json) imprimirJson([]);
    else console.log(`(0 resultados, ni con las palabras sueltas: ${palabras.join(", ")})`);
    return 0;
  }
  const { desde, hasta, pie } = trozoDeListado(vistas.length, limite, pagina);
  const filas = vistas.slice(desde, hasta).map(n => {
    // La línea con más de las palabras (la primera, si hay empate): ahí se ve por qué sale la nota.
    let mejor = 0;
    let cuenta = -1;
    n.planas.forEach((l, i) => {
      const c = palabras.filter(w => tienePalabra(l, w)).length;
      if (c > cuenta) { cuenta = c; mejor = i; }
    });
    return {
      ruta: n.ruta, linea: mejor + 1, seccion: seccionDeLinea(n.lineas, n.lista, mejor), texto: enUnaLinea(n.lineas[mejor], 160),
      palabras: n.con, descripcion: enUnaLinea(n.descripcion, 110), cambiada: fechasDeNotas().get(n.ruta) ?? null
    };
  });
  const resumen = `${vistas.length} ${vistas.length === 1 ? "nota" : "notas"} por palabras sueltas (${todas} con todas: ${palabras.join(", ")})`;
  if (op.json) {
    imprimirJson(filas);
    process.stderr.write(`memoria: ${resumen}\n`);
    return 0;
  }
  console.log(`sin «${terminos.join(" ")}» exacto; por palabras sueltas, primero las notas con todas:`);
  for (const a of filas) {
    console.log(`${a.ruta}:${a.linea} · ${a.seccion} · ${a.texto}`);
    const resumen = resumenDeNota(a.cambiada, a.descripcion);
    if (resumen) console.log(`  ↳ ${resumen}`);
  }
  console.log(`(${resumen}${pie.includes("mostrando") ? `; ${pie.replace(/^\d+ resultados?; /, "")}` : ""})`);
  return 0;
}

function leerLocal(pos, op) {
  if (pos.length !== 1) throw new Fallo(USO_LEER, 2);
  const ruta = resolverNota(pos[0]);
  return mostrarNota({ ruta, contenido: readFileSync(resolve(MEMORIA_DIR, ruta), "utf8"), cambiada: () => fechasDeNotas().get(ruta) ?? null }, op);
}

function listaLocal(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria lista [carpeta] [--limite N] [--pagina N]", 2);
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
  const fechasNotas = fechasDeNotas();
  const filas = todasLasNotas(carpeta).map(ruta => {
    const texto = readFileSync(resolve(MEMORIA_DIR, ruta), "utf8");
    const f = frontmatter(texto);
    return { ruta, nombre: ruta.split("/").pop().replace(/\.md$/, ""), description: f.description ?? "", actualizada: fechasNotas.get(ruta) ?? statSync(resolve(MEMORIA_DIR, ruta)).mtime.toISOString().slice(0, 10) };
  });
  const { desde, hasta, pie } = trozoDeListado(filas.length, op.limite ?? 50, op.pagina ?? 1);
  if (op.json) {
    imprimirJson(filas.slice(desde, hasta));
    process.stderr.write(`memoria: ${pie.replace("resultados", "notas").replace("resultado", "nota")}\n`);
  } else {
    for (const f of filas.slice(desde, hasta)) console.log(f.description ? `${f.ruta} — ${enUnaLinea(f.description, 140)}` : f.ruta);
    console.log(`(${pie.replace("resultados", "notas").replace("resultado", "nota")})`);
  }
  return 0;
}

function recientesLocal(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria recientes [N]", 2);
  const n = pos.length ? Number(pos[0]) : 15;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Fallo("N tiene que ser un entero entre 1 y 200", 2);
  // safe.directory: el repositorio es de otro usuario (cli-memoria) y git, si no, se niega a leerlo. Sin configuración
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

// --- lectura remota por pasarela (sin MEMORIA_DIR) ------------------------------

/** La fecha (AAAA-MM-DD) de un `updated_at` del servidor, o null si no la da. */
const fechaDelServidor = valor => (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}/.test(valor) ? valor.slice(0, 10) : null);

/** `buscar --en <nota>` sin MEMORIA_DIR: se lee la nota por el Badulaque y se busca en ella aquí, igual que en local. */
async function buscarEnNotaRemota(pos, op) {
  const terminos = pos.map(t => t.trim()).filter(Boolean);
  if (!terminos.length) throw new Fallo("dime qué buscas: memoria buscar <texto…> --en <nota>", 2);
  if (op.carpeta) throw new Fallo("--en y --carpeta no se combinan: --en busca dentro de una nota; --carpeta, en una carpeta", 2);
  // Una carpeta («projects/») vale como --carpeta, como en local.
  if (/\/$/.test(op.en.trim())) return buscarRemoto(pos, { ...op, en: undefined, carpeta: op.en.trim() });
  const r = await conServidor(ctx => usarOFallar(ctx, "read", dondeDe(op.en)));
  const contenido = typeof r.json?.content === "string" ? r.json.content : r.texto;
  const descripcion = frontmatter(contenido).description ?? r.json?.frontmatter?.description;
  return buscarEnNota({ ruta: r.json?.path ?? op.en, contenido, descripcion, cambiada: () => fechaDelServidor(r.json?.updated_at) }, terminos, op);
}

async function buscarRemoto(pos, op) {
  if (op.en !== undefined) return buscarEnNotaRemota(pos, op);
  const consulta = pos.join(" ").trim();
  if (!consulta) throw new Fallo("dime qué buscas: memoria buscar <texto…>", 2);
  const limite = op.limite ?? 20;
  const pagina = op.pagina ?? 1;
  // El servidor no pagina: se piden los de las páginas anteriores y la actual, y se corta aquí.
  const r = await conServidor(ctx => usarOFallar(ctx, "search", {
    query: consulta, limit: limite * pagina,
    ...(op.carpeta ? { folder: op.carpeta.replace(/\/+$/, "") } : {}), ...(op.archivo ? { include_archive: true } : {})
  }));
  const todos = r.json?.hits ?? [];
  const sabido = Number(r.json?.total ?? r.json?.count);
  const total = Number.isFinite(sabido) && sabido >= todos.length ? sabido : todos.length;
  const desde = (pagina - 1) * limite;
  const vistos = todos.slice(desde, desde + limite);
  const titulo = h => h.section?.heading ?? h.section?.title ?? h.section?.name ?? h.section?.path ?? "";
  // Como en local, la description de cada nota y la fecha de su último cambio; la fecha, solo si el servidor la da.
  const filas = vistos.map(h => ({
    ruta: h.path, linea: h.section?.line_start ?? 1, seccion: titulo(h) || "?", texto: enUnaLinea(h.snippet ?? h.description ?? "", 160),
    descripcion: enUnaLinea(h.description ?? "", 110), cambiada: fechaDelServidor(h.updated_at)
  }));
  let pie;
  if (!total) pie = "0 resultados";
  else if (!vistos.length) throw new Fallo(`la página ${pagina} no existe: ${total} resultados, ${limite} por página`, 2);
  else {
    pie = `${total} ${total === 1 ? "resultado" : "resultados"}`;
    if (total > vistos.length) pie += `; mostrando ${desde + 1}-${desde + vistos.length}`;
    if (desde + vistos.length < total) pie += `: --pagina ${pagina + 1} (o --limite N)`;
  }
  if (op.json) {
    imprimirJson(filas);
    process.stderr.write(`memoria: ${pie}\n`);
  } else {
    const dichas = new Set();
    for (const a of filas) {
      console.log(`${a.ruta}:${a.linea} · ${a.seccion} · ${a.texto}`);
      const resumen = resumenDeNota(a.cambiada, a.descripcion);
      if (resumen && !dichas.has(a.ruta)) console.log(`  ↳ ${resumen}`);
      dichas.add(a.ruta);
    }
    console.log(`(${pie})`);
  }
  return 0;
}

async function leerRemoto(pos, op) {
  if (pos.length !== 1) throw new Fallo(USO_LEER, 2);
  const ref = pos[0].replace(/^\[\[|\]\]$/g, "");
  const argumentos = ref.includes("/") || ref.endsWith(".md") ? { path: ref.endsWith(".md") ? ref : `${ref}.md` } : { name: ref };
  // Se pide la nota entera y el recorte (índice, sección, rango, página) se hace aquí, igual que en local.
  const r = await conServidor(ctx => usarOFallar(ctx, "read", argumentos));
  const contenido = typeof r.json?.content === "string" ? r.json.content : r.texto;
  return mostrarNota({ ruta: r.json?.path ?? argumentos.path ?? ref, contenido, hash: typeof r.json?.hash === "string" ? r.json.hash : undefined, cambiada: () => fechaDelServidor(r.json?.updated_at) }, op);
}

async function listaRemota(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria lista [carpeta] [--limite N] [--pagina N]", 2);
  const r = await conServidor(ctx => usarOFallar(ctx, "list", pos.length ? { folder: pos[0].replace(/\/+$/, ""), limit: 200 } : {}));
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
  const { desde, hasta, pie } = trozoDeListado(notas.length, op.limite ?? 50, op.pagina ?? 1);
  for (const n of notas.slice(desde, hasta)) console.log(n.description ? `${n.path} — ${enUnaLinea(n.description, 140)}` : n.path);
  console.log(`(${pie.replace("resultados", "notas").replace("resultado", "nota")})`);
  return 0;
}

async function recientesRemoto(pos, op) {
  if (pos.length > 1) throw new Fallo("uso: memoria recientes [N]", 2);
  const n = pos.length ? Number(pos[0]) : 15;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Fallo("N tiene que ser un entero entre 1 y 200", 2);
  const r = await conServidor(ctx => usarOFallar(ctx, "recent", { limit: n }));
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

// --- escritura: siempre por el servidor ----------------------------------------

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
  if (simular(op, "create", argumentos)) return 0;
  const r = await conServidor(ctx => usarOFallar(ctx, "create", argumentos));
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
  if (simular(op, "edit", argumentos)) return 0;
  const r = await conServidor(ctx => usarOFallar(ctx, "edit", argumentos));
  console.log(r.texto);
  return 0;
}

// --- el resto de las herramientas del servidor -------------------------------------------------------

function dondeDe(texto) {
  const ref = String(texto).replace(/^\[\[|\]\]$/g, "");
  return ref.includes("/") || ref.endsWith(".md") ? { path: ref.endsWith(".md") ? ref : `${ref}.md` } : { name: ref };
}

function exigirRazon(op) {
  if (!op.razon) throw new Fallo("falta --razon: una línea que diga por qué (será el mensaje del commit)", 2);
}

/** El hash actual de una nota (el de `read`), para quien no lo da. */
async function hashActual(ctx, donde) {
  const r = await usarOFallar(ctx, "read", donde);
  if (typeof r.json?.hash !== "string") throw new Fallo("el servidor no dio el hash de la nota", 3);
  return r.json.hash;
}

async function historial(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria historial <nota> [--limite N]", 2);
  const r = await conServidor(ctx => usarOFallar(ctx, "history", { ...dondeDe(pos[0]), limit: op.limite ?? 20 }));
  const commits = r.json?.commits ?? [];
  if (op.json) return imprimirJson(commits);
  for (const c of commits) {
    console.log([String(c.commit ?? "").slice(0, 8), c.date ? fechaCorta(c.date) : "", c.trailers?.Client ?? c.author ?? "-", c.trailers?.Tool ?? "-", enUnaLinea(c.message ?? "", 110)].join(" · "));
  }
  console.log(`(${commits.length} ${commits.length === 1 ? "commit" : "commits"} de ${r.json?.path ?? pos[0]})`);
  return 0;
}

async function enlaces(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria enlaces <nota> [--entrantes | --salientes] [--relacion R]", 2);
  if (op.entrantes && op.salientes) throw new Fallo("--entrantes y --salientes juntos son los dos: quita ambos", 2);
  const direction = op.entrantes ? "in" : op.salientes ? "out" : "both";
  const r = await conServidor(ctx => usarOFallar(ctx, "links", { ...dondeDe(pos[0]), direction, ...(op.relacion ? { relation: op.relacion } : {}) }));
  if (op.json) return imprimirJson(r.json ?? r.texto);
  const sale = r.json?.out ?? [];
  const entra = r.json?.in ?? [];
  if (direction !== "in") {
    for (const e of sale) console.log(`→ ${e.target_path ?? `(roto) ${e.target ?? e.name ?? "?"}`}${e.relation ? ` · ${e.relation}` : ""}${e.line ? ` · línea ${e.line}` : ""}`);
  }
  if (direction !== "out") {
    for (const e of entra) console.log(`← ${e.src_path}:${e.line ?? "?"} · ${enUnaLinea(e.context ?? "", 120)}`);
  }
  const partes = [];
  if (direction !== "in") partes.push(`${sale.length} salientes`);
  if (direction !== "out") partes.push(`${entra.length} entrantes`);
  console.log(`(${partes.join(", ")})`);
  return 0;
}

async function revisar(pos, op) {
  if (pos.length) throw new Fallo("uso: memoria revisar [--tipos a,b] [--carpeta X] [--limite N]", 2);
  const r = await conServidor(ctx => usarOFallar(ctx, "lint", {
    ...(op.tipos?.length ? { kinds: op.tipos } : {}), ...(op.carpeta ? { folder: op.carpeta.replace(/\/+$/, "") } : {}), limit: op.limite ?? 30
  }));
  if (op.json) return imprimirJson(r.json ?? r.texto);
  const items = r.json?.items ?? [];
  for (const i of items) console.log(`${i.kind} · ${(i.notes ?? []).join(", ")}${i.detail ? ` · ${enUnaLinea(JSON.stringify(i.detail), 100)}` : ""}`);
  const cuentas = Object.entries(r.json?.counts ?? {}).map(([k, n]) => `${k} ${n}`).join(", ");
  const total = r.json?.total ?? items.length;
  console.log(`(${total} candidatos${items.length < total ? `; mostrando ${items.length}: --limite N` : ""}${cuentas ? ` · ${cuentas}` : ""})`);
  return 0;
}

async function escribirNota(pos, op) {
  if (pos.length < 1 || pos.length > 2 || (pos[1] !== undefined && pos[1] !== "-")) throw new Fallo("uso: memoria escribir <nota> --razon <texto> (--archivo <f> | -) [--hash H]", 2);
  exigirRazon(op);
  if (op.archivo === undefined && pos[1] !== "-") throw new Fallo("falta el contenido: --archivo <f>, o - para leerlo de la entrada", 2);
  const content = textoDe(pos[1], op.archivo);
  if (!content.trim()) throw new Fallo("el contenido está vacío", 2);
  const donde = dondeDe(pos[0]);
  if (simular(op, "write", { ...donde, content, hash: op.hash ?? "(el de ahora)", reason: op.razon })) return 0;
  const r = await conServidor(async ctx => usarOFallar(ctx, "write", { ...donde, content, hash: op.hash ?? await hashActual(ctx, donde), reason: op.razon }));
  console.log(r.texto);
  return 0;
}

async function moverNota(pos, op) {
  if (pos.length !== 2) throw new Fallo("uso: memoria mover <nota> <destino> --razon <texto> [--hash H]", 2);
  exigirRazon(op);
  const donde = dondeDe(pos[0]);
  const de = donde.path ?? donde.name;
  const a = pos[1].endsWith(".md") ? pos[1] : `${pos[1]}.md`;
  if (simular(op, "move", { from: de, to: a, hash: op.hash ?? "(el de ahora)", reason: op.razon })) return 0;
  const r = await conServidor(async ctx => usarOFallar(ctx, "move", { from: de, to: a, hash: op.hash ?? await hashActual(ctx, donde), reason: op.razon }));
  console.log(r.texto);
  return 0;
}

async function borrarNota(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria borrar <nota> --razon <texto> --si [--hash H]", 2);
  exigirRazon(op);
  const donde = dondeDe(pos[0]);
  if (simular(op, "delete", { ...donde, hash: op.hash ?? "(el de ahora)", reason: op.razon })) return 0;
  // Borrar es destructivo: solo con --si (queda en el historial y memoria revertir lo deshace).
  if (!op.si) throw new Fallo(`esto borra la nota «${pos[0]}» (queda en el historial: memoria revertir lo deshace). Si el usuario lo pidió, repite con --si`, 2);
  const r = await conServidor(async ctx => usarOFallar(ctx, "delete", { ...donde, hash: op.hash ?? await hashActual(ctx, donde), reason: op.razon }));
  console.log(r.texto);
  return 0;
}

async function revertir(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria revertir <commit> --razon <texto> [--nota X]", 2);
  exigirRazon(op);
  const argumentos = { commit: pos[0], reason: op.razon, ...(op.nota ? dondeDe(op.nota) : {}) };
  if (simular(op, "revert", argumentos)) return 0;
  const r = await conServidor(ctx => usarOFallar(ctx, "revert", argumentos));
  console.log(r.texto);
  return 0;
}

const TOPE_ADJUNTO = 6 * 1024 * 1024;

async function adjuntar(pos, op) {
  if (pos.length !== 1) throw new Fallo("uso: memoria adjuntar <ruta> --archivo <f> --descripcion <texto> --razon <texto>", 2);
  exigirRazon(op);
  if (!op.archivo) throw new Fallo("falta --archivo: el binario que se guarda", 2);
  if (!op.descripcion) throw new Fallo("falta --descripcion: una línea que diga qué es", 2);
  let bytes;
  try {
    if (statSync(op.archivo).size > TOPE_ADJUNTO) throw new Fallo(`${op.archivo} pasa de ${TOPE_ADJUNTO / 1048576} MB: por aquí solo caben los pequeños`, 2);
    bytes = readFileSync(op.archivo);
  } catch (e) {
    if (e instanceof Fallo) throw e;
    throw new Fallo(`no pude leer ${op.archivo} (${e.code ?? e.message})`, 2);
  }
  const argumentos = {
    path: pos[0], base64: bytes.toString("base64"), description: op.descripcion, reason: op.razon,
    ...(op.titulo ? { title: op.titulo } : {}), ...(op.nombre ? { name: op.nombre } : {}), ...(op.alias?.length ? { aliases: op.alias } : {}),
    ...(op.confirmar_nueva ? { confirm_new: true } : {})
  };
  if (simular(op, "attach", argumentos)) return 0;
  const r = await conServidor(ctx => usarOFallar(ctx, "attach", argumentos));
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
 * (es de otro usuario, cli-memoria). Si falla y no se pide `permitir`, es un Fallo con lo que dijo git.
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
    throw new Fallo("esto trabaja sobre el repositorio local de notas (MEMORIA_DIR), que aquí no está. Sin él, edita una nota cada vez: memoria crear, editar, escribir, mover o borrar", 2);
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
const HERRAMIENTAS = { A: "create", M: "write", R: "move", D: "delete" };

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
        if (!/\.md$/i.test(ruta)) mal("no es una nota .md (los adjuntos y el resto de archivos no se publican así: memoria adjuntar)");
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

// --- publicar en un solo envío, con `publish` (si el servidor la tiene) ---------------------------------------------------

/** Los cambios que admite un `publish` (el servidor rechaza más; entonces se publica nota a nota). */
const MAX_PUBLISH = 500;

/**
 * ¿Tiene el servidor la herramienta `publish` (varios commits en un solo envío, todo o nada)?
 * En modo directo, mira `tools/list`; en modo pasarela, `buscador_buscar` (`memoria_publish`).
 */
async function tienePublish(ctx) {
  if (ctx.modo === "directo") {
    try {
      const r = await ctx.pasarela.pedir("tools/list", {});
      return Array.isArray(r?.tools) && r.tools.some(t => t?.name === "publish");
    } catch {
      return false;
    }
  }
  let r;
  try {
    r = await ctx.pasarela.llamar("buscador_buscar", { consulta: "memoria_publish", limite: 1 });
  } catch {
    return false;
  }
  if (r?.isError) return false;
  let encontradas = r?.structuredContent?.encontradas;
  if (!Array.isArray(encontradas)) {
    try {
      encontradas = JSON.parse((r?.content ?? []).map(c => c?.text ?? "").join("")).encontradas;
    } catch {
      return false;
    }
  }
  return Array.isArray(encontradas) && encontradas.some(h => h?.nombre === "memoria_publish");
}

/**
 * Los cambios de un commit como los pide `publish`: create, write, move (con un write detrás si además cambió el
 * contenido) y delete, cada uno con el hash de la versión de la que parte: la del commit anterior de la copia, cuyos
 * blobs son los del servidor (choques() ya comprobó que nadie tocó esas notas desde la base).
 */
function cambiosParaPublish(commit, cambios, padre) {
  const lista = [];
  for (const x of cambios) {
    const contenido = () => git(["show", `${commit}:${x.ruta}`]).salida;
    if (x.estado === "A") lista.push({ op: "create", path: x.ruta, content: contenido() });
    else if (x.estado === "M") lista.push({ op: "write", path: x.ruta, content: contenido(), hash: blobEn(padre, x.ruta) });
    else if (x.estado === "D") lista.push({ op: "delete", path: x.ruta, hash: blobEn(padre, x.ruta) });
    else {
      const antes = blobEn(padre, x.de);
      lista.push({ op: "move", from: x.de, to: x.ruta, hash: antes });
      if (blobEn(commit, x.ruta) !== antes) lista.push({ op: "write", path: x.ruta, content: contenido(), hash: antes });
    }
  }
  return lista;
}

/**
 * Publica con `publish`: un commit del servidor por commit de la copia, con su asunto como razón (con --aplanar, uno por
 * nota, con la razón de esa nota). Devuelve { r, envio } con lo que contestó el servidor.
 */
async function publicarDeUnaVez(ctx, base, commits, op) {
  const envio = op.aplanar
    ? commits[0].cambios.map(x => ({ reason: x.razon, changes: cambiosParaPublish(commits[0].commit, [x], base), local: commits[0], cambios: [x] }))
    : commits.map(c => ({ reason: c.razon, changes: cambiosParaPublish(c.commit, c.cambios, `${c.commit}^`), local: c, cambios: c.cambios }));
  const r = await usar(ctx, "publish", {
    commits: envio.map(e => ({ reason: e.reason, changes: e.changes })), ...(op.confirmar_nueva ? { confirm_new: true } : {})
  });
  return { r, envio };
}

/** Después de `publish`: si falló, no se publicó nada y la copia queda igual; si fue bien, la copia pasa a ser el servidor. */
function terminarDeUnaVez({ r, envio }, commits, cabeza, op) {
  if (r.error) {
    // El servidor dice en qué commit y qué cambio del envío falló (sus índices, desde 0).
    const i = Number.isInteger(r.json?.commit) ? r.json.commit : null;
    const donde = i !== null && envio[i] ? ` (commit ${corto(envio[i].local.commit)} «${enUnaLinea(envio[i].reason, 60)}»)` : "";
    const movio = envio.some(e => e.changes.some(c => c.op === "move"));
    const pistaMover = r.json?.code === "CONFLICT" && movio
      ? "\nAl mover una nota, el servidor reescribe sus [[enlaces]] en las demás: si luego cambias una de esas, reescríbelos tú en el commit del movimiento."
      : "";
    const pista = commits.length > 1 && !op.aplanar ? "\nSi un commit posterior arregla el problema, memoria publicar --aplanar publica el resultado final en vez de commit a commit." : "";
    throw new Fallo(`no he publicado nada (va todo en un solo envío: todo o nada)${donde}: ${explicar(r.json, r.texto)}.\nTu copia queda como estaba.${pistaMover}${pista}`, 1);
  }
  const servidor = Array.isArray(r.json?.commits) && r.json.commits.length === envio.length ? r.json.commits : [];
  const hechos = envio.flatMap((e, i) => e.cambios.map(x => ({
    commit: corto(e.local.commit), razon: e.reason, operacion: VERBOS[x.estado], ruta: x.ruta, ...(x.de ? { de: x.de } : {}),
    servidor: servidor[i]?.commit ? corto(servidor[i].commit) : null
  })));
  const avisos = (Array.isArray(r.json?.warnings) ? r.json.warnings : []).map(w => enUnaLinea(w?.message ?? JSON.stringify(w), 200));
  git(["update-ref", "refs/memoria/publicado", cabeza]);
  traerServidor();
  git(["reset", "--hard", "--quiet", SERVIDOR]);
  if (op.json) {
    imprimirJson({ publicado: true, envio: "publish", commits: commits.length, operaciones: hechos, avisos });
    return 0;
  }
  console.log(`publicado: ${commits.length} commits, ${hechos.length} notas en el servidor, firmadas por ti (en un solo envío)`);
  for (const h of hechos) console.log(`  ${h.operacion} ${h.de ? `${h.de} → ` : ""}${h.ruta} — ${enUnaLinea(h.razon, 80)}`);
  for (const a of avisos.slice(0, 5)) console.log(`  aviso: ${a}`);
  if (avisos.length > 5) console.log(`  … y ${avisos.length - 5} avisos más (--json los da todos)`);
  console.log("tu copia queda igual que el servidor (tus commits locales siguen en refs/memoria/publicado)");
  return 0;
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
        commits: commits.map(c => ({ commit: corto(c.commit), razon: c.razon, llamadas: c.cambios.map(x => ({ herramienta: nombreHerramienta(HERRAMIENTAS[x.estado]), ruta: x.ruta, ...(x.de ? { de: x.de } : {}) })) }))
      });
      return 0;
    }
    for (const c of commits) {
      console.log(`${corto(c.commit)} ${enUnaLinea(c.razon, 100)}`);
      for (const x of c.cambios) console.log(`  ${nombreHerramienta(HERRAMIENTAS[x.estado])} ${x.de ? `${x.de} → ` : ""}${x.ruta}`);
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
  let deUnaVez = null; // lo que devolvió `publish`, si el servidor la tiene
  await conServidor(async ctx => {
    // Si el servidor tiene `publish`, todo va en un solo envío: todo o nada, con las reglas juzgadas sobre el envío entero.
    if (commits.reduce((n, c) => n + c.cambios.length, 0) <= MAX_PUBLISH && await tienePublish(ctx)) {
      deUnaVez = await publicarDeUnaVez(ctx, base, commits, op);
      return;
    }
    // Si no, como siempre: nota a nota, cada una con su herramienta (create, write, move, delete).
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
          r = await llamar("create", { path: x.ruta, content: contenido(), reason: razon, ...(op.confirmar_nueva ? { confirm_new: true } : {}) });
        } else if (x.estado === "M") {
          r = await llamar("write", { path: x.ruta, content: contenido(), hash: hashDe(x.ruta), reason: razon });
          // El servidor ya tiene exactamente eso (por ejemplo, un enlace que reescribió al mover otra nota).
          if (r.error && r.json?.code === "CONFLICT" && r.json.content === contenido()) r = { error: false, json: { hash: r.json.hash }, texto: "" };
        } else if (x.estado === "D") {
          r = await llamar("delete", { path: x.ruta, hash: hashDe(x.ruta), reason: razon });
        } else {
          r = await llamar("move", { from: x.de, to: x.ruta, hash: hashDe(x.de), reason: razon });
          if (!r.error && blobEn(c.commit, x.ruta) !== r.json?.hash) {
            r = await llamar("write", { path: x.ruta, content: contenido(), hash: r.json?.hash, reason: razon });
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

  if (deUnaVez) return terminarDeUnaVez(deUnaVez, commits, cabeza, op);

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

// En el orden en que los presenta la ayuda (y el error de un comando que no existe): leer, escribir una nota, el resto.
const OPCIONES = {
  buscar: { carpeta: "valor", en: "valor", limite: "entero", pagina: "entero", archivo: "bool", regex: "bool", json: "bool" },
  leer: { seccion: "valor", lineas: "valor", pagina: "entero", todo: "bool" },
  lista: { carpeta: "valor", limite: "entero", pagina: "entero", json: "bool" },
  recientes: { json: "bool" },
  crear: { razon: "valor", archivo: "valor", confirmar_nueva: "bool", simular: "bool" },
  editar: { razon: "valor", viejo: "valor", nuevo: "valor", todas: "bool", hash: "valor", ediciones: "valor", simular: "bool" },
  escribir: { razon: "valor", archivo: "valor", hash: "valor", simular: "bool" },
  mover: { razon: "valor", hash: "valor", simular: "bool" },
  borrar: { razon: "valor", hash: "valor", si: "bool", simular: "bool" },
  adjuntar: { razon: "valor", archivo: "valor", descripcion: "valor", titulo: "valor", nombre: "valor", alias: "lista", confirmar_nueva: "bool", simular: "bool" },
  revertir: { razon: "valor", nota: "valor", simular: "bool" },
  historial: { limite: "entero", json: "bool" },
  enlaces: { entrantes: "bool", salientes: "bool", relacion: "valor", json: "bool" },
  revisar: { tipos: "lista", carpeta: "valor", limite: "entero", json: "bool" },
  copia: {},
  estado: { json: "bool" },
  publicar: { razon: "valor", simular: "bool", confirmar_nueva: "bool", aplanar: "bool", json: "bool" },
  actualizar: {}
};

// Sin alias destructivos para borrar, pero el error dice cómo se hace.
const BORRAR_EN_INGLES = ["delete", "remove", "rm", "del", "erase"];

async function principal(argv) {
  const [dado, ...resto] = argv;
  if (dado === undefined || esAyuda(dado)) {
    process.stdout.write(AYUDA);
    return 0;
  }
  if (dado === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (BORRAR_EN_INGLES.includes(String(dado).toLowerCase())) {
    throw new Fallo(`no existe «${dado}»: para borrar una nota, memoria borrar <nota> --razon <texto> --si (solo si el usuario lo pidió)`, 2);
  }
  const orden = resolverOrden("memoria", dado, OPCIONES);
  const def = OPCIONES[orden];
  if (resto.includes("--help") || resto.includes("-h")) {
    process.stdout.write(AYUDA);
    return 0;
  }
  const { pos, op } = analizar(resto, def, "Mira memoria --help");
  switch (orden) {
    case "buscar": return LOCAL ? buscarLocal(pos, op) : buscarRemoto(pos, op);
    case "leer": return LOCAL ? leerLocal(pos, op) : leerRemoto(pos, op);
    case "lista": if (op.carpeta && !pos.length) pos.push(op.carpeta); return LOCAL ? listaLocal(pos, op) : listaRemota(pos, op);
    case "recientes": return LOCAL ? recientesLocal(pos, op) : recientesRemoto(pos, op);
    case "copia": return copiar(pos);
    case "estado": return estado(pos, op);
    case "actualizar": return actualizar(pos);
    case "publicar": return publicar(pos, op);
    case "crear": return crear(pos, op);
    case "editar": return editar(pos, op);
    case "historial": return historial(pos, op);
    case "enlaces": return enlaces(pos, op);
    case "revisar": return revisar(pos, op);
    case "escribir": return escribirNota(pos, op);
    case "mover": return moverNota(pos, op);
    case "borrar": return borrarNota(pos, op);
    case "revertir": return revertir(pos, op);
    case "adjuntar": return adjuntar(pos, op);
  }
  return 2;
}

await ejecutarCli("memoria", principal);
