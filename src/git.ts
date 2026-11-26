import { execFile } from "node:child_process";

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitOptions {
	/** Extra config passed through GIT_CONFIG_* variables, so secrets never show up in the process arguments. */
	config?: Record<string, string>;
	env?: Record<string, string>;
	gitBinary?: string;
}

export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly result: GitResult,
	) {
		super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = "GitError";
	}
}

/** Thin wrapper over the git binary: no shell, fixed locale, never prompts. */
export class Git {
	constructor(
		readonly cwd: string,
		private readonly options: GitOptions = {},
	) {}

	private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LC_ALL: "C",
			LANG: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_EDITOR: "true",
			...this.options.env,
			...extra,
		};
		const config = Object.entries(this.options.config ?? {});
		if (config.length > 0) {
			env.GIT_CONFIG_COUNT = String(config.length);
			config.forEach(([key, value], i) => {
				env[`GIT_CONFIG_KEY_${i}`] = key;
				env[`GIT_CONFIG_VALUE_${i}`] = value;
			});
		}
		return env;
	}

	run(args: string[], opts: { input?: string | Buffer; allowFail?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
		return new Promise((resolve, reject) => {
			const child = execFile(
				this.options.gitBinary ?? "git",
				args,
				{ cwd: this.cwd, env: this.env(opts.env), maxBuffer: 256 * 1024 * 1024, encoding: "utf8", windowsHide: true },
				(error, stdout, stderr) => {
					const errCode = (error as { code?: unknown } | null)?.code;
					if (errCode === "ENOENT") return reject(new Error(`git binary not found (${this.options.gitBinary ?? "git"})`));
					const code = error ? (typeof errCode === "number" ? errCode : 1) : 0;
					const result = { stdout, stderr, code };
					if (code !== 0 && !opts.allowFail) return reject(new GitError(args, result));
					resolve(result);
				},
			);
			if (opts.input !== undefined) child.stdin?.end(opts.input);
		});
	}

	async out(args: string[]): Promise<string> {
		return (await this.run(args)).stdout;
	}

	/** Stdout as raw bytes (blobs), failing like `run` does. */
	bytes(args: string[], opts: { input?: string } = {}): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = execFile(this.options.gitBinary ?? "git", args, { cwd: this.cwd, env: this.env(), maxBuffer: 1024 * 1024 * 1024, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
				if (!error) return resolve(stdout);
				const errCode = (error as { code?: unknown }).code;
				if (errCode === "ENOENT") return reject(new Error(`git binary not found (${this.options.gitBinary ?? "git"})`));
				reject(new GitError(args, { stdout: "", stderr: stderr.toString("utf8"), code: typeof errCode === "number" ? errCode : 1 }));
			});
			if (opts.input !== undefined) child.stdin?.end(opts.input);
		});
	}

	/** Many blobs (`rev:path`) in one `git cat-file --batch`, as text; null for those that do not exist. */
	async blobs(specs: string[]): Promise<(string | null)[]> {
		if (specs.length === 0) return [];
		const out = await this.bytes(["cat-file", "--batch"], { input: specs.map((s) => `${s}\n`).join("") });
		const result: (string | null)[] = [];
		let at = 0;
		for (let i = 0; i < specs.length; i++) {
			const nl = out.indexOf(10, at);
			const header = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
			at = nl + 1;
			if (!header) {
				result.push(null); // «<spec> missing» or «ambiguous»
				continue;
			}
			const size = Number(header[2]);
			result.push(header[1] === "blob" ? out.subarray(at, at + size).toString("utf8") : null);
			at += size + 1;
		}
		return result;
	}

	async head(): Promise<string | null> {
		const r = await this.run(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
		return r.code === 0 ? r.stdout.trim() : null;
	}

	async isClean(): Promise<boolean> {
		return (await this.out(["status", "--porcelain", "--untracked-files=all"])).trim() === "";
	}

	async exists(rev: string): Promise<boolean> {
		return (await this.run(["cat-file", "-e", `${rev}^{commit}`], { allowFail: true })).code === 0;
	}
}
