#!/usr/bin/env bash
# Prueba de escribir en nativo (memoria copia, estado, actualizar y publicar) contra un servidor my-memory DE VERDAD
# (el binario real, con su índice, sus reglas, sus firmas por token y su cola de escritura), pero de juguete: una carpeta
# temporal que crea y borra este script, un repositorio de notas inventado y dos agentes de juguete. No toca ninguna
# memoria real ni ningún servicio de lisa.
#
# Entre la CLI y my-memory pone una pasarela mínima (la misma que el Badulaque para estas llamadas: buscador_usar con
# «memoria_<herramienta>»), con una clave por agente que se traduce a su token de my-memory.
#
# Uso:  NODE=<node 22 o más> MY_MEMORY=<my-memory> kit/memoria/probar.sh
# Requiere git, curl y jq. Imprime OK o FALLO por prueba y sale con 1 si alguna falla.
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${NODE:?falta NODE}" "${MY_MEMORY:?falta MY_MEMORY}"
for h in git curl jq; do command -v "$h" >/dev/null || { echo "Falta $h" >&2; exit 2; }; done

T="$(mktemp -d "${TMPDIR:-/tmp}/probar-memoria.XXXXXX")"
PIDS=()
limpiar() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
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

# --- el servidor de juguete -------------------------------------------------------------------------------

DATOS="$T/datos"
REPO="$DATOS/repo"
mkdir -p "$REPO/people" "$REPO/projects" "$REPO/topics" "$REPO/archive"
(
  cd "$REPO" || exit 1
  git init -q -b main . && git config user.email t@t && git config user.name t
  cat > memory.toml <<'TOML'
[folders]
allowed = ["people", "projects", "topics", "archive"]
archive = "archive"

[notes]
required_fields = ["name", "description"]
filename_pattern = "^[a-z0-9]+(-[a-z0-9]+)*\\.md$"
TOML
  printf '# Reglas de juguete\nEscribe en español.\n' > AGENTS.md
  printf -- '---\nname: Ana\ndescription: Amiga de juguete\n---\n# Ana\nLe gusta el café.\n\n## Trabajo\nTrabaja en [[alfa]].\n' > people/ana.md
  printf -- '---\nname: Alfa\ndescription: Proyecto alfa de juguete\n---\n# Alfa\nPrimera línea.\n\n## Estado\nTodo va bien.\n\n## Pendiente\nComprar pan.\n' > projects/alfa.md
  printf -- '---\nname: Café\ndescription: Notas sobre el café\n---\n# Café\nEspresso, filtrado y moka.\n' > topics/cafe.md
  printf -- '---\nname: Vieja\ndescription: Nota de juguete para borrar\n---\n# Vieja\nYa no sirve.\n' > topics/vieja.md
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
  git add -A && git commit -q -m "alta de juguete"
) || { echo "no pude crear las notas de juguete" >&2; exit 2; }

PUERTO_MM=$(( 20000 + RANDOM % 10000 ))
PUERTO_PA=$(( 30000 + RANDOM % 10000 ))
cat > "$T/config.toml" <<TOML
data_dir = "$DATOS"
tokens_file = "$T/tokens.toml"
[listen.private]
address = "127.0.0.1"
port = $PUERTO_MM
TOML
# Los tokens salen solo a variables; no se imprimen.
TOK1=$("$MY_MEMORY" token add agente1 --name "Agente Uno" --scope write --file "$T/tokens.toml" | grep -o 'mm_[A-Za-z0-9_-]*' | head -1)
TOK2=$("$MY_MEMORY" token add agente2 --name "Agente Dos" --scope write --file "$T/tokens.toml" | grep -o 'mm_[A-Za-z0-9_-]*' | head -1)
[ -n "$TOK1" ] && [ -n "$TOK2" ] || { echo "no pude crear los tokens de juguete" >&2; exit 2; }
"$MY_MEMORY" serve --config "$T/config.toml" > "$T/mm.log" 2>&1 &
PIDS+=($!)

