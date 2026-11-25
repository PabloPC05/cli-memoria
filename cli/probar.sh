#!/usr/bin/env bash
# Prueba la CLI memoria contra un servidor cli-memoria DE VERDAD (el binario real, con su índice, sus reglas, sus firmas por
# token y su cola de escritura), pero de juguete: una carpeta temporal que crea y borra este script, un repositorio de notas
# inventado y dos agentes de juguete. No toca ninguna memoria real ni ningún servicio externo.
#
# Todo va en modo directo (MEMORIA_URL + MEMORIA_TOKEN contra /mcp), con un token por agente. `memoria buscar` y `memoria
# plazos` llaman a `search` y `deadlines`: si el servidor que se prueba todavía no las tiene (las está cambiando otro a la
# vez), las sirve un servidor MCP de juguete que sigue la interfaz común y pasa lo demás al servidor de verdad. El script
# dice al empezar en cuál de los dos casos está.
#
# Uso:  NODE=<node 22 o más> CLI_MEMORIA=<cli-memoria> [MEMORIA=<memoria>] cli/probar.sh
#   CLI_MEMORIA (o MY_MEMORY): el servidor (bin/cli-memoria del paquete por defecto, o el instalado).
#   MEMORIA: la CLI que se prueba, ya empaquetada (p. ej. result/bin/memoria de `nix build .#memoria`).
#   Sin MEMORIA, se prueba cli/memoria.mjs de este repositorio con NODE. NODE corre también el servidor MCP de juguete.
# Requiere git, curl y jq. Imprime OK o FALLO por prueba y sale con 1 si alguna falla.
#
# Vale con un cli-memoria que tenga la herramienta `publish` (varios commits en un solo envío, todo o nada) y con uno que no:
# `memoria publicar` la usa si el servidor la ofrece, y si no, publica nota a nota. Las pruebas de publicar esperan lo que
# toca según el servidor (lo dicen al empezar).
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVIDOR="${CLI_MEMORIA:-${MY_MEMORY:-}}"
: "${NODE:?falta NODE}" "${SERVIDOR:?falta CLI_MEMORIA}"
# La CLI: el ejecutable de MEMORIA, o este repositorio con NODE.
if [ -n "${MEMORIA:-}" ]; then CLI=("$MEMORIA"); else CLI=("$NODE" "$AQUI/memoria.mjs"); fi
for h in git curl jq; do command -v "$h" >/dev/null || { echo "Falta $h" >&2; exit 2; }; done

T="$(mktemp -d "${TMPDIR:-/tmp}/probar-memoria.XXXXXX")"
PIDS=()
limpiar() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  # solo se borra lo que este script creó
  case "$T" in "${TMPDIR:-/tmp}"/probar-memoria.*) rm -rf "$T" ;; esac
}
trap limpiar EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
fallos=0
SAL=""
RC=0
ok() { echo "OK     $1"; }
mal() { echo "FALLO  $1"; [ -n "${2:-}" ] && echo "       $2"; fallos=$((fallos + 1)); }
sed_en_sitio() { sed "$1" "$2" > "$2.tmp" && mv "$2.tmp" "$2"; }
lineas() { wc -l | tr -d ' '; }

# --- el servidor de juguete -------------------------------------------------------------------------------

DATOS="$T/datos"
REPO="$DATOS/repo"
mkdir -p "$REPO/people" "$REPO/projects" "$REPO/topics" "$REPO/archive" "$REPO/tareas" "$REPO/pruebas"
(
  cd "$REPO" || exit 1
  git init -q -b main . && git config user.email t@t && git config user.name t
  cat > memory.toml <<'TOML'
[folders]
allowed = ["people", "projects", "topics", "archive", "tareas", "pruebas"]
archive = "archive"

[notes]
required_fields = ["name", "description"]
filename_pattern = "^[a-z0-9]+(-[a-z0-9]+)*\\.md$"

# Solo lo entiende un cli-memoria con reglas al escribir (y publish); los demás no lo leen. Ver el apartado 6c.
[rules.append_only]
sections = ["Fuentes"]
TOML
  printf '# Reglas de juguete\nEscribe en español.\n' > AGENTS.md
  printf -- '---\nname: Ana\ndescription: Amiga de juguete\n---\n# Ana\nLe gusta el café.\n\n## Trabajo\nTrabaja en [[alfa]].\n' > people/ana.md
  printf -- '---\nname: Alfa\ndescription: Proyecto alfa de juguete\n---\n# Alfa\nPrimera línea.\n\n## Estado\nTodo va bien.\n\n## Pendiente\nComprar pan.\n' > projects/alfa.md
  printf -- '---\nname: Café\ndescription: Notas sobre el café\n---\n# Café\nEspresso, filtrado y moka.\n' > topics/cafe.md
  printf -- '---\nname: Vieja\ndescription: Nota de juguete para borrar\n---\n# Vieja\nYa no sirve. Una causa perdida.\n' > topics/vieja.md
  printf -- '---\nname: Guardada\ndescription: Nota archivada de juguete\n---\n# Guardada\n\n## Zeta\nzeta en el archivo\n' > archive/guardada.md
  # Una description de casi 300 caracteres: la línea ↳ la corta a 200 (antes, 110), así que «mediados» sale y «finalisimo» no.
  DESC_LARGA="$(printf 'x%.0s' $(seq 1 120)) mediados $(printf 'y%.0s' $(seq 1 150)) finalisimo"
  printf -- '---\nname: Larga descripción\ndescription: %s\n---\n# Larga\n\n## Zumbido\nun zumbido\n' "$DESC_LARGA" > topics/larga-descripcion.md
  # Seis notas con un solo acierto cada una (y su type/status), para probar las páginas de buscar y sus filtros sin
  # depender del orden que le dé el servidor a las secciones de una misma nota.
  for n in a b c d e f; do
    case "$n" in
      a) TIPO=proyecto ESTADO=activo ;;
      b) TIPO=proyecto ESTADO=inactivo ;;
      *) TIPO=nota ESTADO=inactivo ;;
    esac
    printf -- '---\nname: Prueba %s\ndescription: Nota de juguete %s\ntype: %s\nstatus: %s\n---\n# Nota %s\n\n## Zeta\nla palabra zeta %s\n' \
      "$n" "$n" "$TIPO" "$ESTADO" "$n" "$n" > "pruebas/$n.md"
  done
  # Las tareas de las secciones «Pendiente», en el formato de la interfaz común: - [ ] Qué · responsable · fecha [origen].
  printf -- '---\nname: Pendientes\ndescription: Tareas de juguete con plazo\ntype: lista\nstatus: activo\n---\n# Pendientes\nCosas por hacer.\n\n## Pendiente\n- [ ] Comprar pan · ana · 2026-03-10\n- [ ] Pagar la luz · ana · 2026-02\n- [x] Llamar al fontanero · beto · 2026-03-01\n- [ ] Revisar el tejado · marta · sin plazo\n- [ ] Ensayar la canción · marta · 2026-03-05 [aviso]\n' > tareas/pendientes.md
  # Una nota larga para probar la lectura navegable: secciones y subsecciones, una sección enorme (Pendiente, con cinco
  # colas de 40 líneas: pasa de 8.000 caracteres), un prefijo ambiguo (Pendiente / Pendiente de pago), acentos y un
  # «# encabezado» dentro de un bloque de código que no cuenta.
  {
    printf -- '---\nname: Largo\ndescription: Nota larga de juguete con secciones y subsecciones\n---\n# Largo\nIntro del largo.\n\n'
    printf '## Estado\nTodo va bien.\n```sh\n# no soy un encabezado\n```\n\n'
    printf '## Pendiente\nCosas pendientes de la canción.\n'
    for c in 1 2 3 4 5; do
      printf '### Cola %s\n' "$c"
      for j in $(seq 0 39); do printf -- '- tarea %s.%s: hacer algo pendiente con un texto de relleno para que pese bastante\n' "$c" "$j"; done
    done
    printf -- '- zorro-azul: una línea única en la cola cinco\n'
    printf '## Pendiente de pago\nPagar la luz.\n\n## Acciones\nAcción uno.\n\n## Acentuación\nCafé y canción.\n'
  } > projects/largo.md
  # Con una fecha fija y vieja: los resultados de buscar dicen la del último cambio de cada nota, y así se distingue de
  # la de los cambios que se publican después.
  git add -A && GIT_AUTHOR_DATE="2026-01-02T10:00:00+01:00" GIT_COMMITTER_DATE="2026-01-02T10:00:00+01:00" git commit -q -m "alta de juguete"
) || { echo "no pude crear las notas de juguete" >&2; exit 2; }
ALTA=2026-01-02

PUERTO_MM=$(( 20000 + RANDOM % 10000 ))
cat > "$T/config.toml" <<TOML
data_dir = "$DATOS"
tokens_file = "$T/tokens.toml"
[listen]
address = "127.0.0.1"
port = $PUERTO_MM
TOML
# Los tokens salen solo a variables; no se imprimen.
TOK1=$("$SERVIDOR" token add agente1 --name "Agente Uno" --scope write --file "$T/tokens.toml" | grep -o 'mm_[A-Za-z0-9_-]*' | head -1)
TOK2=$("$SERVIDOR" token add agente2 --name "Agente Dos" --scope write --file "$T/tokens.toml" | grep -o 'mm_[A-Za-z0-9_-]*' | head -1)
[ -n "$TOK1" ] && [ -n "$TOK2" ] || { echo "no pude crear los tokens de juguete" >&2; exit 2; }
"$SERVIDOR" serve --config "$T/config.toml" > "$T/mm.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PUERTO_MM/mcp" && break
  sleep 0.2
