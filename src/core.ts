import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { deflateSync } from "zlib";

import { adbList, adbPull, adbPullFrom, adbStat, clockSkewMs } from "./adb";
import {
	RENDER_LAYOUT,
	layoutOf,
	Extras,
	NotebookState,
	noteConcepts,
	pageDate,
	pagePngs,
	VaultIO,
	writeNotebookNotes,
} from "./notes";

export type { NotebookState, VaultIO } from "./notes";

export interface SyncState {
	notebooks: Record<string, NotebookState>;
}

export interface DeviceNotebook {
	/** absolute path: on the tablet when `via` is "adb", on the MTP mount for "mtp", the local copy for "push" */
	file: string;
	/** how the notebook is read: through the adb server, the desktop's MTP mount, or a copy the tablet sent over HTTPS (push.ts) */
	via: "adb" | "mtp" | "push";
	/** path relative to the device Note folder, e.g. 2a/cs241e/Lectures.note */
	rel: string;
	course: string;
	name: string;
	mtimeMs: number;
	size: number;
}

export interface NotebookResult {
	rel: string;
	rendered: number;
	notesUpdated: string[];
	/** page dates with no matching dated note */
	unmatchedDates: string[];
	/** the section's index note, when it changed */
	indexUpdated: string | null;
}

/** The notebook changed while it was being copied; the next poll retries it. */
export class NotebookBusy extends Error {}

const MTP_PREFIX = "mtp:host=Supernote";

/** Returns the device's Note folder if a Supernote is mounted over MTP via gvfs. */
export async function findDeviceNoteRoot(): Promise<string | null> {
	const gvfs = `/run/user/${os.userInfo().uid}/gvfs`;
	let entries: string[];
	try {
		entries = await fs.readdir(gvfs);
	} catch {
		return null;
	}
	for (const e of entries) {
		if (!e.startsWith(MTP_PREFIX)) continue;
		const root = path.join(gvfs, e, "Internal shared storage", "Note");
		try {
			await fs.access(root);
			return root;
		} catch {
			/* storage not exposed yet, e.g. tablet locked */
		}
	}
	return null;
}

