import { readProps } from "./frontmatter";
import { BEGIN, dateLabel, END } from "./notes";

/**
 * Deadlines.md holds one task per deliverable:
 *
 *   - [ ] **2026-10-02**: [[CS241E/CS241E|CS241E]] CS 241E A3 due ^dl-a1b2c3
 *     Marmoset.
 *
 * The block id after "^" identifies the item across edits. Older files used ✅/🔶/▫️ in
 * place of the checkbox; those are read as done/open and rewritten as checkboxes.
 */

export interface Deadline {
	id: string;
	done: boolean;
	/** YYYY-MM-DD */
	date: string;
	/** text after the date, e.g. "[[CS241E/CS241E|CS241E]] CS 241E A3 due" */
	title: string;
	/** indented lines under the item */
	detail: string[];
}

const ITEM = /^- (?:\[( |x|X)\]|(✅|🔶|▫️|⬜)) \*\*(\d{4}-\d{2}-\d{2})\*\*(?::| —) (.*?)(?: \^(dl-[a-z0-9]+))?\s*$/u;

function newId(taken: Set<string>): string {
	let id: string;
	do id = `dl-${Math.random().toString(36).slice(2, 8)}`;
	while (taken.has(id));
	taken.add(id);
	return id;
}

export interface DeadlinesFile {
	/** lines before the first item */
	head: string[];
	items: Deadline[];
	/** unindented lines after the first item that are not items, kept at the end */
	tail: string[];
	/** some item had no id or used the old emoji status, so the file should be rewritten */
	dirty: boolean;
}

export function parseDeadlines(text: string): DeadlinesFile {
	const lines = text.split("\n");
	const head: string[] = [];
	const items: Deadline[] = [];
	const tail: string[] = [];
	const taken = new Set<string>();
	let dirty = false;
	for (const line of lines) {
		const m = ITEM.exec(line);
		if (m) {
			const done = m[1] ? m[1].toLowerCase() === "x" : m[2] === "✅";
			if (!m[5] || taken.has(m[5]) || m[2]) dirty = true;
			const id = m[5] && !taken.has(m[5]) ? m[5] : newId(taken);
			taken.add(id);
			items.push({ id, done, date: m[3], title: m[4].trim(), detail: [] });
		} else if (items.length && /^\s+\S/.test(line)) {
			items[items.length - 1].detail.push(line.trim());
		} else if (!items.length) {
			head.push(line);
		} else if (line.trim()) {
			tail.push(line);
		}
		// Blank lines between items are regenerated.
	}
	return { head, items, tail, dirty };
}

export function formatDeadlines(file: DeadlinesFile): string {
	const items = [...file.items].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
	const body = items
		.map((d) => [`- [${d.done ? "x" : " "}] **${d.date}**: ${d.title} ^${d.id}`, ...d.detail.map((l) => `  ${l}`)].join("\n"))
		.join("\n\n");
	const head = file.head.join("\n").replace(/\s*$/, "");
	const tail = file.tail.length ? `\n${file.tail.join("\n")}\n` : "";
	return `${head}\n\n${body}\n${tail}`;
}

/** Local date as YYYY-MM-DD. */
/**
 * Minutes after midnight a class starts, from its note's `time` property ("1:30–2:20 PM" or
 * "11:30 AM–12:50 PM"); null for a note with no class time. A start with no AM/PM takes the
 * end's, unless the start hour is later than the end hour (11:30–12:20 PM starts in the morning).
 */
export function classStart(text: string): number | null {
	const time = readProps(text).props.get("time");
	if (typeof time !== "string") return null;
	const m = /^(\d{1,2}):(\d{2}) ?([AP]M)?(?:\s*[–-]\s*(\d{1,2}):\d{2} ?([AP]M))?/.exec(time.trim());
	if (!m) return null;
	const hour = Number(m[1]) % 12;
	let pm = m[3] ? m[3] === "PM" : m[5] === "PM";
	if (!m[3] && m[4] && hour > Number(m[4]) % 12) pm = !pm;
	return (hour + (pm ? 12 : 0)) * 60 + Number(m[2]);
}

export function isoDate(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number);
	return isoDate(new Date(y, m - 1, d + n));
}

/** "[[CS241E/CS241E|CS241E]] CS 241E A3 due" -> "CS 241E A3 due" for compact lists. */
export function plainTitle(title: string): string {
	return title.replace(/^\[\[[^\]]*\]\]\s*/, "");
}

export interface Lecture {
	/** vault path of the dated note */
	path: string;
	/** e.g. "CS241E Lecture 6" */
	label: string;
	/** e.g. "11:30 AM–12:50 PM, MC 2066", from the note's time and room properties */
	when?: string;
}

export interface RecentLecture {
	path: string;
	/** e.g. "CS241E Lecture 5" */
	label: string;
	date: string;
	topics: string[];
}

