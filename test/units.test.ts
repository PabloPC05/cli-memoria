import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultConventions, parseConventions } from "../src/conventions.js";
import { lenientYaml, parseNote, splitFrontmatter } from "../src/frontmatter.js";
import { maskCode, parseWikiLinks, rewriteWikiLinks, splitSections } from "../src/markdown.js";
import { parseTypedLinks } from "../src/relations.js";
import { buildFtsQuery, SCHEMA_VERSION, SearchIndex } from "../src/search-index.js";
import { deadlineKey, parsePendingLine } from "../src/pending.js";
import { blobHash, checkNewFilename, checkPath, looksLikeSame, parseNameStatus, parseSince } from "../src/util.js";
import { CONVENTIONS, makeMemory, tempDir, writer } from "./helpers.js";

const conv = parseConventions(CONVENTIONS);

describe("frontmatter", () => {
	it("splits frontmatter with BOM and CRLF", () => {
		const s = splitFrontmatter("\uFEFF---\r\nname: X\r\n---\r\nbody\r\n");
		expect(s.yaml).toBe("name: X");
		expect(s.body).toBe("body\r\n");
		expect(s.bodyLine).toBe(4);
	});

	it("reads flow and block aliases, quotes and folded descriptions", () => {
		const flow = parseNote("---\nname: 'A'\ndescription: \"d\"\naliases: [x, y]\n---\n", conv);
		expect(flow.meta.aliases).toEqual(["x", "y"]);
		expect(flow.problems).toEqual([]);
		const block = parseNote("---\nname: A\ndescription: >\n  una línea\naliases:\n  - uno\n  - dos\n---\n", conv);
		expect(block.meta.aliases).toEqual(["uno", "dos"]);
		expect(block.meta.description).toBe("una línea");
	});

	it("reports missing fields, multi-line description and bad YAML", () => {
		expect(parseNote("no frontmatter", conv).problems).toContain("missing frontmatter");
		expect(parseNote("---\nname: A\n---\n", conv).problems).toContain("missing required field «description»");
		expect(parseNote("---\nname: A\ndescription: |\n  a\n  b\n---\n", conv).problems[0]).toMatch(/single line/);
		expect(parseNote("---\nname: [unclosed\ndescription: d\n---\n", conv).problems[0]).toMatch(/not valid YAML/);
	});

	it("reads the superseded field as a link target", () => {
		const n = parseNote('---\nname: A\ndescription: d\nsustituida_por: "[[nueva-nota]]"\n---\n', conv);
		expect(n.meta.superseded).toBe("nueva-nota");
	});
});

describe("markdown", () => {
	it("masks fenced and inline code without moving offsets", () => {
		const text = "a `[[x]]` b\n```\n[[y]]\n```\n[[z]]";
		const masked = maskCode(text);
		expect(masked.length).toBe(text.length);
		expect(parseWikiLinks(text).map((l) => l.targetName)).toEqual(["z"]);
	});

	it("parses aliases, headings, embeds, escaped pipes and folders", () => {
		const links = parseWikiLinks("[[Nota|texto]] ![[doc.pdf]] [[carpeta/otra#Sección]] | [[tabla\\|alias]] | [[#local]]");
		expect(links.map((l) => [l.targetName, l.heading, l.alias, l.embed])).toEqual([
			["nota", null, "texto", false],
			["doc.pdf", null, null, true],
			["otra", "Sección", null, false],
			["tabla", null, "alias", false],
		]);
	});

	it("rewrites only matching targets and keeps heading and alias", () => {
		const out = rewriteWikiLinks("[[vieja]] [[vieja#H|t]] [[otra]] `[[vieja]]` | [[vieja\\|x]] |", (l) => (l.targetName === "vieja" ? "nueva" : null));
		expect(out.text).toBe("[[nueva]] [[nueva#H|t]] [[otra]] `[[vieja]]` | [[nueva\\|x]] |");
		expect(out.count).toBe(3);
	});

	it("splits sections at ## and ###, ignoring headings in code", () => {
		const body = "# T\n\nintro\n\n## Uno\n\ntexto\n\n#### dentro\n\n```\n## no\n```\n\n### Dos\n\nfin\n";
		const s = splitSections(body, 5, "T");
		expect(s.map((x) => [x.heading, x.level, x.lineStart])).toEqual([
			["T", 1, 5],
			["Uno", 2, 9],
			["Dos", 3, 19],
		]);
		expect(s[1]?.text).toContain("#### dentro");
		expect(s[1]?.text).toContain("## no");
	});
});

