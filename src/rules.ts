import { parse as parseYaml } from "yaml";
import type { Conventions } from "./conventions.js";
import { lenientYaml, splitFrontmatter } from "./frontmatter.js";
import { maskCode } from "./markdown.js";
import { normalizeWords, topFolder } from "./util.js";

/**
 * Write rules: what a memory declares in the `[rules]` table of its `memory.toml` and the server enforces on every
 * write, so that code and not the model that writes decides what may enter the memory. A write may not add a
 * violation; what a note already had only warns, so old notes stay editable while they get cleaned up.
 * Everything here is pure (text in, findings out): the server, `lint` and `my-memory check` share it.
 */

export const RULE_IDS = ["frontmatter", "type", "obsolete", "append_only", "forbidden_section", "template", "size"] as const;
export type RuleId = (typeof RULE_IDS)[number];
export type RuleAction = "block" | "warn";

export interface ObsoletePattern {
	pattern: string;
	regex: RegExp;
	/** How to fix a mention, in the memory's own words; a generic hint when absent. */
	fix: string | null;
	/** Notes (exact path) or folders (everything under them) where the pattern may appear. */
	except: string[];
}

export interface Rules {
	/** Folders the rules leave alone, besides the archive and the root files. */
	exclude: string[];
	frontmatter: { required: boolean; action: RuleAction };
	type: { field: string; allowed: string[] | null; untypedFolders: string[]; attachmentType: string | null; action: RuleAction };
	obsolete: { patterns: ObsoletePattern[]; action: RuleAction };
	appendOnly: { sections: string[]; action: RuleAction };
	forbiddenSections: { sections: string[]; fix: string | null; action: RuleAction };
	/** Allowed headings of `level`, in order, per type. */
	templates: { byType: Record<string, string[]>; level: number; action: RuleAction };
	size: { maxChars: number | null; action: RuleAction };
}

export interface Violation {
	rule: RuleId;
	/** 1-based line of the note, or null when it concerns the whole note. */
	line: number | null;
	/** What is wrong. */
	message: string;
	/** How to fix it. */
	fix: string;
	action: RuleAction;
	/** Identity of the finding across versions of a note, to tell new from existing. */
	key: string;
}

export interface NoteText {
	path: string;
	text: string;
}

export interface WriteCheck {
	/** New violations of `block` rules: the write must not happen. */
	blocking: Violation[];
	/** New violations of `warn` rules. */
	warnings: Violation[];
	/** Violations the note already had before this write. */
	existing: Violation[];
}

export interface CheckOptions {
	/** Only these rules (attach checks only the frontmatter of the note it generates). */
	only?: RuleId[];
	/**
	 * Lines of append-only sections this write may remove: what a reverted commit itself added, or what enters the
	 * same section of another note of the same submission (`checkBatch`).
	 */
	allowRemoved?: string[];
	/** Part of a submission of several notes (a `publish`, a commit): changes the advice of `append_only`. */
	batch?: boolean;
}

// ── configuration ──────────────────────────────────────────────────────────

const FOLDER = /^[^/\\.][^/\\]*$/;

function table(value: unknown, key: string): Record<string, unknown> | null {
	if (value === undefined) return null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`[${key}] must be a table`);
	return value as Record<string, unknown>;
}

function strings(value: unknown, key: string, check?: (v: string) => boolean): string[] {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim().length > 0)) throw new Error(`${key} must be a list of non-empty strings`);
	if (check) for (const v of value) if (!check(v)) throw new Error(`${key}: invalid entry «${v}»`);
	return (value as string[]).map((v) => v.trim());
}

function text(value: unknown, key: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
	return value.trim();
}

function action(t: Record<string, unknown>, key: string, fallback: RuleAction): RuleAction {
	if (t.action === undefined) return fallback;
	if (t.action !== "block" && t.action !== "warn") throw new Error(`${key}.action must be "block" or "warn"`);
	return t.action;
}

function unknownKeys(t: Record<string, unknown>, key: string, allowed: string[]): void {
	const extra = Object.keys(t).filter((k) => !allowed.includes(k));
	if (extra.length) throw new Error(`[${key}] has unknown keys: ${extra.join(", ")} (allowed: ${allowed.join(", ")})`);
}

