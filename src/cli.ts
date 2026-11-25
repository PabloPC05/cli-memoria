import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addToken, listTokens, revokeToken } from "./auth/tokens.js";
import { checkCommits, checkRange, checkTree, commitsReport, rangeReport, renderCommits, renderRange, renderTree, treeReport } from "./check.js";
import { buildClientsReport, ClientActivity, renderClientsTable } from "./clients.js";
import { loadConfig } from "./config.js";
import { Git } from "./git.js";
import { CONVENTIONS_FILE, defaultConventions, parseConventions } from "./conventions.js";
import { lint, renderLint } from "./lint.js";
import { jsonLogger } from "./log.js";
import { MemoryService } from "./memory.js";
import { SearchIndex } from "./search-index.js";
import { startServer } from "./server.js";

const USAGE = `cli-memoria — git-backed memory server for AI agents (MCP)

Usage:
  cli-memoria serve --config <file>
  cli-memoria token add <id> --name <name> --scope read|write (--config <file> | --file <tokens.toml>)
  cli-memoria token list   (--config <file> | --file <tokens.toml>)
  cli-memoria token revoke <id> (--config <file> | --file <tokens.toml>)
  cli-memoria clients [--json] --config <file>   who is connected: last seen, writes, setup version
  cli-memoria lint [--json] [--kind <k>[,<k>]] [--folder <f>] [--limit <n>] --config <file>
                                                 maintenance worklist (broken links, orphans, stale notes…)
  cli-memoria check <repo-dir> [<rev> | <from>..<to> [--each]] [--conventions <memory.toml>] [--json]
                                                 the write rules ([rules] in memory.toml) over a git repo:
                                                 a tree lists every note's problems; a range is judged like a write
                                                 (exit 1 if it adds a problem that blocks: usable as a git hook);
                                                 --each judges every commit of the range on its own
  cli-memoria reindex --config <file>            full rebuild of the FTS5 index (stop the service first)

The config file is TOML; see the README for every key.
`;

function tokensFile(values: { config?: string; file?: string }): string {
	if (values.file) return values.file;
	if (!values.config) throw new Error("give --config or --file");
	const config = loadConfig(values.config);
	if (!config.tokensFile) throw new Error("the config has no tokens_file");
	return config.tokensFile;
}

