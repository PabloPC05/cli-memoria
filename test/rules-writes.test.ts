import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCommits, checkRange, checkTree, commitsReport } from "../src/check.js";
import { main } from "../src/cli.js";
import { parseConventions } from "../src/conventions.js";
import { MemoryError } from "../src/errors.js";
import { Git } from "../src/git.js";
import { blobHash } from "../src/util.js";
import { makeMemory, writer } from "./helpers.js";
import { RULES } from "./rules-config.js";

const FOLDERS = `[folders]
allowed = ["me", "people", "topics", "projects", "skills", "archive"]
archive = "archive"
index_full = ["me"]
`;

const WITH_RULES = `${FOLDERS}${RULES}`;

function fm(name: string, type: string | null, extra = ""): string {
	return `---\nname: ${name}\ndescription: ${name}, nota de prueba\naliases: []\n${type ? `type: ${type}\n` : ""}${extra}---\n# ${name}\n\n`;
}

const ANA = `${fm("Ana", "People")}Ana es prima de Pablo.\n\n## Quién es\n\nPrima de Pablo.\n\n## Fuentes\n\n- Pablo, 2026-10-21: «Ana es mi prima»\n`;
/** An old note with every kind of old problem: an invalid type, a retired tool, a forbidden section. */
const VIEJA = `${fm("Vieja", "Topic")}Usa \`memoria_search\` para buscar.\n\nOtra línea.\n\n## Historia\n\nAntes vivía en Lugo.\n\n## Fuentes\n\n- Pablo, 2026-10-01: «esto es viejo»\n`;

const SEED = {
	"memory.toml": WITH_RULES,
	"AGENTS.md": "# Normas\n\nUsa memoria_search si quieres: los archivos de la raíz no siguen las reglas.\n",
	"me/nucleo.md": `${fm("Núcleo", "Profile")}Pablo. Ver [[ana]] y [[vieja]].\n`,
	"people/ana.md": ANA,
	"topics/vieja.md": VIEJA,
	"skills/revision.md": `${fm("Revisión", null)}Un procedimiento sin tipo.\n`,
	"archive/sucia.md": `${fm("Sucia", "Topic")}Habla de memoria_read.\n`,
};

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
	vi.restoreAllMocks();
});

async function refused(p: Promise<unknown>): Promise<MemoryError & { details: { violations: { rule: string; line: number | null; fix: string }[] } }> {
	try {
		await p;
	} catch (error) {
		expect(error).toBeInstanceOf(MemoryError);
		expect((error as MemoryError).code).toBe("RULES_VIOLATED");
		return error as MemoryError & { details: { violations: { rule: string; line: number | null; fix: string }[] } };
	}
	throw new Error("expected RULES_VIOLATED");
}

const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);

async function hashOf(path: string): Promise<string> {
	return blobHash(await readFile(join(env!.memory.opts.repoDir, path), "utf8"));
}