/** Lists <term>/<course>/<name>.note files under the device Note folder. */
export async function listDeviceNotebooks(noteRoot: string): Promise<DeviceNotebook[]> {
	const out: DeviceNotebook[] = [];
	const dirs = async (p: string) =>
		(await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	for (const term of await dirs(noteRoot)) {
		for (const course of await dirs(path.join(noteRoot, term))) {
			const courseDir = path.join(noteRoot, term, course);
			for (const f of await fs.readdir(courseDir)) {
				if (!f.endsWith(".note")) continue;
				const file = path.join(courseDir, f);
				const st = await fs.stat(file);
				out.push({
					file,
					via: "mtp",
					rel: `${term}/${course}/${f}`,
					course,
					name: f.slice(0, -".note".length),
					mtimeMs: st.mtimeMs,
					size: st.size,
				});
			}
		}
	}
	return out;
}

/**
 * Creates <TERM>/<COURSE>/ with a course page for a device folder such as 2b/cs341 that has no
 * vault folder yet, e.g. at the start of a new term. Only term-like folders (digit + A or B)
 * count; anything else on the tablet is left out. Returns null for those.
 */
export async function createCourse(vault: VaultIO, term: string, course: string): Promise<string | null> {
	if (!/^\d[ab]$/i.test(term) || !/^[a-z]+\d+[a-z]?$/i.test(course)) return null;
	const T = term.toUpperCase();
	const C = course.toUpperCase();
	const folder = `${T}/${C}`;
	if (!(await vault.exists(T))) await vault.mkdir(T);
	if (!(await vault.exists(folder))) await vault.mkdir(folder);
	const page = `${folder}/${C}.md`;
	if (!(await vault.exists(page))) {
		// Title like "CS 341": the code with a space before the number, as on the course calendar.
		await vault.write(page, `# ${C.replace(/^([A-Z]+)(\d)/, "$1 $2")}\n\nCreated by Supersidian when notebooks for this course appeared on the tablet. Each tablet notebook becomes a section folder here (Lectures, Tutorials, ...) with one note per day and an index note.\n`);
	}
	return folder;
}

/** Where notebooks live on the tablet, as adb sees it. */
const ADB_NOTE_ROOT = "/sdcard/Note";

/** Lists <term>/<course>/<name>.note files on the tablet through adb; null when no tablet is attached. */
export async function listAdbNotebooks(): Promise<DeviceNotebook[] | null> {
	let files;
	try {
		files = await adbList(ADB_NOTE_ROOT, "*.note");
	} catch {
		return null;
	}
	const out: DeviceNotebook[] = [];
	for (const f of files) {
		const rel = f.path.slice(ADB_NOTE_ROOT.length + 1);
		const parts = rel.split("/");
		if (parts.length !== 3) continue;
		out.push({ file: f.path, via: "adb", rel, course: parts[1], name: parts[2].slice(0, -".note".length), mtimeMs: f.mtimeMs, size: f.size });
	}
	return out;
}

/**
 * Vault folder for a device course folder: <TERM>/<COURSE>, e.g. 2a/cs241e -> 2A/CS241E,
 * matched ignoring case. Null when the vault has no such course.
 */
export async function courseFolder(vault: VaultIO, term: string, course: string): Promise<string | null> {
	const strip = (p: string) => p.replace(/^\/+/, "");
	const t = (await vault.list("")).folders.map(strip).find((f) => f.toLowerCase() === term.toLowerCase());
	if (!t) return null;
	const c = (await vault.list(t)).folders.map(strip).find((f) => f.split("/").pop()!.toLowerCase() === course.toLowerCase());
	return c ?? null;
}

interface RenderedPage {
	index: number;
	pageid: string;
	hash: string;
	png: string | null;
	blank: boolean | null;
	top: number | null;
	width: number | null;
	/** visible strokes of a rendered page, from render.py's page_strokes */
	strokes?: PageStroke[] | null;
}

/** A visible stroke: pen width in the tablet's units and its points as [x0, y0, x1, y1, ...] in page pixels. */
export interface PageStroke {
	w: number;
	p: number[];
}

/** Visible strokes of one page, read from a local notebook copy with render.py --strokes. */
export function readPageStrokes(python: string, script: string, note: string, pageid: string): Promise<PageStroke[]> {
	return new Promise((resolve, reject) => {
		const proc = spawn(python, [script, "--strokes", note, pageid]);
		let stdout = "";
		proc.stdout.on("data", (d) => (stdout += d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) return reject(new Error(`render.py --strokes exited ${code}`));
			try {
				resolve(JSON.parse(stdout).strokes);
			} catch (e) {
				reject(e);
			}
		});
	});
}

function runRenderer(python: string, script: string, note: string, outDir: string, known: Record<string, string>) {
	return new Promise<RenderedPage[]>((resolve, reject) => {
		const proc = spawn(python, [script, note, outDir]);
		// Stops a renderer that hangs; the sync fails and is retried on the next poll.
		const timer = setTimeout(() => proc.kill("SIGKILL"), 150_000);
		proc.on("close", () => clearTimeout(timer));
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) return reject(new Error(`render.py exited ${code}: ${stderr.trim().split("\n").pop()}`));
			try {
				resolve(JSON.parse(stdout).pages);
			} catch (e) {
				reject(new Error(`render.py returned invalid JSON: ${e}`));
			}
		});
		proc.stdin.end(JSON.stringify(known));
	});
}

/** Images this plugin wrote: <YYYYMMDD-HHMMSS>.png, and <YYYYMMDD-HHMMSS>-<hash8>.png from commit 87bc5de. */
const MANAGED_PNG = /\/\d{8}-\d{6}(-\d{6}|-[0-9a-f]{8})?\.png$/;

export interface SyncOptions {
	python: string;
	renderScript: string;
	/** re-render every page even if its hash is unchanged */
	force?: boolean;
	/** transcripts, topics and concepts per page */
	extras?: Extras;
	/** concept tags per dated note, for the related-lectures line */
	concepts?: Map<string, Set<string>>;
	/** pages that got live ink after a save at `savedAt` (laptop clock); kept embedded even if the save has them blank */
	inked?: (savedAt: number) => Record<string, boolean>;
	/** receives the visible strokes of each re-rendered page */
	strokes?: (pageid: string, strokes: PageStroke[]) => void;
	/**
	 * Placeholder pages (hash "") for pages the tablet has drawn on but not saved yet, given the
	 * number of pages in the synced file. They are kept after the file's pages, blank.
	 */
	placeholders?: (count: number) => { pageid: string; width: number }[];
}