done
grep -q "listening\|started\|serve" "$T/mm.log" 2>/dev/null || sleep 1
curl -s -o /dev/null "http://127.0.0.1:$PUERTO_MM/mcp" || { echo "cli-memoria no arrancó:"; cat "$T/mm.log"; exit 2; }
# ¿Tiene este cli-memoria la herramienta publish? Según eso, memoria publicar manda un solo envío o va nota a nota.
CON_PUBLISH=0
curl -s -XPOST "http://127.0.0.1:$PUERTO_MM/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $TOK1" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | sed 's/^data://' | grep -q '"name":"publish"' && CON_PUBLISH=1
if [ "$CON_PUBLISH" = 1 ]; then echo "(este cli-memoria tiene publish: memoria publicar va en un solo envío)"; else echo "(este cli-memoria no tiene publish: memoria publicar va nota a nota)"; fi

# ¿Tiene ya este cli-memoria `search` con offset y `deadlines` (la interfaz común)? Si no, las sirve delante un servidor MCP
# de juguete que las lee de la carpeta de notas y pasa todo lo demás al servidor de verdad.
MM_URL="http://127.0.0.1:$PUERTO_MM/mcp"
TOOLS=$(curl -s -XPOST "http://127.0.0.1:$PUERTO_MM/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $TOK1" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | sed 's/^data://')
if jq -e '.result.tools[] | select(.name == "deadlines")' <<<"$TOOLS" >/dev/null 2>&1 \
  && jq -e '.result.tools[] | select(.name == "search") | .inputSchema.properties.offset' <<<"$TOOLS" >/dev/null 2>&1; then
  echo "(este cli-memoria ya tiene search con offset y deadlines: se prueban contra él)"
else
  echo "(este cli-memoria todavía no tiene search con offset ni deadlines: las sirve un servidor MCP de juguete de la interfaz común, y lo demás va al servidor de verdad)"
  cat > "$T/mcp-juguete.mjs" <<'JS'
// Servidor MCP de juguete para cli/probar.sh: sirve `search` y `deadlines` como manda la interfaz común (leídas de la
// carpeta de notas) y pasa todo lo demás al servidor cli-memoria de verdad. Sin dependencias de npm.
//
// Entorno: REPO (la carpeta de notas), DESTINO (la URL /mcp del cli-memoria), PUERTO, TOKENS (separados por comas).
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.env.REPO;
const DESTINO = process.env.DESTINO;
const PUERTO = Number(process.env.PUERTO);
const TOKENS = new Set((process.env.TOKENS ?? "").split(",").filter(Boolean));

const plano = texto => String(texto).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const nombreDe = ruta => ruta.replace(/^.*\//, "").replace(/\.md$/, "");

/** Las palabras de una consulta, sin acentos ni mayúsculas. */
const palabrasDe = consulta => plano(consulta).split(/[^a-z0-9ñ]+/).filter(Boolean);

/** ¿Está la palabra en el texto? Las de 3 letras o menos, solo enteras («usa» no es «causa»). */
function entera(texto, palabra) {
  if (palabra.length > 3) return texto.includes(palabra);
  return new RegExp(`(^|[^a-z0-9])${palabra}([^a-z0-9]|$)`).test(texto);
}

/** Las rutas de las notas (sin .git), ordenadas. */
function notas() {
  const salida = [];
  const andar = (dir) => {
    for (const entrada of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      if (entrada.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) andar(rel);
      else if (entrada.name.endsWith(".md")) salida.push(rel);
    }
  };
  andar("");
  return salida.sort();
}

/** La fecha del último commit de cada nota (AAAA-MM-DD), en una sola pasada de git log. */
function fechasDeNotas() {
  const fechas = new Map();
  try {
    const salida = execFileSync("git", ["-C", REPO, "log", "--format=%x01%aI", "--name-only"], { encoding: "utf8" });
    let fecha = null;
    for (const linea of salida.split("\n")) {
      if (linea.startsWith("\x01")) fecha = linea.slice(1, 11);
      else if (linea.trim() && fecha && !fechas.has(linea.trim())) fechas.set(linea.trim(), fecha);
    }
  } catch {
    // Sin historial de git: las notas salen sin fecha.
  }
  return fechas;
}

/** Una nota: sus campos del frontmatter y sus secciones (la cabecera cuenta como una, «cabecera»). */
function leerNota(ruta) {
  const lineas = readFileSync(join(REPO, ruta), "utf8").replace(/\n$/, "").split("\n");
  const meta = {};
  let i = 0;
  if (lineas[0] === "---") {
    for (i = 1; i < lineas.length && lineas[i] !== "---"; i++) {
      const campo = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lineas[i]);
      if (campo) meta[campo[1]] = campo[2].trim();
    }
    i++;
  }
  const secciones = [];
  if (i > 0) secciones.push({ heading: "cabecera", line_start: 1, lineas: lineas.slice(0, i) });
  let actual = { heading: "", line_start: i + 1, lineas: [] };
  for (let n = i; n < lineas.length; n++) {
    const encabezado = /^(#{1,6})\s+(.*)$/.exec(lineas[n]);
    if (encabezado) {
      if (actual.heading || actual.lineas.some((l) => l.trim())) secciones.push(actual);
      actual = { heading: encabezado[2].trim(), line_start: n + 1, lineas: [lineas[n]] };
    } else {
      actual.lineas.push(lineas[n]);
    }
  }
  if (actual.heading || actual.lineas.some((l) => l.trim())) secciones.push(actual);
  return { path: ruta, name: meta.name ?? nombreDe(ruta), description: meta.description ?? null, type: meta.type ?? null, status: meta.status ?? null, secciones };
}

/** `search`: las secciones que tienen todas las palabras, como mucho dos por nota (group_by_note). */
function buscar(args) {
  const palabras = palabrasDe(args.query ?? "");
  if (!palabras.length) throw new Error("la consulta no tiene palabras que buscar");
  const tipos = args.type === undefined ? null : [args.type].flat().map(plano);
  const estados = args.status === undefined ? null : [args.status].flat().map(plano);
  const carpeta = String(args.folder ?? "").replace(/\/+$/, "");
  const fechas = fechasDeNotas();
  const hits = [];
  for (const ruta of notas()) {
    if (!args.include_archive && ruta.startsWith("archive/")) continue;
    if (carpeta && !ruta.startsWith(`${carpeta}/`)) continue;
    const nota = leerNota(ruta);
    if (tipos && !tipos.includes(plano(nota.type ?? ""))) continue;
    if (estados && !estados.includes(plano(nota.status ?? ""))) continue;
    const deNota = [];
    for (const seccion of nota.secciones) {
      const cuerpo = plano(seccion.lineas.join("\n"));
      const cabecera = plano(seccion.heading);
      let puntos = 0;
      let todas = true;
      for (const palabra of palabras) {
        if (entera(cuerpo, palabra) || entera(cabecera, palabra)) puntos += entera(cabecera, palabra) ? 10 : 1;
        else {
          todas = false;
          break;
        }
      }
      if (!todas) continue;
      const i = seccion.lineas.findIndex((l) => palabras.some((p) => plano(l).includes(p)));
      deNota.push({
        path: ruta,
        name: nota.name,
        description: nota.description,
        ...(fechas.has(ruta) ? { updated_at: fechas.get(ruta) } : {}),
        section: { heading: seccion.heading, level: 1, line_start: seccion.line_start, line_end: seccion.line_start + seccion.lineas.length - 1 },
        snippet: (seccion.lineas[Math.max(0, i)] ?? "").trim().slice(0, 200),
        score: -puntos,
        type: nota.type,
        status: nota.status
      });
    }
    deNota.sort((a, b) => a.score - b.score || a.section.line_start - b.section.line_start);
    hits.push(...(args.group_by_note === false ? deNota : deNota.slice(0, 2)));
  }
  hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path) || a.section.line_start - b.section.line_start);
  const total = hits.length;
  const offset = Math.max(0, Number(args.offset ?? 0));
  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
  const pagina = hits.slice(offset, offset + limit);
  return { mode: "all", hits: pagina, total, ...(offset + pagina.length < total ? { next_offset: offset + pagina.length } : {}) };
}

/** Las tareas de las secciones «Pendiente» de una nota: `- [ ] Qué · responsable · fecha [origen]`. */
function tareasDe(ruta) {
  const nota = leerNota(ruta);
  const items = [];
  for (const seccion of nota.secciones) {
    if (!plano(seccion.heading).startsWith("pendiente")) continue;
    seccion.lineas.forEach((linea, i) => {
      const tarea = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(linea);
      if (!tarea) return;
      const origen = /\[([^\]]+)\]\s*$/.exec(tarea[2]);
      const cuerpo = (origen ? tarea[2].slice(0, origen.index) : tarea[2]).trim();
      const [texto = "", responsable = null, fecha = ""] = cuerpo.split("·").map((x) => x.trim());
      const dia = /^(\d{4}-\d{2}-\d{2})$/.exec(fecha);
      const mes = /^(\d{4}-\d{2})$/.exec(fecha);
      items.push({
        path: ruta,
        name: nota.name,
        line: seccion.line_start + i,
        done: tarea[1] !== " ",
        text: texto,
        owner: responsable,
        date: dia ? dia[1] : mes ? mes[1] : null,
        date_precision: dia ? "day" : mes ? "month" : null,
        origin: origen ? origen[1] : null
      });
    });
  }
  return items;
}