export interface FollowUp {
	/** note the question is in */
	path: string;
	label: string;
	text: string;
}

export interface HomeContext {
	items: Deadline[];
	today: string;
	lectures: Lecture[];
	recent: RecentLecture[];
	followUps: FollowUp[];
	/** one line about the tablet and transcription, or null to leave it out */
	status: string | null;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
	const [a, b] = [from, to].map((d) => {
		const [y, m, day] = d.split("-").map(Number);
		return Date.UTC(y, m - 1, day);
	});
	return Math.round((b - a) / 86_400_000);
}

/** "today", "tomorrow", "in 3 days", or "Fri Oct 09 · in 12 days". */
function countdown(today: string, date: string): string {
	const n = daysBetween(today, date);
	if (n < 0) return `${-n} day${n === -1 ? "" : "s"} late`;
	if (n === 0) return "today";
	if (n === 1) return "tomorrow";
	if (n < 7) return `${dateLabel(date).slice(0, 3)} · in ${n} days`;
	return `${dateLabel(date)} · in ${n} days`;
}

export const EXAM = /\b(midterm|final|exam|quiz|test)\b/i;

const link = (path: string, label: string) => `[[${path.replace(/\.md$/, "")}|${label}]]`;

/**
 * The managed part of Home.md. Deadline lines are tasks: checking one here checks it in
 * Deadlines.md. Everything else links to the note it came from.
 */
export function homeBlock(ctx: HomeContext): string {
	const { today } = ctx;
	const open = ctx.items.filter((d) => !d.done).sort((a, b) => a.date.localeCompare(b.date));
	const task = (d: Deadline) => `- [ ] ${plainTitle(d.title)} · **${countdown(today, d.date)}** [[Deadlines#^${d.id}|↗]]`;
	const out: string[] = [];

	out.push(`## Today · ${dateLabel(today)}`);
	const classes = ctx.lectures.map((l) => `- ${link(l.path, l.label)}${l.when ? ` · ${l.when}` : ""}`);
	const dueToday = open.filter((d) => d.date <= today);
	if (!classes.length && !dueToday.length) out.push("- No classes and nothing due.");
	out.push(...classes, ...dueToday.map(task));

	const week = open.filter((d) => d.date > today && daysBetween(today, d.date) <= 7);
	out.push("", "## This week");
	out.push(...(week.length ? week.map(task) : ["- Nothing else due in the next 7 days."]));

	const exams = open.filter((d) => EXAM.test(d.title) && daysBetween(today, d.date) > 7 && daysBetween(today, d.date) <= 30);
	const later = open.filter((d) => !EXAM.test(d.title) && daysBetween(today, d.date) > 7 && daysBetween(today, d.date) <= 14);
	if (exams.length || later.length) {
		out.push("", "## Coming up");
		out.push(...[...exams, ...later].sort((a, b) => a.date.localeCompare(b.date)).map(task));
	}

	if (ctx.recent.length) {
		out.push("", "## Pick up where you left off");
		for (const r of ctx.recent) {
			// Two topics, shortened, so each lecture stays on one or two lines.
			const short = (t: string) => (t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t);
			const topics = r.topics.slice(0, 2).map(short).join(" · ");
			const n = daysBetween(r.date, today);
			const ago = n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
			out.push(`- ${link(r.path, r.label)} (${ago})${topics ? `: ${topics}` : ""}`);
		}
	}

	if (ctx.followUps.length) {
		out.push("", "## Open questions");
		out.push(...ctx.followUps.slice(0, 8).map((f) => `- ${f.text} · ${link(f.path, f.label)}`));
	}

	if (ctx.status) out.push("", `*${ctx.status}*`);
	return out.join("\n");
}

/** Ids of tasks checked in the Home block; the ↗ link names the deadline's block id. */
export function checkedInHome(text: string): string[] {
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start === -1 || end < start) return [];
	const ids: string[] = [];
	for (const line of text.slice(start, end).split("\n")) {
		const m = /^- \[[xX]\] .*\[\[Deadlines#\^(dl-[a-z0-9]+)\|/.exec(line);
		if (m) ids.push(m[1]);
	}
	return ids;
}

/** Replaces the managed block in Home.md, or the old static "## Next 14 days" section on first run. */
export function applyHome(text: string, block: string): string {
	const wrapped = `${BEGIN}\n${block}\n${END}`;
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start !== -1 && end > start) return text.slice(0, start) + wrapped + text.slice(end + END.length);
	const old = /^## Next 14 days[ \t]*\n[^]*?(?=^## |(?![^]))/m.exec(text);
	if (old) return text.slice(0, old.index) + wrapped + "\n\n" + text.slice(old.index + old[0].length);
	const h1 = /^# .*\n/m.exec(text);
	const at = h1 ? h1.index + h1[0].length : 0;
	return `${text.slice(0, at)}\n${wrapped}\n\n${text.slice(at)}`;
}