describe("rules on every write path", () => {
	it("create: refuses a new note that breaks a rule, saying rule, line and fix, and commits nothing", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const head = await m.git.head();
		const e = await refused(m.create(writer, { path: "topics/nueva.md", content: `${fm("Nueva", "Topic")}Busca con memoria_read.\n\n## Historia\n\nx\n`, reason: "Nueva" }));
		expect(e.message.split("\n")[0]).toMatch(/^Not saved: this write would add 3 problems that the memory's rules forbid in «topics\/nueva\.md»/);
		expect(e.message).toContain("\n- type, line 5: «type: Topic» is not one of this memory's types. Fix: use one of: Profile, Preference, Work, People, Notes.");
		expect(e.message).toContain("\n- obsolete, line 9: «memoria_read» is a retired name");
		expect(e.message).toContain("\n- forbidden_section, line 11: «## Historia»");
		expect(e.details.violations.map((v) => v.rule)).toEqual(["type", "obsolete", "forbidden_section"]);
		expect(await m.git.head()).toBe(head);
		expect(await m.git.isClean()).toBe(true);
		const ok = await m.create(writer, { path: "topics/nueva.md", content: `${fm("Nueva", "Notes")}Busca con search.\n`, reason: "Nueva" });
		expect(codes(ok)).toEqual([]);
	});

	it("edit: old problems only warn, even on the line being edited; new ones are refused", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const r = await m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "Otra línea.", new_string: "Otra línea, corregida." }], reason: "Corrige" });
		expect(codes(r)).toEqual(["RULES_EXISTING"]);
		const existing = r.warnings[0] as unknown as { message: string; violations: { rule: string }[] };
		expect(existing.violations.map((v) => v.rule)).toEqual(["type", "obsolete", "forbidden_section"]);
		expect(existing.message).toMatch(/^Saved\. The note already had these problems \(they do not block\); fix them when you can:\n- type, line 5/);
		// Editing the very line with the old mention is fine.
		await m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "para buscar.", new_string: "para buscar notas." }], reason: "Matiza" });
		const head = await m.git.head();
		await refused(m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "Otra línea, corregida.", new_string: "Otra línea, y memoria_write para escribir." }], reason: "Añade" }));
		const e = await refused(m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "«esto es viejo»", new_string: "«esto es nuevo»" }], reason: "Cambia la fuente" }));
		expect(e.details.violations).toEqual([{ rule: "append_only", line: 17, message: "the line «- Pablo, 2026-10-01: «esto es viejo»» of «## Fuentes» was changed or removed", fix: expect.stringMatching(/^put it back exactly as it was; this section only takes new lines\. To split the note, do it in one submission \(the publish tool, or one memoria publicar\)/) }]);
		expect(await m.git.head()).toBe(head);
		// Fixing an old problem is a plain edit.
		const fixed = await m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "type: Topic", new_string: "type: Notes" }], reason: "Tipo" });
		expect((fixed.warnings[0] as unknown as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["obsolete", "forbidden_section"]);
	});

	it("write: same rules over the whole note; template problems warn and still save", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const more = ANA.replace("## Fuentes", "## Aficiones\n\nLe gusta el mar.\n\n## Fuentes");
		const r = await m.write(writer, { path: "people/ana.md", content: more, hash: await hashOf("people/ana.md"), reason: "Aficiones" });
		expect(codes(r)).toEqual(["RULES_WARNINGS"]);
		expect(r.warnings[0]?.message).toContain("- template, line 15: «## Aficiones» is not a section of the People template. Fix: move its content into one of the template's sections: Quién es · Relación con Pablo");
		await refused(m.write(writer, { path: "people/ana.md", content: more.replace(/## Fuentes[\s\S]*$/, "## Fuentes\n\n- Pablo, 2026-11-23: «otra cosa»\n"), hash: await hashOf("people/ana.md"), reason: "Pisa la fuente" }));
		await refused(m.write(writer, { path: "people/ana.md", content: more.replace("type: People\n", ""), hash: await hashOf("people/ana.md"), reason: "Sin tipo" }));
	});

	it("move: a note is judged where it goes against what it was where it was", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		// Renaming a note with old problems is fine; the links rewritten in other notes are not held to their old problems.
		const r = await m.move(writer, { from: "topics/vieja.md", to: "topics/antigua.md", hash: await hashOf("topics/vieja.md"), reason: "Renombra" });
		expect(r.links_rewritten).toBe(1);
		expect(codes(r)).toEqual(["RULES_EXISTING"]);
		// Out of a folder without types, or out of the archive, its problems are new.
		await refused(m.move(writer, { from: "skills/revision.md", to: "topics/revision.md", hash: await hashOf("skills/revision.md"), reason: "Mueve" }));
		const e = await refused(m.move(writer, { from: "archive/sucia.md", to: "topics/sucia.md", hash: await hashOf("archive/sucia.md"), reason: "Desarchiva" }));
		expect(e.details.violations.map((v) => v.rule)).toEqual(["type", "obsolete"]);
		expect(await m.git.isClean()).toBe(true);
		// Into the archive, the rules no longer apply.
		const archived = await m.move(writer, { from: "topics/antigua.md", to: "archive/antigua.md", hash: await hashOf("topics/antigua.md"), reason: "Archiva" });
		expect(codes(archived)).toEqual([]);
	});

	it("revert: may take back the lines a commit added to Fuentes, but not bring back a retired name", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const added = await m.edit(writer, { path: "people/ana.md", edits: [{ old_string: "«Ana es mi prima»\n", new_string: "«Ana es mi prima»\n- Pablo, 2026-11-23: «inventado por un agente»\n" }], reason: "Añade fuente" });
		const undone = await m.revert(writer, { commit: added.commit as string, reason: "Esa fuente no la dijo Pablo" });
		expect(undone.changes).toEqual([{ path: "people/ana.md", change: "reverted" }]);
		expect(await readFile(join(m.opts.repoDir, "people/ana.md"), "utf8")).toBe(ANA);
		const cleanup = await m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "Usa `memoria_search` para buscar.", new_string: "Busca en la memoria." }], reason: "Limpia" });
		const e = await refused(m.revert(writer, { commit: cleanup.commit as string, reason: "Deshace la limpieza" }));
		expect(e.details.violations.map((v) => v.rule)).toEqual(["obsolete"]);
		expect(await m.git.isClean()).toBe(true);
	});

	it("revert: a deleted note comes back as it was, old problems and all", async () => {
		env = await makeMemory({ ...SEED, "me/nucleo.md": `${fm("Núcleo", "Profile")}Pablo. Ver [[ana]].\n` });
		const m = env.memory;
		const gone = await m.delete(writer, { path: "topics/vieja.md", hash: await hashOf("topics/vieja.md"), reason: "Borra" });
		const back = await m.revert(writer, { commit: gone.commit as string, reason: "No había que borrarla" });
		expect(back.changes).toEqual([{ path: "topics/vieja.md", change: "restored" }]);
		expect(codes(back)).toEqual(["RULES_EXISTING"]);
	});

	it("publishing the commits of a working copy (memoria publicar) goes note by note through the same rules", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		// The working copy: a clone, edited and committed with git, as `memoria copia` leaves it.
		const copy = join(env.root, "copia");
		execFileSync("git", ["clone", "-q", m.opts.repoDir, copy]);
		const git = new Git(copy);
		await git.run(["config", "user.name", "copia"]);
		await git.run(["config", "user.email", "copia@example.com"]);
		const base = (await git.head()) as string;
		const commit = async (subject: string, path: string, change: (t: string) => string) => {
			const file = join(copy, path);
			await writeFile(file, change(await readFile(file, "utf8")));
			await git.run(["commit", "-q", "-am", subject]);
		};
		await commit("Ana vive en Vigo", "people/ana.md", (t) => t.replace("Prima de Pablo.\n", "Prima de Pablo. Vive en Vigo.\n"));
		await commit("Cómo buscar", "people/ana.md", (t) => t.replace("Vive en Vigo.", "Vive en Vigo. Se busca con memoria_search."));
		await commit("Quita la herramienta vieja", "people/ana.md", (t) => t.replace(" Se busca con memoria_search.", ""));
		// What `memoria publicar` sends for each commit: a `write` of every note it changed, with the server's hash.
		const publish = async (from: string, to: string, reason: string) => {
			for (const path of (await git.out(["diff", "--name-only", from, to])).split("\n").filter(Boolean)) {
				await m.write(writer, { path, content: await git.out(["show", `${to}:${path}`]), hash: await hashOf(path), reason });
			}
		};
		const commits = (await git.out(["rev-list", "--reverse", `${base}..HEAD`])).trim().split("\n");
		await publish(base, commits[0] as string, "Ana vive en Vigo");
		const e = await refused(publish(commits[0] as string, commits[1] as string, "Cómo buscar"));
		expect(e.message).toContain("- obsolete, line 13: «memoria_search» is a retired name");
		// Published flattened (`--aplanar`), the end result is clean and goes through.
		await publish(commits[0] as string, "HEAD", "Cómo buscar; Quita la herramienta vieja");
		expect(await readFile(join(m.opts.repoDir, "people/ana.md"), "utf8")).toBe(await readFile(join(copy, "people/ana.md"), "utf8"));
	});

	it("attach: the companion note gets the type the rules ask for", async () => {
		const lfs = (() => {
			try {
				execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		})();
		if (!lfs) return; // like the other attach tests, it needs git-lfs
		env = await makeMemory(SEED);
		const m = env.memory;
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");
		const r = await m.attach(writer, { path: "projects/logo.png", source: { base64: png }, description: "El logo", reason: "Logo" });
		expect(await readFile(join(m.opts.repoDir, r.path), "utf8")).toMatch(/\ntype: Notes\nattachment: logo\.png\n/);
		const w = await m.attach(writer, { path: "projects/plano.png", source: { base64: png }, description: "El plano", type: "Work", reason: "Plano" });
		expect(await readFile(join(m.opts.repoDir, w.path), "utf8")).toContain("\ntype: Work\n");
		await refused(m.attach(writer, { path: "projects/otro.png", source: { base64: png }, description: "Otro", type: "Imagen", reason: "Otro" }));
	});

});

