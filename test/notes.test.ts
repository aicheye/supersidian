import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBlock, applyCourses, applySections, applyTopics, BEGIN, blockBody, datedNotePath, END, escapeTags, newDatedNote, normalizeTranscript, pagePngs, userText } from "../src/notes";
import { checkedInHome, classStart, formatDeadlines, homeBlock, parseDeadlines } from "../src/school";
import { repairJson } from "../src/transcribe";
import { outlineWidth } from "../src/live";
import { shellArg } from "../src/adb";
import { lineChanges } from "../src/diff";

const note = `# CS241E — Lecture 5 (Thu Sep 24, 2026)
**Course:** x · 11:30 AM–12:50 PM, MC 2066

## Topics

## Notes

## Questions / follow-ups
- [ ]
`;
const page = (id: string) => ({ pageid: id, png: `2A/CS241E/assets/notes/Lectures/${id.slice(1, 9)}-${id.slice(9, 15)}.png` });

test("a new block goes directly under the heading before Questions, keeping one empty line in empty sections", () => {
	const out = applyBlock(note, [page("P20260924114821aa")], []);
	assert.match(out, /## Notes\n<!-- supersidian:begin -->\n!\[\[2A\/CS241E\/assets\/notes\/Lectures\/20260924-114821\.png\]\]\n<!-- supersidian:end -->\n\n## Questions/);
	assert.match(out, /## Topics\n\n## Notes/);
});

test("text written under a page image survives a rewrite", () => {
	const first = applyBlock(note, [page("P20260924114821aa"), page("P20260924120933bb")], []);
	const edited = first.replace("20260924-114821.png]]\n", "20260924-114821.png]]\nmy link [x](https://example.com)\n");
	const again = applyBlock(edited, [page("P20260924114821aa"), page("P20260924120933bb")], []);
	assert.match(again, /20260924-114821\.png\]\]\n\nmy link \[x\]\(https:\/\/example\.com\)\n\n!\[\[.*20260924-120933\.png\]\]/);
	assert.equal(applyBlock(again, [page("P20260924114821aa"), page("P20260924120933bb")], []), again);
});

test("text under a deleted page moves to the end instead of being lost", () => {
	const first = applyBlock(note, [page("P20260924114821aa"), page("P20260924120933bb")], []);
	const edited = first.replace("20260924-120933.png]]", "20260924-120933.png]]\nkeep me");
	const out = applyBlock(edited, [page("P20260924114821aa")], []);
	assert.match(out, /keep me\n<!-- supersidian:end -->/);
});