/** A path is a note (exact) or a folder (everything under it). */
function pathMatches(path: string, entry: string): boolean {
	const e = entry.replace(/^\.\//, "");
	return path === e || path.startsWith(e.endsWith("/") ? e : `${e}/`);
}

/** Parses the `[rules]` table of `memory.toml`; `undefined` means no rules (the server behaves as without them). */
export function parseRules(value: unknown): Rules | null {
	const doc = table(value, "rules");
	if (!doc) return null;
	unknownKeys(doc, "rules", ["exclude", "frontmatter", "type", "obsolete", "append_only", "forbidden_sections", "templates", "size"]);
	const rules: Rules = {
		exclude: doc.exclude === undefined ? [] : strings(doc.exclude, "rules.exclude", (v) => FOLDER.test(v)),
		frontmatter: { required: false, action: "block" },
		type: { field: "type", allowed: null, untypedFolders: [], attachmentType: null, action: "block" },
		obsolete: { patterns: [], action: "block" },
		appendOnly: { sections: [], action: "block" },
		forbiddenSections: { sections: [], fix: null, action: "block" },
		templates: { byType: {}, level: 2, action: "warn" },
		size: { maxChars: null, action: "warn" },
	};

	const fm = table(doc.frontmatter, "rules.frontmatter");
	if (fm) {
		unknownKeys(fm, "rules.frontmatter", ["required", "action"]);
		if (fm.required !== undefined && typeof fm.required !== "boolean") throw new Error("rules.frontmatter.required must be true or false");
		rules.frontmatter = { required: fm.required ?? true, action: action(fm, "rules.frontmatter", "block") };
	}

	const type = table(doc.type, "rules.type");
	if (type) {
		unknownKeys(type, "rules.type", ["field", "allowed", "untyped_folders", "attachment_type", "action"]);
		const field = type.field === undefined ? "type" : text(type.field, "rules.type.field");
		if (!/^[A-Za-z_][\w-]*$/.test(field)) throw new Error("rules.type.field must be a field name");
		const allowed = strings(type.allowed, "rules.type.allowed");
		const attachmentType = type.attachment_type === undefined ? null : text(type.attachment_type, "rules.type.attachment_type");
		if (attachmentType !== null && !allowed.includes(attachmentType)) throw new Error(`rules.type.attachment_type «${attachmentType}» is not in rules.type.allowed`);
		rules.type = {
			field,
			allowed,
			untypedFolders: type.untyped_folders === undefined ? [] : strings(type.untyped_folders, "rules.type.untyped_folders", (v) => FOLDER.test(v)),
			attachmentType,
			action: action(type, "rules.type", "block"),
		};
	}

	const obsolete = table(doc.obsolete, "rules.obsolete");
	if (obsolete) {
		unknownKeys(obsolete, "rules.obsolete", ["patterns", "action"]);
		if (!Array.isArray(obsolete.patterns) || obsolete.patterns.length === 0) throw new Error("rules.obsolete.patterns must be a non-empty list");
		rules.obsolete = {
			action: action(obsolete, "rules.obsolete", "block"),
			patterns: obsolete.patterns.map((entry, i) => {
				const key = `rules.obsolete.patterns[${i}]`;
				const t: Record<string, unknown> = typeof entry === "string" ? { pattern: entry } : (table(entry, key) ?? {});
				unknownKeys(t, key, ["pattern", "fix", "except", "ignore_case"]);
				const pattern = text(t.pattern, `${key}.pattern`);
				if (t.ignore_case !== undefined && typeof t.ignore_case !== "boolean") throw new Error(`${key}.ignore_case must be true or false`);
				let regex: RegExp;
				try {
					// Case-sensitive unless asked: «Memoria_2025.pdf» is a file, «memoria_read» a tool.
					regex = new RegExp(pattern, t.ignore_case === true ? "giu" : "gu");
				} catch (error) {
					throw new Error(`${key}.pattern is not a valid regular expression: ${(error as Error).message}`);
				}
				if (regex.test("")) throw new Error(`${key}.pattern matches the empty text`);
				return { pattern, regex, fix: t.fix === undefined ? null : text(t.fix, `${key}.fix`), except: t.except === undefined ? [] : strings(t.except, `${key}.except`) };
			}),
		};
	}

	const appendOnly = table(doc.append_only, "rules.append_only");
	if (appendOnly) {
		unknownKeys(appendOnly, "rules.append_only", ["sections", "action"]);
		rules.appendOnly = { sections: strings(appendOnly.sections, "rules.append_only.sections"), action: action(appendOnly, "rules.append_only", "block") };
	}

	const forbidden = table(doc.forbidden_sections, "rules.forbidden_sections");
	if (forbidden) {
		unknownKeys(forbidden, "rules.forbidden_sections", ["sections", "fix", "action"]);
		rules.forbiddenSections = {
			sections: strings(forbidden.sections, "rules.forbidden_sections.sections"),
			fix: forbidden.fix === undefined ? null : text(forbidden.fix, "rules.forbidden_sections.fix"),
			action: action(forbidden, "rules.forbidden_sections", "block"),
		};
	}

	const templates = table(doc.templates, "rules.templates");
	if (templates) {
		const byType: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(templates)) {
			if (k === "action" || k === "level") continue;
			if (rules.type.allowed && !rules.type.allowed.includes(k)) throw new Error(`rules.templates.${k}: «${k}» is not in rules.type.allowed`);
			byType[k] = strings(v, `rules.templates.${k}`);
		}
		const level = templates.level === undefined ? 2 : templates.level;
		if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) throw new Error("rules.templates.level must be a heading level from 1 to 6");
		rules.templates = { byType, level, action: action(templates, "rules.templates", "warn") };
	}

	const size = table(doc.size, "rules.size");
	if (size) {
		unknownKeys(size, "rules.size", ["max_chars", "action"]);
		if (typeof size.max_chars !== "number" || !Number.isInteger(size.max_chars) || size.max_chars < 1) throw new Error("rules.size.max_chars must be a positive integer");
		rules.size = { maxChars: size.max_chars, action: action(size, "rules.size", "warn") };
	}
	return rules;
}