/** `deadlines`: las tareas por fecha (las de solo mes, al principio de su mes; sin fecha, al final). */
function plazos(args) {
  const carpeta = String(args.folder ?? "").replace(/\/+$/, "");
  let items = [];
  for (const ruta of notas()) {
    if (carpeta && !ruta.startsWith(`${carpeta}/`)) continue;
    if (!args.include_archive && ruta.startsWith("archive/")) continue;
    items.push(...tareasDe(ruta));
  }
  if (!args.include_done) items = items.filter((t) => !t.done);
  if (!args.include_undated) items = items.filter((t) => t.date);
  const clave = (t) => (t.date ? `${t.date}${t.date_precision === "month" ? "-00" : ""}` : "9999-99-99");
  items.sort((a, b) => clave(a).localeCompare(clave(b)) || a.path.localeCompare(b.path) || a.line - b.line);
  if (args.limit) items = items.slice(0, Number(args.limit));
  return { items };
}

// --- MCP ------------------------------------------------------------------------------------------------

const leerCuerpo = (req) => new Promise((r) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => r(cuerpo));
});

const respuesta = (res, mensaje, cabeceras = {}) => {
  res.writeHead(200, { "content-type": "application/json", ...cabeceras }).end(JSON.stringify(mensaje));
};

/** Una llamada al servidor de verdad, con el token del agente que llama: devuelve el `result` (en JSON o en SSE). */
async function remoto(metodo, params, token) {
  const r = await fetch(DESTINO, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: metodo, params })
  });
  const texto = await r.text();
  const datos = texto.startsWith("{") ? texto : texto.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  const mensaje = JSON.parse(datos);
  if (mensaje.error) throw new Error(mensaje.error.message ?? "error del servidor");
  return mensaje.result;
}

const ESQUEMA_SEARCH = {
  type: "object",
  properties: {
    query: { type: "string" },
    folder: { type: "string" },
    include_archive: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    offset: { type: "integer", minimum: 0 },
    type: {},
    status: {},
    group_by_note: { type: "boolean" }
  },
  required: ["query"]
};

createServer(async (req, res) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!TOKENS.has(token)) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(200).end();
    return;
  }
  let cuerpo;
  try {
    cuerpo = JSON.parse((await leerCuerpo(req)) || "{}");
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (cuerpo.method === "initialize") {
    return respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mcp-de-juguete", version: "0" } } });
  }
  if (cuerpo.method === "notifications/initialized") {
    res.writeHead(202).end();
    return;
  }
  if (cuerpo.method === "tools/list") {
    const real = await remoto("tools/list", {}, token);
    const herramientas = (real.tools ?? []).filter((t) => t.name !== "search" && t.name !== "deadlines");
    herramientas.unshift(
      { name: "deadlines", description: "De juguete: tareas de las secciones «Pendiente» de la interfaz común.", inputSchema: { type: "object", properties: { folder: { type: "string" }, include_undated: { type: "boolean" }, include_done: { type: "boolean" }, limit: { type: "integer" } } } },
      { name: "search", description: "De juguete: search con offset, type, status y group_by_note de la interfaz común.", inputSchema: ESQUEMA_SEARCH }
    );
    return respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, result: { tools: herramientas } });
  }
  if (cuerpo.method === "tools/call") {
    const { name, arguments: args = {} } = cuerpo.params ?? {};
    if (name === "search" || name === "deadlines") {
      try {
        const salida = name === "search" ? buscar(args) : plazos(args);
        return respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, result: { content: [{ type: "text", text: JSON.stringify(salida) }], structuredContent: salida } });
      } catch (error) {
        return respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, result: { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] } });
      }
    }
    return respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, result: await remoto("tools/call", cuerpo.params, token) });
  }
  respuesta(res, { jsonrpc: "2.0", id: cuerpo.id, error: { code: -32601, message: "método no soportado por el servidor de juguete" } });
}).listen(PUERTO, "127.0.0.1");
JS
  PUERTO_J=$(( 30000 + RANDOM % 10000 ))
  REPO="$REPO" DESTINO="http://127.0.0.1:$PUERTO_MM/mcp" PUERTO="$PUERTO_J" TOKENS="$TOK1,$TOK2" "$NODE" "$T/mcp-juguete.mjs" > "$T/juguete.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$PUERTO_J/" && break
    sleep 0.2
  done
  curl -s -o /dev/null "http://127.0.0.1:$PUERTO_J/" || { echo "el servidor MCP de juguete no arrancó:"; cat "$T/juguete.log"; exit 2; }
  MM_URL="http://127.0.0.1:$PUERTO_J/"
fi

# --- cómo se llama a la CLI -------------------------------------------------------------------------------------

# m1 y m2: los agentes uno y dos, cada uno con su copia de trabajo y su token, contra el servidor (o su fachada de juguete).
m1() { MEMORIA_DIR="$REPO" MEMORIA_COPIA="$T/copia1" HOME="$T/h1" MEMORIA_URL="$MM_URL" MEMORIA_TOKEN="$TOK1" "${CLI[@]}" "$@"; }
m2() { MEMORIA_DIR="$REPO" MEMORIA_COPIA="$T/copia2" HOME="$T/h2" MEMORIA_URL="$MM_URL" MEMORIA_TOKEN="$TOK2" "${CLI[@]}" "$@"; }
# mr1: lo mismo que m1 pero sin MEMORIA_DIR: leer, lista, recientes y buscar --en van al servidor, no al disco.
mr1() { MEMORIA_DIR="" MEMORIA_COPIA="$T/copiar" HOME="$T/h1" MEMORIA_URL="$MM_URL" MEMORIA_TOKEN="$TOK1" "${CLI[@]}" "$@"; }
# sin_servidor: con la dirección del servidor caída, para ver que no se busca en el disco por su cuenta.
sin_servidor() { SAL=$(MEMORIA_DIR="$REPO" MEMORIA_COPIA="$T/copiar" HOME="$T/h1" MEMORIA_URL="http://127.0.0.1:1/mcp" MEMORIA_TOKEN="$TOK1" "${CLI[@]}" "$@" 2>&1); RC=$?; }
mkdir -p "$T/h1" "$T/h2"
c1() { git -C "$T/copia1" "$@"; }
c2() { git -C "$T/copia2" "$@"; }
# corre <comando…>: guarda la salida (stdout y stderr) en SAL y el código en RC.
corre() { SAL=$("$@" 2>&1); RC=$?; }
# espera <texto> <descripción>: SAL contiene el texto.
espera() { if grep -qF -- "$1" <<<"$SAL"; then ok "$2"; else mal "$2" "salida (rc=$RC): $(head -c 500 <<<"$SAL" | tr '\n' ' ')"; fi; }
no_espera() { if grep -qF -- "$1" <<<"$SAL"; then mal "$2" "no debía salir «$1»: $(head -c 300 <<<"$SAL" | tr '\n' ' ')"; else ok "$2"; fi; }
rc_es() { if [ "$RC" = "$1" ]; then ok "$2"; else mal "$2" "rc=$RC, se esperaba $1: $(head -c 300 <<<"$SAL" | tr '\n' ' ')"; fi; }
# del servidor: lo que hay de verdad en su repositorio.
srv() { git -C "$REPO" "$@"; }
srv_head() { srv rev-parse HEAD; }

# --- 0. leer: local, con su índice, sus secciones y sus páginas -----------------------------------------------

