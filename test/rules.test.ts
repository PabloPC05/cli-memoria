import { describe, expect, it } from "vitest";
import { defaultConventions, parseConventions } from "../src/conventions.js";
import { appendOnlyAdded, checkWrite, describeRules, formatViolation, noteViolations, parseRules, type Rules, type WriteCheck } from "../src/rules.js";
import { RULES } from "./rules-config.js";


const rules = parseConventions(RULES).rules as Rules;

function person(body: string, type = "People"): string {
	return `---\nname: Ana\ndescription: Ana, prima de Pablo\naliases: []\ntype: ${type}\n---\n# Ana\n\nAna es prima de Pablo.\n\n${body}`;
}

const FUENTES = "## Fuentes\n\n- Pablo, 2026-10-21: «Ana es mi prima»\n- Pablo, 2026-11-02: «vive en Vigo»\n";

function check(path: string, after: string, before: string | null, opts = {}): WriteCheck {
	return checkWrite(rules, { path, text: after }, before === null ? null : { path, text: before }, opts);
}

const rulesOf = (c: WriteCheck, kind: keyof WriteCheck) => c[kind].map((v) => v.rule);

describe("configuration", () => {
	it("without [rules] there are no rules: the server behaves as before", () => {
		expect(defaultConventions().rules).toBeNull();
		expect(parseConventions('[folders]\narchive = "archive"\n').rules).toBeNull();
		expect(describeRules(null)).toBeNull();
		expect(parseRules(undefined)).toBeNull();
	});

	it("reads every rule with its default action", () => {
		expect(rules.frontmatter).toEqual({ required: true, action: "block" });
		expect(rules.type).toMatchObject({ field: "type", untypedFolders: ["skills"], attachmentType: "Notes", action: "block" });
		expect(rules.obsolete.patterns.map((p) => p.pattern)).toEqual(["\\bmemoria_[a-z_]+", "\\bLisa IA\\b"]);
		expect(rules.obsolete.action).toBe("block");
		expect(rules.appendOnly).toEqual({ sections: ["Fuentes"], action: "block" });
		expect(rules.forbiddenSections.action).toBe("block");
		expect(rules.templates).toMatchObject({ level: 2, action: "warn" });
		expect(rules.templates.byType.People).toHaveLength(7);
		expect(rules.size).toEqual({ maxChars: 1500, action: "warn" });
	});

	it("refuses a broken configuration with a readable message", () => {
		const bad = (toml: string) => () => parseConventions(toml);
		expect(bad("[rules.obsolete]\npatterns = ['(']")).toThrow(/rules\.obsolete\.patterns\[0\]\.pattern is not a valid regular expression/);
		expect(bad("[rules.obsolete]\npatterns = ['x*']")).toThrow(/matches the empty text/);
		expect(bad('[rules.type]\nallowed = ["Work"]\n[rules.templates]\nPeople = ["A"]')).toThrow(/rules\.templates\.People: «People» is not in rules\.type\.allowed/);
		expect(bad('[rules.type]\nallowed = ["Work"]\nattachment_type = "Notes"')).toThrow(/attachment_type «Notes» is not in rules\.type\.allowed/);
		expect(bad('[rules.size]\nmax_chars = 0')).toThrow(/max_chars must be a positive integer/);
		expect(bad('[rules.append_only]\nsections = ["Fuentes"]\naction = "maybe"')).toThrow(/action must be "block" or "warn"/);
		expect(bad('[rules.append_only]\nsection = ["Fuentes"]')).toThrow(/unknown keys: section/);
		expect(() => parseConventions("[rules]\ntypo = 1\n")).toThrow(/\[rules\] has unknown keys: typo/);
	});

	it("tells agents the rules up front, without repeating the retired names", () => {
		const text = describeRules(rules) as string;
		expect(text).toContain("«type» is one of Profile, Preference, Work, People, Notes (except notes in skills/)");
		expect(text).toContain("«## Fuentes» are never changed or removed");
		expect(text).toContain("People notes use the sections Quién es · Relación con Pablo");
		expect(text).toContain("RULES_VIOLATED");
		expect(text).not.toContain("memoria_");
	});
});