# La pasarela de juguete: clave de agente -> token de my-memory; buscador_usar{nombre:"memoria_x"} -> tools/call x.
cat > "$T/pasarela.mjs" <<'JS'
import { createServer } from "node:http";
const tokens = Object.fromEntries(process.env.CLAVES.split(",").map(p => p.split("=")));
const destino = `http://127.0.0.1:${process.env.PUERTO_MM}/mcp`;
const leer = req => new Promise(r => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => r(b)); });
createServer(async (req, res) => {
  const clave = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!tokens[clave]) { res.writeHead(401).end(); return; }
  if (req.method === "DELETE") { res.writeHead(200).end(); return; }
  const m = JSON.parse((await leer(req)) || "{}");
  const json = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }).end(JSON.stringify(o)); };
  if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "pasarela-de-juguete", version: "0" } } }, { "mcp-session-id": "s1" });
  if (m.method === "notifications/initialized") { res.writeHead(202).end(); return; }
  if (m.method === "tools/call" && m.params.name === "buscador_usar") {
    const { nombre, argumentos } = m.params.arguments;
    const r = await fetch(destino, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens[clave]}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: nombre.replace(/^memoria_/, ""), arguments: argumentos } })
    });
    const texto = await r.text();
    const linea = texto.startsWith("{") ? texto : texto.split("\n").find(l => l.startsWith("data:"))?.slice(5);
    return json({ jsonrpc: "2.0", id: m.id, result: JSON.parse(linea).result });
  }
  json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
}).listen(Number(process.env.PUERTO_PA), "127.0.0.1");
JS
CLAVES="clave-uno=$TOK1,clave-dos=$TOK2" PUERTO_MM="$PUERTO_MM" PUERTO_PA="$PUERTO_PA" "$NODE" "$T/pasarela.mjs" > "$T/pasarela.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PUERTO_MM/mcp" && curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PA/" && break
  sleep 0.2
done
grep -q "listening\|started\|serve" "$T/mm.log" 2>/dev/null || sleep 1
curl -s -o /dev/null "http://127.0.0.1:$PUERTO_MM/mcp" || { echo "my-memory no arrancó:"; cat "$T/mm.log"; exit 2; }

# --- cómo se llama a la CLI -------------------------------------------------------------------------------------

# m1 y m2: los agentes uno y dos, cada uno con su copia de trabajo y su clave.
m1() { MEMORIA_DIR="$REPO" MEMORIA_COPIA="$T/copia1" HOME="$T/h1" BADULAQUE_CLAVE=clave-uno BADULAQUE_URL="http://127.0.0.1:$PUERTO_PA/" "$NODE" "$AQUI/memoria.mjs" "$@"; }
m2() { MEMORIA_DIR="$REPO" MEMORIA_COPIA="$T/copia2" HOME="$T/h2" BADULAQUE_CLAVE=clave-dos BADULAQUE_URL="http://127.0.0.1:$PUERTO_PA/" "$NODE" "$AQUI/memoria.mjs" "$@"; }
# mr1: lo mismo que m1 pero sin MEMORIA_DIR (como en el Mac): la lectura va por la pasarela, no por el disco.
mr1() { MEMORIA_DIR="" MEMORIA_COPIA="$T/copiar" HOME="$T/h1" BADULAQUE_CLAVE=clave-uno BADULAQUE_URL="http://127.0.0.1:$PUERTO_PA/" "$NODE" "$AQUI/memoria.mjs" "$@"; }
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

# --- 0. leer y buscar con salida navegable ---------------------------------------------------------------------

L="$REPO/projects/largo.md"
linea_de() { grep -n -m1 -F -- "$1" "$L" | cut -d: -f1; }
corre m1 leer cafe
espera "Espresso, filtrado y moka" "leer: una nota corta sale entera"
no_espera "nota larga" "leer: una corta no lleva índice ni aviso"
corre m1 leer largo
espera "nota larga: lee una sección con --seccion '<título>' o un rango con --lineas A-B" "leer larga: el aviso de una línea"
espera "hash: $(git -C "$REPO" hash-object "$L")" "leer larga: la cabecera lleva el hash de la nota"
espera "descripción: Nota larga de juguete" "leer larga: la cabecera lleva la descripción"
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