L="$REPO/projects/largo.md"
linea_de() { grep -n -m1 -F -- "$1" "$L" | cut -d: -f1; }
corre m1 leer cafe
espera "Espresso, filtrado y moka" "leer: una nota corta sale entera"
no_espera "nota larga" "leer: una corta no lleva índice ni aviso"
corre m1 leer largo
espera "nota larga: lee una sección con --seccion '<título>' o un rango con --lineas A-B" "leer larga: el aviso de una línea"
espera "hash: $(git -C "$REPO" hash-object "$L")" "leer larga: la cabecera lleva el hash de la nota"
espera "descripción: Nota larga de juguete" "leer larga: la cabecera lleva la descripción"
espera " · cambiada el $ALTA · " "leer larga: la cabecera lleva la fecha de su último cambio (del historial de git)"
espera "$(linea_de '## Pendiente') · " "leer larga: el índice da la línea de inicio de cada sección"
espera "### Cola 3" "leer larga: el índice lista las subsecciones"
espera "## Acentuación" "leer larga: el índice conserva los acentos"
no_espera "no soy un encabezado" "leer larga: un # dentro de un bloque de código no es un encabezado"
no_espera "tarea 3.5" "leer larga: sin opciones no da el contenido"
[ "$(m1 leer largo | wc -c)" -lt 2000 ] && ok "leer larga: el índice es corto (menos de 2.000 caracteres)" || mal "leer larga: el índice es corto"
corre m1 leer largo --seccion estado
espera "Todo va bien." "seccion: sin distinguir mayúsculas"
no_espera "tarea" "seccion: solo esa sección"
espera "(sección «Estado», líneas $(linea_de '## Estado')-" "seccion: dice qué líneas son"
corre m1 leer largo --seccion ACENTUACION
espera "Café y canción." "seccion: sin acentos ni mayúsculas"
corre m1 leer largo --seccion acentu
espera "Café y canción." "seccion: un prefijo único basta"
corre m1 leer largo --seccion pen
rc_es 2 "seccion: un prefijo ambiguo falla (rc 2)"
espera "encaja con 2 secciones" "seccion: …y dice que encaja con dos"
espera "Pendiente de pago" "seccion: …y las lista con su línea"
corre m1 leer largo --seccion pendiente
espera "### Cola 1" "seccion: igual a un encabezado gana al prefijo, e incluye las subsecciones"
no_espera "Pagar la luz" "seccion: …y no la siguiente del mismo nivel"
espera "(sección «Pendiente», página 1 de 3: --pagina 2" "seccion enorme: pagina, y dice cuántas páginas hay"
no_espera "tarea 5.39" "seccion enorme: la primera página no trae todo"
[ "$(m1 leer largo --seccion pendiente | wc -c)" -lt 8600 ] && ok "seccion enorme: una página pesa menos de 8.600 caracteres" || mal "seccion enorme: una página pesa menos de 8.600 caracteres"
corre m1 leer largo --seccion pendiente --pagina 3
espera "tarea 5.39" "seccion enorme: la última página trae el final"
espera "la última" "seccion enorme: …y dice que es la última"
corre m1 leer largo --seccion pendiente --pagina 4
rc_es 2 "seccion enorme: una página que no existe falla (rc 2)"
espera "hay 3" "seccion enorme: …y dice cuántas hay"
corre m1 leer largo --seccion pendiente --todo
espera "tarea 1.0:" "seccion --todo: sin ventanas (el principio)"
espera "zorro-azul" "seccion --todo: sin ventanas (el final)"
corre m1 leer largo --seccion "pendiente > cola 3"
espera "tarea 3.0:" "seccion: «Padre > Hija» baja a la subsección"
no_espera "tarea 2.0:" "seccion: …y solo esa"
corre m1 leer largo --lineas 8-10
espera "## Estado" "lineas: el rango pedido"
espera "(líneas 8-10 de" "lineas: dice qué líneas son y cuántas tiene la nota"
corre m1 leer largo --lineas 2000
rc_es 2 "lineas: pasarse del final falla (rc 2)"
corre m1 leer largo --lineas abc
rc_es 2 "lineas: un rango mal escrito falla (rc 2)"
corre m1 leer largo --seccion estado --lineas 1-3
rc_es 2 "--seccion y --lineas juntas: error de uso"
corre m1 leer largo --seccion nohay
rc_es 2 "seccion que no existe: rc 2"
espera "### Pendiente › Cola 2" "seccion que no existe: lista las que hay"
corre m1 leer largo --todo
espera "Pagar la luz." "--todo: la nota entera"
espera "tarea 1.0:" "--todo: …desde el principio"
corre m1 leer largo --pagina 2
espera "(página 2 de " "--pagina sin seccion: lee la nota seguida"
corre m1 leer cafe --seccion inexistente
rc_es 2 "seccion en una nota corta que no la tiene: rc 2"

# --- 0a. buscar: la herramienta search del servidor, con --limite, --pagina y filtros ---------------------

corre m1 buscar zorro-azul
espera "projects/largo.md:" "buscar: la ruta del resultado"
espera "zorro-azul" "buscar: el fragmento de la línea que coincide"
espera "(1 resultado)" "buscar: dice el total (uno)"
espera "  ↳ (cambiada el $ALTA) Nota larga de juguete" "buscar: bajo la nota, su último cambio y su description"
corre m1 buscar CANCION --carpeta projects
espera "canción" "buscar: sin acentos ni mayúsculas (lo hace el servidor)"
no_espera "topics/" "buscar --carpeta: solo esa carpeta"
corre m1 buscar alfa --carpeta projects
espera "projects/alfa.md:" "buscar: una nota de esa carpeta"
espera "  ↳ (cambiada el $ALTA) Proyecto alfa de juguete" "buscar: la description va en la línea ↳"
corre m1 buscar nadadenada
espera "(0 resultados)" "buscar: sin resultados, lo dice"
corre m1 buscar nadadenada --pagina 2
rc_es 0 "buscar --pagina > 1 con 0 hits: sale con 0"
espera "(0 resultados)" "buscar --pagina > 1 con 0 hits: dice 0 resultados"
no_espera "20 resultados" "buscar --pagina > 1 con 0 hits: no inventa un total falso"
corre m1 lista --carpeta projects
espera "projects/alfa.md" "lista --carpeta X es lista X (el error más común: no hace fallar)"

# paginar: seis notas con un solo acierto (pruebas/a.md … pruebas/f.md), dos por página
corre m1 buscar zeta --limite 2
espera "(6 resultados; mostrando 1-2: --pagina 2 (o --limite N))" "buscar: el total y cómo pasar de página"
[ "$(m1 buscar zeta --limite 2 | lineas)" = 5 ] && ok "buscar: dos resultados, sus dos ↳ y el aviso" || mal "buscar: dos resultados, sus dos ↳ y el aviso" "$(m1 buscar zeta --limite 2)"
corre m1 buscar zeta --limite 2 --pagina 2
espera "pruebas/c.md" "buscar: la página 2 sigue por donde iba"
no_espera "pruebas/a.md" "buscar: …sin repetir la página 1"
espera "mostrando 3-4" "buscar: …y dice dónde va"
corre m1 buscar zeta --limite 2 --pagina 3
espera "pruebas/f.md" "buscar: la última página"
no_espera "--pagina 4" "buscar: …y no ofrece más porque no hay"
corre m1 buscar zeta --limite 2 --pagina 4
rc_es 2 "buscar: una página que no existe falla (rc 2)"
espera "hay 3 (6 resultados, 2 por página)" "buscar: …y dice cuántas hay"
corre m1 buscar zeta --limite 2 --pagina 5
rc_es 2 "buscar: página muy por encima del total falla (rc 2)"
espera "hay 3 (6 resultados, 2 por página)" "buscar: …y conserva el total real"
corre m1 buscar zeta --limite 60
rc_es 2 "buscar: --limite por encima de 50 falla (rc 2)"
espera "para ver más, --pagina" "buscar: …y dice cómo ver más"

# --tipo y --estado: los filtros del frontmatter
corre m1 buscar zeta --tipo proyecto --limite 5
espera "pruebas/a.md" "buscar --tipo: filtra por el campo type de la nota"
espera "pruebas/b.md" "buscar --tipo: …las dos que lo tienen"
no_espera "pruebas/c.md" "buscar --tipo: …y deja fuera las demás"
corre m1 buscar zeta --estado activo --limite 5
espera "(1 resultado)" "buscar --estado: filtra por el campo status"
corre m1 buscar zeta --tipo nota,proyecto --limite 6
espera "(6 resultados)" "buscar --tipo con comas: vale una lista"
corre m1 buscar zeta --tipo noexiste
espera "(0 resultados)" "buscar --tipo que no hay: sin resultados"

# --archivo
corre m1 buscar zeta --limite 50
no_espera "archive/" "buscar: sin --archivo, el archivo no sale"
corre m1 buscar zeta --archivo --limite 50
espera "archive/guardada.md" "buscar --archivo: incluye archive/"

# --json y el alias
corre m1 buscar zeta --limite 6 --json
espera '"seccion": "Zeta"' "buscar --json: lleva la sección"
espera '"tipo": "proyecto"' "buscar --json: lleva el tipo de la nota"
espera '"estado": "activo"' "buscar --json: lleva el estado"
espera "\"cambiada\": \"$ALTA\"" "buscar --json: lleva la fecha del último cambio"
corre m1 search zeta --limite 2
espera "(6 resultados; mostrando 1-2" "alias: search vale para buscar"

# la description se corta a 200 caracteres (antes, 110)
corre m1 buscar zumbido
espera "mediados" "buscar: la línea ↳ lleva la description más allá de 110 caracteres"
no_espera "finalisimo" "buscar: …y se corta antes del final"
[ "$(m1 buscar zumbido | sed -n 2p | wc -m)" -le 245 ] && ok "buscar: la description cortada no pasa de 200" || mal "buscar: la description cortada no pasa de 200"

# el que manda es el servidor: si no está, no se busca en el disco por su cuenta
sin_servidor buscar zorro-azul
rc_es 3 "buscar con el servidor caído: falla (rc 3)"
espera "no llego al servidor" "buscar con el servidor caído: lo dice"
no_espera "projects/largo.md" "buscar con el servidor caído: no busca en el disco por su cuenta"
sin_servidor plazos
rc_es 3 "plazos con el servidor caído: falla (rc 3)"
# --en y --regex siguen en el disco (rg): no necesitan el servidor
sin_servidor buscar pan --en alfa
rc_es 0 "--en con el servidor caído: sale del disco con rg"
espera "Comprar pan." "--en: la línea de la nota"
corre m1 buscar 'moka|filtrado' --regex
espera "topics/cafe.md" "buscar --regex: una expresión de rg en la copia local"

# la fecha de una nota sin tocar sale del historial de git, y se guarda en una caché (~/.cache/memoria): la usa leer
CACHE="$T/h1/.cache/memoria/fechas.json"
[ "$(jq -r .cabeza "$CACHE" 2>/dev/null)" = "$(srv_head)" ] && ok "fechas: se guardan en ~/.cache/memoria con el HEAD del que salen" || mal "fechas: la caché" "$(head -c 200 "$CACHE" 2>&1)"
# Con la caché al día no se lanza git log: una fecha falsa en ella es lo que sale (y así se ve que se usa).
jq '.fechas["projects/largo.md"] = "1999-09-09"' "$CACHE" > "$CACHE.x" && mv "$CACHE.x" "$CACHE"
corre m1 leer largo
espera " · cambiada el 1999-09-09 · " "fechas: con HEAD igual, salen de la caché, sin git log"
rm -f "$CACHE"
corre m1 leer largo
espera " · cambiada el $ALTA · " "fechas: sin caché, se calculan otra vez"