describe("relations", () => {
	it("types links written as Dataview fields in the body", () => {
		const text = [
			"# Alex",
			"",
			"trabaja_en:: [[empresa-x]]",
			"- Hermanos:: [[ana]], [[luis]]",
			"Vive con [vive_con:: [[sara]]] y conoce a [[marta]] (pareja_de:: [[sara|Ele]]).",
			"`no:: [[codigo]]`",
			"Texto con dos puntos: [[normal]]",
			"línea:: con [[x]] y [otra:: [[y]]] dentro",
		].join("\n");
		expect(parseTypedLinks(text).map((l) => [l.targetName, l.relation])).toEqual([
			["empresa-x", "trabaja_en"],
			["ana", "hermanos"],
			["luis", "hermanos"],
			["sara", "vive_con"],
			["marta", null],
			["sara", "pareja_de"],
			["normal", null],
			["x", "línea"],
			["y", "otra"],
		]);
	});

	it("types links in frontmatter fields, but not in text fields", () => {
		const text = '---\nname: X\ndescription: "Ver [[nada]]"\nsustituida_por: "[[nueva]]"\npadres:\n  - "[[ana]]"\n  - "[[juan]]"\n---\n# X\n\n[[suelta]]\n';
		expect(parseTypedLinks(text).map((l) => [l.targetName, l.relation])).toEqual([
			["nada", null],
			["nueva", "sustituida_por"],
			["ana", "padres"],
			["juan", "padres"],
			["suelta", null],
		]);
	});
});

describe("search query", () => {
	it("turns words into prefix terms and keeps phrases", () => {
		expect(buildFtsQuery('hipoteca "piso de oviedo" ir')).toEqual({ and: '"piso de oviedo" AND "hipoteca"* AND "ir"', or: '"piso de oviedo" OR "hipoteca"* OR "ir"' });
		expect(buildFtsQuery("¿?¡!")).toBeNull();
		expect(buildFtsQuery('a"b')?.and).toBe('"a" AND "b"');
	});

	it("searches the singular of a Spanish plural, keeping the word itself", () => {
		// Ending in -s: the word without it; the exact one stays.
		expect(buildFtsQuery("hipotecas")?.and).toBe('("hipotecas"* OR "hipoteca"*)');
		// Ending in -es: both the -s and the -es forms.
		expect(buildFtsQuery("universidades")?.and).toBe('("universidades"* OR "universidad"* OR "universidade"*)');
		// Words under four letters are not expanded (they are still prefix terms).
		expect(buildFtsQuery("gas")?.and).toBe('"gas"*');
		expect(buildFtsQuery("tos")?.and).toBe('"tos"*');
		expect(buildFtsQuery("hipoteca")?.and).toBe('"hipoteca"*');
		// A phrase stays a phrase: its words are not expanded.
		expect(buildFtsQuery('"las hipotecas"')).toEqual({ and: '"las hipotecas"', or: '"las hipotecas"' });
		// The alternatives stay together as one term of an AND query.
		expect(buildFtsQuery("hipotecas piso")?.and).toBe('("hipotecas"* OR "hipoteca"*) AND "piso"*');
	});
});

describe("pending lines", () => {
	it("reads the shape the memory agrees on and rejects everything else", () => {
		expect(parsePendingLine("- [ ] Pedir presupuesto · Ana · 2026-03-14 [llamada]")).toEqual({
			done: false,
			text: "Pedir presupuesto",
			owner: "Ana",
			date: "2026-03-14",
			precision: "day",
			origin: "llamada",
		});
		expect(parsePendingLine("- [x] Elegir azulejos · Ana · 2026-03")).toEqual({ done: true, text: "Elegir azulejos", owner: "Ana", date: "2026-03", precision: "month", origin: null });
		expect(parsePendingLine("* [ ] Llamar · - · sin plazo")?.owner).toBeNull();
		expect(parsePendingLine("- [ ] Llamar · Ana · sin plazo")?.date).toBeNull();
		// A «·» inside the text is kept: the parts are read from the right.
		expect(parsePendingLine("- [ ] Comprar pan · leche · Ana · 2026-04-01")?.text).toBe("Comprar pan · leche");
		for (const bad of ["- Pedir presupuesto", "- [ ] Solo el texto", "- [ ] Texto · Ana", "- [ ] Texto · Ana · mañana", "- [ ] Texto · Ana · 2026-02-31", "- [ ] Texto · Ana · 2026-13", "  prosa suelta"]) {
			expect(parsePendingLine(bad), bad).toBeNull();
		}
	});

	it("orders deadlines with the month-only ones opening their month and the undated ones last", () => {
		const key = (date: string | null, precision: "day" | "month" | null) => deadlineKey({ date, date_precision: precision });
		expect(key("2026-03", "month")).toBe("2026-03-00");
		expect(key("2026-03-01", "day")).toBe("2026-03-01");
		expect(key(null, null)).toBe("9999-99-99");
		expect([key(null, null), key("2026-03-14", "day"), key("2026-03", "month")].sort()).toEqual(["2026-03-00", "2026-03-14", "9999-99-99"]);
	});
});