export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: "string", short: "c" },
			file: { type: "string" },
			name: { type: "string" },
			scope: { type: "string" },
			conventions: { type: "string" },
			json: { type: "boolean" },
			each: { type: "boolean" },
			kind: { type: "string" },
			folder: { type: "string" },
			limit: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, sub, arg] = positionals;
	try {
		if (values.help || !command) {
			process.stdout.write(USAGE);
			return command ? 0 : 1;
		}
		if (command === "serve") {
			if (!values.config) throw new Error("serve needs --config");
			const config = loadConfig(values.config);
			const running = await startServer(config);
			process.on("SIGHUP", () => {
				try {
					running.tokens.reload();
					jsonLogger()("info", "tokens.reloaded", { count: running.tokens.count });
				} catch (error) {
					jsonLogger()("error", "tokens.reload_failed", { error: (error as Error).message });
				}
			});
			await new Promise<void>((resolve) => {
				const stop = () => resolve();
				process.once("SIGTERM", stop);
				process.once("SIGINT", stop);
			});
			await running.stop();
			return 0;
		}
		if (command === "token") {
			const file = tokensFile(values);
			if (sub === "add") {
				if (!arg) throw new Error("token add needs an id");
				const scope = values.scope ?? "write";
				if (scope !== "read" && scope !== "write") throw new Error("--scope must be read or write");
				const token = await addToken(file, arg, values.name ?? arg, scope);
				process.stdout.write(`${token}\n`);
				process.stderr.write(`Token «${arg}» (${scope}) saved. This is the only time it is shown. Reload the service (SIGHUP) to use it.\n`);
				return 0;
			}
			if (sub === "list") {
				for (const t of await listTokens(file)) process.stdout.write(`${t.id}\t${t.scope}\t${t.name}\n`);
				return 0;
			}
			if (sub === "revoke") {
				if (!arg) throw new Error("token revoke needs an id");
				const done = await revokeToken(file, arg);
				process.stderr.write(done ? `Revoked «${arg}». Reload the service (SIGHUP).\n` : `No token «${arg}».\n`);
				return done ? 0 : 1;
			}
			throw new Error("token: add, list or revoke");
		}
		if (command === "clients") {
			if (!values.config) throw new Error("clients needs --config");
			const config = loadConfig(values.config);
			const repoDir = join(config.dataDir, "repo");
			const report = await buildClientsReport({
				git: new Git(repoDir),
				repoDir,
				staticClients: () => (config.tokensFile ? listTokens(config.tokensFile) : []),
				activity: () => ClientActivity.snapshot(join(config.dataDir, "activity.sqlite")),
			});
			process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : renderClientsTable(report)}\n`);
			return 0;
		}
		if (command === "lint") {
			if (!values.config) throw new Error("lint needs --config");
			const config = loadConfig(values.config);
			const repoDir = join(config.dataDir, "repo");
			const conventionsText = await readFile(join(repoDir, CONVENTIONS_FILE), "utf8").catch(() => null);
			const conventions = conventionsText === null ? defaultConventions() : parseConventions(conventionsText);
			const limit = values.limit === undefined ? 500 : /^\d+$/.test(values.limit.trim()) ? Number(values.limit) : Number.NaN;
			if (!(limit >= 1)) throw new Error(`--limit must be a positive whole number, not «${values.limit}»`);
			// Reads the index the server keeps, read-only: safe while the server runs (SQLite WAL), and an index of
			// another schema version is refused, never reset under a running server.
			const index = new SearchIndex(join(config.dataDir, "index.sqlite"), { readOnly: true });
			try {
				if (!index.getMeta("indexed_commit")) throw new Error("the index is empty: start the server once or run «cli-memoria reindex»");
				const readNote = (path: string) => {
					try {
						return readFileSync(join(repoDir, ...path.split("/")), "utf8");
					} catch {
						return null;
					}
				};
				const report = lint(index, conventions, { kinds: values.kind?.split(",").map((k) => k.trim()).filter(Boolean), folder: values.folder, limit }, Date.now(), readNote);
				process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : renderLint(report)}\n`);
				return 0;
			} finally {
				index.close();
			}
		}
		if (command === "check") {
			if (!sub) throw new Error("check needs the path of a clone of the notes repo (or a bare repo)");
			const spec = arg ?? "HEAD";
			if (spec.startsWith("-")) throw new Error(`invalid revision «${spec}»`);
			const git = new Git(sub);
			const range = /^(.*?)\.\.(.+)$/.exec(spec);
			const at = range ? (range[2] as string) : spec;
			let conventionsText: string | null;
			if (values.conventions) conventionsText = await readFile(values.conventions, "utf8");
			else {
				const shown = await git.run(["show", `${at}:${CONVENTIONS_FILE}`], { allowFail: true });
				conventionsText = shown.code === 0 ? shown.stdout : null;
			}
			const conventions = conventionsText === null ? defaultConventions() : parseConventions(conventionsText);
			if (!conventions.rules) {
				process.stdout.write(`no [rules] in ${values.conventions ?? `${CONVENTIONS_FILE} at ${at}`}: nothing to check\n`);
				return 0;
			}
			if (!range) {
				if (values.each) throw new Error("--each needs a range: <from>..<to>");
				const result = await checkTree(git, conventions, spec);
				process.stdout.write(`${values.json ? JSON.stringify(treeReport(result), null, 2) : renderTree(result)}\n`);
				return 0;
			}
			if (values.each) {
				const commits = await checkCommits(git, conventions, spec);
				const report = commitsReport(commits);
				process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : renderCommits(commits)}\n`);
				return report.refused_commits ? 1 : 0;
			}
			const files = await checkRange(git, conventions, range[1] || null, range[2] as string);
			const report = rangeReport(files);
			process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : renderRange(files)}\n`);
			return report.blocked ? 1 : 0;
		}
		if (command === "reindex") {
			if (!values.config) throw new Error("reindex needs --config");
			const config = loadConfig(values.config);
			const memory = new MemoryService({
				repoDir: join(config.dataDir, "repo"),
				indexPath: join(config.dataDir, "index.sqlite"),
				branch: config.branch,
				log: jsonLogger(),
			});
			await memory.start();
			try {
				await memory.rebuildIndex();
			} finally {
				await memory.stop();
			}
			return 0;
		}
		throw new Error(`unknown command «${command}»`);
	} catch (error) {
		process.stderr.write(`cli-memoria: ${(error as Error).message}\n`);
		return 1;
	}
}