/** Whether the rules hold a note: not a root file, not in the archive, not in `[rules] exclude`. */
export function rulesApply(conventions: Conventions, path: string): boolean {
	if (!conventions.rules || !path.includes("/") || !/\.md$/i.test(path)) return false;
	const folder = topFolder(path);
	return folder !== conventions.folders.archive && !conventions.rules.exclude.includes(folder);
}

// ── reading a note ─────────────────────────────────────────────────────────

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/;

interface Heading {
	level: number;
	text: string;
	norm: string;
	/** 0-based index in the file's lines. */
	index: number;
}

interface Parsed {
	lines: string[];
	hasFrontmatter: boolean;
	fields: Record<string, unknown>;
	/** 0-based index of the first frontmatter line (after `---`). */
	yamlStart: number;
	yamlLines: string[];
	headings: Heading[];
}

function parse(text: string): Parsed {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	const split = splitFrontmatter(text);
	let fields: Record<string, unknown> = {};
	if (split.yaml !== null && split.yaml.trim() !== "") {
		try {
			const doc: unknown = parseYaml(split.yaml, { schema: "core" });
			if (doc && typeof doc === "object" && !Array.isArray(doc)) fields = doc as Record<string, unknown>;
		} catch {
			fields = lenientYaml(split.yaml);
		}
	}
	const offset = split.bodyLine - 1;
	const masked = maskCode(split.body).split("\n");
	const headings: Heading[] = [];
	masked.forEach((line, i) => {
		const m = HEADING.exec(line);
		if (!m) return;
		const raw = HEADING.exec(lines[offset + i] ?? "");
		const heading = (raw?.[2] ?? (m[2] as string)).trim();
		headings.push({ level: (m[1] as string).length, text: heading, norm: normalizeWords(heading), index: offset + i });
	});
	return { lines, hasFrontmatter: split.yaml !== null, fields, yamlStart: 1, yamlLines: (split.yaml ?? "").split("\n"), headings };
}

function clip(s: string, max = 100): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function hashes(level: number): string {
	return "#".repeat(level);
}