export { noteConcepts, writeNotebookNotes };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	let crc = 0xffffffff;
	for (const b of body) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
	return out;
}

/** A fully transparent gray+alpha PNG, the image render.py makes for a page with no ink. */
export function blankPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 4, 0, 0, 0], 8);
	// Each row: filter byte 0, then 2 zero bytes per pixel.
	const rows = Buffer.alloc((width * 2 + 1) * height);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** Local copies of tablet notebooks from their last sync, for pulling only what was appended. */
const PULL_CACHE = path.join(os.tmpdir(), "supersidian-pulls");
/** Bytes before the old end that are pulled again and compared, to detect a rewritten file. */
const OVERLAP = 64 * 1024;

/** The local copy of a tablet notebook, shared by adb pulls and HTTPS pushes. */
export function cachePath(rel: string): string {
	return path.join(PULL_CACHE, rel.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Copies a tablet notebook to `local`. A save only appends to a .note file (the tablet
 * rewrites it only when it compacts the file), so when the last copy is a prefix of the file,
 * only the bytes after it are pulled: about 0.2 s instead of 1 s for a 20 MB notebook. The
 * last OVERLAP bytes of the old copy are pulled again and compared to confirm it is a prefix.
 */
async function pullNotebook(nb: DeviceNotebook, local: string): Promise<void> {
	await fs.mkdir(PULL_CACHE, { recursive: true });
	const cached = cachePath(nb.rel);
	const old = await fs.stat(cached).catch(() => null);
	if (old && old.size > OVERLAP && nb.size > old.size) {
		const from = old.size - OVERLAP;
		const tail = `${local}.tail`;
		await adbPullFrom(nb.file, from, tail);
		const fresh = await fs.readFile(tail);
		const handle = await fs.open(cached, "r");
		const mine = Buffer.alloc(OVERLAP);
		try {
			await handle.read(mine, 0, OVERLAP, from);
		} finally {
			await handle.close();
		}
		if (fresh.length === nb.size - from && fresh.subarray(0, OVERLAP).equals(mine)) {
			await fs.copyFile(cached, local);
			await fs.appendFile(local, fresh.subarray(OVERLAP));
			await fs.rm(tail, { force: true });
			await fs.copyFile(local, cached);
			return;
		}
		await fs.rm(tail, { force: true });
	}
	await adbPull(nb.file, local);
	await fs.copyFile(local, cached);
}

/**
 * Syncs one notebook: renders changed pages into <Course>/assets/notes/<name>/,
 * then rewrites the supersidian block in each dated note under <Course>/<name>/.
 */
export async function syncNotebook(
	vault: VaultIO,
	nb: DeviceNotebook,
	prev: NotebookState | undefined,
	opts: SyncOptions,
): Promise<{ state: NotebookState; result: NotebookResult } | null> {
	// A current course is a top-level folder; a past term's course lives under Archive/<term>/<course>.
	const term = nb.rel.split("/")[0];
	const course = (await courseFolder(vault, term, nb.course)) ?? (await createCourse(vault, term, nb.course));
	if (!course) return null;
	// Note and folder names use underscores where the device name has spaces.
	const name = nb.name.replace(/ /g, "_");

	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "supersidian-"));
	try {
		// Copy first so the renderer never reads a file the tablet is mid-way through saving.
		const local = path.join(staging, "notebook.note");
		if (nb.via === "adb") await pullNotebook(nb, local);
		else await fs.copyFile(nb.file, local);
		const after =
			nb.via === "adb"
				? await adbStat(nb.file)
				: nb.via === "push"
					? // A pushed copy has no tablet mtime; a new push while copying shows as a size change.
						await fs.stat(nb.file).then((s) => ({ mtimeMs: nb.mtimeMs, size: s.size, savedAt: nb.mtimeMs - clockSkewMs }))
					: await fs.stat(nb.file).then((s) => ({ ...s, savedAt: s.mtimeMs }));
		if (!after || Math.floor(after.mtimeMs / 1000) !== Math.floor(nb.mtimeMs / 1000) || after.size !== nb.size) throw new NotebookBusy(nb.rel);
		const savedAt = after.savedAt;
		const inked = opts.inked?.(savedAt) ?? {};
		const assetDir = layoutOf({ course, name } as NotebookState).assetDir;
		if (!(await vault.exists(assetDir))) await vault.mkdir(assetDir);
		const existing = new Set((await vault.list(assetDir)).files.map((f) => f.replace(/^\/+/, "")));

		// Pages whose PNG was deleted from the vault are dropped from `known` so they render again.
		const known: Record<string, string> = {};
		if (!opts.force) {
			const before = pagePngs(assetDir, Object.keys(prev?.pages ?? {}));
			for (const [id, hash] of Object.entries(prev?.pages ?? {})) {
				// Pages rendered before blank/geometry were recorded render once more to measure them.
				if (existing.has(before.get(id)!) && prev?.geometry?.[id] && prev.renderLayout === RENDER_LAYOUT) known[id] = hash;
			}
		}
		const pages = await runRenderer(opts.python, opts.renderScript, local, path.join(staging, "pages"), known);

		const wanted = new Set<string>();
		let rendered = 0;
		const pngs = pagePngs(assetDir, pages.map((p) => p.pageid));
		// A page whose file name changed (it now shares a second with another page) has no image yet: render it again.
		const missing = new Set(pages.filter((p) => !p.png && !existing.has(pngs.get(p.pageid)!)).map((p) => p.pageid));
		if (missing.size) {
			const again = await runRenderer(
				opts.python,
				opts.renderScript,
				local,
				path.join(staging, "missing"),
				Object.fromEntries(Object.entries(known).filter(([id]) => !missing.has(id))),
			);
			for (const r of again) {
				const p = pages.find((x) => x.pageid === r.pageid);
				if (p && missing.has(r.pageid)) Object.assign(p, { png: r.png, blank: r.blank, top: r.top, width: r.width, strokes: r.strokes });
			}
		}
		for (const p of pages) if (p.strokes) opts.strokes?.(p.pageid, p.strokes);
		const later = opts.placeholders?.(pages.length) ?? [];
		for (const png of pagePngs(assetDir, later.map((p) => p.pageid)).values()) wanted.add(png);
		for (const p of pages) {
			const target = pngs.get(p.pageid)!;
			wanted.add(target);
			if (p.png) {
				const buf = await fs.readFile(p.png);
				await vault.writeBinary(target, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), savedAt);
				rendered++;
			}
		}

		const now = Date.now();
		const state: NotebookState = {
			course,
			name,
			mtimeMs: nb.mtimeMs,
			size: nb.size,
			pages: Object.fromEntries([...pages.map((p) => [p.pageid, p.hash]), ...later.map((p) => [p.pageid, ""])]),
			// A page seen for the first time in an initial sync counts as long unchanged.
			changedAt: Object.fromEntries(
				pages.map((p) => {
					const before = prev?.pages[p.pageid];
					const at = before === p.hash ? prev?.changedAt?.[p.pageid] ?? 0 : prev ? now : 0;
					return [p.pageid, at];
				}),
			),
			notes: prev?.notes ?? [],
			renderLayout: RENDER_LAYOUT,
			savedAt,
			...(Object.keys(inked).length ? { inked } : {}),
			// Unrendered pages keep what the previous sync measured.
			blank: Object.fromEntries(pages.map((p) => [p.pageid, p.blank ?? prev?.blank?.[p.pageid] ?? false])),
			geometry: Object.fromEntries(
				pages.flatMap((p) => {
					const g = p.top !== null && p.width !== null ? ([p.top, p.width] as [number, number]) : prev?.geometry?.[p.pageid];
					return g ? [[p.pageid, g]] : [];
				}),
			),
		};
		for (const p of later) {
			state.changedAt[p.pageid] = prev?.changedAt?.[p.pageid] ?? now;
			state.blank![p.pageid] = true;
			state.geometry![p.pageid] = [0, p.width];
		}
		const out = await writeNotebookNotes(vault, state, opts.extras ?? {}, opts.concepts ?? new Map());
		state.notes = out.holding;

		// Remove images of edited or deleted pages only after the notes stop embedding them.
		for (const f of existing) {
			if (MANAGED_PNG.test(f) && !wanted.has(f)) await vault.remove(f);
		}

		return {
			state,
			result: {
				rel: nb.rel,
				rendered,
				notesUpdated: out.notesUpdated,
				unmatchedDates: out.unmatchedDates,
				indexUpdated: out.indexUpdated,
			},
		};
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

export function changed(nb: DeviceNotebook, prev: NotebookState | undefined): boolean {
	return !prev || prev.mtimeMs !== nb.mtimeMs || prev.size !== nb.size;
}
