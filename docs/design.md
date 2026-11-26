# Design

How `cli-memoria` works inside, for people who want to run it, change it or build something similar. The [README](../README.md) covers tools, configuration and deployment.

## Architecture

```text
  shell agents (`memoria` CLI)                  MCP clients
   ├─ reads: local checkout (`rg` + `git`)      (Claude Code, Codex, your bots)
   └─ writes: POST /mcp (Bearer token)                   │
                     │                                   │
                     └───────────────┬───────────────────┘
                                     ▼
            cli-memoria (one Node.js process)
            ├─ HTTP listener: static Bearer tokens
            ├─ MCP server (Streamable HTTP, stateless)
            ├─ write queue (one global mutex)
            ├─ repo/             the notes repo (git)
            ├─ index.sqlite      derived FTS5 + links index, rebuildable from git
            └─ activity.sqlite   last seen per client (not derivable, not in the notes repo)
```

- **Stack:** TypeScript on Node.js 24; the official `@modelcontextprotocol/sdk` for the stateless Streamable HTTP transport; express; the built-in `node:sqlite` (FTS5, WAL); and one binary, `git`, called with `execFile`, never through a shell.
- **Single listener, per-agent tokens.** Every request to `/mcp` authenticates with a per-agent static Bearer token (SHA-256 hashed in `tokens.toml`, reloaded on `SIGHUP`). There is no git remote and no webhook: this process is the only writer of the notes repo, and `git` is kept as the history, not as a transport. The JSON body of `/mcp` is capped at 32 MB and answers 413 above that.
- **Cheap answers.** Tool results are JSON without indentation, and the MCP `instructions` (the memory's rules file plus the short index) are only rendered for an `initialize` request, cached by HEAD and the hash of `memory.toml`, so a `tools/call` does not pay for them.

## Notes

A notes repo is plain Markdown with YAML frontmatter:

```markdown
---
name: Kitchen renovation
description: Budget, quotes and schedule for the kitchen
aliases: [kitchen]
---
# Kitchen renovation

Quote from [[acme-builders]], see ![[quote.pdf]].
contractor:: [[acme-builders]]
```

- **Names.** A note's name is its file name without `.md`, unique across the repo (case-insensitive), so `[[name]]` always resolves and survives moves between folders. This matches Obsidian's "shortest path" links.
- **Required fields** (`name`, `description` by default) are checked on writes. Dates and authors are never stored in the file: they come from `git log`.
- **Superseded notes** go to the archive folder with `superseded_by: "[[new-note]]"`.
- **Typed links** are Dataview inline fields: `key:: [[x]]` on its own line or list item, `[key:: [[x]]]` or `(key:: [[x]])` inside a sentence, or a frontmatter field whose value holds links. Every link in the field's value gets the key as its relation. `name`, `description` and `aliases` never carry relations.
- **`memory.toml`** at the repo root declares the conventions (folders, archive, required fields, file name pattern, relation vocabulary, write rules, instructions file). An invalid file is never applied; the server keeps the last valid one. Keys this version no longer reads (`[attachments]`, `rules.type.attachment_type`, both about the removed `attach` tool) are ignored instead of refused, so an old file keeps every rule it still declares.
- **Legacy frontmatter** that strict YAML rejects (typically an unquoted `: ` inside a value) is read leniently and reported as a problem. Writes must produce valid YAML, except that an edit may leave an already broken frontmatter block exactly as it was.
- **`type` and `status`.** `type` says what a note is (a closed list when `[rules.type]` declares one); `status` says where it stands (`idea`, `active`, `waiting`, `paused`). Both are free-form frontmatter unless a rule asks for them, and both are indexed so `search` can filter in SQL. `type: record` marks a list or a log, exempt from `stale`, `oversized` and the size rule.
- **No migration command.** `cli-memoria migrate` (relative Markdown links to `[[wikilinks]]`, name collisions renamed, quoted frontmatter) is gone with the repository it used to receive: notes are wikilinks already, and the quote-on-write rule above handles the rest.

## Index

`index.sqlite` is derived and disposable; `cli-memoria reindex` rebuilds it from the working tree.

- **Catalog** (`notes`): path, name, folder, title, description, aliases, `type` and `status` from the frontmatter (to filter in SQL), archived, superseded_by, the git blob hash (the `hash` of the tools), dates and authors from git, and `problems`.
- **Full text** (`sections` + `sections_fts`): one row per section. The text before the first `##` is a section named after the title; `##` and `###` start new ones; deeper headings stay inside. FTS5 with `unicode61 remove_diacritics 2`, so accents don't matter. Title, aliases and description are stored only with a note's first section, so matches on them point at the top of the note.
- **Links** (`links`): source, target name, resolved target (null when broken), heading, embed, relation and line. Links inside code are ignored.
- **Assets** (`assets`): the files that are not notes, with their path, name and size. They are never read, but they are catalogued so `[[a-link]]` to one still resolves, and `lint` reports them as `binary`.

**Ranking.** Full text is SQLite FTS5 `bm25` with weights 5, 4, 3, 2, 1 for title, aliases, description, heading and body, down-weighted by half for notes of type `reference` or `record` (`bm25` is negative, so half of it is closer to zero and sorts worse): a dictionary or a log that mentions a word should not push a real note down. The query is built from the user's words: each word of three or more letters becomes a prefix term, quoted text stays a phrase, and terms are ANDed, falling back to OR when that finds nothing. A word of four or more letters ending in `s`/`es` is searched with its singular too (as one alternative term, `("hipotecas"* OR "hipoteca"*)`), so a Spanish plural finds both. Raw FTS5 syntax is not exposed, so there are no query syntax errors. There are no embeddings or external model calls: FTS5 + disciplined note naming and wikilinks is fast, deterministic and needs zero extra services.

**Pages and grouping.** `search` answers one page at a time: `limit` (up to 50), `offset`, `total` and `next_offset` when more remain. With `group_by_note` (the default) at most two sections of each note are returned, so one long note cannot fill the page. `type` and `status` filter in SQL. FTS5 only allows `bm25()` in a query that reads the FTS table directly, so the ranking is read first (path, section id and score) and the snippets of the page are fetched by rowid after it.

**Link resolution.** `resolveLinks` rewrites `links.target_path` from `links.target_name` with `name COLLATE NOCASE = …` in `notes` and, failing that, in `assets`, the collation of the `notes_name` index: one index lookup per link instead of a table scan. It runs after every index change (a full or incremental reindex) and, inside a `publish`, once at the end of the whole submission: the changes of a batch see the links by name (`linksToName`) until then.

**Incremental reindex.** After each commit or pull the server diffs the indexed commit against HEAD with `git diff --name-status`, reparses the changed files and re-resolves links, all in one transaction that also stores the new indexed commit. At startup: a schema change or an indexed commit that is not an ancestor of HEAD means a full rebuild; otherwise incremental. A change to `memory.toml` also triggers a full rebuild.

## Writes

Every write goes through one in-process queue. Reads take no lock: SQLite runs in WAL mode and files are replaced by writing a temp file and renaming it.

```text
 1. authenticate → client identity and scope
 2. take the write lock
 3. validate: path, file name, hash, frontmatter, write rules, duplicates, backlinks
 4. apply to the working tree (for move, also rewrite the notes that link to it)
 5. git commit
      author:  "<client name> <client-id@cli-memoria.invalid>"
      subject: the reason the agent gave
      trailers: Client, Tool, Session
 6. incremental reindex (link resolution included)
 7. release the lock, log one JSON line, return
```

- **Optimistic concurrency.** `read` returns the note's git blob hash. `write`, `move` and `delete` require it and fail with `CONFLICT` and the current content when it no longer matches; `edit` takes it optionally and otherwise relies on its `old_string` still being there.
- **Duplicates.** `create` compares the new note's labels (name, title, aliases, normalized) with the existing ones and refuses with `DUPLICATE_CANDIDATES` unless the agent confirms. Labels count as the same when they are equal, within a small edit distance (25 % for single words, 12 % for several), or when all the words of a label of six or more characters appear in the other **and that label has several words**: a single word («lentejas» in «receta de lentejas») names a topic, not the same note, and treating it as a duplicate buries the real ones.
- **Backlinks.** `move` rewrites every `[[link]]` to the note in the same commit, keeping headings, aliases and relation keys. `delete` refuses while other notes link to the note.
- **Revert.** `revert` takes a commit on the current branch (not a merge) and, optionally, one note of it, and writes the files it touched back to their state in its parent, as one normal write: same queue, one commit by the client with a `Reverts: <hash>` trailer, incremental reindex, same push and conflict rules. A file changed again later is three-way merged (`git merge-file`: current, the commit's version, the parent's version), so later changes that don't overlap survive; if they overlap, or the file was deleted, moved or created again since, nothing is written and it fails with `REVERT_CONFLICT` and the later commits that touched it. Undoing a create deletes the note and follows the `delete` rule: `HAS_BACKLINKS` while notes outside the revert link to it. Undoing a delete restores the note, if its path is free and its name still unique (`NAME_TAKEN`). Undoing a move moves it back, and the link rewrites of that move are other files of the same commit, so they are undone too. A file that is not a note (a binary, whose place is the archives of lisa) is never rewritten from history: undoing the commit that added one removes it, moving it back is a plain rename, and restoring or changing one fails with `NOT_RESTORABLE` (a note of that commit alone can be restored with `path`). `.gitattributes` is never reverted, and every path the revert would touch goes through the same path checks as the other writes (no hidden files such as `.gitignore`, allowed folders, root files), or it fails with `INVALID_PATH`. A file brought back unchanged (nothing else touched it since) is copied byte for byte from the blob. Any failure resets the worktree to HEAD, as for every write.
- **Write rules.** A memory can declare rules in the `[rules]` table of its `memory.toml`, and every write (`create`, `edit`, `write`, `move`, `revert`, `publish`) is checked against them in code, so a model that skips the instructions cannot get around them: frontmatter required, `type` from a closed list (with folders that go without one), retired names given as regular expressions (with notes excepted per pattern; with `allow_dated`, the default, a mention on a line that gives a full date outside its `[…]` origin markers is history, not an instruction, and does not count), sections whose existing lines can only be added to, forbidden sections, the allowed sections of each type in order, and a size limit. Each rule `block`s or `warn`s. Only what a write adds counts: the note before the write is the baseline, compared per rule and per matched text (a write may not raise the count, so editing a line that already had an old problem is fine) and, for append-only sections, line by line. A refused write fails with `RULES_VIOLATED` and one line per problem (rule, line, what is wrong, how to fix it); what the note already had comes back as a `RULES_EXISTING` warning and new problems of `warn` rules as `RULES_WARNINGS`. `move` judges the note where it goes against what it was where it was (out of the archive or of an untyped folder, its problems are new); `revert` may take back the lines its commit added to an append-only section and nothing else, and a deleted note it restores is compared with its own last version. Root files and the archive are outside the rules, and `memory.toml` cannot be written by tools, so the rules can only be changed with git. Without `[rules]` nothing changes. The same code backs the `rules` kind of `lint` and `cli-memoria check <repo> [<rev> | <from>..<to> [--each]]`, which judges a tree, a range (exit 1 when it adds a blocking problem: a pre-receive or pre-push hook) or every commit of a range.
- **Publish.** `publish` sends several commits of changes (create, write, move, delete) as one submission, the way a client publishes the commits of a working copy: under one hold of the write lock, each change runs in order and sees what the previous ones did (the index entries of the paths it touched are refreshed from the worktree without a commit), each commit becomes one commit with its reason, and the write rules are judged at the end over the whole submission. All or nothing: any failure resets the branch and the worktree to where they were, restores those index entries and changes nothing; the error names the commit and the change. The links of the submission are resolved once, at the end. Judged together, a line may leave an append-only section of one note when the same line enters that section of another note of the submission, and a retired name may leave one note for another (splitting or merging notes; notes the submission deletes give what they had); a single `edit` or `write` cannot do that, and its refusal says so. `cli-memoria check` judges each commit, or the whole range, the same way.
- **Recent changes.** `recent` reads `git log` of the branch (with rename detection): per commit the date, author, `Client`/`Tool`/`Session`/`Reverts` trailers, the subject (the reason) and the files with their change type. `since` (ISO date or `30m`/`12h`/`7d`/`2w`) and `folder` go to git; `client` (trailer or author name) and the archive filter (files only in the archive are hidden unless `include_archive`, and so are commits that touched nothing else) are applied to pages of the log.
- **Crash safety.** At startup a dirty working tree means a crash mid-write: it is reset to HEAD and the discarded paths are logged, and then the index is reconciled with HEAD (nothing to push: the repo is local).

| Case | Behavior |
|---|---|
| Two agents write different notes | Serialized; two commits |
| Two agents `edit` the same note | Serialized; the second fails with `EDIT_NO_MATCH` if its text is gone |
| Two agents `write` the same note from the same read | The first wins; the second gets `CONFLICT` |
| Someone commits in the repo by hand while the server is stopped | The next start resets the worktree to HEAD and reindexes; the commit itself stays in the history |
| A client sends a body over 32 MB | `413 payload_too_large` |

## Notes only

The memory is Markdown and nothing else: there is no upload endpoint, no extraction of attached files and no git-lfs.
A document stays in the archives of lisa (its own service, its own permissions) and a note cites it in its text.

- **Files that are not notes.** An old repo may still carry one. The server catalogs it as an *asset* (path and name,
  never its content) so `[[a-link]]` to it keeps resolving, and it never reads it: search, `list` and the short index
  only know about `.md`. `lint` reports each one as `binary`, which is the worklist to move them out; deleting them is
  a commit in git, because the tools only write notes.
- **No restoration.** `revert` can undo the commit that added a binary (the file goes) or move it back, but it never
  rewrites one from history (`NOT_RESTORABLE`): the worktree, not the object store, is where they live.
- **Companion notes** written by the old `attach` tool (`attachment:` in the frontmatter, `extracted_with`, page
  headings, `[attachments]` in `memory.toml`) are plain notes now: the frontmatter field is not read, the table is
  ignored, and nothing breaks. The size rule and `oversized` apply to them like to any other note.

## Authentication

- **Static tokens:** one per agent, `mm_` plus 32 random bytes, stored as SHA-256 hashes in a TOML file that the server reloads on `SIGHUP`. Each has an id (commit trailer and author email), a name (commit author) and a scope (`read` or `write`). Read-only clients don't see the write tools.
- **One credential per agent.** Identity is whatever token the request carried, and that is all `cli-memoria` knows: the commit author, the `Client:` trailer, the log line and the `clients` view all use it. Two agents sharing a token are one client to the server. Create one token per agent (`cli-memoria token add <id> --name "<Agent name>" …`). Behind a gateway or proxy that joins several MCP servers into one endpoint, give the gateway one key per agent and map each key to its own `cli-memoria` token, or every write is attributed to the gateway. To verify, `cli-memoria clients --config config.toml` or the `clients` tool must show each agent on its own row.

## Connected clients

The `clients` tool (available to read-only tokens too) and `cli-memoria clients --config config.toml` (`--json` for scripts) answer "who is connected". The report joins three sources and never includes tokens or hashes:

- **Known clients:** every static token from the tokens file (without hashes).
- **Last seen:** `activity.sqlite` in the data dir, a small SQLite file of its own (not in the notes repo and not in the rebuildable index). It keeps per client the name, scope, last request time and last tool. The in-memory copy is always current; the file is written at most once a minute per client and on shutdown. The CLI reads a snapshot without side effects.
- **Writes:** counted from the `Client:` trailers of the commits on the current branch, for the last 7 and 30 days. A client that only appears in the activity log or in git (token revoked) is still listed and flagged as no longer known.
- **Setup version:** the latest `memory-setup <version>` record found in the notes, attributed to the client whose id or name appears nearby, or failing that to the only client named in the file or the author of the last commit that touched it. Best effort.

## Lint

Andrej Karpathy's "LLM wiki" pattern has the model do three things with a wiki: ingest sources, answer from it, and periodically lint it for contradictions, stale claims, orphan pages, concepts without a page of their own and missing cross-references. Most of that needs judgment, but finding the candidates does not. The `lint` tool (read-only tokens too) and `cli-memoria lint --config config.toml` (`--json`, `--kind`, `--folder`, `--limit`) are that cheap half: a worklist computed from the index and git dates, with no model, so the maintaining agent reads only the notes that need it and does the judgment half.

| Kind | Found from |
|---|---|
| `problems` | The catalog's `problems` (bad frontmatter, file names, relations), superseded notes outside the archive, duplicate names |
| `rules` | What each note breaks of the memory's write rules as it stands, one item per note with a line and a fix per problem (append-only sections compare two versions, so they only show on writes). Only with `[rules]`; it reads the notes |
| `broken_link` | Links with no target |
| `duplicate_candidates` | Pairs of notes whose labels look alike, with the same rule as `create`'s `DUPLICATE_CANDIDATES`. Candidates come from a bigram index and a word index, exact filters for that rule (the q-gram bound for the edit distance, the rarest word for containment), so it is not quadratic and finds the same pairs |
| `old_inference` | Lines with an inference marker, in brackets or in parentheses, with an optional note and date after the word: `[deducido]`, `[deducido, 2026-01-31]`, `[deducido de [[otra]]]`, `(deducido)`. The words come from `[lint] inferred_markers`; a marker older than `inference_days` is reported, and an undated one is at least as old as the note's last change |
| `missing_page` | A missing target linked from `missing_page_min` notes or more, reported once instead of as broken links |
| `unlinked_mention` | A note's name, title or alias in the plain text of a note that never links to it (whole words, accents ignored; ambiguous and short labels skipped; code, links and headings ignored). The notes of `folders.index_full` are the index itself, so by default they are not destinations; `lint.mention_exclude_labels` leaves more labels alone |
| `orphan` | Notes with no links in, except from the archive; root files count as sources. `orphan_exclude` folders (default `index_full`) are exempt |
| `stale` | Last commit older than `stale_days` (notes of type `record` are exempt: a log is meant to stay as it is) |
| `binary` | Files that are not notes (assets): the memory is Markdown, so each one belongs in the archives of lisa. Detail: its size, and the fix |
| `oversized` | Notes bigger than `max_bytes`, except notes of type `record` |

Root files and the archive are never reported, and `[lint] exclude` adds folders. Items come in the order of the table, worst first within each kind, each with its notes and a short detail (line, snippet, target, days); `counts` has the totals per kind before `limit`. Section text comes from the FTS table, which keeps it, so lint reads no files (except for `rules`) and needs no new index tables; a few thousand notes take well under a second. The CLI opens the index read-only and refuses one of another schema version instead of rebuilding it under a running server.

## Deadlines

`deadlines` reads the pending lines of the memory, the other half of «what has to be done» that a note-by-note read would hide. A pending line lives in the sections named by `[rules.pending] sections` (default `Pendiente`) and has a fixed shape, one per line:

```text
- [ ] Pedir presupuesto · Ana · 2026-03-14 [llamada]
- [x] Elegir azulejos · Ana · 2026-03
- [ ] Llamar al fontanero · - · sin plazo
```

`- [x]` is done; the parts are `what · who · when`, with the date as a day (`AAAA-MM-DD`), a month (`AAAA-MM`) or `sin plazo`, and an optional origin in brackets at the end. The parts are read from the right, so a `·` inside the text is kept, and a date that is not a real day or month is rejected (and reported by the `pending` rule). `src/pending.ts` holds the only parser: the tool and the rule always agree. Items are sorted by date (month-only ones open their month, undated ones go last), done ones and undated ones are left out unless `include_done`/`include_undated`, archived notes never appear, and `folder`/`limit` work as in `lint`.

The rule `[rules.pending]` (`section` or `sections`, `action`, default `warn`) checks every line that carries the mark: a line that does not parse is a violation with its line and the shape to write. Prose in the section is not a pending line and is left alone.

`status` is the other new frontmatter field: `idea`, `active`, `waiting` or `paused`, what the note is doing right now. It is free-form unless `[rules.status]` declares it (`types`, `allowed`, `action`, default `warn`), in which case notes of those types must carry one of the allowed values. `search` filters by `type` and `status`, and `type: record` is exempt from `stale`, `oversized` and the size rule.

## Agent setup guide

[docs/agent-setup.md](agent-setup.md) ships inside the package and the server offers it offline to every connected client: as the MCP prompt `setup` ("Set up this memory on your host") and as the resource `memory://agent-setup`, both with the Markdown of the guide. The server instructions mention them, so an agent on an unconfigured host can follow the guide without being given the URL. Agents compare the `memory-setup <version>` line they installed with the guide's version (see the [changelog](agent-setup/changelog.md)), and the `clients` view shows which version each one has.

The guide's Claude Code hooks live next to it in `docs/agent-setup/claude-code/`: dependency-free Node scripts that the agent copies to `~/.claude/hooks/`, each with a self-running test that the vitest suite executes. Two enforce the memory (`block-native-memory.mjs` refuses writes to Claude Code's own memory; `remind-memory.mjs` reminds the agent what "my memory" means when a message talks about saving). The optional third, `inject-memory.mjs`, brings recall to the agent instead of waiting for it to search: on `UserPromptSubmit` it turns the message into a keyword query (stopwords dropped, slash commands and short messages skipped), calls `search` over MCP with its own read-only token (`MEMORIA_URL` / `MEMORIA_TOKEN`) and adds the top hits (note, section, snippet) as `additionalContext`, framed as information to read before relying on, within a character budget; on `SessionStart` it can add the short index. It speaks plain JSON-RPC over Streamable HTTP: a bare `tools/call` first, which this stateless server answers in one round trip, and the `initialize` handshake with session id only if that is refused (gateways), reading JSON or SSE answers. It talks to nothing but the configured URL (`https`, or plain `http` only to localhost), never follows redirects, and on any error, timeout (2.5 s by default) or missing setting it prints nothing and exits 0, so it can never hold up a message.

