/**
 * Reads and writes a note's properties (YAML frontmatter) as text, so the sync works the same
 * inside Obsidian and in the CLI. Only the YAML Obsidian's property editor writes is parsed: a
 * scalar per key, or a list (block "  - item" or inline "[a, b]"). Keys this plugin does not set
 * keep their lines as they are.
 */

export type PropValue = string | string[];

interface Entry {
	key: string;
	/** the key's line and the indented or "- " lines under it */
	lines: string[];
}

const FRONTMATTER = /^---\n([^]*?)\n?---[ \t]*(?:\n|$)/;
const KEY = /^([A-Za-z0-9_-]+):(.*)$/;

function entries(yaml: string): Entry[] {
	const out: Entry[] = [];
	for (const line of yaml.split("\n")) {
		const m = KEY.exec(line);
		if (m) out.push({ key: m[1], lines: [line] });
		else if (out.length) out[out.length - 1].lines.push(line);
		else if (line.trim()) out.push({ key: "", lines: [line] });
	}
	return out;
}

function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) {
		try {
			return JSON.parse(t) as string;
		} catch {
			return t.slice(1, -1);
		}
	}
	if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}

/** Splits "a, "b, c", [[x|y]]" at commas outside quotes and brackets. */
function splitInline(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = "";
	let cur = "";
	for (const ch of s) {
		if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") depth++;
		else if (ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out.map(unquote).filter(Boolean);
}

function valueOf(e: Entry): PropValue {
	const first = KEY.exec(e.lines[0])![2].trim();
	const items = e.lines
		.slice(1)
		.map((l) => /^\s*- (.*)$/.exec(l)?.[1])
		.filter((v): v is string => v !== undefined)
		.map(unquote);
	if (items.length) return items;
	if (first.startsWith("[") && first.endsWith("]") && !first.startsWith("[[")) return splitInline(first.slice(1, -1));
	return unquote(first);
}

/** The note's properties and the text after the frontmatter. */
export function readProps(text: string): { props: Map<string, PropValue>; body: string } {
	const m = FRONTMATTER.exec(text);
	if (!m) return { props: new Map(), body: text };
	const props = new Map<string, PropValue>();
	for (const e of entries(m[1])) if (e.key) props.set(e.key, valueOf(e));
	return { props, body: text.slice(m[0].length) };
}

/** A value as YAML: quoted when plain YAML would read it differently (links, "key: value", leading symbols). */
function scalar(v: string): string {
	if (v === "" || /^[\s[\]{}>|*&!%@`'"#,?-]|: | #|\s$|^(true|false|null|yes|no|~)$/i.test(v) || /^[\d.:-]+$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return JSON.stringify(v);
	return v;
}

function lines(key: string, value: PropValue): string[] {
	if (!Array.isArray(value)) return [`${key}: ${scalar(value)}`];
	return [`${key}:`, ...value.map((v) => `  - ${scalar(v)}`)];
}

/**
 * Sets properties on a note: a string or list replaces the key's value in place (new keys are
 * added in the order given), and null or an empty list removes it. Other keys are kept as they
 * are. The frontmatter is dropped when no key is left.
 */
export function setProps(text: string, updates: Record<string, PropValue | null>): string {
	const m = FRONTMATTER.exec(text);
	const list = m ? entries(m[1]) : [];
	const body = m ? text.slice(m[0].length) : text;
	for (const [key, value] of Object.entries(updates)) {
		const i = list.findIndex((e) => e.key === key);
		const empty = value === null || (Array.isArray(value) && !value.length);
		if (empty) {
			if (i !== -1) list.splice(i, 1);
			continue;
		}
		const e = { key, lines: lines(key, value) };
		if (i === -1) list.push(e);
		else if (valueOf(list[i]) + "" !== value + "" || Array.isArray(valueOf(list[i])) !== Array.isArray(value)) list[i] = e;
	}
	if (!list.length) return body;
	return `---\n${list.flatMap((e) => e.lines).join("\n")}\n---\n${body}`;
}

/** The note's `tags` with every `prefix` tag replaced by `tags` (the others kept, in order). */
export function withTags(props: Map<string, PropValue>, prefix: string, tags: string[]): string[] {
	const now = props.get("tags");
	const list = Array.isArray(now) ? now : now ? now.split(/[\s,]+/).filter(Boolean) : [];
	return [...list.map((t) => t.replace(/^#/, "")).filter((t) => !t.startsWith(prefix)), ...tags];
}