describe("frontmatter and type", () => {
	it("a new note needs frontmatter and a type from the list", () => {
		const none = check("people/ana.md", "# Ana\n\nPrima.\n", null);
		expect(rulesOf(none, "blocking")).toEqual(["frontmatter"]);
		expect(formatViolation(none.blocking[0]!)).toBe(
			"frontmatter, line 1: the note has no frontmatter. Fix: start it with a block between --- lines holding name, description and type (one of: Profile, Preference, Work, People, Notes).",
		);
		const missing = check("people/ana.md", "---\nname: Ana\ndescription: x\n---\n# Ana\n", null);
		expect(formatViolation(missing.blocking[0]!)).toBe("type, line 1: the frontmatter has no «type». Fix: add «type: …» with one of: Profile, Preference, Work, People, Notes (only notes in skills/ go without it).");
		const invalid = check("topics/x.md", person("", "Topic"), null);
		expect(formatViolation(invalid.blocking[0]!)).toBe("type, line 5: «type: Topic» is not one of this memory's types. Fix: use one of: Profile, Preference, Work, People, Notes.");
		const lower = check("topics/x.md", person("", "work"), null);
		expect(lower.blocking[0]?.fix).toBe("write «Work»");
		expect(check("topics/x.md", person("", "Work"), null).blocking).toEqual([]);
	});

	it("notes in an untyped folder go without type, but still need frontmatter", () => {
		expect(check("skills/revision.md", "---\nname: Revisión\ndescription: x\n---\n# R\n", null).blocking).toEqual([]);
		expect(rulesOf(check("skills/revision.md", "# R\n", null), "blocking")).toEqual(["frontmatter"]);
	});

	it("an old missing or invalid type does not block editing the body, but changing it to another invalid one does", () => {
		const old = person("Vive en Vigo.\n", "Topic");
		const edited = check("topics/x.md", person("Vive en Ourense.\n", "Topic"), old);
		expect(edited.blocking).toEqual([]);
		expect(rulesOf(edited, "existing")).toEqual(["type"]);
		expect(rulesOf(check("topics/x.md", person("Vive en Vigo.\n", "Project"), old), "blocking")).toEqual(["type"]);
		expect(check("topics/x.md", person("Vive en Vigo.\n", "Work"), old)).toEqual({ blocking: [], warnings: [], existing: [] });
		const noFm = "# Vieja\n\nSin frontmatter.\n";
		const kept = check("topics/vieja.md", "# Vieja\n\nSin frontmatter, editada.\n", noFm);
		expect(kept.blocking).toEqual([]);
		expect(rulesOf(kept, "existing")).toEqual(["frontmatter"]);
	});
});

describe("retired names", () => {
	const old = person("Usa `memoria_search` para buscar.\n\nOtra línea.\n");

	it("blocks a new mention and says the line and the fix", () => {
		const c = check("people/ana.md", person("Busca con memoria_read.\n"), null);
		expect(c.blocking).toHaveLength(1);
		expect(formatViolation(c.blocking[0]!)).toBe("obsolete, line 11: «memoria_read» is a retired name this memory no longer uses. Fix: use this server's own tools (search, read, write…).");
		const lisa = check("topics/x.md", person("Lo dijo Lisa IA.\n"), null);
		expect(lisa.blocking[0]?.fix).toBe("remove it or write the name of what replaced it");
	});

	it("keeps an old mention editable, even on the same line, but not a second one", () => {
		const sameLine = check("people/ana.md", person("Usa `memoria_search` para buscar notas.\n\nOtra línea.\n"), old);
		expect(sameLine.blocking).toEqual([]);
		expect(rulesOf(sameLine, "existing")).toEqual(["obsolete"]);
		const other = check("people/ana.md", person("Usa `memoria_search` para buscar.\n\nOtra línea, cambiada.\n"), old);
		expect(other.blocking).toEqual([]);
		const twice = check("people/ana.md", person("Usa `memoria_search` para buscar.\n\nOtra línea.\nY memoria_search otra vez.\n"), old);
		expect(twice.blocking.map((v) => v.line)).toEqual([14]);
		expect(twice.existing.map((v) => v.line)).toEqual([11]);
		// Swapping one retired name for another is a new one.
		expect(rulesOf(check("people/ana.md", person("Usa `memoria_list` para buscar.\n\nOtra línea.\n"), old), "blocking")).toEqual(["obsolete"]);
		// Removing it is always fine.
		expect(check("people/ana.md", person("Busca en la memoria.\n\nOtra línea.\n"), old)).toEqual({ blocking: [], warnings: [], existing: [] });
	});

	it("leaves alone the notes a pattern excepts", () => {
		expect(check("projects/historia-de-lisa.md", person("Antes se llamaba Lisa IA.\n", "Work"), null).blocking).toEqual([]);
		expect(rulesOf(check("projects/historia-de-lisa.md", person("Usa memoria_read.\n", "Work"), null), "blocking")).toEqual(["obsolete"]);
	});
});