describe("paths and names", () => {
	it("rejects traversal, absolute, hidden and foreign folders", () => {
		for (const bad of ["../x.md", "/etc/x.md", "C:/x.md", "yo\\x.md", ".git/config.md", "yo/.obsidian/x.md", "otros/x.md", "x.md", "yo/x.txt", "yo//x.md"]) {
			expect(() => checkPath(bad, conv, "note"), bad).toThrow();
		}
		expect(checkPath("./yo/perfil.md", conv, "note")).toBe("yo/perfil.md");
		expect(checkPath("AGENTS.md", conv, "note")).toBe("AGENTS.md");
		expect(checkPath("temas/doc.pdf", conv, "asset")).toBe("temas/doc.pdf");
		expect(() => checkPath("temas/doc.md", conv, "asset")).toThrow();
	});

	it("checks the filename pattern for notes and for files that are not notes", () => {
		expect(() => checkNewFilename("yo/Perfil.md", conv)).toThrow(/pattern/);
		expect(() => checkNewFilename("temas/escritura-casa.pdf", conv)).not.toThrow();
		expect(() => checkNewFilename("temas/Escritura.PDF", conv)).toThrow();
	});

	it("detects look-alike labels", () => {
		expect(looksLikeSame("Seguro del Hogar", "seguro del hogar")).toBe(true);
		// A single word is not enough: «universidad» is a topic of «universidad de verano», not the same note.
		expect(looksLikeSame("Universidad", "universidad de verano")).toBe(false);
		expect(looksLikeSame("lentejas", "receta de lentejas")).toBe(false);
		// Several words, all of them contained: the same thing with a longer title.
		expect(looksLikeSame("piso de oviedo", "el piso de oviedo")).toBe(true);
		expect(looksLikeSame("piso de oviedo", "piso de toledo")).toBe(false);
		expect(looksLikeSame("coche", "coches")).toBe(true);
		expect(looksLikeSame("ana", "eva")).toBe(false);
	});

	it("computes git blob hashes", () => {
		expect(blobHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	});
});

describe("conventions", () => {
	it("has defaults and rejects invalid files", () => {
		expect(defaultConventions().folders.allowed).toBeNull();
		expect(conv.folders.archive).toBe("archivo");
		expect(conv.notes.supersededField).toBe("sustituida_por");
		expect(() => parseConventions('[notes]\nfilename_pattern = "("')).toThrow(/regular expression/);
		expect(() => parseConventions("[folders]\nallowed = [1]")).toThrow();
		// `[attachments]` is an old table (attached files and their OCR are gone): it is ignored, never fatal.
		expect(parseConventions('[attachments]\npage_heading = "Página"').notes.requiredFields).toEqual(defaultConventions().notes.requiredFields);
		expect(defaultConventions().relations.allowed).toBeNull();
		expect(parseConventions('[relations]\nallowed = ["Trabaja_en", "vive_con"]').relations.allowed).toEqual(["trabaja_en", "vive_con"]);
		expect(() => parseConventions('[relations]\nallowed = ["vive con"]')).toThrow(/relations.allowed/);
	});
});

describe("history helpers", () => {
	it("parses since as an ISO date or an age", () => {
		const now = Date.parse("2026-05-10T12:00:00Z");
		expect(parseSince("7d", now)).toBe("2026-05-03T12:00:00.000Z");
		expect(parseSince("12h", now)).toBe("2026-05-10T00:00:00.000Z");
		expect(parseSince("2w", now)).toBe("2026-04-26T12:00:00.000Z");
		expect(parseSince("2026-05-01T10:00:00Z")).toBe("2026-05-01T10:00:00.000Z");
		expect(() => parseSince("ayer")).toThrow(/since/);
		expect(() => parseSince("--all")).toThrow(/since/);
	});

	it("parses name-status lines, renames included", () => {
		expect(parseNameStatus("\nA\ttemas/a.md\nR087\ttemas/b.md\ttemas/c.md\nD\t\"temas/q\\\"uote.md\"\n")).toEqual([
			{ status: "A", path: "temas/a.md" },
			{ status: "R", path: "temas/c.md", from: "temas/b.md" },
			{ status: "D", path: 'temas/q"uote.md' },
		]);
	});
});

describe("index schema and config", () => {
	it("replaces an index made with a previous schema version", async () => {
		const path = join(await tempDir(), "index.sqlite");
		const old = new DatabaseSync(path);
		old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '3'), ('indexed_commit', 'abc');");
		old.exec("CREATE TABLE vectors (hash TEXT PRIMARY KEY, vector BLOB NOT NULL);");
		old.close();
		const index = new SearchIndex(path);
		expect(index.getMeta("schema_version")).toBe(SCHEMA_VERSION);
		expect(index.getMeta("indexed_commit")).toBeNull();
		index.close();
	});

	it("opens an index read-only for the CLI, refusing another schema version instead of resetting it", async () => {
		const dir = await tempDir();
		const path = join(dir, "index.sqlite");
		expect(() => new SearchIndex(join(dir, "missing.sqlite"), { readOnly: true })).toThrow(/cannot open the index/);
		const old = new DatabaseSync(path);
		old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '3'), ('indexed_commit', 'abc');");
		old.close();
		expect(() => new SearchIndex(path, { readOnly: true })).toThrow(/schema version 3 and this cli-memoria expects/);
		const check = new DatabaseSync(path);
		expect(check.prepare("SELECT value FROM meta WHERE key = 'indexed_commit'").get()).toEqual({ value: "abc" }); // untouched
		check.close();
		new SearchIndex(path).close(); // the server's open rebuilds it
		const ro = new SearchIndex(path, { readOnly: true });
		expect(ro.getMeta("schema_version")).toBe(SCHEMA_VERSION);
		expect(() => ro.setMeta("x", "y")).toThrow(/readonly/i);
		ro.close();
	});

	it("loads [listen] and keeps legacy [listen.private] working", async () => {
		const dir = await tempDir();
		const file = join(dir, "config.toml");
		await writeFile(file, 'data_dir = "data"\n[listen]\naddress = "127.0.0.1"\nport = 8782\n');
		expect(loadConfig(file).listen).toEqual({ address: "127.0.0.1", port: 8782 });
		await writeFile(file, 'data_dir = "data"\n[listen.private]\nport = 8783\n');
		expect(loadConfig(file).listen).toEqual({ address: "127.0.0.1", port: 8783 });
	});

	it("names the keys it no longer uses instead of refusing an old config", async () => {
		const dir = await tempDir();
		const file = join(dir, "config.toml");
		// The keys of the git sync and of the extraction of attached files, as an old install left them.
		await writeFile(
			file,
			'data_dir = "data"\nremote = "git@example.com:notes.git"\npdftotext = "pdftotext"\nfetch_interval_seconds = 60\n[listen]\nport = 8782\n[ocr]\nenabled = true\nlanguages = "spa+eng"\n',
		);
		const config = loadConfig(file);
		expect(config.ignoredKeys).toEqual(["remote", "fetch_interval_seconds", "pdftotext", "ocr"]);
		expect(config.dataDir.endsWith("data")).toBe(true);
	});
});

