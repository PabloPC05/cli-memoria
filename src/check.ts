import type { Conventions } from "./conventions.js";
import type { Git } from "./git.js";
import { checkBatch, formatViolation, type NoteText, noteViolations, type Rules, rulesApply, type Violation, violationJson, type WriteCheck } from "./rules.js";
import { type FileChange, parseNameStatus } from "./util.js";

/**
 * `cli-memoria check`: the write rules over a git repo, without the server. On a tree it lists what every note breaks
 * (like `lint`); on a range it judges the change the way the server judges a submission (only new problems block,
 * and a line may move between the Fuentes of two notes), so it can run as a pre-receive or pre-push hook; with
 * `each` it judges every commit of the range on its own.
 */

/** git's empty tree, the "parent" of a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface NoteFindings {
	path: string;
	violations: Violation[];
}

export interface FileCheck {
	path: string;
	from?: string;
	check: WriteCheck;
}

export interface CommitCheck {
	commit: string;
	date: string;
	client: string;
	tool: string;
	subject: string;
	files: FileCheck[];
}

function rulesOf(conventions: Conventions): Rules {
	if (!conventions.rules) throw new Error("this memory has no [rules] in memory.toml: nothing to check");
	return conventions.rules;
}

/** Every note of a tree that breaks a rule, with what it breaks. */
export async function checkTree(git: Git, conventions: Conventions, rev = "HEAD"): Promise<{ notes: number; findings: NoteFindings[] }> {
	const rules = rulesOf(conventions);
	const paths = (await git.out(["ls-tree", "-r", "-z", "--name-only", rev])).split("\0").filter((p) => p && rulesApply(conventions, p));
	const texts = await git.blobs(paths.map((p) => `${rev}:${p}`));
	const findings: NoteFindings[] = [];
	paths.forEach((path, i) => {
		const text = texts[i];
		if (text === null || text === undefined) return;
		const violations = noteViolations(rules, path, text);
		if (violations.length) findings.push({ path, violations });
	});
	return { notes: paths.length, findings };
}

/**
 * The notes a change writes, judged against what they were before it, in one `cat-file` for all of them. Pairs with
 * the same `group` (one commit, or the whole range) are one submission: a line may leave the Fuentes of one note if
 * it enters those of another (`checkBatch`).
 */
async function judge(git: Git, conventions: Conventions, pairs: { from: string; to: string; change: FileChange; group: number }[]): Promise<FileCheck[][]> {
	const rules = rulesOf(conventions);
	const specs: string[] = [];
	const plan = pairs.map(({ from, to, change, group }) => {
		const beforePath = change.status === "R" && change.from ? change.from : change.path;
		// A deleted note is part of the submission too: what it had may have gone to another note.
		const deleted = change.status === "D";
		if (!rulesApply(conventions, deleted ? beforePath : change.path)) return null;
		const hasBefore = from !== EMPTY_TREE && (deleted || change.status === "M" || change.status === "T" || change.status === "R") && rulesApply(conventions, beforePath);
		if (deleted && !hasBefore) return null;
		if (!deleted) specs.push(`${to}:${change.path}`);
		if (hasBefore) specs.push(`${from}:${beforePath}`);
		return { change, beforePath, hasBefore, deleted, group };
	});
	const texts = await git.blobs(specs);
	let k = 0;
	const groups = new Map<number, { index: number; after: NoteText | null; before: NoteText | null }[]>();
	plan.forEach((p, index) => {
		if (!p) return;
		const after = p.deleted ? null : texts[k++];
		const before = p.hasBefore ? texts[k++] : null;
		if (!p.deleted && (after === null || after === undefined)) return;
		const entry = {
			index,
			after: p.deleted ? null : { path: p.change.path, text: after as string },
			before: before === null || before === undefined ? null : { path: p.beforePath, text: before },
		};
		groups.set(p.group, [...(groups.get(p.group) ?? []), entry]);
	});
	const out: FileCheck[][] = pairs.map(() => []);
	for (const entries of groups.values()) {
		checkBatch(rules, entries).forEach((check, i) => {
			const e = entries[i] as (typeof entries)[number];
			if (!e.after) return;
			const change = (plan[e.index] as { change: FileChange }).change;
			out[e.index] = [{ path: change.path, ...(change.status === "R" ? { from: change.from } : {}), check }];
		});
	}
	return out;
}

/** The whole range as one change (what a push brings), each note against its version at `from`. */
export async function checkRange(git: Git, conventions: Conventions, from: string | null, to: string): Promise<FileCheck[]> {
	const base = from ?? EMPTY_TREE;
	const changes = parseNameStatus(await git.out(["diff", "-M", "--name-status", base, to]));
	return (await judge(git, conventions, changes.map((change) => ({ from: base, to, change, group: 0 })))).flat();
}

/** Every commit of a range (oldest first, merges left out) against its parent. */
export async function checkCommits(git: Git, conventions: Conventions, range: string): Promise<CommitCheck[]> {
	const log = await git.out([
		"log",
		"--reverse",
		"--no-merges",
		"-M",
		"--name-status",
		"--format=%x1e%H%x1f%P%x1f%aI%x1f%(trailers:key=Client,valueonly,separator=%x2C)%x1f%(trailers:key=Tool,valueonly,separator=%x2C)%x1f%s%x1f",
		range,
	]);
	const commits: Omit<CommitCheck, "files">[] = [];
	const pairs: { from: string; to: string; change: FileChange; group: number }[] = [];
	const owner: number[] = [];
	for (const block of log.split("\x1e")) {
		if (!block.trim()) continue;
		const [commit, parents, date, client, tool, subject, files] = block.split("\x1f") as string[];
		const parent = (parents ?? "").trim().split(" ")[0] || EMPTY_TREE;
		commits.push({ commit: commit as string, date: date as string, client: (client ?? "").trim(), tool: (tool ?? "").trim(), subject: subject as string });
		for (const change of parseNameStatus(files ?? "")) {
			pairs.push({ from: parent, to: commit as string, change, group: commits.length - 1 });
			owner.push(commits.length - 1);
		}
	}
	const judged = await judge(git, conventions, pairs);
	const out: CommitCheck[] = commits.map((c) => ({ ...c, files: [] }));
	judged.forEach((files, i) => out[owner[i] as number]?.files.push(...files));
	return out;
}