test("removing every page leaves an empty section shape", () => {
	const first = applyBlock(note, [page("P20260924114821aa")], []);
	assert.equal(applyBlock(first, [], []).includes(BEGIN), false);
	assert.match(applyBlock(first, [], []), /## Notes\n\n## Questions/);
});

test("transcripts escape tilde runs and split one-line display math", () => {
	const body = blockBody([{ ...page("P20260924114821aa"), extra: { hash: "h", transcript: "  ~~~~ (spring)\n$$x = 1$$", topics: [], concepts: [] } }], null, []);
	assert.match(body, />   ​~~~~ \(spring\)/);
	assert.match(body, /> \$\$\n> x = 1\n> \$\$/);
});

test("user text keys ignore managed callouts", () => {
	const body = `![[a/20260924-114821.png]]\n> [!transcript]- Transcript\n> hi\n\nmine`;
	assert.deepEqual([...userText(body)], [["20260924-114821", ["mine"]]]);
});

test("generated topics fill an empty Topics section but not a hand-written one", () => {
	assert.match(applyTopics(note, ["Stacks"]), /## Topics\n<!-- supersidian:topics -->\n- Stacks\n<!-- \/supersidian:topics -->/);
	const hand = note.replace("## Topics\n", "## Topics\n- mine\n");
	assert.equal(applyTopics(hand, ["Stacks"]), hand);
});

test("pages created in the same second get distinct image names", () => {
	const names = pagePngs("d", ["P20250905170629952119aa", "P20250905170629933818bb", "P20250905170630000000cc"]);
	assert.deepEqual([...names.values()], ["d/20250905-170629-952119.png", "d/20250905-170629-933818.png", "d/20250905-170630.png"]);
});

test("deadlines round-trip, convert emoji statuses, and keep ids", () => {
	const text = "# Deadlines\n\n- ✅ **2026-09-15** — A0 due\n  MarkUs.\n- ▫️ **2026-10-02** — A3 due\n";
	const f = parseDeadlines(text);
	assert.equal(f.dirty, true);
	assert.deepEqual(f.items.map((d) => [d.done, d.date]), [[true, "2026-09-15"], [false, "2026-10-02"]]);
	const out = formatDeadlines(f);
	const again = parseDeadlines(out);
	assert.equal(again.dirty, false);
	assert.equal(formatDeadlines(again), out);
});

test("checking a task in Home maps to its deadline id", () => {
	const items = parseDeadlines("# D\n\n- [ ] **2026-09-28** — Lab ^dl-abc123\n").items;
	const block = homeBlock({ items, today: "2026-09-27", lectures: [], recent: [], followUps: [], status: null });
	const home = `${BEGIN}\n${block.replace("- [ ]", "- [x]")}\n${END}`;
	assert.deepEqual(checkedInHome(home), ["dl-abc123"]);
});

test("deadlines read both item forms, and are written with a colon", () => {
	const text = "# D\n\n- [ ] **2026-09-28**: Lab ^dl-abc123\n- [x] **2026-09-20** — Quiz ^dl-def456\n";
	const { items } = parseDeadlines(text);
	assert.deepEqual(items.map((d) => [d.date, d.title, d.done]), [["2026-09-28", "Lab", false], ["2026-09-20", "Quiz", true]]);
});

test("model JSON with raw control characters inside strings is repaired", () => {
	assert.deepEqual(JSON.parse(repairJson('[{"t": "a\nb\tc"}]')), [{ t: "a\nb\tc" }]);
});

test("stroke width is estimated from its outline, with loop holes subtracted", () => {
	const band = { contours: [[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 3 }, { x: 0, y: 3 }]] };
	assert.ok(Math.abs(outlineWidth(band)! - 3) < 0.1);
	// A ring 4 wide around a 40x40 hole, outer clockwise and inner counter-clockwise.
	const outer = [{ x: 0, y: 0 }, { x: 48, y: 0 }, { x: 48, y: 48 }, { x: 0, y: 48 }];
	const inner = [{ x: 4, y: 4 }, { x: 4, y: 44 }, { x: 44, y: 44 }, { x: 44, y: 4 }];
	assert.ok(Math.abs(outlineWidth({ contours: [outer, inner] })! - 4) < 0.5);
});

test("shell arguments are escaped with backslashes, never quotes", () => {
	assert.equal(shellArg("/sdcard/Note/1a/math117/H1 High School Review.note"), "/sdcard/Note/1a/math117/H1\\ High\\ School\\ Review.note");
	assert.equal(shellArg("*.note"), "\\*.note");
});

test("a new term's course folder is created with a course page; other device folders are ignored", async () => {
	const { promises: fs } = await import("fs");
	const os = await import("os");
	const path = await import("path");
	const { createCourse } = await import("../src/core");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "supersidian-"));
	const abs = (p: string) => path.join(root, p);
	const vault = {
		exists: (p: string) => fs.access(abs(p)).then(() => true, () => false),
		read: (p: string) => fs.readFile(abs(p), "utf8"),
		write: (p: string, d: string) => fs.writeFile(abs(p), d),
		writeBinary: async () => {},
		mkdir: (p: string) => fs.mkdir(abs(p), { recursive: true }).then(() => undefined),
		remove: async () => {},
		list: async () => ({ files: [], folders: [] }),
	};
	assert.equal(await createCourse(vault, "2b", "cs341"), "2B/CS341");
	assert.match(await fs.readFile(abs("2B/CS341/CS341.md"), "utf8"), /^# CS 341\n/);
	assert.equal(await createCourse(vault, "random", "screensaver"), null);
	assert.equal(await createCourse(vault, "2b", "moss stuff"), null);
});

test("transcript code fences move to the left margin, dedented, and unclosed ones are closed", async () => {
	const { normalizeTranscript } = await import("../src/notes");
	assert.deepEqual(
		normalizeTranscript(["- item", "- ```text", "  a = 1", "    b", "  ```", "after"]),
		["- item", "```text", "a = 1", "  b", "```", "after"],
	);
	assert.deepEqual(normalizeTranscript(["```", "$$x$$", "~~~~ (spring)"]), ["```", "$$x$$", "​~~~~ (spring)", "```"]);
	assert.deepEqual(normalizeTranscript(["$$x = 1$$"]), ["$$", "x = 1", "$$"]);
	assert.deepEqual(normalizeTranscript(["use ```inline``` here"]), ["use ```inline``` here"]);
});

test("a concept two notes mention is a tag in both; one only one note has is text", async () => {
	const { footerLines } = await import("../src/notes");
	const concepts = new Map<string, Set<string>>([
		["a.md", new Set(["#concept/shared", "#concept/only-a"])],
		["b.md", new Set(["#concept/shared"])],
	]);
	assert.deepEqual(footerLines("a.md", concepts), ["Concepts: #concept/shared", "Other concepts: only a"]);
	assert.deepEqual(footerLines("b.md", concepts), ["Concepts: #concept/shared"]);
});

