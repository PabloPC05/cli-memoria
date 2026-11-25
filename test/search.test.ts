import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { noteViolations, type Rules } from "../src/rules.js";
import { makeMemory, note, writer } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import { tempDir } from "./helpers.js";

const SEED = {
	"proyectos/reforma.md": note("Reforma de la cocina", "Presupuesto y plazos", "## Pendiente\n\n- [ ] Pedir presupuesto · Ana · 2026-03-14 [llamada]\n- [ ] Elegir azulejos · Ana · 2026-03\n- [x] Hablar con el fontanero · Luis · 2026-01-20\n- [ ] Comprar el material · - · sin plazo\n", 'type: project\nstatus: active\n'),
	"proyectos/ideas.md": note("Ideas sueltas", "Cosas por hacer algún día", "## Pendiente\n\n- [ ] Aprender a soldar · Alex · 2027-01-05\n", "type: idea\nstatus: idea\n"),
	"referencia/diccionario.md": note("Diccionario", "Palabras y oficios", "## Oficios\n\nEl fontanero y el electricista. Las hipotecas del banco.\n", "type: reference\n"),
	"temas/hipotecas.md": note("Hipotecas", "Préstamos de la casa", "## Banco\n\nLas hipotecas variables del banco suben. El fontanero lo sabe.\n"),
	"temas/sin-tipo.md": note("Sin tipo", "Nota sin type ni status", "## Banco\n\nLas hipotecas y el banco.\n"),
	"archivo/reforma-vieja.md": note("Reforma vieja", "Presupuesto antiguo", "## Pendiente\n\n- [ ] Rehacer el baño · Ana · 2026-02-01\n", "type: project\n"),
};

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