/** Lines (trimmed, non-blank) of the sections with one of these names, and the line of each such heading. */
function sectionLines(p: Parsed, names: string[]): { lines: string[]; headingLine: number | null; heading: string | null } {
	const wanted = new Set(names.map(normalizeWords));
	const out: string[] = [];
	let headingLine: number | null = null;
	let heading: string | null = null;
	p.headings.forEach((h, i) => {
		if (!wanted.has(h.norm)) return;
		headingLine ??= h.index + 1;
		heading ??= `${hashes(h.level)} ${h.text}`;
		const next = p.headings.slice(i + 1).find((n) => n.level <= h.level);
		for (let l = h.index + 1; l < (next ? next.index : p.lines.length); l++) {
			const t = (p.lines[l] as string).trim();
			if (t) out.push(t);
		}
	});
	return { lines: out, headingLine, heading };
}

function typeLine(p: Parsed, field: string): number | null {
	const i = p.yamlLines.findIndex((l) => new RegExp(`^${field}\\s*:`).test(l));
	return i < 0 ? null : p.yamlStart + i + 1;
}

/**
 * Violations a note has as it stands (every rule but `append_only`, which compares two versions).
 * Used for each side of a write and, on its own, by `lint` and `my-memory check`.
 */
export function noteViolations(rules: Rules, path: string, text: string, only?: RuleId[]): Violation[] {
	const on = (r: RuleId) => !only || only.includes(r);
	const p = parse(text);
	const out: Violation[] = [];
	const add = (rule: RuleId, act: RuleAction, key: string, line: number | null, message: string, fix: string) => out.push({ rule, line, message, fix, action: act, key: `${rule}:${key}` });
	const typed = rules.type.allowed !== null && !rules.type.untypedFolders.includes(topFolder(path));
	const typeList = rules.type.allowed?.join(", ") ?? "";

	if (on("frontmatter") && rules.frontmatter.required && !p.hasFrontmatter) {
		add("frontmatter", rules.frontmatter.action, "missing", 1, "the note has no frontmatter", `start it with a block between --- lines holding name, description${typed ? ` and ${rules.type.field} (one of: ${typeList})` : ""}`);
	}

	if (on("type") && typed && (p.hasFrontmatter || !(on("frontmatter") && rules.frontmatter.required))) {
		const allowed = rules.type.allowed as string[];
		const value = p.fields[rules.type.field];
		const untyped = rules.type.untypedFolders.length ? ` (only notes in ${rules.type.untypedFolders.map((f) => `${f}/`).join(", ")} go without it)` : "";
		if (value === undefined || value === null || value === "") {
			add("type", rules.type.action, "missing", 1, `the frontmatter has no «${rules.type.field}»`, `add «${rules.type.field}: …» with one of: ${typeList}${untyped}`);
		} else if (typeof value !== "string" || !allowed.includes(value)) {
			const shown = typeof value === "string" ? value : JSON.stringify(value);
			const sameCase = typeof value === "string" ? allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase()) : undefined;
			add("type", rules.type.action, `invalid:${shown}`, typeLine(p, rules.type.field) ?? 1, `«${rules.type.field}: ${clip(shown, 40)}» is not one of this memory's types`, sameCase ? `write «${sameCase}»` : `use one of: ${typeList}`);
		}
	}

	if (on("obsolete")) {
		rules.obsolete.patterns.forEach((pat, i) => {
			if (pat.except.some((e) => pathMatches(path, e))) return;
			p.lines.forEach((line, l) => {
				for (const m of line.matchAll(pat.regex)) {
					if (!m[0]) continue;
					add("obsolete", rules.obsolete.action, `${i}:${m[0].toLowerCase()}`, l + 1, `«${clip(m[0], 60)}» is a retired name this memory no longer uses`, pat.fix ?? "remove it or write the name of what replaced it");
				}
			});
		});
	}

	if (on("forbidden_section") && rules.forbiddenSections.sections.length) {
		const forbidden = new Set(rules.forbiddenSections.sections.map(normalizeWords));
		for (const h of p.headings) {
			if (!forbidden.has(h.norm)) continue;
			add(
				"forbidden_section",
				rules.forbiddenSections.action,
				h.norm,
				h.index + 1,
				`«${hashes(h.level)} ${clip(h.text, 60)}» is a section this memory does not allow`,
				rules.forbiddenSections.fix ?? "remove the section and correct the note so it says what is true now (git keeps the earlier versions)",
			);
		}
	}

	const type = p.fields[rules.type.field];
	const template = typeof type === "string" ? rules.templates.byType[type] : undefined;
	if (on("template") && template && !rules.type.untypedFolders.includes(topFolder(path))) {
		const level = rules.templates.level;
		const ranks = new Map(template.map((t, i) => [normalizeWords(t), i]));
		const order = template.join(" · ");
		let highest: { rank: number; text: string } | null = null;
		for (const h of p.headings) {
			if (h.level !== level) continue;
			const rank = ranks.get(h.norm);
			if (rank === undefined) {
				add("template", rules.templates.action, `extra:${h.norm}`, h.index + 1, `«${hashes(level)} ${clip(h.text, 60)}» is not a section of the ${type} template`, `move its content into one of the template's sections: ${order}`);
				continue;
			}
			if (highest && highest.rank > rank) {
				add("template", rules.templates.action, `order:${h.norm}`, h.index + 1, `«${hashes(level)} ${clip(h.text, 60)}» comes after «${hashes(level)} ${clip(highest.text, 60)}»`, `put the sections in the template's order: ${order}`);
			}
			if (!highest || rank > highest.rank) highest = { rank, text: h.text };
		}
	}

	const max = rules.size.maxChars;
	if (on("size") && max !== null && text.length > max && !p.fields.attachment) {
		add(
			"size",
			rules.size.action,
			"over",
			null,
			`the note has ${text.length.toLocaleString("en")} characters (about ${Math.round(text.length / 4).toLocaleString("en")} tokens), over the limit of ${max.toLocaleString("en")}`,
			"split it into notes by topic and link them",
		);
	}
	return out;
}

