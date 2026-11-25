# cli-memoria

Una memoria autoalojada en git para agentes de IA: una **CLI compacta (`memoria`)** para agentes con terminal y un **servidor MCP sin estado (`cli-memoria`)** sobre notas Markdown en git. Cada escritura es un commit atribuido al agente que la hizo.

*[Read in English](README.md)*

> Mantén este archivo y [README.md](README.md) sincronizados: cuando edites uno, actualiza el otro.

- **Una CLI para agentes (`memoria`).** [cli/](cli/README.md) busca, lee y escribe las notas desde la terminal con salida compacta: lee directamente de una copia del repo de notas (`rg` + `git`) y escribe siempre a través del servidor (`MEMORIA_URL` + `MEMORIA_TOKEN`). Empaquetada en Nix como `memoria` para Linux y macOS, sin dependencias de npm.
- **Git es la fuente de verdad.** La búsqueda en el servidor va sobre un índice SQLite (catálogo, texto completo FTS5 por secciones, wikilinks) que se puede reconstruir desde git en cualquier momento.
- **Un commit por escritura**, con el cliente como autor: `Claude Code (laptop)`, `Codex`, etc. El mensaje del commit es el motivo que dio el agente, más los trailers `Client:` / `Tool:` / `Session:`.
- **Seguro con varios agentes a la vez.** Una sola cola de escritura, concurrencia optimista (el `hash` de `read`) y `publish` atómico de varios commits. El servidor es el único que escribe: no hay remoto git al que empujar ni del que traer.
- **Tus convenciones, no las nuestras.** El repo de notas declara sus carpetas, su frontmatter obligatorio, sus reglas de escritura y sus reglas de nombres en `memory.toml`; su `AGENTS.md` llega a todos los clientes como instrucciones MCP, junto con un índice corto.
- **Tokens fijos por agente.** Un token Bearer por agente (permiso `read` o `write`), guardado solo como hash SHA-256 y recargable con `SIGHUP`. Los tokens de solo lectura solo ven herramientas de lectura.
- **Adjuntos.** Los binarios van a git LFS con una nota al lado que contiene su texto (los PDF, con `pdftotext`; los PDF escaneados y las imágenes, con OCR local mediante `tesseract` si está instalado), así que también se encuentran al buscar.
- **Enlaces con tipo.** `works_at:: [[acme]]` dice qué significa un enlace, y `links` puede filtrar por él.

Cómo funciona por dentro (índice, flujo de escritura, concurrencia, autenticación): [docs/design.md](docs/design.md). Diseño y evaluación de las reglas de escritura: [docs/normas-al-escribir.md](docs/normas-al-escribir.md).

## La CLI `memoria`

`memoria` convierte la memoria en comandos de terminal para agentes: una línea por resultado con el total y cómo seguir, `--json` para filtrar con `jq` y `--simular` en todo lo que escribe. Los comandos están en español (`buscar`, `leer`, `lista`, `recientes`…) con alias en inglés (`search`, `read`, `list`, `recent`…). Sin dependencias de npm: Node 22 o más y unos `.mjs`.

```sh
nix run github:PabloPC05/cli-memoria#memoria -- --help
memoria buscar cocina --carpeta projects --limite 5
```

- **Lee** directamente de una copia del repo de notas cuando `MEMORIA_DIR` apunta a ella (con `rg` y `git`), o contra el servidor si no.
- **Escribe** siempre a través del servidor, así que firma con la credencial del agente y sigue `memory.toml`: una nota cada vez (`crear`, `editar`, `escribir`, `mover`, `borrar --si`), o, para cambios de varias notas a la vez, una copia de trabajo de git (`memoria copia`) cuyos commits `memoria publicar` envía en un solo `publish` atómico.
- **Directa al servidor (recomendado):** define `MEMORIA_URL` (p. ej. `http://127.0.0.1:8782/mcp`) y `MEMORIA_TOKEN` (`mm_…`) para hablar directamente por Streamable HTTP sin pasarela intermedia. Para instalaciones detrás de una pasarela que envuelve las herramientas como `memoria_<herramienta>` bajo `buscador_usar`, también admite `BADULAQUE_URL` y `BADULAQUE_CLAVE`.