describe("search: paging, filters and grouping", () => {
	it("marks the matched words with «» unless highlight is false", async () => {
		env = await makeMemory(SEED);
		expect(env.memory.search({ query: "fontanero" }).hits.some((h) => h.snippet.includes("«fontanero»"))).toBe(true);
		const plain = env.memory.search({ query: "fontanero", highlight: false }).hits;
		expect(plain.length).toBeGreaterThan(0);
		expect(plain.every((h) => !h.snippet.includes("«") && !h.snippet.includes("»"))).toBe(true);
	});

	it("returns the total, the next offset and the type and status of every hit", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.search({ query: "banco", limit: 1 });
		expect(r).toMatchObject({ mode: "all", total: expect.any(Number) });
		expect(r.hits).toHaveLength(1);
		expect(Object.keys(r.hits[0] ?? {})).toEqual(expect.arrayContaining(["path", "name", "section", "snippet", "score", "type", "status"]));
		expect(r.next_offset).toBe(1);
		const second = env.memory.search({ query: "banco", limit: 1, offset: r.next_offset });
		expect(second.hits[0]?.path).not.toBe(r.hits[0]?.path);
		// A name is returned as it is, and a note without type or status says null.
		const all = env.memory.search({ query: "banco", limit: 50, offset: 0 });
		expect(all.hits.map((h) => [h.path, h.type, h.status])).toContainEqual(["temas/sin-tipo.md", null, null]);
		expect(all.next_offset).toBeUndefined();
		expect(all.hits).toHaveLength(all.total);
	});

	it("filters by type and status in SQL, alone or as a list", async () => {
		env = await makeMemory(SEED);
		expect(env.memory.search({ query: "banco", type: "reference" }).hits.map((h) => h.path)).toEqual(["referencia/diccionario.md"]);
		expect(env.memory.search({ query: "banco", type: ["reference", "project"] }).hits.map((h) => h.path)).toEqual(["referencia/diccionario.md"]);
		// Two sections of the same note match: one note, at most two sections (group_by_note).
		expect([...new Set(env.memory.search({ query: "presupuesto", type: ["reference", "project"] }).hits.map((h) => h.path))]).toEqual(["proyectos/reforma.md"]);
		expect([...new Set(env.memory.search({ query: "presupuesto", status: "active" }).hits.map((h) => h.path))]).toEqual(["proyectos/reforma.md"]);
		expect(env.memory.search({ query: "presupuesto", status: ["idea", "waiting"] }).hits).toEqual([]);
		expect(env.memory.search({ query: "banco", type: "nada" }).hits).toEqual([]);
	});

	it("keeps at most two sections per note unless group_by_note is off", async () => {
		env = await makeMemory({
			"temas/larga.md": note("Larga", "Muchas secciones", ["## Uno", "banco uno", "## Dos", "banco dos", "## Tres", "banco tres", "## Cuatro", "banco cuatro"].join("\n\n")),
			"temas/otra.md": note("Otra", "Otra nota", "## Banco\n\nbanco cinco\n"),
		});
		const grouped = env.memory.search({ query: "banco", limit: 10 });
		expect(grouped.hits.filter((h) => h.path === "temas/larga.md")).toHaveLength(2);
		expect(grouped.total).toBe(3);
		const flat = env.memory.search({ query: "banco", limit: 10, group_by_note: false });
		expect(flat.hits.filter((h) => h.path === "temas/larga.md")).toHaveLength(4);
		expect(flat.total).toBe(5);
	});

	it("ranks a record and a reference below a plain note with the same words", async () => {
		env = await makeMemory({
			"temas/registro.md": note("Registro", "Un registro", "## Banco\n\nbanco banco banco\n", "type: record\n"),
			"temas/referencia.md": note("Referencia", "Una referencia", "## Banco\n\nbanco banco banco\n", "type: reference\n"),
			"temas/normal.md": note("Normal", "Una nota normal", "## Banco\n\nbanco banco banco\n"),
		});
		const hits = env.memory.search({ query: "banco", limit: 10 }).hits.map((h) => h.path);
		expect(hits[0]).toBe("temas/normal.md");
		expect(hits.slice(1).sort()).toEqual(["temas/referencia.md", "temas/registro.md"]);
	});

	it("finds the singular of what the query says in plural", async () => {
		env = await makeMemory({ "temas/casa.md": note("Casa", "La casa", "## Dinero\n\nLa hipoteca del piso.\n") });
		expect(env.memory.search({ query: "hipotecas" }).hits.map((h) => h.path)).toEqual(["temas/casa.md"]);
		expect(env.memory.search({ query: "hipoteca" }).hits.map((h) => h.path)).toEqual(["temas/casa.md"]);
	});

	it("resolves links through the name index, whatever the case of the file", async () => {
		env = await makeMemory({
			"temas/Universidad.md": note("Universidad", "Carrera", "Texto."),
			"temas/origen.md": note("Origen", "Enlaza", "Ver [[universidad]]."),
		});
		expect(env.memory.index.brokenLinks().filter((l) => l.srcPath === "temas/origen.md")).toEqual([]);
		const back = (await env.memory.links({ name: "Universidad", direction: "in" })) as { in: { src_path: string }[] };
		expect(back.in.map((l) => l.src_path)).toEqual(["temas/origen.md"]);
	});
});

describe("publish resolves the links of the whole submission once", () => {
	it("a note created and linked inside the same publish ends up resolved", async () => {
		env = await makeMemory({ "temas/base.md": note("Base", "La base", "Texto.") });
		const m = env.memory;
		await m.publish(writer, {
			commits: [
				{
					reason: "Dos notas nuevas",
					changes: [
						{ op: "create", path: "temas/alpha.md", content: note("Alpha", "Primera", "Ver [[beta]].") },
						{ op: "create", path: "temas/beta.md", content: note("Beta", "Segunda", "Ver [[alpha]].") },
					],
				},
			],
		});
		expect(m.index.brokenLinks()).toEqual([]);
		await m.publish(writer, { commits: [{ reason: "Renombrar beta", changes: [{ op: "move", from: "temas/beta.md", to: "temas/beta-dos.md", hash: await hashOf(m, "temas/beta.md") }] }] });
		expect(m.index.brokenLinks()).toEqual([]);
		const back = (await m.links({ name: "beta-dos", direction: "in" })) as { in: { src_path: string }[] };
		expect(back.in.map((l) => l.src_path)).toEqual(["temas/alpha.md"]);
	});

	it("a link added to a note created earlier in the same publish is seen by a later delete", async () => {
		env = await makeMemory({ "temas/vieja.md": note("Vieja", "Se va", "Texto.") });
		const m = env.memory;
		await expect(
			m.publish(writer, {
				commits: [
					{
						reason: "Nueva que enlaza",
						changes: [
							{ op: "create", path: "temas/nueva.md", content: note("Nueva", "Enlaza a la vieja", "Ver [[vieja]].") },
							{ op: "delete", path: "temas/vieja.md", hash: await hashOf(m, "temas/vieja.md") },
						],
					},
				],
			}),
		).rejects.toMatchObject({ code: "HAS_BACKLINKS" });
	});
});

