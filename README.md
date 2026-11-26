# cli-memoria

A self-hosted, git-backed memory for AI agents: a compact **CLI (`memoria`)** for shell-capable agents and a **stateless MCP server (`cli-memoria`)** backed by Markdown notes in git. Every write is a git commit attributed to the agent that made it.

*[Leer en español](README.es.md)*

> Keep this file and [README.es.md](README.es.md) in sync: when you edit one, update the other.

- **A CLI for agents (`memoria`).** [cli/](cli/README.md) searches, reads and writes notes from a shell with compact output: reads straight from a checkout of the notes repo (`rg` + `git`), writes always through the server (`MEMORIA_URL` + `MEMORIA_TOKEN`). Packaged in Nix as `memoria` for Linux and macOS, with zero npm dependencies.
- **Git is the source of truth.** Server-side search runs on a SQLite index (catalog, FTS5 full text by section, wikilinks) that can be rebuilt from git at any time.
- **One commit per write**, authored by the client: `Claude Code (laptop)`, `Codex`, etc. The commit message is the reason the agent gave, plus `Client:` / `Tool:` / `Session:` trailers.
- **Safe for several agents at once.** One writer queue, optimistic concurrency (`hash` from `read`) and atomic multi-commit `publish`. The server is the only writer: there is no git remote to push to or fetch from.
- **Your conventions, not ours.** The notes repo declares its folders, required frontmatter, write rules and filename pattern in `memory.toml`; its `AGENTS.md` is sent to every client as MCP instructions, with a short index.
- **Per-agent static tokens.** One Bearer token per agent (`read` or `write` scope), stored as SHA-256 hashes and reloaded on `SIGHUP`. Read-only tokens only see read tools.
- **Notes only.** The memory is Markdown and nothing else: no attached files, no OCR, no git-lfs. The documents themselves live in the archives of lisa, and a note points at them in its text. A repo that still carries a binary is read without breaking (it is catalogued so links to it keep resolving) and `lint` reports it as `binary` until it moves out.
- **Typed links.** `works_at:: [[acme]]` says what a link means, and `links` can filter by it.

How it works inside (index, write flow, concurrency, auth): [docs/design.md](docs/design.md). Write-rules design and evaluation (Spanish): [docs/normas-al-escribir.md](docs/normas-al-escribir.md).

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
| `search` | Full-text search by section (SQLite FTS5: accents ignored, prefixes match, a Spanish plural also finds its singular) with snippets, `type`, `status`, `updated_at` and one page at a time (`offset`, `total`, `next_offset`). At most two sections per note (`group_by_note`, default true); filters `type` and `status` |
| `read` | A note or one section, with its `hash`; `revision` reads an old version |
| `links` | Outgoing `[[links]]` (broken ones included) and backlinks with context, optionally only one relation |
| `history` | Commits that touched a note: who, when, why |
| `recent` | Latest changes to the whole memory: per commit when, who (author and client), tool, reason and the notes it touched; filters `since` (`2026-05-01` or `7d`), `folder`, `client` |
| `deadlines` | The pending lines of the notes, soonest first: from the «Pendiente» sections, one item per line (`- [ ] what · who · 2026-03-14 [origin]`). Month-only deadlines open their month, undated ones go last; `include_done`, `include_undated`, `folder`, `limit` |
| `lint` | Maintenance worklist, worst first: bad frontmatter and superseded notes outside the archive, write-rule violations, broken links, look-alike duplicates, old inferences, missing pages, unlinked mentions, orphans, stale notes, files that are not notes (`binary`) and oversized notes. Counts per kind; filter by `kinds`, `folder`, `limit` |
| `clients` | Who is connected: every token with last seen (time and tool), writes in the last 7 and 30 days, and the `memory-setup` version it left in the notes. Never returns secrets |
| `create` | New note; unique names across folders; refuses look-alike duplicates unless `confirm_new` |
| `edit` | Exact text replacements, all or nothing |
| `write` | Rewrite a whole note; needs the `hash` you read |
| `move` | Rename or move; rewrites every `[[link]]` to it in the same commit |
| `delete` | Remove a note (it stays in history); refused while other notes link to it |
| `publish` | Atomic multi-commit submission (`create`, `write`, `move`, `delete`), judged together against `[rules]` |
| `revert` | Undo a commit from `recent`/`history` with a new commit, or only what it did to one note; keeps later changes that don't overlap, refuses with `REVERT_CONFLICT` otherwise |