## The memoria CLI

`cli/` holds `memoria`, a dependency-free Node CLI for agents (in Spanish; layout, configuration and tests in [cli/README.md](../cli/README.md)):

- **Reads skip the server.** With `MEMORIA_DIR` pointing at a checkout of the notes repo (read-only is enough), `buscar`, `leer`, `lista` and `recientes` work on the files with `rg` and `git`: no index, no MCP round trip, and output in windows (about 150 lines or 8,000 characters) with a section index for long notes. Without it, the same commands call `search`, `read`, `list` and `recent`.
- **Writes never skip it.** Every write is a tool call, so the server still signs it with the agent's credential, applies `memory.toml` and serialises it in its queue. `memoria copia` gives the agent a plain git clone to edit and commit; `memoria publicar` sends those commits as one `publish` submission (one server commit per commit of the copy, all or nothing) when the server lists that tool, and otherwise replays them as `create` / `write` / `move` / `delete` calls, one note at a time, each with the hash the agent saw, stopping at the first conflict.
- **Direct only.** With `MEMORIA_URL` and `MEMORIA_TOKEN`, tool calls go directly to this server's stateless `/mcp` endpoint (calling `search`, `read`, `create`, `publish`, etc. by their real names). The mode that wrapped them behind a gateway's `buscador_usar` is gone with that gateway. `cli/probar.sh` tests it end to end against a real `cli-memoria serve`.

`nix/memoria.nix` packages it for Linux and macOS: the `.mjs` files under `lib/memoria/` and a `bin/memoria` that runs them with Node 22.

## Observability

One JSON line per request on stdout (journald under systemd): client, tool, path, duration, outcome, commit and warnings. Note content, search queries (only their length) and tokens are never logged. Sync events, reindex runs and auth failures are logged too; `error` is reserved for things worth alerting on: a remote conflict that dropped a change, pushes failing for more than ten minutes, an invalid `memory.toml`.
