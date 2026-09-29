import * as path from "path";
import { PropValue, readProps, setProps, withTags } from "./frontmatter";

/** Subset of Obsidian's DataAdapter used by the sync. Paths are vault-relative. */
export interface VaultIO {
	exists(p: string): Promise<boolean>;
	read(p: string): Promise<string>;
	write(p: string, data: string): Promise<void>;
	/** `savedAt`: the tablet's modified time of the notebook the image was rendered from */
	writeBinary(p: string, data: ArrayBuffer, savedAt?: number): Promise<void>;
	mkdir(p: string): Promise<void>;
	remove(p: string): Promise<void>;
	list(p: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface NotebookState {
	/** vault course folder, <TERM>/<COURSE>, e.g. 2A/CS241E */
	course: string;
	/** notebook name, e.g. Lectures */
	name: string;
	mtimeMs: number;
	size: number;
	/** pageid -> content hash, in notebook page order */
	pages: Record<string, string>;
	/** pageid -> time its hash last changed (0 when first seen in an initial sync) */
	changedAt: Record<string, number>;
	/** dated note paths that currently hold a supersidian block */
	notes: string[];
	/** pageid -> [first page row kept by the crop, page width], for drawing live ink over the image */
	geometry?: Record<string, [number, number]>;
	/** pages with no ink; they are not embedded unless `inked` */
	blank?: Record<string, boolean>;
	/** when the tablet saved the synced copy, on the laptop's clock (exact, unlike mtimeMs) */
	savedAt?: number;
	/** blank pages receiving live ink; embedded until the notebook's next sync (which drops this) */
	inked?: Record<string, boolean>;
	/** RENDER_LAYOUT the page images were rendered with */
	renderLayout?: number;
}

/** Bump when the rendered image geometry changes; pages re-render once without changing their hash. */
export const RENDER_LAYOUT = 2;

export interface Layout {
	/** where page images go */
	assetDir: string;
	/** the notebook's section folder: one note per day (LEC-YYYY-MM-DD.md) receives that day's pages */
	datedFolder: string;
	/** the section's index note, <folder>/<folder>.md: every dated note by month, plus pages with no date */
	indexPath: string;
	/** short name for prompts, e.g. "CS241E Lectures" */
	label: string;
}

/**
 * Vault paths for a notebook in course folder <TERM>/<COURSE>. Each notebook is a section folder
 * named after it (Lectures, Tutorials, Psets, ...) holding one note per day and an index note.
 */
export function layoutOf(nb: NotebookState): Layout {
	const [term, course] = nb.course.split("/");
	return {
		assetDir: `${nb.course}/assets/notes/${nb.name}`,
		datedFolder: `${nb.course}/${nb.name}`,
		indexPath: sectionIndex(`${nb.course}/${nb.name}`),
		label: `${course ?? term} ${nb.name.replace(/_/g, " ")} (${term})`,
	};
}

/** The index note of a section folder: 2A/CS241E/Lectures -> 2A/CS241E/Lectures/Lectures.md. */
export function sectionIndex(folder: string): string {
	return `${folder}/${folder.split("/").pop()}.md`;
}

/** File name prefix of a section's dated notes; other notebooks use their own name (Psets-2025-09-03.md). */
const PREFIXES: Record<string, string> = { Lectures: "LEC", Tutorials: "TUT", Labs: "LAB" };

/** Path of a new dated note in a section folder: Lectures -> LEC-2025-09-03.md, Psets -> Psets-2025-09-03.md. */
export function datedNotePath(folder: string, date: string): string {
	const name = folder.split("/").pop()!;
	return `${folder}/${PREFIXES[name] ?? name}-${date}.md`;
}

/** A note's `type` property from its section folder; sections not listed here are "notes". */
const SECTION_TYPES: Record<string, string> = {
	Lectures: "lecture",
	Tutorials: "tutorial",
	Labs: "lab",
	Psets: "pset",
	Homework: "homework",
	Assignments: "assignment",
};

export function sectionType(folder: string): string {
	return SECTION_TYPES[folder.split("/").pop()!] ?? "notes";
}

/** The `course` property: a link to the course page, e.g. [[2A/CS241E/CS241E|CS241E]]. */
export function courseLink(folder: string): string {
	const [term, course] = folder.split("/");
	return `[[${term}/${course}/${course}|${course}]]`;
}

/**
 * A new dated note for a day that has pages but no note, in the shape of the class notes. Its
 * title is the date alone: the folders and the course property name the course and section. It
 * has no `time` property, so Home does not list it as a class.
 */
export function newDatedNote(folder: string, date: string): string {
	return setProps(`# ${dateLabel(date, true)}\n\n## Topics\n\n## Notes\n`, { type: sectionType(folder), course: courseLink(folder), date });
}

/**
 * Link label for a note under <TERM>/<COURSE>/: "CS241E Thu Sep 24" for a lecture, "MATH115
 * Homework Tue Oct 21, 2025" for another section's day, "MATH135 Psets (1A)" otherwise.
 */
export function noteLabel(note: string): string {
	const parts = note.replace(/\.md$/, "").split("/");
	const course = parts[1] ?? parts[0];
	const date = /(\d{4}-\d{2}-\d{2})$/.exec(parts[parts.length - 1])?.[1];
	const section = parts.length > 3 && parts[2] !== "Lectures" ? `${parts[2].replace(/_/g, " ")} ` : "";
	if (date) return `${course} ${section}${dateLabel(date)}`;
	return `${course} ${parts[parts.length - 1].replace(/_/g, " ")} (${parts[0]})`;
}

/** What the transcriber produced for one version of a page. */
export interface PageExtra {
	/** page hash the transcript was made from */
	hash: string;
	transcript: string;
	topics: string[];
	concepts: string[];
}

export type Extras = Record<string, PageExtra>;

export const BEGIN = "<!-- supersidian:begin -->";
export const END = "<!-- supersidian:end -->";
const TOPICS_BEGIN = "<!-- supersidian:topics -->";
const TOPICS_END = "<!-- /supersidian:topics -->";
const PLACEHOLDER = /<!--\s*Paste exported Supernote[^]*?-->/;
const HEADING = /^## Handwritten notes[ \t]*$/m;
/** An embed of a page image this plugin wrote; group 1 is the page's creation stamp. */
const PAGE_EMBED = /^!\[\[[^\]]*\/(\d{8}-\d{6}(?:-\d{6})?)(?:-[0-9a-f]{8})?\.png\]\]\s*$/;
/** First line of a callout this plugin writes; the callout continues on lines starting with ">". */
const MANAGED_CALLOUT = /^> \[!(transcript|supersidian)\]/;

/** Page ids look like P20260924114800123456xxxx: local creation time, then random chars. */
export function pageDate(pageid: string): { date: string; stamp: string } | null {
	const m = /^P(\d{4})(\d{2})(\d{2})(\d{6})/.exec(pageid);
	if (!m) return null;
	return { date: `${m[1]}-${m[2]}-${m[3]}`, stamp: `${m[1]}${m[2]}${m[3]}-${m[4]}` };
}

/**
 * Image paths for a notebook's pages, named from each page's creation time, e.g.
 * 20260924-114821.png. The name stays the same when the page is edited, so the note text
 * does not change; the plugin refreshes the image in place. Pages created in the same
 * second get the microseconds from their id as well, e.g. 20250905-170629-952119.png.
 */
export function pagePngs(assetDir: string, pageids: string[]): Map<string, string> {
	const count = new Map<string, number>();
	for (const id of pageids) {
		const stamp = pageDate(id)?.stamp ?? id;
		count.set(stamp, (count.get(stamp) ?? 0) + 1);
	}
	return new Map(
		pageids.map((id) => {
			const stamp = pageDate(id)?.stamp ?? id;
			const name = (count.get(stamp) ?? 0) > 1 && /^P\d{20}/.test(id) ? `${stamp}-${id.slice(15, 21)}` : stamp;
			return [id, `${assetDir}/${name}.png`];
		}),
	);
}

/** Key that ties user text in a block to a page: the image file name without extension. */
function pageKey(png: string): string {
	return path.basename(png, ".png");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2026-09-10 -> "Thu Sep 10", with ", 2026" when not this year or when `year` is set. */
export function dateLabel(date: string, year = false): string {
	const [y, m, d] = date.split("-").map(Number);
	const label = `${DAYS[new Date(y, m - 1, d).getDay()]} ${MONTHS[m - 1]} ${String(d).padStart(2, "0")}`;
	return y === new Date().getFullYear() && !year ? label : `${label}, ${y}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Bullet lines under a note's "## Topics" heading. */
function topicLines(text: string): string[] {
	const m = /^## Topics[ \t]*\n([^]*?)(?=^## |(?![^]))/m.exec(text);
	if (!m) return [];
	return m[1].split("\n").filter((l) => /^\s*- \S/.test(l) && !/^\s*- \[ \]\s*$/.test(l));
}

/** Maps YYYY-MM-DD -> note path for notes named like LEC-2026-09-24.md in a folder. */
export async function datedNotes(vault: VaultIO, folder: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (!(await vault.exists(folder))) return map;
	for (const f of (await vault.list(folder)).files) {
		const m = /(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
		if (m) map.set(m[1], f.replace(/^\/+/, ""));
	}
	return map;
}

/** "concept/symbol-table" for "Symbol table"; null when nothing tag-safe is left. */
export function conceptTag(concept: string): string | null {
	const slug = concept
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return /[a-z]/.test(slug) ? `concept/${slug}` : null;
}

function trimBlank(lines: string[]): string[] {
	let a = 0;
	let b = lines.length;
	while (a < b && !lines[a].trim()) a++;
	while (b > a && !lines[b - 1].trim()) b--;
	return lines.slice(a, b);
}

/**
 * Splits an existing block body into the text the user wrote after each page image, keyed
 * by page stamp ("" for text before the first image). Page embeds and callouts this plugin
 * writes are dropped, since they are regenerated.
 */
export function userText(body: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let key = "";
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const embed = PAGE_EMBED.exec(lines[i]);
		if (embed) {
			key = embed[1];
			continue;
		}
		if (MANAGED_CALLOUT.test(lines[i])) {
			while (i + 1 < lines.length && lines[i + 1].startsWith(">")) i++;
			continue;
		}
		out.set(key, [...(out.get(key) ?? []), lines[i]]);
	}
	for (const [k, v] of out) {
		const t = trimBlank(v);
		if (t.length) out.set(k, t);
		else out.delete(k);
	}
	return out;
}

/**
 * Rewrites a transcript so Obsidian's editor parses it the way Reading view does. Inside a
 * callout the editor loses track of code fences that are indented or start a list item
 * ("- ```"), and reads a line of tildes (a drawn line, e.g. "~~~~ (spring)") as a fence,
 * and then shows the rest of the note as code. So: backtick fences start at the left margin
 * (their contents dedented to match), an unclosed fence is closed, a line starting with 3+
 * tildes gets a zero-width space, and one-line
 * display math ("$$x = 1$$") outside code is split into "$$", "x = 1", "$$".
 */
/**
 * Escapes a "#" that would start a tag ("real #s", "#include" outside a code block) as "\#", which
 * Obsidian shows as "#". Inline code and $...$ math are left as they are, and so are headings,
 * since their "#" is followed by another "#" or a space.
 */
export function escapeTags(line: string): string {
	return line
		.split(/(`[^`]*`|\$[^$]*\$)/)
		.map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w\\&#])#(?=[\p{L}\p{N}_/-]*[\p{L}_/-])/gu, "$1\\#")))
		.join("");
}

export function normalizeTranscript(lines: string[], escape = true): string[] {
	const out: string[] = [];
	/** inside a $$ display math block, where "#" is not a tag */
	let display = false;
	let fence: { char: string; len: number; indent: number } | null = null;
	const tilde = (l: string) => l.replace(/^(\s*)(~{3,})/, "$1\u200b$2");
	for (const line of lines) {
		if (fence) {
			const close = /^\s*(`{3,})\s*$/.exec(line);
			if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
				out.push(fence.char.repeat(fence.len));
				fence = null;
				continue;
			}
			const lead = /^ */.exec(line)![0].length;
			out.push(tilde(line.slice(Math.min(lead, fence.indent))));
			continue;
		}
		// Only backtick fences count: the prompt asks for them, and a tilde line is a drawing.
		const open = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(`{3,})(.*)$/.exec(line);
		if (open && !open[3].includes("`")) {
			fence = { char: open[2][0], len: open[2].length, indent: open[1].length };
			out.push(`${open[2]}${open[3].trim() ? open[3].trim() : ""}`);
			continue;
		}
		const math = /^(\s*)\$\$(.+?)\$\$\s*$/.exec(line);
		if (math) out.push(`${math[1]}$$`, `${math[1]}${math[2].trim()}`, `${math[1]}$$`);
		else if (/^\s*\$\$\s*$/.test(line)) {
			display = !display;
			out.push(line);
		} else out.push(display || !escape ? tilde(line) : tilde(escapeTags(line)));
	}
	if (fence) out.push(fence.char.repeat(fence.len));
	return out;
}