Clients with a read-only token only see the read tools: `list`, `search`, `deadlines`, `read`, `links`, `history`, `recent`, `lint` and `clients`.

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

Text, with links like [[otra-nota]], [[otra-nota#Sección|texto]] or an embed like ![[otra-nota]].
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

[relations]
allowed = ["works_at", "lives_with"]  # warn on other keys; without it, keys in use are suggested

[lint]
exclude            = []            # folders left out of every check (root files and the archive always are)
orphan_exclude     = ["me"]        # never reported as orphans; defaults to folders.index_full
stale_days         = 180           # unchanged for longer → stale
inference_days     = 90            # "(deducido, 2026-01-31)" older than this → old_inference
inferred_markers   = ["deducido"]  # provenance words that mark an inference
max_bytes          = 16384         # bigger → oversized
missing_page_min   = 2             # a missing target linked from this many notes → missing_page
mention_min_length = 4             # shortest name or alias looked for as an unlinked mention
mention_exclude_labels = []        # labels never looked for as an unlinked mention (besides folders.index_full)

[rules]                            # optional; every write is checked against these
# …see docs/normas-al-escribir.md for every rule…

[rules.status]                     # optional, off unless declared
types   = ["project"]              # the types that must say where they stand (empty: every typed note)
allowed = ["idea", "active", "waiting", "paused"]
action  = "warn"                   # or "block"

[rules.pending]                    # optional, off unless declared
section = "Pendiente"              # or sections = ["Pendiente", "Tareas"]
action  = "warn"                   # checks that every line is «- [ ] what · who · 2026-03-14 [origin]»
```

## Running it

Requirements: Node.js 24 and git. Nothing else: the server never reads or extracts a file, it only writes Markdown notes.

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

[listen]
address = "127.0.0.1"
port = 8782

```

The JSON body of `/mcp` is capped at 32 MB, which is room for a `publish` of several long notes.

The server keeps the notes repo in `data_dir/repo` and is its only writer: no git remote, no fetch, no push, and no webhook to receive one. The keys of the removed git sync (`[remote]`, `fetch_interval_seconds`, `webhook_secret_file`), of the removed extraction of attached files (`[ocr]`, `pdftotext`), and the `/hooks/git` and `/uploads/:filename` endpoints are gone; an old `config.toml` still works, and the server names those keys in the log (`config.ignored_keys`) instead of refusing to start.

### NixOS

```nix
{
  inputs.cli-memoria.url = "github:PabloPC05/cli-memoria";
  # in your configuration:
  imports = [ inputs.cli-memoria.nixosModules.default ];
  services.cli-memoria = {
    enable = true;
    listen = { address = "127.0.0.1"; port = 8782; };
    tokensFile = "/var/lib/secrets/cli-memoria/tokens.toml";   # root:cli-memoria 0640
  };
}
```

After `cli-memoria token add … --file <tokensFile>`, run `systemctl reload cli-memoria`. The package brings `git` and nothing else: there is no extraction of attached files, so no `poppler-utils` and no `tesseract`. See [`nix/module.nix`](nix/module.nix) for all options (`services.my-memory` and `listen.private` remain supported for existing deployments). `remote`, `webhookSecretFile`, `fetchIntervalSeconds` and `ocr` have been removed from the NixOS module: remove them when updating if an existing NixOS configuration still sets them, and delete the binaries and their companion notes from the notes repo (see *No attached files* below).

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

### Notes format at a glance

- **`type` and `status`.** `type` says what a note is (a person, a project, a reference…, see `[rules.type]`); `status` says where it stands: `idea`, `active`, `waiting` or `paused`. Both are optional and only enforced if `memory.toml` asks for it; `search` can filter by them.
- **`type: record`.** A list or a log, meant to be long and to stay as it is: `lint` does not report it as `stale` or `oversized`, and the size rule of `[rules]` leaves it alone.
- **No attached files.** The memory is Markdown; documents live in the archives of lisa and a note cites them in its text. `lint --kind binary` lists whatever is still a file of another kind, and it never stops the server: such files are catalogued (so `[[a-link]]` to one still resolves) and never read. Removing them is a commit in git, since the tools only write notes (`revert` can undo the commit that added one, but never bring its content back: `NOT_RESTORABLE`).
- **Pending lines.** A `## Pendiente` section holds one item per line, `- [ ] what · who · 2026-03-14 [origin]` (`- [x]` when done; the date may be `2026-03` or `sin plazo`). The `deadlines` tool reads them; `[rules.pending]` checks their shape on every write.

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