# --- 0b. plazos: la herramienta deadlines, una línea por tarea ---------------------------------------------

corre m1 plazos
espera "2026-02 · Pagar la luz · ana · tareas/pendientes.md" "plazos: fecha · qué · responsable · nota"
espera "2026-03-10 · Comprar pan · ana · tareas/pendientes.md" "plazos: por fecha"
no_espera "Llamar al fontanero" "plazos: las hechas no salen sin --hechas"
no_espera "Revisar el tejado" "plazos: las que no tienen fecha no salen sin --sin-plazo"
espera "(3 tareas · sin plazo: --sin-plazo · hechas: --hechas)" "plazos: el total y cómo ver el resto"
[ "$(m1 plazos | sed -n 1p | cut -d' ' -f1)" = "2026-02" ] && ok "plazos: la primera es la del mes más antiguo" || mal "plazos: la primera es la del mes más antiguo" "$(m1 plazos)"
corre m1 plazos --hechas
espera "2026-03-01 · Llamar al fontanero · beto · tareas/pendientes.md (hecha)" "plazos --hechas: las hechas van marcadas"
corre m1 plazos --sin-plazo
espera "sin plazo · Revisar el tejado · marta · tareas/pendientes.md" "plazos --sin-plazo: al final, sin fecha"
corre m1 plazos --hechas --sin-plazo
espera "(5 tareas)" "plazos --hechas --sin-plazo: las cinco"
corre m1 plazos --carpeta tareas
espera "(3 tareas" "plazos --carpeta X: solo esa carpeta"
corre m1 plazos --carpeta projects
espera "(0 tareas" "plazos --carpeta sin tareas: ninguna"
corre m1 plazos --limite 2
espera "(3 tareas; mostrando 2: usa --limite N hasta 1000" "plazos --limite N: recorta y avisa de que está truncado"
[ "$(m1 plazos --limite 2 | grep -c '^2026-')" = 2 ] && ok "plazos --limite 2: solo dos tareas" || mal "plazos --limite 2: solo dos tareas" "$(m1 plazos --limite 2)"
corre m1 plazos --limite 0
rc_es 2 "plazos --limite 0: error de uso"
corre m1 plazos --limite 1001
rc_es 2 "plazos --limite 1001: error de uso"
corre m1 deadlines
espera "2026-02 · Pagar la luz" "alias: deadlines es plazos"
corre m1 plazos --json
espera '"date_precision": "month"' "plazos --json: las tareas del servidor, tal cual"
espera '"origin": "aviso"' "plazos --json: con su origen"
corre m1 plazos tareas
rc_es 2 "plazos con un posicional: error de uso"
espera "uso: memoria plazos" "plazos: …y dice cómo se usa"

# buscar --en <nota>: las líneas de esa nota, con su número y su sección, y el total
corre m1 buscar tarea --en largo --limite 3
espera "projects/largo.md:$(linea_de 'tarea 1.0:') · Pendiente › Cola 1 · - tarea 1.0:" "--en: ruta:línea · sección · línea de la nota"
espera "(200 resultados en projects/largo.md; mostrando 1-3: --pagina 2 (o --limite N))" "--en: el total, en qué nota y cómo seguir"
[ "$(m1 buscar tarea --en largo --limite 3 | grep -c '↳')" = 1 ] && ok "--en: la línea ↳ sale una vez" || mal "--en: la línea ↳ sale una vez"
espera "  ↳ (cambiada el $ALTA) Nota larga de juguete" "--en: con la fecha y la description de la nota"
corre m1 buscar tarea --en largo --limite 3 --pagina 2
espera "tarea 1.3:" "--en --pagina 2: sigue por donde iba"
corre m1 buscar cafe --en largo
espera "projects/largo.md:$(linea_de 'Café y canción') · Acentuación · Café y canción." "--en: sin acentos ni mayúsculas"
no_espera "topics/cafe.md" "--en: solo esa nota"
corre m1 buscar zorro-azul --en projects/alfa.md
espera "(0 resultados en projects/alfa.md" "--en con ruta: sin nada, lo dice"
corre m1 buscar "zorro cancion" --en largo
espera "sin «zorro cancion» exacto en projects/largo.md; por palabras sueltas" "--en por palabras: avisa de que la frase no está"
espera "zorro-azul" "--en por palabras: las líneas con alguna palabra (zorro)"
espera "Café y canción." "--en por palabras: …y las de la otra (canción)"
espera "líneas por palabras sueltas en projects/largo.md (0 con todas: zorro, cancion)" "--en por palabras: el resumen"
corre m1 buscar relleno pendiente --en largo --limite 1
espera "· Pendiente › Cola 1 · - tarea 1.0: hacer algo pendiente" "--en: varias palabras en la misma línea, en cualquier orden"
espera "(200 resultados en projects/largo.md; mostrando 1:" "--en: varias palabras, con su total"
corre m1 buscar zorro-azul --en largo --json
espera "\"linea\": $(linea_de zorro-azul)" "--en --json: el número de línea"
espera "\"cambiada\": \"$ALTA\"" "--en --json: la fecha"
corre m1 buscar cafe --en topics
espera "topics/cafe.md" "--en <carpeta>: vale como --carpeta"
no_espera "projects/largo.md" "--en <carpeta>: …y solo esa carpeta"
corre m1 buscar cafe --en largo --carpeta projects
rc_es 2 "--en y --carpeta juntas: error de uso"
corre m1 buscar cafe --en nohaytal
rc_es 2 "--en con una nota que no existe: error de uso"
espera "no hay ninguna nota llamada «nohaytal»" "--en con una nota que no existe: lo dice"
corre m1 search zorro-azul --en largo
espera "(1 resultado en projects/largo.md)" "alias: search … --en también vale"
corre m1 buscar zumbido --en larga-descripcion
espera "mediados" "--en: la línea ↳ lleva la description hasta 200 caracteres"
no_espera "finalisimo" "--en: …y se corta antes del final"
# Una ruta con la carpeta equivocada: si el nombre es el de una sola nota, es esa, y se dice dónde está.
corre m1 leer topics/largo.md
espera "nota larga: lee una sección" "leer con la carpeta equivocada: lee la nota de ese nombre"
espera "topics/largo.md no existe; la nota «largo» está en projects/largo.md" "leer con la carpeta equivocada: …y dice dónde está"
corre m1 buscar zorro-azul --en topics/largo
espera "(1 resultado en projects/largo.md)" "--en con la carpeta equivocada: también"
corre m1 leer topics/nohaytal.md
rc_es 2 "leer una ruta que no existe y que no es el nombre de ninguna nota: rc 2"
espera "no existe la nota topics/nohaytal.md" "…y lo dice"
corre m1 lista projects --limite 1
espera "(2 notas; mostrando 1: --pagina 2 (o --limite N))" "lista: total y paginación"

# --- 0c. sin copia local (MEMORIA_DIR vacío): leer, buscar y plazos, por el servidor -------------------------

corre mr1 leer largo
espera "nota larga: lee una sección con --seccion" "sin MEMORIA_DIR: leer larga da su índice"
espera "hash: " "sin MEMORIA_DIR: …con su hash"
corre mr1 leer largo --seccion estado
espera "Todo va bien." "sin MEMORIA_DIR: leer --seccion"
no_espera "tarea" "sin MEMORIA_DIR: …y nada más"
corre mr1 leer cafe
espera "Espresso, filtrado y moka" "sin MEMORIA_DIR: leer una nota corta, entera"
corre mr1 buscar zeta --limite 2
espera "(6 resultados; mostrando 1-2" "sin MEMORIA_DIR: buscar va al servidor y pagina igual"
corre mr1 buscar zeta --tipo proyecto --limite 5
espera "pruebas/a.md" "sin MEMORIA_DIR: los filtros de buscar, también"
corre mr1 plazos
espera "2026-02 · Pagar la luz · ana · tareas/pendientes.md" "sin MEMORIA_DIR: plazos"
corre mr1 buscar pan --en alfa
espera "projects/alfa.md:$(grep -n -m1 -F 'Comprar pan.' "$REPO/projects/alfa.md" | cut -d: -f1) · Pendiente · Comprar pan." "sin MEMORIA_DIR: --en lee la nota por el servidor y busca aquí"
espera "  ↳ (cambiada el $ALTA) Proyecto alfa de juguete" "sin MEMORIA_DIR: --en con la fecha que da el servidor (updated_at de read)"
corre mr1 buscar moka --regex
rc_es 2 "sin MEMORIA_DIR: --regex falla (necesita la copia local)"
espera "define MEMORIA_DIR" "…y lo dice"
corre mr1 leer largo
espera " · cambiada el $ALTA · " "sin MEMORIA_DIR: la fecha en la cabecera de leer"

# --- 0d. la ayuda y los comandos: escribir una nota, primero -------------------------------------------------------------

corre m1 --help
[ "$(grep -n '^Escribir una nota' <<<"$SAL" | cut -d: -f1)" -lt "$(grep -n '^Cambios de varias notas' <<<"$SAL" | cut -d: -f1)" ] \
  && ok "ayuda: escribir una nota va antes que la copia de trabajo" || mal "ayuda: escribir una nota va antes que la copia de trabajo"