function callout(kind: string, title: string, body: string[]): string {
	return [`> [!${kind}]- ${title}`, ...normalizeTranscript(body).map((l) => (l ? `> ${l}` : ">"))].join("\n");
}

export interface BlockPage {
	pageid: string;
	png: string;
	extra?: PageExtra;
}

/**
 * Builds the block body: each page image, its transcript, then whatever the user wrote under it.
 * The concepts callout older versions wrote at the end is dropped (concepts are properties now).
 */
export function blockBody(pages: BlockPage[], previous: string | null): string {
	const user = previous === null ? new Map<string, string[]>() : userText(previous);
	const parts: string[] = [];
	const lead = user.get("");
	if (lead) parts.push(lead.join("\n"));
	const shown = new Set<string>();
	for (const p of pages) {
		const stamp = pageKey(p.png);
		shown.add(stamp);
		let section = `![[${p.png}]]`;
		if (p.extra?.transcript) section += `\n${callout("transcript", "Transcript", p.extra.transcript.split("\n"))}`;
		const mine = user.get(stamp);
		if (mine) section += `\n\n${mine.join("\n")}`;
		parts.push(section);
	}
	// Text under a page that no longer exists is kept at the end instead of being dropped.
	for (const [k, v] of user) if (k && !shown.has(k)) parts.push(v.join("\n"));
	return parts.join("\n\n");
}

