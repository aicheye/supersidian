/** A replacement in the old text: characters [from, to) become `insert`. */
export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

/** Lines of a text, each with its "\n" (the last one may have none). */
function lines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Above this many line pairs in the differing middle, the middle is replaced as one change. */
const MAX_CELLS = 4_000_000;

/**
 * The line-level changes that turn `prev` into `next`, as separate replacements in `prev`'s
 * coordinates, ordered. Lines both texts share stay untouched between changes, so an editor
 * applying them keeps the content in between (a note's page images) in place. Uses the longest
 * common subsequence of the lines that differ.
 */
export function lineChanges(prev: string, next: string): TextChange[] {
	if (prev === next) return [];
	const a = lines(prev);
	const b = lines(next);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const offsets = [0];
	for (const l of a) offsets.push(offsets[offsets.length - 1] + l.length);
	const am = a.slice(start, a.length - end);
	const bm = b.slice(start, b.length - end);
	if (am.length * bm.length > MAX_CELLS) {
		return [{ from: offsets[start], to: offsets[a.length - end], insert: bm.join("") }];
	}
	// lcs[i][j]: length of the longest common subsequence of am[i..] and bm[j..].
	const lcs = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1));
	for (let i = am.length - 1; i >= 0; i--) {
		for (let j = bm.length - 1; j >= 0; j--) {
			lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const changes: TextChange[] = [];
	let i = 0;
	let j = 0;
	let hunk: { ai: number; bj: number } | null = null;
	const close = () => {
		if (!hunk) return;
		changes.push({ from: offsets[start + hunk.ai], to: offsets[start + i], insert: bm.slice(hunk.bj, j).join("") });
		hunk = null;
	};
	while (i < am.length || j < bm.length) {
		if (i < am.length && j < bm.length && am[i] === bm[j]) {
			close();
			i++;
			j++;
			continue;
		}
		hunk ??= { ai: i, bj: j };
		if (j < bm.length && (i >= am.length || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
		else i++;
	}
	close();
	return changes;
}