test("a course page lists its sections, lectures first, and the list is replaced in place", () => {
	const page = "# CS 241E\n\n- **Instructor:** X\n\n## Assessments\n| a |\n";
	const once = applySections(page, [
		{ folder: "2A/CS241E/Tutorials", notes: 12 },
		{ folder: "2A/CS241E/Lectures", notes: 24 },
	]);
	assert.match(once, /- \*\*Instructor:\*\* X\n\n## Sections\n<!-- supersidian:sections -->\n- \[\[2A\/CS241E\/Lectures\/Lectures\|Lectures\]\] \(24 notes\)\n- \[\[2A\/CS241E\/Tutorials\/Tutorials\|Tutorials\]\] \(12 notes\)\n<!-- \/supersidian:sections -->\n\n## Assessments/);
	const twice = applySections(once, [{ folder: "2A/CS241E/Lectures", notes: 1 }]);
	assert.equal(twice.match(/## Sections/g)?.length, 1);
	assert.match(twice, /Lectures\]\] \(1 note\)\n<!--/);
});

test("a day with pages and no note gets one in the notebook's section folder", () => {
	assert.equal(datedNotePath("1A/MATH115/Lectures", "2025-09-03"), "1A/MATH115/Lectures/LEC-2025-09-03.md");
	assert.equal(datedNotePath("1A/MATH117/Psets", "2025-09-10"), "1A/MATH117/Psets/Psets-2025-09-10.md");
	assert.match(newDatedNote("1A/MATH115/Lectures", "2025-09-03"), /^# Wed Sep 03, 2025\n\*\*Course:\*\* \[\[1A\/MATH115\/MATH115\|MATH115\]\] · \[\[1A\/MATH115\/Lectures\/Lectures\|Lectures\]\]\n\n## Topics\n\n## Notes\n$/);
});

test("a # that would start a tag is escaped, except in headings, code and math", () => {
	assert.equal(escapeTags("set of all real #s"), "set of all real \\#s");
	assert.equal(escapeTags("#include <stdio.h>"), "\\#include <stdio.h>");
	assert.equal(escapeTags("### Vectors"), "### Vectors");
	assert.equal(escapeTags("by SRT #2, # of free params"), "by SRT #2, # of free params");
	assert.equal(escapeTags("use `#define X` and $a\\#b$ here"), "use `#define X` and $a\\#b$ here");
	assert.equal(escapeTags("already \\#s"), "already \\#s");
	assert.deepEqual(normalizeTranscript(["$$", "x #y", "$$", "#s"]), ["$$", "x #y", "$$", "\\#s"]);
});

test("concept tags in the footer callout stay tags", () => {
	const body = blockBody([page("P20260924114821aa")], null, ["Concepts: #concept/stack #concept/heap"]);
	assert.match(body, /> Concepts: #concept\/stack #concept\/heap/);
});

test("class start times read AM/PM from the end time when the start has none", () => {
	assert.equal(classStart("**Course:** x · 1:30–2:20 PM, EIT 1015"), 13 * 60 + 30);
	assert.equal(classStart("**Course:** x · 11:30 AM–12:50 PM, MC 2066"), 11 * 60 + 30);
	assert.equal(classStart("**Course:** x · 11:30–12:20 PM, MC 2066"), 11 * 60 + 30);
	assert.equal(classStart("**Course:** x · 8:30–11:20 AM, E2 2356"), 8 * 60 + 30);
	assert.equal(classStart("**Course:** [[a|b]] · [[c|Lectures]]"), null);
});

test("a term page's hand-written course list is replaced by the generated one", () => {
	const page = "# 1A\n\nNotes from 1A.\n\n## Courses\n- [[1A/MATH115/MATH115|MATH115]]\n";
	const out = applyCourses(page, [
		{ page: "1A/MATH115/MATH115.md", title: "MATH115", sections: [{ folder: "1A/MATH115/Homework", notes: 14 }, { folder: "1A/MATH115/Lectures", notes: 35 }] },
	]);
	assert.equal(
		out,
		"# 1A\n\nNotes from 1A.\n\n## Courses\n<!-- supersidian:courses -->\n- [[1A/MATH115/MATH115|MATH115]]: [[1A/MATH115/Lectures/Lectures|Lectures]] (35) · [[1A/MATH115/Homework/Homework|Homework]] (14)\n<!-- /supersidian:courses -->\n",
	);
	assert.equal(applyCourses(out, []).match(/## Courses/g)?.length, 1);
});

test("an edit at the top and one lower down stay two changes, leaving the lines between untouched", () => {
	const apply = (text: string, changes: { from: number; to: number; insert: string }[]) =>
		[...changes].reverse().reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);
	const prev = "# T\n## Topics\n- a\n- b\n## Notes\n![[p1.png]]\n> t1\n![[p2.png]]\n> t2\nend";
	const next = "# T\n## Topics\n- a\n## Notes\n![[p1.png]]\n> t1\n![[p2.png]]\nend";
	const changes = lineChanges(prev, next);
	assert.equal(apply(prev, changes), next);
	assert.equal(changes.length, 2);
	assert.ok(changes.every((c) => !prev.slice(c.from, c.to).includes("p1.png")));
	for (const [p, n] of [["", "x"], ["x", ""], ["a\nb", "a\nb\n"], ["a\nb\nc", "c\nb\na"], ["same", "same"]]) assert.equal(apply(p, lineChanges(p, n)), n);
});