/** Inserts, replaces, or removes the supersidian block in a note's text. */
export function applyBlock(text: string, pages: BlockPage[]): string {
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start !== -1 && end > start) {
		const previous = text.slice(start + BEGIN.length, end);
		const body = blockBody(pages, previous);
		if (body.trim()) return text.slice(0, start) + `${BEGIN}\n${body}\n${END}` + text.slice(end + END.length);
		// Removing the block leaves an empty section: one empty line before the next heading.
		return text.slice(0, start).replace(/\n*$/, "\n") + text.slice(end + END.length).replace(/^\n*/, "\n");
	}
	if (!pages.length) return text;
	const block = `${BEGIN}\n${blockBody(pages, null)}\n${END}`;
	// Older templates had a "## Handwritten notes" heading with a placeholder comment; the block replaces both.
	const heading = HEADING.exec(text);
	if (heading) {
		let end = heading.index + heading[0].length;
		const rest = text.slice(end);
		const placeholder = PLACEHOLDER.exec(rest);
		if (placeholder && rest.slice(0, placeholder.index).trim() === "") end += placeholder.index + placeholder[0].length;
		return text.slice(0, heading.index) + block + text.slice(end);
	}
	const questions = /^## Questions/m.exec(text);
	if (questions) {
		// Directly under a heading such as "## Notes", with no empty line between.
		const before = text.slice(0, questions.index).replace(/(^#{1,6} [^\n]*)\n\n+$/m, "$1\n");
		return `${before}${block}\n\n${text.slice(questions.index)}`;
	}
	return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

/**
 * Fills the "## Topics" section with generated topics inside marker comments. A section the
 * user already filled in by hand (bullets outside the markers) is left alone.
 */
export function applyTopics(text: string, topics: string[]): string {
	const m = /^## Topics[ \t]*\n([^]*?)(?=^## |(?![^]))/m.exec(text);
	if (!m) return text;
	const bodyStart = m.index + m[0].length - m[1].length;
	const body = m[1];
	const bullets = topics.map((t) => `- ${t}`).join("\n");
	const s = body.indexOf(TOPICS_BEGIN);
	const e = body.indexOf(TOPICS_END);
	let next: string;
	if (s !== -1 && e > s) {
		next = body.slice(0, s + TOPICS_BEGIN.length) + (bullets ? `\n${bullets}\n` : "\n") + body.slice(e);
	} else {
		const handWritten = body.split("\n").some((l) => l.trim() && !/^\s*- \[ \]\s*$/.test(l) && l.trim() !== "-");
		if (handWritten || !bullets) return text;
		next = `${TOPICS_BEGIN}\n${bullets}\n${TOPICS_END}\n\n`;
	}
	return text.slice(0, bodyStart) + next + text.slice(bodyStart + body.length);
}

/** Section folders listed first on a course page, in this order; the rest follow by name. */
const SECTION_ORDER = ["Lectures", "Tutorials", "Labs"];

/**
 * Puts a generated list under `## <heading>` between <!-- supersidian:<name> --> markers. Without
 * markers, a list already under that heading is replaced (it was written by hand or by an older
 * build); without the heading, the section goes before the first "## " heading, after the page's
 * title and details.
 */
function applyList(text: string, name: string, heading: string, lines: string[]): string {
	const begin = `<!-- supersidian:${name} -->`;
	const endMark = `<!-- /supersidian:${name} -->`;
	const block = `${begin}\n${lines.length ? lines.join("\n") : "- none yet"}\n${endMark}`;
	const start = text.indexOf(begin);
	const end = text.indexOf(endMark);
	if (start !== -1 && end > start) return text.slice(0, start) + block + text.slice(end + endMark.length);
	const existing = new RegExp(`^## ${heading}[ \\t]*\\n([^]*?)(?=^## |(?![^]))`, "m").exec(text);
	if (existing) {
		const at = existing.index + existing[0].length - existing[1].length;
		return `${text.slice(0, at)}${block}\n\n${text.slice(existing.index + existing[0].length)}`.replace(/\s*$/, "\n");
	}
	const first = /^## /m.exec(text);
	const section = `## ${heading}\n${block}\n\n`;
	if (!first) return `${text.replace(/\s*$/, "")}\n\n${section}`.replace(/\s*$/, "\n");
	return text.slice(0, first.index) + section + text.slice(first.index);
}

/** Lists a course's section folders on its page under "## Sections": each index with its number of dated notes. */
export function applySections(text: string, sections: { folder: string; notes: number }[]): string {
	const links = sectionLinks(sections, (n) => ` (${n} note${n === 1 ? "" : "s"})`);
	return applyList(text, "sections", "Sections", links.map((l) => `- ${l}`));
}

/** Links to section indexes, lectures first, each followed by `count(notes)`. */
function sectionLinks(sections: { folder: string; notes: number }[], count: (n: number) => string): string[] {
	const rank = (f: string) => {
		const i = SECTION_ORDER.indexOf(f.split("/").pop()!);
		return i === -1 ? SECTION_ORDER.length : i;
	};
	return [...sections]
		.sort((a, b) => rank(a.folder) - rank(b.folder) || a.folder.localeCompare(b.folder))
		.map(({ folder, notes }) => `[[${sectionIndex(folder).replace(/\.md$/, "")}|${folder.split("/").pop()!.replace(/_/g, " ")}]]${count(notes)}`);
}

/**
 * Lists a term's courses on its page under "## Courses": the course page by its title, then its
 * sections with their note counts on one line.
 */
export function applyCourses(text: string, courses: { page: string; title: string; sections: { folder: string; notes: number }[] }[]): string {
	const lines = courses.map(({ page, title, sections }) => {
		const links = sectionLinks(sections, (n) => ` (${n})`);
		return `- [[${page.replace(/\.md$/, "")}|${title}]]${links.length ? `: ${links.join(" · ")}` : ""}`;
	});
	return applyList(text, "courses", "Courses", lines);
}

/** Writes the index into the index note's supersidian block, creating the note (with `header`) if needed. */
export function applyIndex(text: string | null, header: string, sections: string[]): string {
	const block = `${BEGIN}\n${sections.join("\n\n")}\n${END}`;
	if (text === null) return `${header}\n\n${block}\n`;
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start !== -1 && end > start) return text.slice(0, start) + block + text.slice(end + END.length);
	return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** Concept -> weight for every dated note, across all notebooks. Used to find related lectures. */
export async function noteConcepts(
	vault: VaultIO,
	notebooks: NotebookState[],
	extras: Extras,
): Promise<Map<string, Set<string>>> {
	const out = new Map<string, Set<string>>();
	for (const nb of notebooks) {
		const layout = layoutOf(nb);
		const notes = await datedNotes(vault, layout.datedFolder);
		for (const pageid of Object.keys(nb.pages)) {
			// Every dated page has a dated note (writeNotebookNotes creates missing ones); an undated
			// page counts toward the section's index.
			const date = pageDate(pageid)?.date;
			const note = date ? notes.get(date) ?? datedNotePath(layout.datedFolder, date) : layout.indexPath;
			const extra = extras[pageid];
			// Blank and nearly blank pages (no transcript) contribute no concepts.
			if (!extra || nb.blank?.[pageid] || !extra.transcript.trim()) continue;
			const set = out.get(note) ?? new Set<string>();
			for (const c of extra.concepts) {
				const tag = conceptTag(c);
				if (!tag) continue;
				set.add(tag);
			}
			out.set(note, set);
		}
	}
	return out;
}

/** Up to 5 other notes sharing at least 2 concepts with `note`, most shared first. */
export function relatedNotes(note: string, concepts: Map<string, Set<string>>): string[] {
	const mine = concepts.get(note);
	if (!mine) return [];
	const scored: [string, number][] = [];
	for (const [other, set] of concepts) {
		if (other === note) continue;
		let n = 0;
		for (const c of set) if (mine.has(c)) n++;
		if (n >= 2) scored.push([other, n]);
	}
	scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return scored.slice(0, 5).map(([other]) => `[[${other.replace(/\.md$/, "")}|${noteLabel(other)}]]`);
}

export interface NotesResult {
	notesUpdated: string[];
	/** dated notes that now hold a block */
	holding: string[];
	unmatchedDates: string[];
	indexUpdated: string | null;
}

/**
 * Writes the index note of a section folder (<TERM>/<COURSE>/<Section>/<Section>.md): every dated
 * note in the folder by month, with its title and first topics, then any `undated` pages. Text
 * outside the supersidian block is kept. Returns the path when it changed.
 */
export async function writeSectionIndex(
	vault: VaultIO,
	folder: string,
	undated: BlockPage[],
	concepts: Map<string, Set<string>>,
): Promise<string | null> {
	const name = folder.split("/").pop()!;
	const notes = [...(await datedNotes(vault, folder))].sort(([a], [b]) => a.localeCompare(b));
	const sections: string[] = [];
	let month = "";
	let lines: string[] = [];
	for (const [date, note] of notes) {
		const [y, m] = date.split("-").map(Number);
		const heading = `## ${MONTH_NAMES[m - 1]} ${y}`;
		if (heading !== month) {
			if (lines.length) sections.push(lines.join("\n"));
			month = heading;
			lines = [heading];
		}
		const text = await vault.read(note);
		const topics = topicLines(text)
			.map((l) => l.replace(/^\s*- /, "").trim())
			.slice(0, 3)
			.map((t) => (t.length > 40 ? `${t.slice(0, 39)}…` : t));
		const day = dateLabel(date).replace(/, \d{4}$/, "");
		lines.push(`- [[${note.replace(/\.md$/, "")}|${day}]]${topics.length ? `: ${topics.join(" · ")}` : ""}`);
	}
	if (lines.length) sections.push(lines.join("\n"));
	if (undated.length) sections.push(`## Undated\n${blockBody(undated, null)}`);
	const index = sectionIndex(folder);
	const before = (await vault.exists(index)) ? await vault.read(index) : null;
	const header = setProps(`# ${name.replace(/_/g, " ")}`, { type: "index", course: courseLink(folder) });
	const next = applyConcepts(applyIndex(before, header, sections.length ? sections : ["No notes yet."]), index, concepts);
	if (next === before) return null;
	await vault.write(index, next);
	return index;
}

/**
 * For every course folder (<TERM>/<COURSE> with a term like 2A): writes the index of each
 * section folder that has no notebook (`notebookFolders` are written by writeNotebookNotes), lists
 * the sections on the course page, and lists the courses on the term page (<TERM>/<TERM>.md).
 */
export async function writeCourseIndexes(vault: VaultIO, notebookFolders: Set<string>, concepts: Map<string, Set<string>>) {
	const strip = (p: string) => p.replace(/^\/+/, "");
	for (const term of (await vault.list("")).folders.map(strip)) {
		if (!/^\d[AB]$/i.test(term)) continue;
		const courses: { page: string; title: string; sections: { folder: string; notes: number }[] }[] = [];
		for (const course of (await vault.list(term)).folders.map(strip)) {
			const sections: { folder: string; notes: number }[] = [];
			for (const folder of (await vault.list(course)).folders.map(strip)) {
				if (folder.endsWith("/assets")) continue;
				if (!notebookFolders.has(folder)) await writeSectionIndex(vault, folder, [], concepts);
				sections.push({ folder, notes: (await datedNotes(vault, folder)).size });
			}
			const page = `${course}/${course.split("/").pop()}.md`;
			if (!(await vault.exists(page))) continue;
			const text = await vault.read(page);
			const next = applySections(text, sections);
			if (next !== text) await vault.write(page, next);
			// The course page's title, e.g. "CS 241E".
			const title = /^# (.+?)\s*$/m.exec(next)?.[1]?.replace(/ \(\d[AB]\)$/, "") ?? course.split("/").pop()!;
			courses.push({ page, title, sections });
		}
		const termPage = `${term}/${term}.md`;
		if (!(await vault.exists(termPage))) continue;
		const text = await vault.read(termPage);
		const next = applyCourses(text, courses);
		if (next !== text) await vault.write(termPage, next);
	}
}

/**
 * Rewrites the block in each dated note of a notebook and its section index from the notebook
 * state, without reading the device. Pages go into the note for the day they were created,
 * which is created from newDatedNote when missing.
 */
/**
 * Topics for a lecture from its pages' topics: pages with no transcript (blank or nearly so)
 * are skipped, repeats are dropped ignoring case, a topic contained in a longer one is
 * dropped, and at most 6 are kept.
 */
function lectureTopics(pages: BlockPage[]): string[] {
	const all = pages.filter((p) => p.extra?.transcript.trim()).flatMap((p) => p.extra!.topics);
	const unique: string[] = [];
	for (const t of all) if (!unique.some((u) => u.toLowerCase() === t.toLowerCase())) unique.push(t);
	const kept = unique.filter((t) => !unique.some((u) => u !== t && u.length > t.length && u.toLowerCase().includes(t.toLowerCase())));
	return kept.slice(0, 6);
}

/** How many notes carry each concept tag, computed once per concept map. */
const tagCounts = new WeakMap<Map<string, Set<string>>, Map<string, number>>();

function countTags(concepts: Map<string, Set<string>>): Map<string, number> {
	let counts = tagCounts.get(concepts);
	if (!counts) {
		counts = new Map();
		for (const set of concepts.values()) for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
		tagCounts.set(concepts, counts);
	}
	return counts;
}

/**
 * A note's concept tags and related notes. Only a concept another note also has is a tag, so
 * each tag links at least two notes; a concept one note has stays in transcripts.json and becomes
 * a tag in both notes once a second note has it.
 */
export function conceptProps(note: string, concepts: Map<string, Set<string>>): { tags: string[]; related: string[] } {
	const counts = countTags(concepts);
	const tags = [...(concepts.get(note) ?? [])].filter((t) => (counts.get(t) ?? 0) >= 2).sort();
	return { tags, related: relatedNotes(note, concepts) };
}

/** Sets a note's concept tags (keeping its other tags) and its `related` property. */
export function applyConcepts(text: string, note: string, concepts: Map<string, Set<string>>): string {
	const { tags, related } = conceptProps(note, concepts);
	const updates: Record<string, PropValue> = { tags: withTags(readProps(text).props, "concept/", tags), related };
	return setProps(text, updates);
}

export async function writeNotebookNotes(
	vault: VaultIO,
	nb: NotebookState,
	extras: Extras,
	concepts: Map<string, Set<string>>,
): Promise<NotesResult> {
	const layout = layoutOf(nb);
	const assetDir = layout.assetDir;
	const notes = await datedNotes(vault, layout.datedFolder);
	// Every day with pages gets a note, so no index holds a long run of pages.
	for (const pageid of Object.keys(nb.pages)) {
		const date = pageDate(pageid)?.date;
		if (!date || notes.has(date) || (nb.blank?.[pageid] && !nb.inked?.[pageid])) continue;
		if (!(await vault.exists(layout.datedFolder))) await vault.mkdir(layout.datedFolder);
		const note = datedNotePath(layout.datedFolder, date);
		if (!(await vault.exists(note))) await vault.write(note, newDatedNote(layout.datedFolder, date));
		notes.set(date, note);
	}
	const byDate = new Map<string, BlockPage[]>();
	const loose = new Map<string, BlockPage[]>();
	const unmatched = new Set<string>();
	const pngs = pagePngs(assetDir, Object.keys(nb.pages));
	for (const pageid of Object.keys(nb.pages)) {
		// Blank pages are left out, except one being written on live (so its strokes have an
		// image to draw over until the next save).
		if (nb.blank?.[pageid] && !nb.inked?.[pageid]) continue;
		const d = pageDate(pageid);
		const extra = extras[pageid];
		const page: BlockPage = { pageid, png: pngs.get(pageid)!, extra: extra?.hash === nb.pages[pageid] ? extra : undefined };
		const date = d?.date ?? "";
		const target = d && notes.has(d.date) ? byDate : loose;
		if (target === loose && d) unmatched.add(d.date);
		target.set(date, [...(target.get(date) ?? []), page]);
	}

	// Rewrite notes that have pages now, plus notes that had a block before (pages may have moved or been deleted).
	const touched = new Set<string>(nb.notes);
	for (const date of byDate.keys()) touched.add(notes.get(date)!);
	const noteToDate = new Map([...notes].map(([d, p]) => [p, d]));
	const notesUpdated: string[] = [];
	const holding: string[] = [];
	for (const note of touched) {
		if (!(await vault.exists(note))) continue;
		const pages = byDate.get(noteToDate.get(note) ?? "") ?? [];
		const topics = lectureTopics(pages);
		const text = await vault.read(note);
		const next = applyConcepts(applyTopics(applyBlock(text, pages), topics), note, concepts);
		if (next !== text) {
			await vault.write(note, next);
			notesUpdated.push(note);
		}
		if (pages.length) holding.push(note);
	}

	const indexUpdated = await writeSectionIndex(vault, layout.datedFolder, loose.get("") ?? [], concepts);

	return { notesUpdated: notesUpdated.sort(), holding: holding.sort(), unmatchedDates: [...unmatched].sort(), indexUpdated };
}