// ── comparing two versions ─────────────────────────────────────────────────

/** Indexes (0-based) of the lines of `after` that are not in `before` (as a multiset): what this write added or changed. */
function changedLines(before: string[], after: string[]): Set<number> {
	const pool = new Map<string, number>();
	for (const l of before) pool.set(l, (pool.get(l) ?? 0) + 1);
	const changed = new Set<number>();
	after.forEach((l, i) => {
		const n = pool.get(l) ?? 0;
		if (n > 0) pool.set(l, n - 1);
		else changed.add(i);
	});
	return changed;
}

function byLine(a: Violation, b: Violation): number {
	return (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule);
}

/**
 * Checks a write: `after` is the note as it would be saved, `before` the note as it is now (null for a new note).
 * A finding is new when the note did not have it before: per rule and per matched text, a write may not raise the
 * count (so editing a line that already had an old problem is fine), and `append_only` sections may not lose lines.
 */
export function checkWrite(rules: Rules, after: NoteText, before: NoteText | null, opts: CheckOptions = {}): WriteCheck {
	const now = noteViolations(rules, after.path, after.text, opts.only);
	const was = before ? noteViolations(rules, before.path, before.text, opts.only) : [];
	const fresh: Violation[] = [];
	const existing: Violation[] = [];
	const afterLines = after.text.split("\n").map((l) => l.replace(/\r$/, ""));
	const changed = changedLines(before ? before.text.split("\n").map((l) => l.replace(/\r$/, "")) : [], afterLines);
	const wasCount = new Map<string, number>();
	for (const v of was) wasCount.set(v.key, (wasCount.get(v.key) ?? 0) + 1);
	const groups = new Map<string, Violation[]>();
	for (const v of now) groups.set(v.key, [...(groups.get(v.key) ?? []), v]);
	for (const [key, group] of groups) {
		const had = wasCount.get(key) ?? 0;
		if (key === "size:over") {
			// Already too big: only growing it more counts as new.
			if (had === 0 || (before !== null && after.text.length > before.text.length)) fresh.push(...group);
			else existing.push(...group);
			continue;
		}
		if (group.length <= had) {
			existing.push(...group);
			continue;
		}
		// Which occurrences are the new ones: those on lines this write added or changed, the last ones otherwise.
		const ranked = [...group].sort((a, b) => {
			const ca = a.line !== null && changed.has(a.line - 1) ? 0 : 1;
			const cb = b.line !== null && changed.has(b.line - 1) ? 0 : 1;
			return ca - cb || (b.line ?? 0) - (a.line ?? 0);
		});
		const k = group.length - had;
		fresh.push(...ranked.slice(0, k));
		existing.push(...ranked.slice(k));
	}

	const on = (r: RuleId) => !opts.only || opts.only.includes(r);
	if (before && on("append_only") && rules.appendOnly.sections.length) {
		const old = sectionLines(parse(before.text), rules.appendOnly.sections);
		if (old.lines.length) {
			const neu = sectionLines(parse(after.text), rules.appendOnly.sections);
			const pool = new Map<string, number>();
			for (const l of [...neu.lines, ...(opts.allowRemoved ?? []).map((l) => l.trim())]) pool.set(l, (pool.get(l) ?? 0) + 1);
			const name = neu.heading ?? old.heading ?? `## ${rules.appendOnly.sections[0]}`;
			for (const l of old.lines) {
				const n = pool.get(l) ?? 0;
				if (n > 0) {
					pool.set(l, n - 1);
					continue;
				}
				fresh.push({
					rule: "append_only",
					line: neu.headingLine,
					message: neu.headingLine === null ? `the section «${name}» was removed with its line «${clip(l)}»` : `the line «${clip(l)}» of «${name}» was changed or removed`,
					fix: `${neu.headingLine === null ? `keep «${name}» with all its lines; you may only add lines to it` : "put it back exactly as it was; this section only takes new lines"}${
						opts.batch
							? `, unless it moves unchanged into the «${name}» of another note of this same submission`
							: `. To split the note, do it in one submission (the publish tool, or one memoria publicar): a line may then leave «${name}» here if it enters, unchanged, the «${name}» of another note of the same submission`
					}`,
					action: rules.appendOnly.action,
					key: `append_only:${l}`,
				});
			}
		}
	}
	fresh.sort(byLine);
	existing.sort(byLine);
	return { blocking: fresh.filter((v) => v.action === "block"), warnings: fresh.filter((v) => v.action === "warn"), existing };
}