describe("append-only sections", () => {
	const old = person(`## Quién es\n\nPrima.\n\n${FUENTES}`);

	it("take new lines anywhere, and ignore reordering and blank or trailing space changes", () => {
		expect(check("people/ana.md", person(`## Quién es\n\nPrima.\n\n${FUENTES}- Pablo, 2026-11-20: «trabaja en Vigo»\n`), old).blocking).toEqual([]);
		const reordered = "## Fuentes\n\n- Pablo, 2026-11-02: «vive en Vigo»   \n\n- Pablo, 2026-10-21: «Ana es mi prima»\n";
		expect(check("people/ana.md", person(`## Quién es\n\nPrima.\n\n${reordered}`), old).blocking).toEqual([]);
	});

	it("block changing or removing an existing line, or the whole section", () => {
		const changed = check("people/ana.md", person(`## Quién es\n\nPrima.\n\n${FUENTES.replace("vive en Vigo", "vive en Ourense")}`), old);
		expect(changed.blocking).toHaveLength(1);
		expect(formatViolation(changed.blocking[0]!)).toBe(
			"append_only, line 15: the line «- Pablo, 2026-11-02: «vive en Vigo»» of «## Fuentes» was changed or removed. Fix: put it back exactly as it was; this section only takes new lines.",
		);
		const gone = check("people/ana.md", person("## Quién es\n\nPrima.\n"), old);
		expect(gone.blocking).toHaveLength(2);
		expect(gone.blocking[0]?.message).toBe("the section «## Fuentes» was removed with its line «- Pablo, 2026-10-21: «Ana es mi prima»»");
		expect(gone.blocking[0]?.line).toBeNull();
	});

	it("let a revert take back exactly the lines the reverted commit added", () => {
		const added = person(`## Quién es\n\nPrima.\n\n${FUENTES}- Pablo, 2026-11-20: «inventado»\n`);
		const allowRemoved = appendOnlyAdded(rules, old, added);
		expect(allowRemoved).toEqual(["- Pablo, 2026-11-20: «inventado»"]);
		expect(check("people/ana.md", old, added, { allowRemoved }).blocking).toEqual([]);
		expect(check("people/ana.md", person("## Quién es\n\nPrima.\n"), added, { allowRemoved }).blocking).toHaveLength(2);
	});
});

describe("forbidden sections", () => {
	it("block a new one, keep an old one editable, and ignore code", () => {
		const c = check("topics/x.md", person("## Historia\n\nAntes vivía en Lugo.\n", "Notes"), null);
		expect(formatViolation(c.blocking[0]!)).toBe(
			"forbidden_section, line 11: «## Historia» is a section this memory does not allow. Fix: remove the section and correct the note so it says what is true now (git keeps the earlier versions).",
		);
		const old = person("## Historia\n\nAntes vivía en Lugo.\n", "Notes");
		const edited = check("topics/x.md", person("## Historia\n\nAntes vivía en Lugo y en León.\n", "Notes"), old);
		expect(edited.blocking).toEqual([]);
		expect(rulesOf(edited, "existing")).toEqual(["forbidden_section"]);
		expect(check("topics/x.md", person("```\n## Historia\n```\n", "Notes"), null).blocking).toEqual([]);
		expect(rulesOf(check("topics/x.md", person("### historia\n\nx\n", "Notes"), null), "blocking")).toEqual(["forbidden_section"]);
	});
});

