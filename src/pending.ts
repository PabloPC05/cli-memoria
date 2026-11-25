/**
 * The «Pendiente» lines: one pending item per line, in the shape the memory agrees on,
 *
 *     - [ ] Qué hay que hacer · responsable · 2026-03-14 [origen]
 *
 * with `- [x]` for one that is done, a date of `AAAA-MM-DD`, `AAAA-MM` or the word `sin plazo`, and an
 * optional origin between brackets at the end. The `deadlines` tool lists them and the optional
 * `[rules.pending]` checks that each line has this shape; both use this parser, so they always agree.
 */

export const PENDING_SECTION = "Pendiente";
export const NO_DEADLINE = "sin plazo";
/** Separator between the parts: a middle dot with spaces around it (a bare «·» is accepted too). */
const SEPARATOR = /\s*·\s*/u;
const DONE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/u;
const DAY = /^(\d{4}-\d{2}-\d{2})$/;
const MONTH = /^(\d{4}-\d{2})$/;
const ORIGIN = /\s*\[([^\]\n]*)\]\s*$/u;

export interface PendingLine {
	/** `- [x]`. */
	done: boolean;
	/** What has to be done, without the mark, the owner, the date or the origin. */
	text: string;
	owner: string | null;
	/** `2026-03-14`, `2026-03`, `2026-03-14` of a month, or null for no deadline. */
	date: string | null;
	precision: "day" | "month" | null;
	origin: string | null;
}

/** A real calendar day: `2026-02-31` is a typo, not a date. */
function isDay(date: string): boolean {
	const at = Date.parse(`${date}T00:00:00Z`);
	return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === date;
}

/** A real month: `2026-13` is a typo. */
function isMonth(month: string): boolean {
	const n = Number(month.slice(5, 7));
	return n >= 1 && n <= 12;
}

/**
 * Parses one pending line, and returns null for anything else (blank lines, prose, a line with parts missing
 * or a date that is not one of the accepted forms).
 */
export function parsePendingLine(line: string): PendingLine | null {
	const marked = DONE.exec(line);
	if (!marked) return null;
	const done = (marked[1] ?? " ").toLowerCase() === "x";
	let rest = (marked[2] ?? "").trim();
	let origin: string | null = null;
	const withOrigin = ORIGIN.exec(rest);
	if (withOrigin) {
		origin = (withOrigin[1] ?? "").trim() || null;
		rest = rest.slice(0, withOrigin.index).trim();
	}
	// From the right, so a text that itself has a «·» keeps it: ¿texto · responsable · fecha.
	const parts = rest.split(SEPARATOR);
	if (parts.length < 2) return null;
	const datePart = (parts.pop() as string).trim().toLowerCase();
	const ownerPart = (parts.pop() as string).trim();
	const text = parts.join(" · ").trim();
	if (!text || !ownerPart) return null;
	let date: string | null = null;
	let precision: "day" | "month" | null = null;
	if (DAY.test(datePart)) {
		if (!isDay(datePart)) return null;
		date = datePart;
		precision = "day";
	} else if (MONTH.test(datePart)) {
		if (!isMonth(datePart)) return null;
		date = datePart;
		precision = "month";
	} else if (datePart !== NO_DEADLINE) return null;
	return { done, text, owner: ownerPart === "-" ? null : ownerPart, date, precision, origin };
}

/** Whether a line is one of the pending lines at all (it has the mark), so a rule can report the ones that do not parse. */
export function looksPending(line: string): boolean {
	return DONE.test(line);
}

/** Sort key: month-only deadlines open their month, undated ones go last. */
export function deadlineKey(item: { date: string | null; date_precision: "day" | "month" | null }): string {
	if (item.date === null) return "9999-99-99";
	return item.date_precision === "month" ? `${item.date}-00` : item.date;
}