Estructura, configuración, empaquetado y pruebas: [cli/README.md](cli/README.md).

## Dale a tu agente un enlace

Una vez que la CLI `memoria` o el servidor MCP están disponibles para un agente (mira [Conectar clientes](#conectar-clientes)), mándale este enlace y nada más:

```text
https://raw.githubusercontent.com/PabloPC05/cli-memoria/main/docs/agent-setup.md
```

El agente lee [la guía de instalación](docs/agent-setup.md) y se instala tu memoria él solo en su plataforma: detecta la CLI o las herramientas MCP, te propone importar lo que ya sabe de ti, instala sus instrucciones permanentes y, donde la plataforma lo permite (Claude Code, tus propios agentes), le impide guardar en cualquier otro sitio. Te pide un único permiso antes de cambiar nada. Inspirado en la página de instalación para agentes de Notion.

En Claude Code también puede instalar, si quieres, un hook que le acerca al agente las notas relevantes automáticamente: antes de cada mensaje, [`inject-memory.mjs`](docs/agent-setup/claude-code/inject-memory.mjs) busca ese mensaje en tu memoria y añade al turno las mejores coincidencias, presentadas como información que comprobar, no como instrucciones, y con un límite de tamaño pequeño. Necesita `MEMORIA_URL` y un `MEMORIA_TOKEN` de solo lectura, y no añade nada ante cualquier error o tiempo de espera agotado.

## Herramientas MCP

| Herramienta | Qué hace |
|---|---|
| `list` | Índice corto, o todas las notas de una carpeta con descripción, alias y último cambio |
| `search` | Búsqueda de texto completo por secciones (SQLite FTS5: sin distinguir acentos, los prefijos coinciden y un plural en español también encuentra su singular), con fragmentos y `updated_at`; filtra por `type` y `status`, pagina con `offset`/`total`/`next_offset` y da como mucho dos secciones por nota (`group_by_note`, por defecto sí) |
| `read` | Una nota o una sección, con su `hash`; `revision` lee una versión antigua |
| `links` | Enlaces `[[...]]` salientes (también los rotos) y retroenlaces con contexto, opcionalmente solo una relación |
| `history` | Commits que tocaron una nota: quién, cuándo, por qué |
| `recent` | Últimos cambios de toda la memoria: por commit cuándo, quién (autor y cliente), herramienta, motivo y las notas que tocó; filtros `since` (`2026-05-01` o `7d`), `folder`, `client` |
| `deadlines` | Las líneas pendientes de las notas, lo más próximo primero: las de las secciones «Pendiente», un item por línea (`- [ ] qué · quién · 2026-03-14 [origen]`). Las de solo mes abren su mes y las que no tienen fecha van al final; `include_done`, `include_undated`, `folder`, `limit` |
| `lint` | Lista de mantenimiento, lo más grave primero: frontmatter roto y notas sustituidas fuera del archivo, incumplimientos de `[rules]`, enlaces rotos, posibles duplicados, deducciones antiguas, páginas que faltan, menciones sin enlace, notas huérfanas, sin tocar hace mucho o demasiado grandes. Cuenta por tipo; filtra por `kinds`, `folder` y `limit` |
| `clients` | Quién está conectado: cada token con su última conexión (hora y herramienta), escrituras en los últimos 7 y 30 días y la versión de `memory-setup` que dejó anotada en las notas. Nunca devuelve secretos |
| `create` | Nota nueva; nombres únicos entre carpetas; rechaza duplicados parecidos salvo `confirm_new` |
| `edit` | Reemplazos de texto exactos, todos o ninguno |
| `write` | Reescribe una nota entera; necesita el `hash` que leíste |
| `move` | Renombra o mueve; reescribe todos los `[[enlaces]]` a ella en el mismo commit |
| `delete` | Borra una nota (queda en el historial); se rechaza mientras otras notas la enlacen |
| `publish` | Envío atómico de varios commits (`create`, `write`, `move`, `delete`), juzgados en conjunto contra `[rules]` |
| `revert` | Deshace un commit de `recent`/`history` con un commit nuevo, o solo lo que hizo en una nota; conserva los cambios posteriores que no se solapan y si no, se rechaza con `REVERT_CONFLICT` |
| `attach` | Guarda un archivo en LFS con una nota al lado en la que se puede buscar |

Los clientes con un token de solo lectura ven solo las herramientas de lectura: `list`, `search`, `deadlines`, `read`, `links`, `history`, `recent`, `lint` y `clients`.

`lint` es la mitad barata de mantener la memoria en orden (la «wiki para LLM» de Karpathy: ingerir, responder, revisar). Sale del índice y de las fechas de git en milisegundos, sin modelo, así que el agente recibe candidatos en vez de leerse todas las notas; juzgarlos es la mitad del agente. Más en [docs/design.md](docs/design.md#lint).

El servidor también ofrece la guía de instalación para agentes sin conexión a todo cliente conectado (va dentro del paquete): como prompt MCP `setup` («Set up this memory on your host») y como recurso `memory://agent-setup`, ambos con el Markdown de [docs/agent-setup.md](docs/agent-setup.md).

## Formato de las notas

```markdown
---
name: Universidad
description: Carrera, asignaturas de este curso y cómo las lleva
aliases: [uni, carrera]
---
# Universidad

Texto, con enlaces como [[otra-nota]], [[otra-nota#Sección|texto]] o ![[documento.pdf]].
```

Los nombres de archivo (sin `.md`) tienen que ser únicos en todo el repo, de modo que `[[nombre]]` siempre se resuelve; es lo que hace Obsidian con los enlaces de «ruta más corta».

Un enlace también puede decir qué significa, con campos en línea al estilo [Dataview](https://blacksmithgu.github.io/obsidian-dataview/): `works_at:: [[acme]]` en su propia línea, `[lives_with:: [[sam]]]` dentro de una frase, o `works_at: "[[acme]]"` en el frontmatter. `links` devuelve la relación y puede filtrar por ella, así que «quién trabaja en Acme» es una sola llamada.

`memory.toml` en la raíz del repo de notas (todas las claves son opcionales):

```toml
[folders]
allowed    = ["me", "people", "topics", "projects", "archive"]
archive    = "archive"      # excluida de list/search salvo que se pida
index_full = ["me"]         # listadas nota por nota en el índice corto
root_files = ["AGENTS.md", "README.md"]

[notes]
required_fields  = ["name", "description"]
filename_pattern = "^[a-z0-9]+(-[a-z0-9]+)*\\.md$"
superseded_field = "superseded_by"
max_description  = 200

[instructions]
file = "AGENTS.md"

[attachments]
page_heading = "Page {n}"
ocr_notice   = "Text recognised with OCR ({languages}); it may contain errors."

[relations]
allowed = ["works_at", "lives_with"]  # avisa con otras claves; sin esto, se sugieren las que estén en uso

[lint]
exclude            = []            # carpetas que no se revisan (la raíz y la carpeta de archivo nunca se revisan)
orphan_exclude     = ["me"]        # nunca se avisan como huérfanas; por defecto, folders.index_full
stale_days         = 180           # sin cambios más tiempo → stale
inference_days     = 90            # «(deducido, 2026-01-31)» más antiguo → old_inference
inferred_markers   = ["deducido"]  # palabras de procedencia que marcan una deducción
max_bytes          = 16384         # más grande → oversized (las notas de adjuntos no cuentan)
missing_page_min   = 2             # un destino que no existe enlazado desde tantas notas → missing_page
mention_min_length = 4             # nombre o alias más corto que se busca como mención sin enlace
mention_exclude_labels = []        # etiquetas que no se buscan nunca como mención (además de folders.index_full)

[rules]                            # opcional; cada escritura se comprueba contra estas reglas
# …todas las reglas, en docs/normas-al-escribir.md…

[rules.status]                     # opcional, apagada salvo que se declare
types   = ["project"]              # los tipos que deben decir en qué punto están (vacío: toda nota con tipo)
allowed = ["idea", "active", "waiting", "paused"]
action  = "warn"                   # o "block"

[rules.pending]                    # opcional, apagada salvo que se declare
section = "Pendiente"              # o sections = ["Pendiente", "Tareas"]
action  = "warn"                   # comprueba que cada línea sea «- [ ] qué · quién · 2026-03-14 [origen]»
```

## Ponerlo en marcha

Requisitos: Node.js 24, git, git-lfs y, de forma opcional, poppler-utils (`pdftotext` para el texto de los PDF y `pdftoppm` para el OCR de escaneos) y `tesseract` con los idiomas que quieras (para el OCR de PDF escaneados e imágenes). Al arrancar se registra qué herramientas hay (`ocr.tools` en el log); si falta alguna, solo deja de estar disponible esa extracción.

```sh
npm ci && npm run build
cli-memoria token add laptop --name "Claude Code (laptop)" --scope write --file tokens.toml
cli-memoria serve --config config.toml
cli-memoria clients --config config.toml     # quién está conectado: última conexión, escrituras, versión de la guía (--json para scripts)
cli-memoria lint --config config.toml        # lista de mantenimiento (--json, --kind stale,orphan, --folder, --limit)
```

Las horas de última conexión se guardan en `activity.sqlite`, en el directorio de datos (como mucho una vez por minuto y cliente; no está en el repo de notas), y el número de escrituras sale de los trailers `Client:` del historial de git.

`config.toml`:

```toml
data_dir = "/var/lib/cli-memoria"
tokens_file = "tokens.toml"

[listen]
address = "127.0.0.1"
port = 8782

[ocr]                                           # todas las claves son opcionales
enabled = true
languages = "spa+eng"                           # códigos de idioma de tesseract; por defecto "eng"
max_pages = 50                                  # páginas de un PDF escaneado que pasan por OCR
page_timeout_seconds = 120                      # por página (render + reconocimiento) o imagen
# dpi = 300; tesseract = "tesseract"; pdftoppm = "pdftoppm"
```

Subidas para `attach`: `curl -T file.pdf -H "Authorization: Bearer $TOKEN" http://host:8782/uploads/file.pdf` devuelve un `upload_id`. No hay límite de tamaño. El cuerpo JSON de `/mcp` está limitado a 32 MB, sitio de sobra para un `publish` de varias notas largas.

El servidor guarda el repo de notas en `data_dir/repo` y es su único escritor: ni remoto git, ni fetch, ni push, ni webhook que reciba uno. Las claves de la sincronización que se ha quitado (`[remote]`, `fetch_interval_seconds`, `webhook_secret_file`) y el endpoint `/hooks/git` ya no existen; un `config.toml` antiguo sigue valiendo, y el servidor nombra esas claves en el log (`config.ignored_keys`) en vez de negarse a arrancar.

### NixOS

```nix
{
  inputs.cli-memoria.url = "github:PabloPC05/cli-memoria";
  # en tu configuración:
  imports = [ inputs.cli-memoria.nixosModules.default ];
  services.cli-memoria = {
    enable = true;
    listen = { address = "127.0.0.1"; port = 8782; };
    tokensFile = "/var/lib/secrets/cli-memoria/tokens.toml";   # root:cli-memoria 0640
    # ocr = { enable = true; languages = [ "spa" "eng" ]; maxPages = 50; pageTimeoutSeconds = 120; dpi = 300; };
  };
}
```

Tras `cli-memoria token add … --file <tokensFile>`, ejecuta `systemctl reload cli-memoria`. El paquete trae `pdftotext`, `pdftoppm` y `tesseract`; el módulo instala los datos de los idiomas de `ocr.languages` (por defecto español e inglés), y solo compila ese tesseract con `ocr.enable` activado. `user`, `group` y `dataDir` son configurables (y se mantiene compatibilidad con `services.my-memory` y `listen.private` para instalaciones existentes). El módulo todavía tiene `remote`, `webhookSecretFile` y `fetchIntervalSeconds`, que este servidor ya no usa: acaban en el archivo de configuración como claves ignoradas (mira `config.ignored_keys` en el log).

### Conectar clientes

**CLI (recomendado para agentes con terminal):**

```sh
export MEMORIA_URL="http://127.0.0.1:8782/mcp"
export MEMORIA_TOKEN="mm_..."
export MEMORIA_DIR="/ruta/a/copia-de-notas"    # opcional: activa lecturas locales rápidas
memoria lista
```

**MCP directamente:**

```sh
# Claude Code
claude mcp add --transport http memory http://host:8782/mcp --header "Authorization: Bearer $MEMORIA_TOKEN"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.memory]
url = "http://host:8782/mcp"
bearer_token_env_var = "MEMORIA_TOKEN"
```

Después dale al agente el enlace de instalación ([Dale a tu agente un enlace](#dale-a-tu-agente-un-enlace)).

### Una credencial por agente

`cli-memoria` atribuye cada escritura (el autor del commit de git y su trailer `Client:`), cada línea de log y la vista `clients` al token con el que llegó la petición. Por eso **cada agente debe conectarse con su propio token**. Si dos agentes comparten uno, nadie puede saber quién escribió qué, `clients` no los distingue y una clave filtrada no se puede revocar sin cortar también al otro agente.

- **Tokens fijos:** crea uno por agente y no lo compartas nunca: `cli-memoria token add <id> --name "<Nombre del agente>" --scope write|read --file tokens.toml`.
- **Detrás de una pasarela o proxy** que une varios servidores MCP en un único endpoint, el cliente que ve el servidor es la pasarela. Dale a la pasarela una clave por agente y asocia cada clave a su propio token de `cli-memoria`; si no, todas las escrituras aparecen con el nombre de la pasarela.
- **Compruébalo:** ejecuta `cli-memoria clients --config config.toml` o llama a la herramienta `clients`. Cada agente debe aparecer en su propia fila, con su última actividad y sus escrituras.

### El formato de las notas, de un vistazo

- **`type` y `status`.** `type` dice qué es una nota (una persona, un proyecto, una referencia…, ver `[rules.type]`); `status` dice en qué punto está: `idea`, `active`, `waiting` o `paused`. Los dos son opcionales y solo se exigen si `memory.toml` lo pide; `search` puede filtrar por ellos.
- **`type: record`.** Una lista o un registro, pensados para ser largos y quedarse como están: `lint` no los marca como `stale` ni `oversized`, y la regla de tamaño de `[rules]` los deja en paz.
- **Líneas pendientes.** Una sección `## Pendiente` lleva un item por línea, `- [ ] qué · quién · 2026-03-14 [origen]` (`- [x]` si está hecho; la fecha puede ser `2026-03` o `sin plazo`). Las lee la herramienta `deadlines`; `[rules.pending]` comprueba su forma en cada escritura.

## Desarrollo

```sh
npm ci
npm test          # vitest: unitarias, de integración (repos git reales) y extremo a extremo HTTP/MCP
npm run typecheck
nix flake check   # compila el paquete y ejecuta el test de la VM de NixOS
NODE=$(command -v node) CLI_MEMORIA=$(nix build --no-link --print-out-paths .#default)/bin/cli-memoria \
  cli/probar.sh   # la CLI memoria de punta a punta, contra un cli-memoria de verdad con notas de juguete
```

## Licencia

Apache-2.0.