describe("templates", () => {
	it("warn by default about sections outside the type's template and out of order", () => {
		const c = check("people/ana.md", person("## Trato\n\nx\n\n## Contacto\n\ny\n\n## Aficiones\n\nz\n\n### Libre\n\nw\n"), null);
		expect(c.blocking).toEqual([]);
		expect(c.warnings.map(formatViolation)).toEqual([
			"template, line 15: «## Contacto» comes after «## Trato». Fix: put the sections in the template's order: Quién es · Relación con Pablo · Contacto · Trato · Asuntos · Pendiente · Fuentes.",
			"template, line 19: «## Aficiones» is not a section of the People template. Fix: move its content into one of the template's sections: Quién es · Relación con Pablo · Contacto · Trato · Asuntos · Pendiente · Fuentes.",
		]);
		// Accents and case do not matter; other types have no template.
		expect(check("people/ana.md", person("## Quien es\n\nx\n\n## RELACIÓN CON PABLO\n\ny\n"), null).warnings).toEqual([]);
		expect(check("topics/x.md", person("## Aficiones\n\nz\n", "Notes"), null).warnings).toEqual([]);
	});

	it("an old extra section is existing; with action block a new one is refused", () => {
		const old = person("## Aficiones\n\nz\n");
		expect(rulesOf(check("people/ana.md", person("## Aficiones\n\nz y más\n"), old), "existing")).toEqual(["template"]);
		const strict = parseConventions(`${RULES.replace('[rules.templates]', '[rules.templates]\naction = "block"')}`).rules as Rules;
		const c = checkWrite(strict, { path: "people/ana.md", text: person("## Aficiones\n\nz\n## Viajes\n\nv\n") }, { path: "people/ana.md", text: old });
		expect(c.blocking.map((v) => v.message)).toEqual(["«## Viajes» is not a section of the People template"]);
	});
});

describe("size", () => {
	const big = (n: number) => person(`${"Una frase de relleno. ".repeat(n)}\n`, "Notes");

	it("warns when a note goes over the limit, and only when it grows if it already was", () => {
		const c = check("topics/x.md", big(80), null);
		expect(c.blocking).toEqual([]);
		expect(c.warnings[0]?.message).toMatch(/^the note has 1,8\d\d characters \(about 4\d\d tokens\), over the limit of 1,500$/);
		expect(rulesOf(check("topics/x.md", big(79), big(80)), "existing")).toEqual(["size"]);
		expect(rulesOf(check("topics/x.md", big(81), big(80)), "warnings")).toEqual(["size"]);
		const strict = parseConventions(RULES.replace("max_chars = 1500", 'max_chars = 1500\naction = "block"')).rules as Rules;
		expect(checkWrite(strict, { path: "topics/x.md", text: big(81) }, { path: "topics/x.md", text: big(80) }).blocking).toHaveLength(1);
		expect(checkWrite(strict, { path: "topics/x.md", text: big(79) }, { path: "topics/x.md", text: big(80) }).blocking).toEqual([]);
	});

	it("leaves attachment companions alone", () => {
		expect(noteViolations(rules, "topics/x.md", big(80).replace("type: Notes", "type: Notes\nattachment: x.pdf"))).toEqual([]);
	});
});

describe("findings of a note as it stands", () => {
	it("lists every rule but append_only, with lines", () => {
		const text = `---\nname: Vieja\ndescription: x\ntype: Topic\n---\n# Vieja\n\nUsa memoria_search.\n\n## Historia\n\nAntes.\n`;
		expect(noteViolations(rules, "topics/vieja.md", text).map((v) => [v.rule, v.line])).toEqual([
			["type", 4],
			["obsolete", 8],
			["forbidden_section", 10],
		]);
		expect(noteViolations(rules, "topics/vieja.md", text, ["obsolete"]).map((v) => v.rule)).toEqual(["obsolete"]);
	});
});
