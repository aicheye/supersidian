import { EditorState, Range, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/**
 * Hides the plugin's bookkeeping text in the editor: lines that hold only a
 * <!-- supersidian:… --> marker are collapsed entirely (line break included), and ^dl-…
 * block ids at the end of Deadlines.md items are hidden. Reading view already hides both.
 * Nothing is hidden on a line the cursor is on, so the text can still be edited.
 *
 * This is a StateField rather than a ViewPlugin because CodeMirror only accepts
 * decorations that replace line breaks from a state field.
 */
const MARKER_LINE = /^<!-- \/?supersidian:[a-z]+ -->$/;
const BLOCK_ID = /\s\^dl-[a-z0-9]+\s*$/;

function build(state: EditorState): DecorationSet {
	const doc = state.doc;
	const cursorLines = new Set(state.selection.ranges.map((r) => doc.lineAt(r.head).number));
	const out: Range<Decoration>[] = [];
	for (let n = 1; n <= doc.lines; n++) {
		if (cursorLines.has(n)) continue;
		const line = doc.line(n);
		if (MARKER_LINE.test(line.text)) {
			// Take the line break before the marker, so it leaves no empty line behind. Taking the
			// one after it would join the next line onto this one, and a heading there would lose
			// its heading style. On the first line, the break after it is the only one to take.
			const start = n > 1 ? line.from - 1 : line.from;
			const end = n > 1 ? line.to : Math.min(line.to + 1, doc.length);
			if (end > start) out.push(Decoration.replace({}).range(start, end));
			continue;
		}
		const id = BLOCK_ID.exec(line.text);
		if (id) out.push(Decoration.replace({}).range(line.from + id.index, line.to));
	}
	return Decoration.set(out, true);
}

export const hideMarkers = StateField.define<DecorationSet>({
	create: build,
	update(value, tr) {
		return tr.docChanged || tr.selection ? build(tr.state) : value;
	},
	provide: (f) => EditorView.decorations.from(f),
});
