import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Git } from "../src/git.js";
import { type ClientIdentity, MemoryService, type MemoryOptions } from "../src/memory.js";

export const writer: ClientIdentity = { id: "test-writer", name: "Test Writer", scope: "write" };
export const reader: ClientIdentity = { id: "test-reader", name: "Test Reader", scope: "read" };

export async function tempDir(prefix = "mm-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export function note(name: string, description: string, body = "", extra = ""): string {
	return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\n${body}\n`;
}

/** A git repo seeded with files in one initial commit, as the notes repo the server starts with. */
export async function seedRepo(dir: string, files: Record<string, string>): Promise<Git> {
	await mkdir(dir, { recursive: true });
	const git = new Git(dir);
	await git.run(["init", "-q", "-b", "main"]);
	await git.run(["config", "user.name", "Seeder"]);
	await git.run(["config", "user.email", "seed@example.com"]);
	await git.run(["config", "core.autocrlf", "false"]);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	if (Object.keys(files).length) {
		await git.run(["add", "-A"]);
		await git.run(["commit", "-q", "-m", "seed"]);
	}
	return git;
}

/** A note written straight into the notes repo and committed, the way someone edits it by hand on the server. */
export async function commitByHand(git: Git, dir: string, path: string, content: string, message = "a mano"): Promise<string> {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await writeFile(join(dir, path), content);
	await git.run(["add", "--", path]);
	await git.run(["commit", "-q", "-m", message]);
	return (await git.out(["rev-parse", "HEAD"])).trim();
}

export const CONVENTIONS = `[folders]
allowed = ["yo", "personas", "temas", "proyectos", "archivo"]
archive = "archivo"
index_full = ["yo"]

[notes]
superseded_field = "sustituida_por"
`;

export async function makeMemory(
	files: Record<string, string> = {},
	opts: Partial<MemoryOptions> = {},
): Promise<{ root: string; memory: MemoryService; cleanup: () => Promise<void> }> {
	const root = await tempDir();
	await seedRepo(join(root, "data", "repo"), { "memory.toml": CONVENTIONS, ...files });
	const memory = new MemoryService({
		repoDir: join(root, "data", "repo"),
		indexPath: join(root, "data", "index.sqlite"),
		...opts,
	});
	await memory.start();
	const env = {
		root,
		memory,
		cleanup: async () => {
			await memory.stop();
			if (env.memory !== memory) await env.memory.stop();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		},
	};
	return env;
}