espera "memoria borrar <nota> --razon <texto> --si" "ayuda: borrar pide --si"
espera "--en <nota>" "ayuda: buscar --en"
espera "--tipo T" "ayuda: buscar --tipo"
espera "memoria plazos [--carpeta X] [--sin-plazo] [--hechas] [--limite N] [--json]" "ayuda: plazos"
no_espera "BADULAQUE" "ayuda: no queda nada de la pasarela"
espera 'Las notas en bruto están en $MEMORIA_DIR' "ayuda: las notas en bruto, para rg -n"
no_espera "badulaque memoria" "ayuda: nada pasa por «badulaque memoria»"
corre m1 buscr x
espera "Comandos: buscar, plazos, leer, lista, recientes, crear, editar, escribir, mover, borrar" "error de comando: lista primero leer y escribir una nota"
printf -- '---\nname: Alias\ndescription: Nota de los alias\n---\n# Alias\nx\n' > "$T/alias.md"
corre m1 write topics/cafe --razon "alias" --archivo "$T/alias.md" --simular
espera '"herramienta": "write"' "alias: write es escribir"
corre m1 move topics/cafe topics/cafe-dos --razon "alias" --simular
espera '"herramienta": "move"' "alias: move es mover"
corre m1 mv topics/cafe topics/cafe-dos --razon "alias" --simular
espera '"herramienta": "move"' "alias: mv es mover"
corre m1 create topics/alias --razon "alias" --archivo "$T/alias.md" --simular
espera '"herramienta": "create"' "alias: create es crear"
corre m1 edit topics/cafe --razon "alias" --viejo moka --nuevo moca --simular
espera '"herramienta": "edit"' "alias: edit es editar"
antes=$(srv_head)
corre m1 delete topics/vieja --razon "alias" --si
rc_es 2 "alias: delete no borra (no hay alias para borrar)"
espera "memoria borrar <nota> --razon <texto> --si" "alias: …pero dice cómo se borra"
corre m1 rm topics/vieja --razon "alias" --si
rc_es 2 "alias: rm tampoco"
corre m1 borrar topics/vieja --razon "sin si"
rc_es 2 "borrar sin --si: no borra (rc 2)"
espera "repite con --si" "borrar sin --si: dice cómo"
corre m1 borrar topics/vieja --razon "simulado" --simular
espera '"herramienta": "delete"' "borrar --simular: enseña la llamada sin --si"
[ "$(srv_head)" = "$antes" ] && [ -f "$REPO/topics/vieja.md" ] && ok "alias y borrar sin --si: el servidor no cambió" || mal "alias y borrar sin --si: el servidor no cambió"

# --- 1. la copia ----------------------------------------------------------------------------------------------

corre m1 copia
espera "copia de trabajo lista" "copia: crea la copia de trabajo"
[ -f "$T/copia1/projects/alfa.md" ] && ok "copia: tiene las notas" || mal "copia: tiene las notas"
[ -z "$(c1 remote)" ] && ok "copia: sin remoto (un git push no puede llegar a las notas)" || mal "copia: sin remoto"
corre m1 copia
espera "ya tienes copia" "copia: repetirla no rompe nada"
corre m1 estado
espera "por publicar: nada" "estado: limpio al principio"
espera "servidor: sin cambios nuevos" "estado: servidor sin novedades"
corre m1 publicar
espera "no hay nada que publicar" "publicar sin nada: lo dice"

# --- 2. publicar: cambio, nota nueva, mover y borrar -------------------------------------------------------------

sed_en_sitio 's/Comprar pan\./Comprar pan y leche./' "$T/copia1/projects/alfa.md"
printf -- '---\nname: Beta\ndescription: Otro proyecto de juguete\n---\n# Beta\nNota nueva, ligada a [[alfa]].\n' > "$T/copia1/projects/beta.md"
corre m1 publicar
espera "tienes cambios sin commitear" "publicar: con cambios sin commitear, no hace nada"
rc_es 1 "publicar: …y sale con 1"
c1 add projects/alfa.md && c1 commit -q -m "Alfa: comprar también leche"
corre m1 publicar --simular
espera "write projects/alfa.md" "simular: enseña el cambio"
espera "todo en orden" "simular: dice que todo va bien"
[ "$(srv_head)" = "$(srv rev-parse main)" ] && [ "$(srv log --oneline | lineas)" = 1 ] && ok "simular: no escribió nada en el servidor" || mal "simular: no escribió nada en el servidor"
corre m1 publicar --razon "Beta: nota nueva de juguete"
espera "publicado: 2 commits" "publicar: dos commits publicados"
if [ "$CON_PUBLISH" = 1 ]; then espera "(en un solo envío)" "publicar: con publish en el servidor, va en un solo envío"
else no_espera "en un solo envío" "publicar: sin publish en el servidor, nota a nota"; fi
espera "tu copia queda igual que el servidor" "publicar: la copia queda como el servidor"
[ "$(srv log --oneline | lineas)" = 3 ] && ok "servidor: tiene 2 commits nuevos" || mal "servidor: tiene 2 commits nuevos" "$(srv log --oneline | lineas)"
ult=$(srv log -2 --format='%an|%s|%(trailers:key=Client,valueonly,unfold)|%(trailers:key=Tool,valueonly,unfold)' | tr '\n' ' ' | sed 's/ |/|/g')
# Con publish, la herramienta de los dos commits es publish; nota a nota, create y write.
if [ "$CON_PUBLISH" = 1 ]; then H_CREAR=publish H_ESCRIBIR=publish; else H_CREAR=create H_ESCRIBIR=write; fi
case "$ult" in *"Agente Uno|Beta: nota nueva de juguete|agente1|$H_CREAR"*"Agente Uno|Alfa: comprar también leche|agente1|$H_ESCRIBIR"*) ok "servidor: commits firmados por el agente con la razón por mensaje ($H_CREAR, $H_ESCRIBIR)" ;; *) mal "servidor: commits firmados por el agente" "$ult" ;; esac
grep -q "leche" "$REPO/projects/alfa.md" && [ -f "$REPO/projects/beta.md" ] && ok "servidor: tiene el cambio y la nota nueva" || mal "servidor: tiene el cambio y la nota nueva"
[ "$(c1 rev-parse HEAD)" = "$(srv_head)" ] && ok "copia: HEAD igual al del servidor" || mal "copia: HEAD igual al del servidor"
c1 rev-parse -q --verify refs/memoria/publicado >/dev/null && ok "copia: tus commits quedan en refs/memoria/publicado" || mal "copia: refs/memoria/publicado"
corre m1 recientes 2
espera "agente1 · $H_CREAR · Beta: nota nueva de juguete" "recientes: el commit sale con el agente y la herramienta"
# La fecha de los resultados es la del último cambio: la de hoy (la del servidor) para alfa; la del alta para ana.
hoy_alfa=$(srv log -1 --format=%as -- projects/alfa.md)
corre m1 buscar leche
espera "  ↳ (cambiada el $hoy_alfa) Proyecto alfa de juguete" "fecha: la del último cambio de la nota (el que se acaba de publicar)"
no_espera "cambiada el $ALTA) Proyecto alfa" "fecha: …no la del alta"
corre m1 buscar "Le gusta el café"
espera "  ↳ (cambiada el $ALTA) Amiga de juguete" "fecha: una nota sin cambios conserva la del alta"
corre m1 leer largo
[ "$(jq -r .cabeza "$CACHE" 2>/dev/null)" = "$(srv_head)" ] && ok "fechas: la caché sigue al HEAD nuevo (solo los commits nuevos)" || mal "fechas: la caché sigue al HEAD nuevo"

# mover (con reescritura de enlaces) y borrar, en commits distintos; un borrado con su enlace quitado antes
c1 mv topics/cafe.md topics/espresso.md
c1 add -A && c1 commit -q -m "Café pasa a llamarse espresso"
c1 rm -q topics/vieja.md && c1 commit -q -m "Borrar la nota vieja"
corre m1 publicar
espera "mover topics/cafe.md → topics/espresso.md" "publicar: mueve una nota"
espera "borrar topics/vieja.md" "publicar: borra una nota"
[ -f "$REPO/topics/espresso.md" ] && [ ! -f "$REPO/topics/cafe.md" ] && [ ! -f "$REPO/topics/vieja.md" ] && ok "servidor: movida y borrada" || mal "servidor: movida y borrada"

# --- 3. los cambios de otro no se pisan ----------------------------------------------------------------------------

corre m2 copia
sed_en_sitio 's/Todo va bien\./Todo va muy bien./' "$T/copia1/projects/alfa.md"
c1 commit -q -am "Alfa: el estado, mejor"
sed_en_sitio 's/Todo va bien\./Todo va fatal./' "$T/copia2/projects/alfa.md"
c2 commit -q -am "Alfa: el estado, peor"
corre m2 publicar
espera "publicado: 1 commits" "agente dos publica su cambio"
corre m1 estado
espera "choca: projects/alfa.md la cambió agente2" "estado: avisa de que otro cambió la misma nota"
corre m1 publicar
rc_es 1 "publicar con choque: se niega"
espera "no publico nada" "publicar con choque: no publica nada"
grep -q "muy bien" "$REPO/projects/alfa.md" && mal "servidor: el cambio ajeno se pisó" || ok "servidor: el cambio de otro sigue ahí"
corre m1 actualizar
rc_es 1 "actualizar con choque real: para"
espera "no he tocado nada" "actualizar con choque real: no toca la copia"
[ -z "$(c1 status --porcelain)" ] && [ -z "$(c1 rev-parse -q --verify REBASE_HEAD)" ] && ok "copia: sin rebase a medias" || mal "copia: sin rebase a medias"
# lo resuelve el agente a su manera: descarta su commit y vuelve a empezar
c1 reset -q --hard refs/memoria/servidor
corre m1 estado
espera "por publicar: nada" "tras descartar su commit, la copia está al día"