describe("publish: several commits as one submission", () => {
	/** Ana with a second section and its own source, ready to be split. */
	const BIG = ANA.replace("## Fuentes", "## Trabajo\n\nTrabaja en Vigo.\n\n## Fuentes").replace("«Ana es mi prima»\n", "«Ana es mi prima»\n- Pablo, 2026-11-02: «trabaja en Vigo»\n");
	const SHORT = ANA;
	const sub = (fuente: string) => `${fm("Trabajo de Ana", "Work")}Ana trabaja en Vigo. Ver [[ana]].\n\n## Fuentes\n\n${fuente}\n`;

	async function setup() {
		env = await makeMemory({ ...SEED, "people/ana.md": BIG });
		return env.memory;
	}

	it("splitting a note moves its source lines to the new note in one submission, commit by commit", async () => {
		const m = await setup();
		const head = await m.git.head();
		// One write of the original alone is still refused, and says how to split.
		const alone = await refused(m.write(writer, { path: "people/ana.md", content: SHORT, hash: await hashOf("people/ana.md"), reason: "Acorta" }));
		expect(alone.details.violations[0]?.fix).toContain("To split the note, do it in one submission");
		const r = await m.publish(writer, {
			commits: [
				{ reason: "Acorta la nota de Ana", changes: [{ op: "write", path: "people/ana.md", content: SHORT, hash: await hashOf("people/ana.md") }] },
				{ reason: "El trabajo de Ana, en su nota", changes: [{ op: "create", path: "people/trabajo-de-ana.md", content: sub("- Pablo, 2026-11-02: «trabaja en Vigo»") }] },
			],
		});
		expect(r.commits.map((c) => c.reason)).toEqual(["Acorta la nota de Ana", "El trabajo de Ana, en su nota"]);
		expect(r.commits[1]?.commit).toBe(await m.git.head());
		expect((await m.git.out(["rev-list", "--count", `${head}..HEAD`])).trim()).toBe("2");
		expect((await m.git.out(["log", "-1", "--format=%(trailers:key=Tool,valueonly)"])).trim()).toBe("publish");
		expect(r.hashes).toEqual({ "people/ana.md": await hashOf("people/ana.md"), "people/trabajo-de-ana.md": await hashOf("people/trabajo-de-ana.md") });
		await expect(m.read({ path: "people/trabajo-de-ana.md" })).resolves.toMatchObject({ path: "people/trabajo-de-ana.md" });
		await expect(m.links({ path: "people/ana.md", direction: "in" })).resolves.toMatchObject({ in: expect.arrayContaining([expect.objectContaining({ src_path: "people/trabajo-de-ana.md" })]) });
	});

	it("a source line that goes nowhere, or arrives changed, refuses the whole submission and leaves no trace", async () => {
		const m = await setup();
		const head = await m.git.head();
		const send = async (fuente: string) =>
			m.publish(writer, {
				commits: [
					{ reason: "Nueva nota", changes: [{ op: "create", path: "people/trabajo-de-ana.md", content: sub(fuente) }] },
					{ reason: "Acorta", changes: [{ op: "write", path: "people/ana.md", content: SHORT, hash: await hashOf("people/ana.md") }] },
				],
			});
		const nowhere = await refused(send("- Pablo, 2026-11-23: «otra cosa»"));
		expect(nowhere.message.split("\n")[0]).toBe(
			"Not saved: this submission would add 1 problem that the memory's rules forbid in «people/ana.md» (memory.toml [rules]). Nothing was saved; fix each one and send it again.",
		);
		expect(nowhere.message).toContain("- people/ana.md: append_only, line 15: the line «- Pablo, 2026-11-02: «trabaja en Vigo»» of «## Fuentes» was changed or removed. Fix: put it back exactly as it was; this section only takes new lines, unless it moves unchanged into the «## Fuentes» of another note of this same submission.");
		await refused(send("- Pablo, 2026-11-02: «trabaja en Vigo, en el puerto»"));
		expect(await m.git.head()).toBe(head);
		expect(await m.git.isClean()).toBe(true);
		await expect(m.read({ path: "people/trabajo-de-ana.md" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((m.list({ folder: "people" }) as { notes: { path: string }[] }).notes.map((n) => n.path)).toEqual(["people/ana.md"]);
	});

	it("a retired name may go from the note being split to the new note, but no more of it", async () => {
		const m = await setup();
		const head = await m.git.head();
		const mother = await readFile(join(m.opts.repoDir, "topics/vieja.md"), "utf8");
		const short = mother.replace("Usa `memoria_search` para buscar.\n\n", "");
		const send = (body: string) =>
			m.publish(writer, {
				commits: [
					{
						reason: "Parte la nota vieja",
						changes: [
							{ op: "write", path: "topics/vieja.md", content: short, hash: blobHash(mother) },
							{ op: "create", path: "topics/vieja/buscar.md", content: `${fm("Buscar", "Notes")}${body}\n` },
						],
					},
				],
			});
		const e = await refused(send("Usa `memoria_search` para buscar, y `memoria_search` otra vez."));
		expect(e.details.violations).toMatchObject([{ path: "topics/vieja/buscar.md", rule: "obsolete" }]);
		expect(await m.git.head()).toBe(head);
		const r = await send("Usa `memoria_search` para buscar.");
		expect(r.commits).toHaveLength(1);
		// Written as history, with its cut-off date on the line, it is not a violation anywhere.
		const dated = await m.edit(writer, { path: "people/ana.md", edits: [{ old_string: "Prima de Pablo.", new_string: "Prima de Pablo. Antes se buscaba con memoria_search (hasta el 2026-11-22)." }], reason: "Historia" });
		expect(dated.commit).not.toBe(r.commits[0]?.commit);
		expect(JSON.stringify(dated.warnings)).not.toContain("obsolete");
	});

	it("any failed change refuses everything, saying which commit and change", async () => {
		const m = await setup();
		const head = await m.git.head();
		let error: MemoryError | null = null;
		try {
			await m.publish(writer, {
				commits: [
					{ reason: "Uno", changes: [{ op: "create", path: "topics/uno.md", content: `${fm("Uno", "Notes")}Uno.\n` }] },
					{ reason: "Dos", changes: [{ op: "write", path: "people/ana.md", content: SHORT, hash: "0000" }] },
				],
			});
		} catch (e) {
			error = e as MemoryError;
		}
		expect(error?.code).toBe("CONFLICT");
		expect(error?.message).toMatch(/^Nothing was saved\. Commit 2, change 1 \(write people\/ana\.md\): «people\/ana\.md» changed since you read it\./);
		expect(await m.git.head()).toBe(head);
		await expect(m.read({ path: "topics/uno.md" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((await m.read({ path: "people/ana.md" })).content).toBe(BIG);
	});

	it("what memoria publicar would send: the commits of a working copy, and check judges each commit the same way", async () => {
		const m = await setup();
		const copy = join(env!.root, "copia");
		execFileSync("git", ["clone", "-q", m.opts.repoDir, copy]);
		const git = new Git(copy);
		await git.run(["config", "user.name", "copia"]);
		await git.run(["config", "user.email", "copia@example.com"]);
		const base = (await git.head()) as string;
		// One commit that splits the note: what `memoria publicar` turns into one publish.
		await writeFile(join(copy, "people/ana.md"), SHORT);
		await writeFile(join(copy, "people/trabajo-de-ana.md"), sub("- Pablo, 2026-11-02: «trabaja en Vigo»"));
		await git.run(["add", "-A"]);
		await git.run(["commit", "-q", "-m", "Parte la nota de Ana"]);
		const changes = [];
		for (const line of (await git.out(["diff", "--name-status", base, "HEAD"])).trim().split("\n")) {
			const [status, path] = line.split("\t") as [string, string];
			const content = await git.out(["show", `HEAD:${path}`]);
			changes.push(status === "A" ? { op: "create" as const, path, content } : { op: "write" as const, path, content, hash: (await git.out(["rev-parse", `${base}:${path}`])).trim() });
		}
		const r = await m.publish(writer, { commits: [{ reason: "Parte la nota de Ana", changes }] });
		expect(r.commits).toHaveLength(1);
		const each = commitsReport(await checkCommits(new Git(m.opts.repoDir), parseConventions(WITH_RULES), `${base}..HEAD`));
		expect(each).toMatchObject({ commits: 1, refused_commits: 0 });
	});
});

describe("without [rules]", () => {
	it("every write behaves as before: no checks, no rule warnings, nothing in lint", async () => {
		env = await makeMemory({ ...SEED, "memory.toml": FOLDERS });
		const m = env.memory;
		const c = await m.create(writer, { path: "topics/libre.md", content: `${fm("Libre", "Lo que sea")}Usa memoria_read.\n\n## Historia\n\nx\n`, reason: "Libre" });
		expect(codes(c)).toEqual([]);
		const e = await m.edit(writer, { path: "people/ana.md", edits: [{ old_string: "«Ana es mi prima»", new_string: "«otra cosa»" }], reason: "Cambia" });
		expect(codes(e)).toEqual([]);
		expect(m.lint({ kinds: ["rules"] }).counts).toEqual({ rules: 0 });
		expect(await m.instructions()).not.toContain("this memory's rules");
	});
});

describe("lint and check report the same rules", () => {
	it("lint lists each note's problems with line and fix, outside the archive, root files and untyped folders", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.lint({ kinds: ["rules"] });
		expect(r.counts).toEqual({ rules: 1 });
		expect(r.items[0]).toEqual({
			kind: "rules",
			notes: ["topics/vieja.md"],
			detail: {
				by_rule: { type: 1, obsolete: 1, forbidden_section: 1 },
				violations: [
					"type, line 5: «type: Topic» is not one of this memory's types. Fix: use one of: Profile, Preference, Work, People, Notes.",
					"obsolete, line 9: «memoria_search» is a retired name this memory no longer uses. Fix: use this server's own tools (search, read, write…).",
					"forbidden_section, line 13: «## Historia» is a section this memory does not allow. Fix: remove the section and correct the note so it says what is true now (git keeps the earlier versions).",
				],
			},
		});
		expect(await env.memory.instructions()).toContain("Every write is checked against this memory's rules");
	});

	it("cli-memoria lint reads the notes for the rules kind", async () => {
		env = await makeMemory(SEED);
		await env.memory.stop();
		const toml = join(env.root, "server.toml");
		await writeFile(toml, `data_dir = "${join(env.root, "data")}"\n[listen.private]\nport = 1\n`);
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		expect(await main(["lint", "--config", toml, "--kind", "rules"])).toBe(0);
		expect(String(out.mock.calls[0]?.[0])).toMatch(/^1 item\(s\): rules 1\nrules\s+topics\/vieja\.md  by_rule=type:1,obsolete:1,forbidden_section:1  violations=type, line 5/);
	});

	it("check: a tree, a range judged like a write, and every commit on its own", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const git = new Git(m.opts.repoDir);
		const conventions = parseConventions(WITH_RULES);
		const tree = await checkTree(git, conventions);
		expect(tree.notes).toBe(4);
		expect(tree.findings.map((f) => f.path)).toEqual(["topics/vieja.md"]);
		const start = (await git.head()) as string;
		await m.edit(writer, { path: "topics/vieja.md", edits: [{ old_string: "Otra línea.", new_string: "Otra línea, bien." }], reason: "Bien" });
		// Someone with git access commits behind the server's back: check sees what the server would have refused.
		await writeFile(join(m.opts.repoDir, "people/ana.md"), ANA.replace("«Ana es mi prima»", "«nada»"));
		await git.run(["commit", "-q", "-am", "A mano"]);
		const range = await checkRange(git, conventions, start, "HEAD");
		expect(range.map((f) => [f.path, f.check.blocking.map((v) => v.rule), f.check.existing.length])).toEqual([
			["people/ana.md", ["append_only"], 0],
			["topics/vieja.md", [], 3],
		]);
		const each = commitsReport(await checkCommits(git, conventions, `${start}..HEAD`));
		expect(each).toMatchObject({ commits: 2, writes: 2, refused_commits: 1, refused_commits_by_rule: { append_only: 1 }, writes_with_older_problems: 1 });
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		expect(await main(["check", m.opts.repoDir, `${start}..HEAD`])).toBe(1);
		expect(String(out.mock.calls[0]?.[0])).toContain("REFUSED people/ana.md  append_only, line 15:");
		expect(await main(["check", m.opts.repoDir, `${start}..HEAD~1`])).toBe(0);
		expect(await main(["check", m.opts.repoDir, "--json"])).toBe(0);
		expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ notes: 4, with_problems: 1, notes_by_rule: { type: 1, obsolete: 1, forbidden_section: 1 } });
	});
});
