# cli-memoria

A self-hosted, git-backed memory for AI agents: a compact **CLI (`memoria`)** for shell-capable agents and a **stateless MCP server (`cli-memoria`)** backed by Markdown notes in git. Every write is a git commit attributed to the agent that made it.

*[Leer en español](README.es.md)*

> Keep this file and [README.es.md](README.es.md) in sync: when you edit one, update the other.

- **A CLI for agents (`memoria`).** [cli/](cli/README.md) searches, reads and writes notes from a shell with compact output: reads straight from a checkout of the notes repo (`rg` + `git`), writes always through the server (`MEMORIA_URL` + `MEMORIA_TOKEN`). Packaged in Nix as `memoria` for Linux and macOS, with zero npm dependencies.
- **Git is the source of truth.** Server-side search runs on a SQLite index (catalog, FTS5 full text by section, wikilinks) that can be rebuilt from git at any time.
- **One commit per write**, authored by the client: `Claude Code (laptop)`, `Codex`, etc. The commit message is the reason the agent gave, plus `Client:` / `Tool:` / `Session:` trailers.
- **Safe for several agents at once.** One writer queue, optimistic concurrency (`hash` from `read`), atomic multi-commit `publish`, and external pushes integrated by rebase.
- **Your conventions, not ours.** The notes repo declares its folders, required frontmatter, write rules and filename pattern in `memory.toml`; its `AGENTS.md` is sent to every client as MCP instructions, with a short index.
- **Per-agent static tokens.** One Bearer token per agent (`read` or `write` scope), stored as SHA-256 hashes and reloaded on `SIGHUP`. Read-only tokens only see read tools.
- **Attachments.** Binaries go to git LFS with a companion note holding their text (PDFs via `pdftotext`; scanned PDFs and images via local OCR with `tesseract`, when installed), so they are searchable too.
- **Typed links.** `works_at:: [[acme]]` says what a link means, and `links` can filter by it.

How it works inside (index, write flow, concurrency, auth): [docs/design.md](docs/design.md).

## The `memoria` CLI

`memoria` turns the memory into shell commands for agents: one line per result with the total and how to go on, `--json` for `jq`, and dry runs with `--simular` on every write. Commands are in Spanish (`buscar`, `leer`, `lista`, `recientes`…) with English aliases (`search`, `read`, `list`, `recent`…). No npm dependencies: Node 22 or later and a few `.mjs` files.

```sh
nix run github:PabloPC05/cli-memoria#memoria -- --help
memoria buscar kitchen --carpeta projects --limite 5
```

- **Reads** go straight to a checkout of the notes repo when `MEMORIA_DIR` points at one (with `rg` and `git`), or through the server otherwise.
- **Writes** always go through the server, so they are signed by the agent's credential and follow `memory.toml`: one note at a time (`crear`, `editar`, `escribir`, `mover`, `borrar --si`), or, for changes to several notes at once, a git working copy (`memoria copia`) whose commits `memoria publicar` sends in one atomic `publish` submission.
- **Direct to the server (recommended):** set `MEMORIA_URL` (e.g. `http://127.0.0.1:8782/mcp`) and `MEMORIA_TOKEN` (`mm_…`) to talk directly over Streamable HTTP with no gateway required. For setups behind a gateway wrapping tools as `memoria_<tool>` behind `buscador_usar`, `BADULAQUE_URL` and `BADULAQUE_CLAVE` also work.

Layout, configuration, packaging and tests: [cli/README.md](cli/README.md) (in Spanish).

## Give your agent one link