# cambios en notas distintas no chocan, aunque el servidor haya avanzado
printf '\nAna también toma té.\n' >> "$T/copia1/people/ana.md"
c1 commit -q -am "Ana: toma té"
corre m2 actualizar
sed_en_sitio 's/Espresso, filtrado y moka\./Espresso, filtrado, moka y cold brew./' "$T/copia2/topics/espresso.md"
c2 commit -q -am "Espresso: cold brew"
corre m2 publicar
corre m1 estado
espera "servidor: 1 commits nuevos" "estado: ve el commit del otro"
no_espera "choca:" "estado: no choca (notas distintas)"
corre m1 publicar
espera "publicado: 1 commits" "publicar con el servidor adelantado pero sin choque: sí publica"
grep -q "cold brew" "$REPO/topics/espresso.md" && grep -q "té" "$REPO/people/ana.md" && ok "servidor: tiene los dos cambios" || mal "servidor: tiene los dos cambios"

# actualizar: sin commits propios es un avance; con commits propios los rebasa
corre m1 actualizar
espera "ya está al día" "actualizar: ya al día"
printf '\nOtra línea de Beta.\n' >> "$T/copia2/projects/beta.md"
c2 commit -q -am "Beta: otra línea"
corre m2 publicar
printf '\nNota local sin publicar.\n' >> "$T/copia1/people/ana.md"
c1 commit -q -am "Ana: nota local"
corre m1 actualizar
espera "y tus 1 commits encima" "actualizar: rebasa tus commits sobre lo nuevo"
grep -q "Otra línea de Beta" "$T/copia1/projects/beta.md" && ok "actualizar: la copia trae lo del otro" || mal "actualizar: la copia trae lo del otro"
corre m1 publicar
espera "publicado: 1 commits" "publicar tras actualizar"

# --- 4. las reglas, antes de enviar nada -----------------------------------------------------------------------------

antes=$(srv_head)
printf -- '---\nname: Mala\ndescription: Nombre con mayúsculas\n---\nx\n' > "$T/copia1/topics/MalNombre.md"
mkdir -p "$T/copia1/otra"; printf -- '---\nname: Fuera\ndescription: Carpeta no permitida\n---\nx\n' > "$T/copia1/otra/fuera.md"
printf -- '---\nname: Sin descripción\n---\nx\n' > "$T/copia1/topics/sin-descripcion.md"
printf 'binario' > "$T/copia1/topics/foto.png"
corre m1 publicar --razon "Notas que no pasan las reglas"
rc_es 1 "reglas: se niega"
espera "no pasaría las reglas" "reglas: lo explica"
espera "MalNombre.md: el nombre no sigue el patrón" "reglas: nombre con mayúsculas"
espera "«otra» no es una carpeta permitida" "reglas: carpeta no permitida"
espera "falta «description» en el frontmatter" "reglas: falta un campo obligatorio"
espera "foto.png: no es una nota .md" "reglas: un adjunto no se publica así"
[ "$(srv_head)" = "$antes" ] && ok "reglas: no se envió nada al servidor" || mal "reglas: no se envió nada al servidor"
git -C "$T/copia1" reset -q --hard refs/memoria/servidor; git -C "$T/copia1" clean -qfd

# --- 5. el servidor también valida: fallo a medias y recuperación ------------------------------------------------------

printf -- '---\nname: Gamma\ndescription: Tercera nota de juguete\n---\n# Gamma\nBien.\n' > "$T/copia1/projects/gamma.md"
c1 add -A && c1 commit -q -m "Gamma: nota buena"
printf -- '---\nname: [roto\ndescription: frontmatter que no es YAML\n---\nx\n' > "$T/copia1/projects/delta.md"
c1 add -A && c1 commit -q -m "Delta: nota con el frontmatter roto"
printf -- '---\nname: Epsilon\ndescription: Quinta nota de juguete\n---\nx\n' > "$T/copia1/projects/epsilon.md"
c1 add -A && c1 commit -q -m "Epsilon: nota buena, detrás de la mala"
antes=$(srv_head)
corre m1 publicar
rc_es 1 "fallo del servidor: sale con 1"
espera "INVALID_FRONTMATTER" "fallo del servidor: da el motivo del servidor"
if [ "$CON_PUBLISH" = 1 ]; then
  # Con publish es todo o nada: no se guarda ni la primera, y la copia sigue con los 3 commits.
  espera "no he publicado nada (va todo en un solo envío: todo o nada)" "publish: si algo falla, no se publica nada"
  espera "Delta: nota con el frontmatter roto" "publish: dice qué commit falló"
  [ "$(srv_head)" = "$antes" ] && [ ! -f "$REPO/projects/gamma.md" ] && [ ! -f "$REPO/projects/delta.md" ] && ok "servidor (publish): ni la primera; sin rastro del envío" || mal "servidor (publish): ni la primera"
  [ -z "$(srv status --porcelain)" ] && ok "servidor (publish): árbol limpio tras el rechazo" || mal "servidor (publish): árbol limpio tras el rechazo"
  corre m1 estado
  espera "por publicar: 3 commits" "copia (publish): sigue con los 3 commits sin publicar"
  espera "Gamma: nota buena" "copia (publish): …también el bueno, que no se publicó"
else
  espera "publicadas 1 de 3 operaciones" "fallo del servidor: dice cuántas llegó a publicar"
  [ -f "$REPO/projects/gamma.md" ] && [ ! -f "$REPO/projects/delta.md" ] && [ ! -f "$REPO/projects/epsilon.md" ] && ok "servidor: solo la primera, y nada de las siguientes" || mal "servidor: solo la primera"
  corre m1 estado
  espera "por publicar: 2 commits" "copia: se queda con los 2 sin publicar, sobre lo ya publicado"
  no_espera "Gamma: nota buena" "copia: lo publicado ya no está pendiente"
fi
# se arregla la mala y se publica lo que falta
printf -- '---\nname: Delta\ndescription: Ya con YAML bueno\n---\nx\n' > "$T/copia1/projects/delta.md"
c1 commit -q -am "Delta: arreglada"
corre m1 publicar
rc_es 1 "con un commit intermedio malo, publicar uno a uno sigue fallando"
espera "memoria publicar --aplanar" "…y propone --aplanar"
corre m1 publicar --aplanar --simular
espera "create projects/delta.md" "aplanar (simulado): un solo crear de delta, ya arreglada"
corre m1 publicar --aplanar
rc_es 0 "aplanar: publica el resultado final de lo que faltaba"
[ -f "$REPO/projects/gamma.md" ] && [ -f "$REPO/projects/delta.md" ] && [ -f "$REPO/projects/epsilon.md" ] && ok "servidor: ya están gamma, delta y epsilon" || mal "servidor: ya están gamma, delta y epsilon"
grep -q "Ya con YAML bueno" "$REPO/projects/delta.md" && ok "aplanar: delta llega ya arreglada" || mal "aplanar: delta llega ya arreglada"

# --- 6. parecidas y confirmación; borrar con enlaces --------------------------------------------------------------------

printf -- '---\nname: Café\ndescription: Otra de café\n---\n# Café\nLo mismo, otra vez.\n' > "$T/copia1/topics/cafes.md"
c1 add -A && c1 commit -q -m "Café otra vez"
corre m1 publicar
rc_es 1 "parecida a otra: el servidor la frena"
espera "DUPLICATE_CANDIDATES" "parecida a otra: dice por qué"
espera "--confirmar-nueva" "parecida a otra: dice cómo seguir"
corre m1 publicar --confirmar-nueva
rc_es 0 "parecida a otra: con --confirmar-nueva pasa"

# borrar una nota enlazada, quitando el enlace en el mismo commit: va primero el cambio y luego el borrado
git -C "$T/copia1" rm -q projects/gamma.md
printf -- '---\nname: Ana\ndescription: Amiga de juguete\n---\n# Ana\nLe gusta el café.\n\n## Trabajo\nTrabaja en [[beta]].\n' > "$T/copia1/people/ana.md"
git -C "$T/copia1" rm -q projects/beta.md
c1 add -A && c1 commit -q -m "Ana: ya no enlaza a nadie; fuera gamma y beta"
corre m1 publicar
espera "HAS_BACKLINKS" "borrar una nota que otra enlaza: lo frena el servidor"
c1 reset -q --hard refs/memoria/servidor
c1 status --porcelain | grep -q . && mal "copia limpia tras el fallo" || ok "copia limpia tras el fallo"

# --- 6b. el resto de las herramientas del servidor: historial, enlaces, revisar, escribir, mover, borrar, revertir ------------