/**
 * The notes of one submission (several notes in one `publish`, or one commit), judged together: a line that leaves an
 * append-only section of one note is not lost if the same line, unchanged, enters that section of another note of
 * the submission, as when a note is split. Each line that enters covers one line that leaves.
 */
export function checkBatch(rules: Rules, entries: { after: NoteText; before: NoteText | null; opts?: CheckOptions }[]): WriteCheck[] {
	const entering = new Map<string, number>();
	for (const e of entries) for (const l of appendOnlyAdded(rules, e.before?.text ?? null, e.after.text)) entering.set(l, (entering.get(l) ?? 0) + 1);
	return entries.map((e) => {
		const moved: string[] = [];
		if (e.before) {
			for (const l of appendOnlyAdded(rules, e.after.text, e.before.text)) {
				const n = entering.get(l) ?? 0;
				if (n === 0) continue;
				entering.set(l, n - 1);
				moved.push(l);
			}
		}
		return checkWrite(rules, e.after, e.before, { ...e.opts, allowRemoved: [...(e.opts?.allowRemoved ?? []), ...moved], batch: true });
	});
}

/** Lines of the append-only sections that one version adds over another: what a revert of that change may remove. */
export function appendOnlyAdded(rules: Rules, before: string | null, after: string): string[] {
	if (!rules.appendOnly.sections.length) return [];
	const pool = new Map<string, number>();
	for (const l of before === null ? [] : sectionLines(parse(before), rules.appendOnly.sections).lines) pool.set(l, (pool.get(l) ?? 0) + 1);
	const added: string[] = [];
	for (const l of sectionLines(parse(after), rules.appendOnly.sections).lines) {
		const n = pool.get(l) ?? 0;
		if (n > 0) pool.set(l, n - 1);
		else added.push(l);
	}
	return added;
}

// ── messages ───────────────────────────────────────────────────────────────

/** One line: which rule, which line, what is wrong and how to fix it. */
export function formatViolation(v: Violation): string {
	return `${v.rule}${v.line === null ? "" : `, line ${v.line}`}: ${v.message}. Fix: ${v.fix}.`;
}

export function violationJson(v: Violation): { rule: RuleId; line: number | null; message: string; fix: string } {
	return { rule: v.rule, line: v.line, message: v.message, fix: v.fix };
}

const MAX_LINES = 12;