Once the `memoria` CLI or MCP server is available to an agent (see [Connecting clients](#connecting-clients)), send it this link and nothing else:

```text
https://raw.githubusercontent.com/PabloPC05/cli-memoria/main/docs/agent-setup.md
```

The agent reads [the setup guide](docs/agent-setup.md) and installs your memory on its own host: it discovers the CLI or MCP tools, proposes importing what it already knows about you, installs standing instructions and, where the host allows it (Claude Code, your own agents), blocks it from saving anywhere else. It asks for one approval before changing anything. Inspired by Notion's agent setup page.

On Claude Code it can also install, if you want, a hook that brings relevant notes to the agent automatically: before each message, [`inject-memory.mjs`](docs/agent-setup/claude-code/inject-memory.mjs) searches your memory and adds the best few matches to the turn, framed as information to check, not instructions, within a small budget. It needs `MEMORIA_URL` and a read-only `MEMORIA_TOKEN`, and adds nothing on any error or timeout.

## MCP Tools

| Tool | What it does |
|---|---|
| `list` | Short index, or every note in a folder with description, aliases and last change |
| `search` | Full-text search by section (SQLite FTS5: accents ignored, prefixes match) with snippets and `updated_at` |
| `read` | A note or one section, with its `hash`; `revision` reads an old version |
| `links` | Outgoing `[[links]]` (broken ones included) and backlinks with context, optionally only one relation |
| `history` | Commits that touched a note: who, when, why |
| `recent` | Latest changes to the whole memory: per commit when, who (author and client), tool, reason and the notes it touched; filters `since` (`2026-05-01` or `7d`), `folder`, `client` |
| `lint` | Maintenance worklist, worst first: bad frontmatter and superseded notes outside the archive, write-rule violations, broken links, look-alike duplicates, old inferences, missing pages, unlinked mentions, orphans, stale and oversized notes. Counts per kind; filter by `kinds`, `folder`, `limit` |
| `clients` | Who is connected: every token with last seen (time and tool), writes in the last 7 and 30 days, and the `memory-setup` version it left in the notes. Never returns secrets |
| `create` | New note; unique names across folders; refuses look-alike duplicates unless `confirm_new` |
| `edit` | Exact text replacements, all or nothing |
| `write` | Rewrite a whole note; needs the `hash` you read |
| `move` | Rename or move; rewrites every `[[link]]` to it in the same commit |
| `delete` | Remove a note (it stays in history); refused while other notes link to it |
| `publish` | Atomic multi-commit submission (`create`, `write`, `move`, `delete`), judged together against `[rules]` |
| `revert` | Undo a commit from `recent`/`history` with a new commit, or only what it did to one note; keeps later changes that don't overlap, refuses with `REVERT_CONFLICT` otherwise |
| `attach` | Store a file in LFS with a searchable companion note |

Clients with a read-only token only see the read tools: `list`, `search`, `read`, `links`, `history`, `recent`, `lint` and `clients`.

`lint` is the cheap half of keeping the memory tidy (Karpathy's "LLM wiki": ingest, answer, lint). It is computed from the index and git dates in milliseconds, without a model, so the agent gets candidates instead of reading every note; judging them is the agent's half. See [docs/design.md](docs/design.md#lint).

The server also offers the agent setup guide offline to every connected client (it ships with the package): as the MCP prompt `setup` ("Set up this memory on your host") and as the resource `memory://agent-setup`, both with the Markdown of [docs/agent-setup.md](docs/agent-setup.md).

## Notes format

```markdown
---
name: Universidad
description: Carrera, asignaturas de este curso y cómo las lleva
aliases: [uni, carrera]
---
# Universidad

Text, with links like [[otra-nota]], [[otra-nota#Sección|texto]] or ![[documento.pdf]].
```

File names (without `.md`) must be unique across the repo, so `[[name]]` always resolves; this is what Obsidian does with "shortest path" links.

A link can also say what it means, with [Dataview](https://blacksmithgu.github.io/obsidian-dataview/)-style inline fields: `works_at:: [[acme]]` on its own line, `[lives_with:: [[sam]]]` inside a sentence, or `works_at: "[[acme]]"` in the frontmatter. `links` returns the relation and can filter by it, so "who works at Acme" is one call.

`memory.toml` at the root of the notes repo (every key is optional):

```toml
[folders]
allowed    = ["me", "people", "topics", "projects", "archive"]
archive    = "archive"      # excluded from list/search unless asked
index_full = ["me"]         # listed note by note in the short index
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
allowed = ["works_at", "lives_with"]  # warn on other keys; without it, keys in use are suggested

[lint]
exclude            = []            # folders left out of every check (root files and the archive always are)
orphan_exclude     = ["me"]        # never reported as orphans; defaults to folders.index_full
stale_days         = 180           # unchanged for longer → stale
inference_days     = 90            # "(deducido, 2026-01-31)" older than this → old_inference
inferred_markers   = ["deducido"]  # provenance words that mark an inference
max_bytes          = 16384         # bigger → oversized (attachment notes are exempt)
missing_page_min   = 2             # a missing target linked from this many notes → missing_page
mention_min_length = 4             # shortest name or alias looked for as an unlinked mention
```

## Running it

Requirements: Node.js 24, git, git-lfs, and optionally poppler-utils (`pdftotext` for PDF text, `pdftoppm` for OCR of scans) and `tesseract` with the language data you want (for OCR of scanned PDFs and images). Missing tools are reported at startup (`ocr.tools` in the log) and only make that extraction unavailable.

```sh
npm ci && npm run build
cli-memoria token add laptop --name "Claude Code (laptop)" --scope write --file tokens.toml
cli-memoria serve --config config.toml
cli-memoria clients --config config.toml     # who is connected: last seen, writes, setup version (--json for scripts)
cli-memoria lint --config config.toml        # maintenance worklist (--json, --kind stale,orphan, --folder, --limit)
```

Last-seen times are kept in `activity.sqlite` in the data dir (written at most once a minute per client; it is not in the notes repo) and the write counts come from the `Client:` trailers of the git history.

`config.toml`:

```toml
data_dir = "/var/lib/cli-memoria"
tokens_file = "tokens.toml"
webhook_secret_file = "webhook-secret"          # optional; paths, or credential:NAME for systemd credentials

[remote]                                        # omit to keep the notes repo local
url = "https://git.example.com/me/notes.git"
username = "cli-memoria"
token_file = "git-remote-token"

[listen]
address = "127.0.0.1"
port = 8782

[ocr]                                           # every key is optional
enabled = true
languages = "spa+eng"                           # tesseract language codes; default "eng"
max_pages = 50                                  # pages of a scanned PDF that are OCR'd
page_timeout_seconds = 120                      # per page (render + recognition) or image
# dpi = 300; tesseract = "tesseract"; pdftoppm = "pdftoppm"
```

Uploads for `attach`: `curl -T file.pdf -H "Authorization: Bearer $TOKEN" http://host:8782/uploads/file.pdf` returns an `upload_id`. There is no size limit.

Git push webhook (optional): `POST /hooks/git` signed with HMAC-SHA256 (`X-Hub-Signature-256: sha256=<hex>` or `X-Webhook-Signature: <hex>`).

### NixOS

```nix
{
  inputs.cli-memoria.url = "github:PabloPC05/cli-memoria";
  # in your configuration:
  imports = [ inputs.cli-memoria.nixosModules.default ];
  services.cli-memoria = {
    enable = true;
    remote = { url = "https://git.example.com/me/notes.git"; tokenFile = "/run/secrets/git-remote-token"; };
    listen = { address = "127.0.0.1"; port = 8782; };
    tokensFile = "/var/lib/secrets/cli-memoria/tokens.toml";   # root:cli-memoria 0640
    # ocr = { enable = true; languages = [ "spa" "eng" ]; maxPages = 50; pageTimeoutSeconds = 120; dpi = 300; };
  };
}
```

After `cli-memoria token add … --file <tokensFile>`, run `systemctl reload cli-memoria`. The package brings `pdftotext`, `pdftoppm` and `tesseract`; the module installs the language data listed in `ocr.languages` (default Spanish and English), and builds that tesseract only when `ocr.enable` is on.

### Connecting clients

**CLI (recommended for shell-capable agents):**

```sh
export MEMORIA_URL="http://127.0.0.1:8782/mcp"
export MEMORIA_TOKEN="mm_..."
export MEMORIA_DIR="/path/to/notes-checkout"   # optional: enables fast local reads
memoria lista
```

**MCP directly:**

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

Then give the agent the setup link ([Give your agent one link](#give-your-agent-one-link)).

### One credential per agent

`cli-memoria` attributes every write (the git commit author and its `Client:` trailer), every log line and the `clients` view to the token the request used. So **each agent must connect with its own token**. If two agents share one, nobody can tell who wrote what, `clients` cannot tell them apart, and a leaked key cannot be revoked without cutting off the other agent too.

- **Static tokens:** create one per agent and never share it: `cli-memoria token add <id> --name "<Agent name>" --scope write|read --file tokens.toml`.
- **Behind a gateway or proxy** that joins several MCP servers into one endpoint, the gateway is the client the server sees. Give the gateway one key per agent and map each key to its own `cli-memoria` token; otherwise every write shows the gateway's name.
- **Check it:** run `cli-memoria clients --config config.toml` or call the `clients` tool. Each agent must appear on its own row, with its last activity and its writes.

### Moving an existing repo to wikilinks

`cli-memoria migrate <clone>` shows what would change: relative Markdown links become `[[wikilinks]]`, name collisions are renamed, and frontmatter that is not valid YAML gets quoted. Add `--apply` to commit it. Only those spans change.

## Development

```sh
npm ci
npm test          # vitest: unit, integration (real git repos) and HTTP/MCP end to end
npm run typecheck
nix flake check   # builds the package and runs the NixOS VM test
NODE=$(command -v node) CLI_MEMORIA=$(nix build --no-link --print-out-paths .#default)/bin/cli-memoria \
  cli/probar.sh   # the memoria CLI end to end, against a real cli-memoria with toy notes
```

## License

Apache-2.0.
