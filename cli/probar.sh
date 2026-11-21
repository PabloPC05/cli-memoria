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