corre m1 buscar zorro-azul
espera "projects/largo.md:$(linea_de zorro-azul) · Pendiente › Cola 5 · - zorro-azul" "buscar: ruta:línea · sección · fragmento"
espera "(1 resultado)" "buscar: dice el total (uno)"
corre m1 buscar CANCION --carpeta projects
espera "· Acentuación · Café y canción." "buscar: sin acentos y con su sección"
corre m1 buscar juguete --carpeta projects
espera "projects/alfa.md:3 · cabecera · description: Proyecto alfa" "buscar: un acierto en el frontmatter dice «cabecera»"
corre m1 buscar tarea --limite 5
espera "(200 resultados; mostrando 1-5: --pagina 2 (o --limite N))" "buscar: total, lo que muestra y cómo seguir"
[ "$(m1 buscar tarea --limite 5 | wc -l)" = 6 ] && ok "buscar: cinco líneas y el aviso" || mal "buscar: cinco líneas y el aviso"
corre m1 buscar tarea --limite 5 --pagina 2
espera "tarea 1.5:" "buscar: la página 2 sigue por donde iba"
no_espera "tarea 1.4:" "buscar: …sin repetir"
espera "mostrando 6-10" "buscar: …y dice dónde va"
corre m1 buscar tarea --limite 5 --pagina 40
espera "mostrando 196-200" "buscar: la última página no dice cómo seguir"
no_espera "--pagina 41" "buscar: …porque no hay más"
corre m1 buscar tarea --limite 5 --pagina 41
rc_es 2 "buscar: una página que no existe falla (rc 2)"
corre m1 buscar nadadenada
espera "(0 resultados)" "buscar: sin resultados, lo dice"
corre m1 buscar zorro-azul --json
espera '"seccion": "Pendiente › Cola 5"' "buscar --json: lleva la sección"
corre m1 lista projects --limite 1
espera "(2 notas; mostrando 1: --pagina 2 (o --limite N))" "lista: total y paginación"

# lo mismo por el Badulaque (sin MEMORIA_DIR, como en el Mac)
corre mr1 leer largo
espera "nota larga: lee una sección con --seccion" "remoto leer larga: el índice"
espera "hash: " "remoto leer larga: con su hash"
corre mr1 leer largo --seccion estado
espera "Todo va bien." "remoto seccion: solo esa sección"
no_espera "tarea" "remoto seccion: …y nada más"
corre mr1 leer cafe
espera "Espresso, filtrado y moka" "remoto leer corta: entera"
corre mr1 buscar zorro-azul
espera "projects/largo.md:" "remoto buscar: la ruta"
espera "(1 resultado)" "remoto buscar: el total"

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