// ── rendering ──────────────────────────────────────────────────────────────

function countByRule(vs: Violation[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const v of vs) out[v.rule] = (out[v.rule] ?? 0) + 1;
	return out;
}

function renderCounts(counts: Record<string, number>): string {
	const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}`);
	return parts.length ? parts.join(", ") : "none";
}

export function treeReport(result: { notes: number; findings: NoteFindings[] }) {
	const notesByRule: Record<string, number> = {};
	for (const f of result.findings) for (const rule of new Set(f.violations.map((v) => v.rule))) notesByRule[rule] = (notesByRule[rule] ?? 0) + 1;
	return {
		notes: result.notes,
		with_problems: result.findings.length,
		notes_by_rule: notesByRule,
		violations_by_rule: countByRule(result.findings.flatMap((f) => f.violations)),
		findings: result.findings.map((f) => ({ path: f.path, violations: f.violations.map(violationJson) })),
	};
}

export function renderTree(result: { notes: number; findings: NoteFindings[] }): string {
	const r = treeReport(result);
	const lines = [`${r.notes} notes checked, ${r.with_problems} with problems`, `notes by rule: ${renderCounts(r.notes_by_rule)}`, `problems by rule: ${renderCounts(r.violations_by_rule)}`];
	for (const f of result.findings) for (const v of f.violations) lines.push(`${f.path}  ${formatViolation(v)}`);
	return lines.join("\n");
}

export function rangeReport(files: FileCheck[]) {
	const blocked = files.filter((f) => f.check.blocking.length);
	return {
		files: files.length,
		blocked: blocked.length,
		blocking_by_rule: countByRule(files.flatMap((f) => f.check.blocking)),
		warnings_by_rule: countByRule(files.flatMap((f) => f.check.warnings)),
		existing_by_rule: countByRule(files.flatMap((f) => f.check.existing)),
		results: files
			.filter((f) => f.check.blocking.length || f.check.warnings.length)
			.map((f) => ({ path: f.path, ...(f.from ? { from: f.from } : {}), blocking: f.check.blocking.map(violationJson), warnings: f.check.warnings.map(violationJson) })),
	};
}

export function renderRange(files: FileCheck[]): string {
	const r = rangeReport(files);
	const lines = [
		`${r.files} notes written, ${r.blocked} would be refused`,
		`new problems that block: ${renderCounts(r.blocking_by_rule)}`,
		`new problems that warn: ${renderCounts(r.warnings_by_rule)}`,
		`older problems (never block): ${renderCounts(r.existing_by_rule)}`,
	];
	for (const f of files) {
		for (const v of f.check.blocking) lines.push(`REFUSED ${f.path}  ${formatViolation(v)}`);
		for (const v of f.check.warnings) lines.push(`warn    ${f.path}  ${formatViolation(v)}`);
	}
	return lines.join("\n");
}

export function commitsReport(commits: CommitCheck[]) {
	const refused = commits.filter((c) => c.files.some((f) => f.check.blocking.length));
	const commitsByRule: Record<string, number> = {};
	for (const c of refused) for (const rule of new Set(c.files.flatMap((f) => f.check.blocking.map((v) => v.rule)))) commitsByRule[rule] = (commitsByRule[rule] ?? 0) + 1;
	const all = commits.flatMap((c) => c.files);
	return {
		commits: commits.length,
		writes: all.length,
		refused_commits: refused.length,
		refused_writes: all.filter((f) => f.check.blocking.length).length,
		refused_commits_by_rule: commitsByRule,
		blocking_by_rule: countByRule(all.flatMap((f) => f.check.blocking)),
		warnings_by_rule: countByRule(all.flatMap((f) => f.check.warnings)),
		/** Writes to notes that already had problems and that went through: what "only new problems block" keeps working. */
		writes_with_older_problems: all.filter((f) => f.check.existing.length && !f.check.blocking.length).length,
		refused: refused.map((c) => ({
			commit: c.commit,
			date: c.date,
			client: c.client,
			tool: c.tool,
			subject: c.subject,
			files: c.files.filter((f) => f.check.blocking.length).map((f) => ({ path: f.path, blocking: f.check.blocking.map(violationJson) })),
		})),
	};
}

export function renderCommits(commits: CommitCheck[]): string {
	const r = commitsReport(commits);
	const lines = [
		`${r.commits} commits, ${r.writes} note writes; ${r.refused_commits} commits (${r.refused_writes} writes) would be refused`,
		`refused commits by rule: ${renderCounts(r.refused_commits_by_rule)}`,
		`new problems that block: ${renderCounts(r.blocking_by_rule)}`,
		`new problems that warn: ${renderCounts(r.warnings_by_rule)}`,
		`writes to notes with older problems that went through: ${r.writes_with_older_problems}`,
	];
	for (const c of r.refused) {
		lines.push(`${c.commit.slice(0, 10)} ${c.date.slice(0, 10)} ${c.client || "-"} ${c.tool || "-"} ${c.subject}`);
		for (const f of c.files) for (const v of f.blocking) lines.push(`    ${f.path}  ${formatViolation({ ...v, action: "block", key: "" })}`);
	}
	return lines.join("\n");
}