function list(vs: Violation[]): string {
	const lines = vs.slice(0, MAX_LINES).map((v) => `- ${formatViolation(v)}`);
	if (vs.length > MAX_LINES) lines.push(`- …and ${vs.length - MAX_LINES} more (see «violations»).`);
	return lines.join("\n");
}

/** The error text of a refused write. */
export function blockingMessage(path: string, check: WriteCheck): string {
	const n = check.blocking.length;
	const older = check.existing.length ? ` The note also has ${check.existing.length} older problem(s); those do not block.` : "";
	return `Not saved: this write would add ${n} problem${n === 1 ? "" : "s"} that the memory's rules forbid in «${path}» (memory.toml [rules]). Fix each one and retry; nothing else changes.${older}\n${list(check.blocking)}`;
}

/** The error text of a refused submission of several notes. */
export function batchBlockingMessage(results: { path: string; check: WriteCheck }[]): string {
	const refused = results.filter((r) => r.check.blocking.length);
	const n = refused.reduce((k, r) => k + r.check.blocking.length, 0);
	const lines = refused.flatMap((r) => r.check.blocking.map((v) => `- ${r.path}: ${formatViolation(v)}`));
	const shown = lines.slice(0, MAX_LINES);
	if (lines.length > MAX_LINES) shown.push(`- …and ${lines.length - MAX_LINES} more (see «violations»).`);
	return `Not saved: this submission would add ${n} problem${n === 1 ? "" : "s"} that the memory's rules forbid in ${refused.map((r) => `«${r.path}»`).join(", ")} (memory.toml [rules]). Nothing was saved; fix each one and send it again.\n${shown.join("\n")}`;
}

/** Warnings of an accepted write: new problems of `warn` rules and problems the note already had. */
export function warningTexts(check: WriteCheck): { code: "RULES_WARNINGS" | "RULES_EXISTING"; message: string; violations: ReturnType<typeof violationJson>[] }[] {
	const out: { code: "RULES_WARNINGS" | "RULES_EXISTING"; message: string; violations: ReturnType<typeof violationJson>[] }[] = [];
	if (check.warnings.length) {
		out.push({ code: "RULES_WARNINGS", message: `Saved, but this write adds problems the memory's rules advise against; fix them now:\n${list(check.warnings)}`, violations: check.warnings.map(violationJson) });
	}
	if (check.existing.length) {
		out.push({ code: "RULES_EXISTING", message: `Saved. The note already had these problems (they do not block); fix them when you can:\n${list(check.existing)}`, violations: check.existing.map(violationJson) });
	}
	return out;
}

/** What the server tells agents up front, so writes are right the first time. Null without rules. */
export function describeRules(rules: Rules | null): string | null {
	if (!rules) return null;
	const parts: string[] = [];
	if (rules.frontmatter.required) parts.push("every note starts with frontmatter");
	if (rules.type.allowed) {
		const untyped = rules.type.untypedFolders.length ? ` (except notes in ${rules.type.untypedFolders.map((f) => `${f}/`).join(", ")})` : "";
		parts.push(`«${rules.type.field}» is one of ${rules.type.allowed.join(", ")}${untyped}`);
	}
	if (rules.appendOnly.sections.length) {
		const names = rules.appendOnly.sections.map((s) => `«## ${s}»`).join(", ");
		parts.push(`the existing lines of ${names} are never changed or removed, only added to (to split a note, send both notes in one publish: a line may then move unchanged to the same section of the other note)`);
	}
	if (rules.forbiddenSections.sections.length) parts.push(`no ${rules.forbiddenSections.sections.map((s) => `«## ${s}»`).join(", ")} sections`);
	for (const [type, sections] of Object.entries(rules.templates.byType)) parts.push(`${type} notes use the sections ${sections.join(" · ")}, in that order`);
	if (rules.obsolete.patterns.length) parts.push("names of retired tools and services are refused");
	if (rules.size.maxChars) parts.push(`notes stay under ${rules.size.maxChars.toLocaleString("en")} characters`);
	if (!parts.length) return null;
	return `Every write is checked against this memory's rules: ${parts.join("; ")}. A write that adds a violation fails with RULES_VIOLATED and says, per problem, the line and how to fix it; problems a note already had only warn.`;
}