corre m1 historial topics/cafes
rc_es 0 "historial: de una nota"
espera "Café otra vez" "historial: sale la razón del commit"
espera "(1 commit de topics/cafes.md)" "historial: acaba con el total"
corre m1 historial topics/cafes --json
espera '"commit"' "historial --json: da los commits"
corre m1 enlaces ana
rc_es 0 "enlaces: de una nota"
espera "salientes" "enlaces: acaba con los totales"
corre m1 enlaces ana --entrantes
no_espera "salientes" "enlaces --entrantes: solo cuenta los que llegan"
corre m1 enlaces ana --entrantes --salientes
rc_es 2 "enlaces: --entrantes y --salientes juntos son un error de uso"
corre m1 revisar --limite 3
rc_es 0 "revisar: candidatos de mantenimiento"
espera "candidatos" "revisar: acaba con el total"
corre m1 revisar --tipos orphan --json
espera '"items"' "revisar --json"
antes=$(srv_head)
printf -- '---\nname: Café\ndescription: Otra de café, reescrita\n---\n# Café\nReescrita entera por memoria escribir.\n' > "$T/nueva-cafes.md"
corre m1 escribir topics/cafes --razon "Reescribir cafés" --archivo "$T/nueva-cafes.md" --simular
espera '"simulado": true' "escribir --simular: enseña la llamada"
[ "$(srv_head)" = "$antes" ] && ok "escribir --simular: no escribió nada" || mal "escribir --simular: no escribió nada"
corre m1 escribir topics/cafes --razon "Reescribir cafés" --archivo "$T/nueva-cafes.md"
rc_es 0 "escribir: toma el hash de ahora y reemplaza la nota"
grep -q "Reescrita entera" "$REPO/topics/cafes.md" && ok "escribir: el servidor tiene la nota nueva" || mal "escribir: el servidor tiene la nota nueva"
corre m1 escribir topics/cafes --razon "Mal hash" --archivo "$T/nueva-cafes.md" --hash 0000000000000000
[ "$RC" != 0 ] && ok "escribir con un hash viejo: falla y no pisa" || mal "escribir con un hash viejo: falla" "$SAL"
corre m1 mover topics/cafes topics/cafes-juntos --razon "Renombrar cafés"
rc_es 0 "mover: renombra"
[ -f "$REPO/topics/cafes-juntos.md" ] && [ ! -f "$REPO/topics/cafes.md" ] && ok "mover: el servidor la tiene en su sitio nuevo" || mal "mover: el servidor la tiene en su sitio nuevo"
ult=$(srv log -1 --format=%H)
corre m1 revertir "$ult" --razon "Deshacer el renombrado" --simular
espera '"simulado": true' "revertir --simular"
corre m1 revertir "$ult" --razon "Deshacer el renombrado"
rc_es 0 "revertir: deshace el commit"
[ -f "$REPO/topics/cafes.md" ] && [ ! -f "$REPO/topics/cafes-juntos.md" ] && ok "revertir: la nota vuelve a su sitio" || mal "revertir: la nota vuelve a su sitio"
corre m1 borrar topics/cafes --razon "Fuera cafés" --simular
espera '"simulado": true' "borrar --simular"
corre m1 borrar topics/cafes --razon "Fuera cafés"
rc_es 2 "borrar sin --si: no la quita"
[ -f "$REPO/topics/cafes.md" ] && ok "borrar sin --si: el servidor la conserva" || mal "borrar sin --si: el servidor la conserva"
corre m1 borrar topics/cafes --razon "Fuera cafés" --si
rc_es 0 "borrar --si: la quita"
[ ! -f "$REPO/topics/cafes.md" ] && ok "borrar: el servidor ya no la tiene" || mal "borrar: el servidor ya no la tiene"
corre m1 adjuntar docs/x.pdf --archivo "$T/nueva-cafes.md" --descripcion "Una prueba" --razon "Adjunto" --simular
espera '"herramienta": "attach"' "adjuntar --simular: enseña la llamada"
corre m1 adjuntar docs/x.pdf --descripcion "Una prueba" --razon "Adjunto"
rc_es 2 "adjuntar sin --archivo: error de uso"
corre m1 borrar topics/nada-de-nada --razon "x" --si
[ "$RC" = 1 ] && ok "borrar una nota que no existe: falla (rc 1, del servidor)" || mal "borrar una nota que no existe: falla" "rc=$RC $SAL"
c1 fetch -q 2>/dev/null; m1 actualizar >/dev/null 2>&1

# --- 6c. partir una nota: sus líneas de «## Fuentes» pasan a otra en un mismo envío (publish) ----------------------------------
# Con reglas al escribir, una línea de Fuentes no se puede quitar (append_only)… salvo que entre, tal cual, en las Fuentes de otra
# nota del mismo envío. Solo con publish: nota a nota, la escritura de la madre se rechazaría sola.
if [ "$CON_PUBLISH" = 1 ]; then
  printf -- '---\nname: Madre\ndescription: Nota de juguete que se parte\n---\n# Madre\nTexto.\n\n## Fuentes\n- fuente uno\n- fuente dos\n' > "$T/copia1/projects/madre.md"
  c1 add -A && c1 commit -q -m "Madre: nota con fuentes"
  corre m1 publicar
  rc_es 0 "partir: la nota madre, publicada"
  antes=$(srv_head)
  sed_en_sitio '/- fuente dos/d' "$T/copia1/projects/madre.md"
  c1 commit -q -am "Madre: quitar una fuente"
  corre m1 publicar
  rc_es 1 "partir: quitar una línea de Fuentes sin llevarla a otra nota, rechazado"
  espera "RULES_VIOLATED" "partir: …por las reglas"
  [ "$(srv_head)" = "$antes" ] && ok "partir: …sin guardar nada" || mal "partir: …sin guardar nada"
  printf -- '---\nname: Hija\ndescription: La parte que sale de madre\n---\n# Hija\nTexto.\n\n## Fuentes\n- fuente dos\n' > "$T/copia1/projects/hija.md"
  c1 add -A && c1 commit -q -m "Hija: sale de madre con su fuente"
  corre m1 publicar
  rc_es 0 "partir: con la línea en las Fuentes de otra nota del mismo envío (dos commits), publicado"
  espera "publicado: 2 commits" "partir: …los dos commits"
  { grep -q "fuente dos" "$REPO/projects/hija.md" && ! grep -q "fuente dos" "$REPO/projects/madre.md"; } && ok "partir: el servidor tiene la línea en la hija y no en la madre" || mal "partir: el servidor tiene la línea en la hija y no en la madre"
  [ "$(srv log -2 --format=%s | tr '\n' '|')" = "Hija: sale de madre con su fuente|Madre: quitar una fuente|" ] && ok "partir: un commit del servidor por cada uno de la copia, con su razón" || mal "partir: un commit del servidor por cada uno de la copia" "$(srv log -2 --format=%s | tr '\n' '|')"
else
  echo "OMITIDA partir una nota en un envío: este cli-memoria no tiene publish"
fi

# --- 6d. sin copia local: crear, editar y lo demás, por el servidor (MEMORIA_URL + MEMORIA_TOKEN) ----------------------------

printf -- '---\nname: Directa\ndescription: Nota creada sin copia local\n---\n# Directa\nCreada sin MEMORIA_DIR.\n' > "$T/directa.md"
corre mr1 crear topics/directa --razon "Prueba sin copia local" --archivo "$T/directa.md" --simular
rc_es 0 "sin MEMORIA_DIR: crear --simular"
espera '"herramienta": "create"' "sin MEMORIA_DIR: …y enseña la herramienta por su nombre"
corre mr1 crear topics/directa --razon "Prueba sin copia local" --archivo "$T/directa.md"
rc_es 0 "sin MEMORIA_DIR: crear escribe en el servidor"
[ -f "$REPO/topics/directa.md" ] && ok "sin MEMORIA_DIR: la nota está en el repositorio del servidor" || mal "sin MEMORIA_DIR: la nota no se creó"
corre mr1 editar topics/directa --razon "Editar sin copia local" --viejo "Creada sin MEMORIA_DIR." --nuevo "Editada sin MEMORIA_DIR."
rc_es 0 "sin MEMORIA_DIR: editar"
grep -q "Editada sin MEMORIA_DIR." "$REPO/topics/directa.md" && ok "sin MEMORIA_DIR: la edición está en el servidor" || mal "sin MEMORIA_DIR: la edición no está"
corre mr1 historial topics/directa
rc_es 0 "sin MEMORIA_DIR: historial"
espera "Editar sin copia local" "sin MEMORIA_DIR: historial con la razón"
corre mr1 revisar
rc_es 0 "sin MEMORIA_DIR: revisar"
corre mr1 buscar directa --carpeta topics
espera "topics/directa.md" "sin MEMORIA_DIR: buscar encuentra la nota recién escrita"

# --- 7. el repositorio de las notas no se toca a mano -----------------------------------------------------------------------

srv fsck --no-dangling >/dev/null 2>&1 && ok "servidor: el repositorio sigue sano (git fsck)" || mal "servidor: git fsck"
[ -z "$(srv status --porcelain)" ] && ok "servidor: árbol de trabajo limpio" || mal "servidor: árbol de trabajo limpio"
c1 push >/dev/null 2>&1; [ $? -ne 0 ] && ok "copia: un git push no tiene adónde ir" || mal "copia: git push"
corre m1 crear --simular nota-suelta --razon prueba - </dev/null
rc_es 2 "crear sigue ahí (falta el contenido: error de uso, no de otra cosa)"
# la clave nunca sale en los mensajes
if grep -q "mm_" <<<"$SAL$(cat "$T/mm.log")$(cat "$T/juguete.log" 2>/dev/null)"; then mal "ningún token en las salidas"; else ok "ningún token en las salidas"; fi

if [ "$fallos" -gt 0 ]; then
  echo "Fallaron $fallos comprobaciones."
  exit 1
fi
echo "Todas las pruebas pasaron."