describe("deadlines", () => {
	it("lists the pending lines of the notes, soonest first", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.deadlines({});
		expect(r.items.map((i) => [i.date, i.date_precision, i.text])).toEqual([
			["2026-03", "month", "Elegir azulejos"],
			["2026-03-14", "day", "Pedir presupuesto"],
			["2027-01-05", "day", "Aprender a soldar"],
		]);
		expect(r.items[1]).toMatchObject({ path: "proyectos/reforma.md", name: "reforma", owner: "Ana", origin: "llamada", done: false });
		expect(r.items[0]?.origin).toBeNull();
		// Done lines and undated ones are left out unless asked for.
		expect(r.items.some((i) => i.done)).toBe(false);
		expect(r.items.some((i) => i.date === null)).toBe(false);
		// Archived notes are not deadlines any more.
		expect(r.items.some((i) => i.path.startsWith("archivo/"))).toBe(false);
	});

	it("includes done and undated lines when asked, and filters by folder", async () => {
		env = await makeMemory(SEED);
		const all = env.memory.deadlines({ include_done: true, include_undated: true });
		expect(all.items.filter((i) => i.done).map((i) => i.text)).toEqual(["Hablar con el fontanero"]);
		const undated = all.items.filter((i) => i.date === null);
		expect(undated.map((i) => [i.text, i.owner])).toEqual([["Comprar el material", null]]);
		expect(undated[0]?.line).toBeGreaterThan(0);
		// Undated last, in the order they were found.
		expect(all.items.at(-1)?.text).toBe("Comprar el material");
		expect(env.memory.deadlines({ folder: "proyectos" }).items.map((i) => i.text)).toEqual(["Elegir azulejos", "Pedir presupuesto", "Aprender a soldar"]);
		expect(env.memory.deadlines({ folder: "temas" }).items).toEqual([]);
		expect(env.memory.deadlines({ limit: 1 }).items).toHaveLength(1);
		expect(env.memory.deadlines({ limit: 1 })).toMatchObject({ total: 3 });
	});

	it("reads «Pendiente» when the memory has [rules] but no [rules.pending]", async () => {
		env = await makeMemory(
			{
				"memory.toml": `[folders]\nallowed = ["yo", "personas", "temas", "proyectos", "archivo"]\narchive = "archivo"\nindex_full = ["yo"]\n\n[notes]\nsuperseded_field = "sustituida_por"\n\n[attachments]\npage_heading = "Página {n}"\n\n[rules.frontmatter]\nrequired = true\n`,
				"temas/tareas.md": note("Tareas", "Lo que hay que hacer", "## Pendiente\n\n- [ ] Regar el huerto · Alex · 2026-05-02\n"),
			},
			undefined,
		);
		expect(env.memory.conventions.rules?.pending.sections).toEqual([]);
		expect(env.memory.deadlines({}).items.map((i) => i.text)).toEqual(["Regar el huerto"]);
	});

	it("reads another section when [rules.pending] says so", async () => {
		env = await makeMemory(
			{
				"memory.toml": `[folders]\nallowed = ["yo", "personas", "temas", "proyectos", "archivo"]\narchive = "archivo"\nindex_full = ["yo"]\n\n[notes]\nsuperseded_field = "sustituida_por"\n\n[attachments]\npage_heading = "Página {n}"\n\n[rules.pending]\nsection = "Tareas"\n`,
				"temas/tareas.md": note("Tareas", "Lo que hay que hacer", "## Tareas\n\n- [ ] Regar el huerto · Alex · 2026-05-02\n\n## Pendiente\n\n- [ ] Esto ya no cuenta · Alex · 2026-05-02\n"),
			},
			undefined,
		);
		expect(env.memory.deadlines({}).items.map((i) => i.text)).toEqual(["Regar el huerto"]);
		expect(env.memory.conventions.rules?.pending.sections).toEqual(["Tareas"]);
	});

	it("collects pending lines from ### subsections inside ## Pendiente and stops at the next ##", async () => {
		env = await makeMemory({
			"proyectos/grande.md": note(
				"Proyecto grande",
				"Con subsecciones",
				[
					"## Pendiente",
					"",
					"- [ ] Directa · Ana · 2026-04-02",
					"",
					"### Urgente",
					"",
					"- [ ] En subsección · Luis · 2026-04-01",
					"",
					"#### Detalle",
					"",
					"- [ ] Bajo nivel 4 · Marta · 2026-04-03",
					"",
					"### Otra cola",
					"",
					"- [ ] Segunda subsección · Ana · 2026-04-04",
					"",
					"## Hecho",
					"",
					"- [ ] Fuera de pendiente · Ana · 2026-03-01",
					"",
					"### Subsección fuera",
					"",
					"- [ ] Tampoco cuenta · Ana · 2026-03-02",
				].join("\n"),
			),
		});
		expect(env.memory.deadlines({}).items.map((i) => ({ text: i.text, line: i.line }))).toEqual([
			{ text: "En subsección", line: 13 },
			{ text: "Directa", line: 9 },
			{ text: "Bajo nivel 4", line: 17 },
			{ text: "Segunda subsección", line: 21 },
		]);
	});

	it("matches the exact same sections and subsections in deadlines and rules validation, including # Pendiente (level 1) and ### subsections", async () => {
		const conH1Pendiente = [
			"---",
			"name: Pendiente",
			"description: Nota titulada Pendiente",
			"---",
			"# Pendiente",
			"",
			"- [ ] En nivel 1 · Ana · 2026-04-01",
			"- [ ] Rota nivel 1",
			"",
			"## Pendiente",
			"",
			"- [ ] En nivel 2 · Ana · 2026-04-02",
			"- [ ] Rota nivel 2",
			"",
			"### Cola",
			"",
			"- [ ] En cola h3 · Ana · 2026-04-03",
			"- [ ] Rota h3",
			"",
			"## Hecho",
			"",
			"- [ ] En hecho · Ana · 2026-04-04",
			"- [ ] Rota hecho",
		].join("\n");
		env = await makeMemory({
			"memory.toml": `[folders]\nallowed = ["yo", "personas", "temas", "proyectos", "archivo"]\narchive = "archivo"\nindex_full = ["yo"]\n\n[notes]\nsuperseded_field = "sustituida_por"\n\n[attachments]\npage_heading = "Página {n}"\n\n[rules.pending]\nsection = "Pendiente"\naction = "warn"\n`,
			"proyectos/pendiente.md": conH1Pendiente,
		});
		expect(env.memory.deadlines({}).items.map((i) => ({ path: i.path, line: i.line, text: i.text }))).toEqual([
			{ path: "proyectos/pendiente.md", line: 12, text: "En nivel 2" },
			{ path: "proyectos/pendiente.md", line: 17, text: "En cola h3" },
		]);
		const rules = env.memory.conventions.rules as Rules;
		const violations = noteViolations(rules, "proyectos/pendiente.md", conH1Pendiente, ["pending"]);
		expect(violations.map((v) => v.line)).toEqual([13, 18]);
	});
});

describe("config", () => {
	it("ignores the keys of the removed git remote and webhook, saying which ones", async () => {
		const dir = await tempDir();
		const file = join(dir, "config.toml");
		await writeFile(
			file,
			[
				'data_dir = "data"',
				'webhook_secret_file = "no-such-file"',
				"fetch_interval_seconds = 300",
				"[remote]",
				'url = "https://git.example.com/me/notes.git"',
				"[listen]",
				'address = "127.0.0.1"',
				"port = 8782",
			].join("\n"),
		);
		// None of those files is read: the keys are gone, and saying so is better than refusing to start.
		const config = loadConfig(file);
		expect(config.ignoredKeys).toEqual(["remote", "fetch_interval_seconds", "webhook_secret_file"]);
		expect(config.listen.port).toBe(8782);
		expect(loadConfig(file)).not.toHaveProperty("remote");
	});
});

async function hashOf(memory: { read: (a: { path: string }) => Promise<{ hash: string }> }, path: string): Promise<string> {
	return (await memory.read({ path })).hash;
}