sed -i 's/Comprar pan\./Comprar pan y leche./' "$T/copia1/projects/alfa.md"
printf -- '---\nname: Beta\ndescription: Otro proyecto de juguete\n---\n# Beta\nNota nueva, ligada a [[alfa]].\n' > "$T/copia1/projects/beta.md"
corre m1 publicar
espera "tienes cambios sin commitear" "publicar: con cambios sin commitear, no hace nada"
rc_es 1 "publicar: …y sale con 1"
c1 add projects/alfa.md && c1 commit -q -m "Alfa: comprar también leche"
corre m1 publicar --simular
espera "memoria_write projects/alfa.md" "simular: enseña el cambio"
espera "todo en orden" "simular: dice que todo va bien"
[ "$(srv_head)" = "$(srv rev-parse main)" ] && [ "$(srv log --oneline | wc -l)" = 1 ] && ok "simular: no escribió nada en el servidor" || mal "simular: no escribió nada en el servidor"
corre m1 publicar --razon "Beta: nota nueva de juguete"
espera "publicado: 2 commits" "publicar: dos commits publicados"
espera "tu copia queda igual que el servidor" "publicar: la copia queda como el servidor"
[ "$(srv log --oneline | wc -l)" = 3 ] && ok "servidor: tiene 2 commits nuevos" || mal "servidor: tiene 2 commits nuevos" "$(srv log --oneline | wc -l)"
ult=$(srv log -2 --format='%an|%s|%(trailers:key=Client,valueonly,unfold)|%(trailers:key=Tool,valueonly,unfold)' | tr '\n' ' ')
case "$ult" in *"Agente Uno|Beta: nota nueva de juguete|agente1|create"*"Agente Uno|Alfa: comprar también leche|agente1|write"*|*"Agente Uno|Beta: nota nueva de juguete|agente1 |create"*"Agente Uno|Alfa: comprar también leche|agente1 |write"*) ok "servidor: commits firmados por el agente con la razón por mensaje" ;; *) mal "servidor: commits firmados por el agente" "$ult" ;; esac
grep -q "leche" "$REPO/projects/alfa.md" && [ -f "$REPO/projects/beta.md" ] && ok "servidor: tiene el cambio y la nota nueva" || mal "servidor: tiene el cambio y la nota nueva"
[ "$(c1 rev-parse HEAD)" = "$(srv_head)" ] && ok "copia: HEAD igual al del servidor" || mal "copia: HEAD igual al del servidor"
c1 rev-parse -q --verify refs/memoria/publicado >/dev/null && ok "copia: tus commits quedan en refs/memoria/publicado" || mal "copia: refs/memoria/publicado"
corre m1 recientes 2
espera "agente1 · create · Beta: nota nueva de juguete" "recientes: el commit sale con el agente y la herramienta"

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
sed -i 's/Todo va bien\./Todo va muy bien./' "$T/copia1/projects/alfa.md"
c1 commit -q -am "Alfa: el estado, mejor"
sed -i 's/Todo va bien\./Todo va fatal./' "$T/copia2/projects/alfa.md"
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
sed -i 's/Espresso, filtrado y moka\./Espresso, filtrado, moka y cold brew./' "$T/copia2/topics/espresso.md"
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
corre m1 publicar
rc_es 1 "fallo del servidor: sale con 1"
espera "publicadas 1 de 3 operaciones" "fallo del servidor: dice cuántas llegó a publicar"
espera "INVALID_FRONTMATTER" "fallo del servidor: da el motivo del servidor"
[ -f "$REPO/projects/gamma.md" ] && [ ! -f "$REPO/projects/delta.md" ] && [ ! -f "$REPO/projects/epsilon.md" ] && ok "servidor: solo la primera, y nada de las siguientes" || mal "servidor: solo la primera"
corre m1 estado
espera "por publicar: 2 commits" "copia: se queda con los 2 sin publicar, sobre lo ya publicado"
no_espera "Gamma: nota buena" "copia: lo publicado ya no está pendiente"
# se arregla la mala y se publica lo que falta
printf -- '---\nname: Delta\ndescription: Ya con YAML bueno\n---\nx\n' > "$T/copia1/projects/delta.md"
c1 commit -q -am "Delta: arreglada"
corre m1 publicar
rc_es 1 "con un commit intermedio malo, publicar uno a uno sigue fallando"
espera "memoria publicar --aplanar" "…y propone --aplanar"
corre m1 publicar --aplanar --simular
espera "memoria_create projects/delta.md" "aplanar (simulado): un solo crear de delta, ya arreglada"
corre m1 publicar --aplanar
rc_es 0 "aplanar: publica el resultado final de lo que faltaba"
[ -f "$REPO/projects/delta.md" ] && [ -f "$REPO/projects/epsilon.md" ] && ok "servidor: ya están delta y epsilon" || mal "servidor: ya están delta y epsilon"

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
rc_es 0 "borrar: la quita"
[ ! -f "$REPO/topics/cafes.md" ] && ok "borrar: el servidor ya no la tiene" || mal "borrar: el servidor ya no la tiene"
corre m1 adjuntar docs/x.pdf --archivo "$T/nueva-cafes.md" --descripcion "Una prueba" --razon "Adjunto" --simular
espera '"memoria_attach"' "adjuntar --simular: enseña la llamada"
corre m1 adjuntar docs/x.pdf --descripcion "Una prueba" --razon "Adjunto"
rc_es 2 "adjuntar sin --archivo: error de uso"
corre m1 borrar topics/nada-de-nada --razon "x"
[ "$RC" != 0 ] && ok "borrar una nota que no existe: falla" || mal "borrar una nota que no existe: falla"
c1 fetch -q 2>/dev/null; m1 actualizar >/dev/null 2>&1

# --- 7. el repositorio de las notas no se toca a mano -----------------------------------------------------------------------

srv fsck --no-dangling >/dev/null 2>&1 && ok "servidor: el repositorio sigue sano (git fsck)" || mal "servidor: git fsck"
[ -z "$(srv status --porcelain)" ] && ok "servidor: árbol de trabajo limpio" || mal "servidor: árbol de trabajo limpio"
c1 push >/dev/null 2>&1; [ $? -ne 0 ] && ok "copia: un git push no tiene adónde ir" || mal "copia: git push"
corre m1 crear --simular nota-suelta --razon prueba - </dev/null
rc_es 2 "crear sigue ahí (falta el contenido: error de uso, no de otra cosa)"
# la clave nunca sale en los mensajes
if grep -q "mm_" <<<"$SAL$(cat "$T/pasarela.log")"; then mal "ningún token en las salidas"; else ok "ningún token en las salidas"; fi

if [ "$fallos" -gt 0 ]; then
  echo "Fallaron $fallos comprobaciones."
  exit 1
fi
echo "Todas las pruebas pasaron."