describe("legacy frontmatter", () => {
	const LEGACY = '---\nname: Telefonía\ndescription: Líneas de casa: móvil y fibra\naliases: [móvil, internet]\n---\n# Telefonía\n\nVer [Universidad](../temas/universidad.md).\n';

	it("is read leniently but reported", () => {
		const conv = parseConventions(CONVENTIONS);
		const n = parseNote(LEGACY, conv);
		expect(n.meta.description).toBe("Líneas de casa: móvil y fibra");
		expect(n.meta.aliases).toEqual(["móvil", "internet"]);
		expect(n.problems).toHaveLength(1);
		expect(n.problems[0]).toMatch(/not valid YAML/);
		expect(lenientYaml("a: x\nb: >\n  uno\n  dos\nc:\n  - p\n  - q")).toEqual({ a: "x", b: "uno dos", c: ["p", "q"] });
	});

	it("still lets agents edit the body of a note with old frontmatter", async () => {
		const env = await makeMemory({ "temas/telefonia.md": LEGACY.replace("../temas/universidad.md", "x") });
		try {
			expect((env.memory.list({ folder: "temas" }) as { notes: { problems?: string[] }[] }).notes[0]?.problems).toHaveLength(1);
			const r = await env.memory.edit(writer, { name: "telefonia", edits: [{ old_string: "# Telefonía", new_string: "# Telefonía y fibra" }], reason: "x" });
			expect(r.warnings.map((w) => w.code)).toContain("FRONTMATTER_PROBLEMS");
			await expect(env.memory.edit(writer, { name: "telefonia", edits: [{ old_string: "aliases: [móvil, internet]", new_string: "aliases: [móvil]" }], reason: "x" })).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
		} finally {
			await env.cleanup();
		}
	});
});
