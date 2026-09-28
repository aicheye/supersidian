import * as net from "net";
import { adbFrame, transportRequest } from "./adb";

/**
 * Real-time ink. The tablet's plugin host may not make plain http:// requests (Android blocks
 * cleartext traffic for it), so the tablet plugin writes messages to the Android log with
 * console.log instead, and this machine streams that log over USB through the adb server:
 *
 * - "pen": pen positions while a stroke is being drawn, in tablet screen pixels, drawn as a
 *   growing line;
 * - "ink": each finished stroke's outline in page pixels, which replaces that line.
 *
 * Log lines are limited to about 4 KB, so each message is sent as numbered chunks:
 * "SSD1 <message id> <chunk index> <chunk count> <kind> <JSON piece>".
 *
 * Strokes are drawn on a layer fixed over the window and positioned over the page image, not
 * inside the editor, since changing the editor's DOM makes it redraw and lose its scroll.
 */

export interface Point {
	x: number;
	y: number;
}

/** Pen type of a lasso loop: the tablet reports it as a stroke (and keeps it in the file's TOTALPATH). */
export const LASSO_PEN = 4;

/** One stroke as its outline polygons, in the page's pixel coordinates. */
export interface LiveStroke {
	contours: Point[][];
	/** 10 fineliner, 16 pressure pen, 11 marker, 15 calligraphy */
	penType?: number;
	/** gray level: 0 black, 157 dark gray, 201 light gray, 254 white */
	penColor?: number;
}

/**
 * Page pixels per unit of the tablet's pen width setting. Measured from finished fineliner
 * strokes at width 400 (outline widths 3.8 to 4.0 px, 2026-09-27).
 */
export const PX_PER_PEN_UNIT = 0.0098;

/** The current pen when a stroke starts; width is in the tablet's units (minimum 100). */
export interface PenInfo {
	type: number;
	color: number;
	width: number;
}

const MARKER = 11;

/**
 * Fill or stroke color and opacity for a pen color, matching render.py, which turns darkness
 * into opacity over the theme's text color (rendered pages show light gray, 201, at alpha 54,
 * i.e. (255 - 201) / 255, markers included). White ink covers what is under it, so it uses
 * the background color.
 */
export function inkPaint(color = 0): { paint: string; opacity: number } {
	if (color >= 250) return { paint: "var(--background-primary)", opacity: 1 };
	return { paint: "var(--text-normal)", opacity: (255 - color) / 255 };
}

/**
 * Average width of a stroke from its outline: for a band of width w and length L, the area is
 * about w * L and the perimeter about 2 * L, so w is about 2 * area / perimeter. Areas are
 * signed, so the hole inside a loop (an "o") is subtracted rather than added.
 */
export function outlineWidth(stroke: LiveStroke): number | null {
	let area = 0;
	let perimeter = 0;
	for (const c of stroke.contours) {
		if (c.length < 3) continue;
		let a = 0;
		for (let i = 0; i < c.length; i++) {
			const p = c[i];
			const q = c[(i + 1) % c.length];
			a += p.x * q.y - q.x * p.y;
			perimeter += Math.hypot(q.x - p.x, q.y - p.y);
		}
		area += a / 2;
	}
	return perimeter > 0 ? (2 * Math.abs(area)) / perimeter : null;
}

export interface LiveInk {
	/** absolute path of the notebook on the tablet, e.g. /storage/emulated/0/Note/2a/cs241e/Lectures.note */
	file: string;
	/** page index as the tablet reports it */
	page: number;
	/** page size in the same pixel units as the contours */
	width: number;
	height: number;
	strokes: LiveStroke[];
	/** screen-pixel bounding box of the pen samples for these strokes, for calibrating /pen positions */
	screen?: { minX: number; minY: number; maxX: number; maxY: number } | null;
	/** id of the last /pen stroke these strokes finish */
	penStroke?: number;
}

export interface LivePen {
	/** increases with each stroke */
	stroke: number;
	/** pen positions in tablet screen pixels since the last post */
	points: Point[];
	/** the pen has lifted */
	end: boolean;
	/** sent with a stroke's first post: the notebook, page, page size, on-screen page size and pen */
	file?: string;
	page?: number;
	width?: number;
	display?: { width: number; height: number };
	pen?: PenInfo;
}

/** The tablet rendered the current page's main layer to `path` after a pen lift. */
export interface LivePreview {
	file: string;
	page: number;
	path?: string;
	seq: number;
	ok: boolean;
	/** how long the render took on the tablet */
	ms?: number;
	error?: string | null;
}

/** An eraser motion: the pen motion `stroke` erased instead of drawing (tablet 0.0.38 on). */
export interface LiveErase {
	stroke: number;
}

export interface LiveHandlers {
	ink(ink: LiveInk): void;
	erase(erase: LiveErase): void;
	pen(pen: LivePen): void;
	preview(preview: LivePreview): void;
	error(e: Error): void;
}

const PREFIX = "SSD1 ";

/** Ids of recently delivered messages: the tablet may send one over both logcat and HTTPS. */
const delivered = new Set<string>();

/** Hands one message to its handler unless a message with the same id was already delivered. */
export function deliverLive(h: LiveHandlers, id: string, kind: string, msg: unknown) {
	if (delivered.has(id)) return;
	delivered.add(id);
	if (delivered.size > 2000) delivered.delete(delivered.values().next().value!);
	if (kind === "ink") h.ink(msg as LiveInk);
	else if (kind === "preview") h.preview(msg as LivePreview);
	else if (kind === "pen") h.pen(msg as LivePen);
	else if (kind === "erase") h.erase(msg as LiveErase);
}

/**
 * Streams the tablet's log through the adb server (which runs on the host, since the Flatpak
 * sandbox cannot reach USB devices) and hands complete messages to the handlers. Reconnects
 * every 2 s while no tablet is attached. Returns a function that stops it.
 */
export function startLogStream(h: LiveHandlers): () => void {
	let stopped = false;
	let socket: net.Socket | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let streamingVia = "";
	const parts = new Map<string, { kind: string; chunks: string[]; got: number }>();

	const handleLine = (line: string) => {
		const at = line.indexOf(PREFIX);
		if (at === -1) return;
		const m = /^(\S+) (\d+) (\d+) (ink|pen|preview|erase) (.*)$/.exec(line.slice(at + PREFIX.length));
		if (!m) return;
		const [, id, i, n, kind, piece] = m;
		const total = Number(n);
		const entry = parts.get(id) ?? { kind, chunks: new Array<string>(total), got: 0 };
		if (entry.chunks[Number(i)] === undefined) entry.got++;
		entry.chunks[Number(i)] = piece;
		parts.set(id, entry);
		if (entry.got < total) return;
		parts.delete(id);
		try {
			deliverLive(h, id, kind, JSON.parse(entry.chunks.join("")));
		} catch (e) {
			h.error(e instanceof Error ? e : new Error(String(e)));
		}
		// Drop partial messages that will never complete, e.g. from before a reconnect.
		if (parts.size > 50) parts.clear();
	};

	const connect = async () => {
		if (stopped) return;
		const via = await transportRequest();
		streamingVia = via;
		if (stopped) return;
		let buffer = "";
		// 0: waiting for the transport OKAY, 1: waiting for the logcat OKAY, 2: streaming.
		let stage = 0;
		socket = net.connect(5037, "127.0.0.1");
		socket.on("connect", () => socket!.write(adbFrame(via)));
		socket.on("data", (d) => {
			buffer += d.toString("utf8");
			while (stage < 2) {
				if (buffer.length < 4) return;
				if (!buffer.startsWith("OKAY")) {
					socket?.destroy();
					return;
				}
				buffer = buffer.slice(4);
				stage++;
				// Sent only after the transport is accepted (see run() in adb.ts). -T 1 starts at
				// the newest line, so old messages are not replayed.
				if (stage === 1) socket!.write(adbFrame("shell:logcat -v raw -T 1 ReactNativeJS:I \\*:S"));
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) handleLine(l.replace(/\r$/, ""));
		});
		const again = () => {
			socket = null;
			if (!stopped && !retry) retry = setTimeout(() => ((retry = null), connect()), 2000);
		};
		socket.on("error", again);
		socket.on("close", again);
	};

	connect();
	// Moves the stream to USB when the cable is plugged in while it runs over the network.
	const watch = setInterval(async () => {
		if (socket && streamingVia !== (await transportRequest())) socket.destroy();
	}, 3000);
	return () => {
		clearInterval(watch);
		stopped = true;
		if (retry) clearTimeout(retry);
		socket?.destroy();
	};
}

const SVG = "http://www.w3.org/2000/svg";

/** Whether `q` lies inside `polygon` (closed implicitly), by ray casting. */
export function insidePolygon(q: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (a.y > q.y !== b.y > q.y && q.x < a.x + ((q.y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
	}
	return inside;
}

/**
 * A smooth path through pen samples: quadratic curves with each sample as the control point
 * and the midpoints between samples as the ends, so the line has no corners at the samples.
 */
export function smoothPath(pts: Point[]): string {
	const f = (n: number) => n.toFixed(1);
	if (pts.length < 3) return `M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L")}`;
	let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const mx = (pts[i].x + pts[i + 1].x) / 2;
		const my = (pts[i].y + pts[i + 1].y) / 2;
		d += `Q${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
	}
	const last = pts[pts.length - 1];
	return `${d}L${f(last.x)} ${f(last.y)}`;
}

/** Live strokes over one page image. */
interface Overlay {
	svg: SVGSVGElement;
	/** image file path in the vault, used to find the page's <img> as the editor re-creates it */
	png: string;
	/** first page row in the image, and the image width in page pixels */
	top: number;
	renderWidth: number;
	/** last time its image was on screen */
	seen: number;
}

/**
 * Draws strokes over page images on a layer fixed over the whole window. The layer follows
 * each image as the note scrolls, clipped to the note's scroll area, and never changes the
 * editor's DOM.
 */
export class InkLayer {
	private root: HTMLDivElement;
	private overlays = new Map<string, Overlay>();
	private frame = 0;
	/** stroke id -> polyline being drawn from /pen positions */
	private pending = new Map<
		number,
		{
			overlay: Overlay;
			line: SVGPathElement;
			points: Point[];
			at: number;
			eraser: boolean;
			eraserWidth: number;
			/** shapes covering strokes this motion erases, and live strokes it hid */
			masks: SVGElement[];
			hidden: SVGElement[];
		}
	>();
	/** outline points of each finished live stroke, in image pixels, for erasing */
	private inkPoints = new WeakMap<SVGPathElement, Point[]>();

	constructor() {
		this.root = document.body.createDiv({ cls: "supersidian-live-layer" });
	}

	destroy() {
		cancelAnimationFrame(this.frame);
		this.root.remove();
	}

	private imageFor(png: string): HTMLImageElement | null {
		for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img.supersidian-ink"))) {
			if (img.isConnected && img.naturalWidth && decodeURI(img.src.split("?")[0]).endsWith(`/${png}`)) return img;
		}
		return null;
	}

	private overlay(png: string, top: number, renderWidth: number): Overlay {
		let o = this.overlays.get(png);
		if (!o) {
			const svg = document.createElementNS(SVG, "svg");
			svg.classList.add("supersidian-live");
			this.root.appendChild(svg);
			o = { svg, png, top, renderWidth, seen: Date.now() };
			this.overlays.set(png, o);
		}
		o.top = top;
		o.renderWidth = renderWidth;
		this.schedule();
		return o;
	}

	/** Adds finished strokes (page pixels in the tablet's `inkWidth` space) over a page. */
	addStrokes(png: string, strokes: LiveStroke[], top: number, renderWidth: number, inkWidth: number) {
		const o = this.overlay(png, top, renderWidth);
		const scale = renderWidth / inkWidth;
		for (const s of strokes) {
			const d = s.contours
				.filter((c) => c.length > 2)
				.map((c) => `M${c.map((p) => `${(p.x * scale).toFixed(1)} ${(p.y * scale).toFixed(1)}`).join("L")}Z`)
				.join("");
			if (!d) continue;
			const path = document.createElementNS(SVG, "path");
			path.setAttribute("d", d);
			path.dataset.at = String(Date.now());
			this.inkPoints.set(
				path,
				s.contours.flatMap((c) => c.map((p) => ({ x: p.x * scale, y: p.y * scale }))),
			);
			const { paint, opacity } = inkPaint(s.penColor);
			path.style.fill = paint;
			path.style.fillOpacity = String(opacity);
			o.svg.appendChild(path);
		}
	}

	/**
	 * How new in-progress lines are drawn: as the tool of the last finished motion, since a tool
	 * usually stays selected. "erase" draws eraser paths, "lasso" a thin dashed line. A line that
	 * turns out to be ink is replaced by its outline.
	 */
	mode: "ink" | "erase" | "lasso" = "ink";

	/**
	 * Turns an in-progress line into an eraser path: the background color over the page image, so
	 * the erase shows before the re-rendered image arrives. It is removed with the other live
	 * strokes once an image saved after it loads.
	 */
	eraseWith(id: number) {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		this.styleEraser(p.line, p.eraserWidth);
		p.line.dataset.at = String(Date.now());
		for (const el of p.hidden) el.remove();
	}

	/**
	 * An eraser motion's own line: the background color along its path. The tablet erases whole
	 * strokes, so main.ts also covers each stroke the path touches (coverStroke).
	 */
	private styleEraser(line: SVGPathElement, width: number) {
		line.classList.add("supersidian-live-eraser");
		line.style.stroke = "var(--background-primary)";
		line.style.strokeOpacity = "1";
		line.style.strokeLinecap = "round";
		line.setAttribute("stroke-width", String(width));
	}

	/** Points of an in-progress line in image pixels, and whether it is drawn as an eraser. */
	pendingLine(id: number): { points: Point[]; eraser: boolean } | null {
		const p = this.pending.get(id);
		return p ? { points: p.points, eraser: p.eraser } : null;
	}

	/**
	 * Covers a stroke of the page image, erased by motion `id`, with its own shape in the
	 * background color. `points` are image pixels. Undone if the motion turns out to be ink.
	 */
	coverStroke(id: number, png: string, points: number[], width: number) {
		const p = this.pending.get(id);
		// After the erase is confirmed (eraseWith) the motion is no longer pending; covers then go
		// straight onto the page's overlay.
		const svg = p?.overlay.svg ?? this.overlays.get(png)?.svg;
		if (!svg) return;
		const path = document.createElementNS(SVG, "path");
		path.classList.add("supersidian-live-pending", "supersidian-live-eraser");
		path.setAttribute("d", `M${points.map((v, i) => (i % 2 ? `${v.toFixed(1)}` : `${i ? "L" : ""}${v.toFixed(1)} `)).join("")}`);
		path.style.stroke = "var(--background-primary)";
		path.style.strokeOpacity = "1";
		path.setAttribute("stroke-width", String(width));
		path.dataset.at = String(Date.now());
		if (p) {
			svg.insertBefore(path, p.line);
			p.masks.push(path);
		} else svg.appendChild(path);
	}

	/** Hides live strokes of motion `id`'s page with an outline point within `radius` of `points` (image pixels). */
	hideLiveNear(id: number, png: string, points: Point[], radius: number, loop = false) {
		const p = this.pending.get(id);
		const svg = p?.overlay.svg ?? this.overlays.get(png)?.svg;
		if (!svg || !points.length) return;
		const r2 = radius * radius;
		for (const el of Array.from(svg.querySelectorAll<SVGPathElement>("path[data-at]:not(.supersidian-live-eraser)"))) {
			if (el.style.display === "none") continue;
			const pts = this.inkPoints.get(el);
			const hit = loop
				? pts?.some((a) => insidePolygon(a, points))
				: pts?.some((a) => points.some((b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= r2));
			if (!hit) continue;
			el.style.display = "none";
			if (p) p.hidden.push(el);
		}
	}

	/** Whether a page shows any finished live stroke that no eraser has hidden. */
	hasInk(png: string): boolean {
		const svg = this.overlays.get(png)?.svg;
		if (!svg) return false;
		return Array.from(svg.querySelectorAll<SVGPathElement>("path[data-at]:not(.supersidian-live-eraser)")).some((el) => el.style.display !== "none");
	}

	/** Sets an in-progress line's color and width once the stroke's pen is known. */
	stylePending(id: number, pen: PenInfo, width: number) {
		const p = this.pending.get(id);
		if (!p || p.eraser || p.line.classList.contains("supersidian-live-lasso")) return;
		const { paint, opacity } = inkPaint(pen.color);
		p.line.style.stroke = paint;
		p.line.style.strokeOpacity = String(opacity);
		p.line.setAttribute("stroke-width", String(width));
		if (pen.type === MARKER) p.line.style.strokeLinecap = "butt";
	}

	/**
	 * Removes an in-progress line that no finished stroke replaced, e.g. an eraser or lasso
	 * motion: the tablet reports no tool, so those draw a line until the pen lifts.
	 */
	dropIfPending(id: number) {
		const p = this.pending.get(id);
		if (!p) return;
		for (const el of p.masks) el.remove();
		for (const el of p.hidden) el.style.display = "";
		p.line.remove();
		this.pending.delete(id);
	}

	/** Extends the line for an in-progress stroke; points are in the image's page pixels. */
	extendStroke(id: number, png: string, points: Point[], top: number, renderWidth: number, width: number, eraserWidth: number) {
		let p = this.pending.get(id);
		if (!p) {
			const overlay = this.overlay(png, top, renderWidth);
			const line = document.createElementNS(SVG, "path");
			line.classList.add("supersidian-live-pending");
			line.setAttribute("stroke-width", String(width));
			if (this.mode === "erase") this.styleEraser(line, eraserWidth);
			else if (this.mode === "lasso") line.classList.add("supersidian-live-lasso");
			overlay.svg.appendChild(line);
			p = { overlay, line, points: [], at: Date.now(), eraser: this.mode === "erase", eraserWidth, masks: [], hidden: [] };
			this.pending.set(id, p);
		}
		p.at = Date.now();
		p.points.push(...points);
		p.line.setAttribute("d", smoothPath(p.points));
	}

	/** Removes in-progress lines up to stroke `upTo` once their finished outlines have arrived. */
	dropPending(upTo: number) {
		for (const [id, p] of this.pending) {
			// An earlier line drawn as an eraser waits for its erase message instead.
			if (id > upTo || (p.eraser && id < upTo)) continue;
			// Drawn as an eraser but it was ink: undo what it covered and hid.
			for (const el of p.masks) el.remove();
			for (const el of p.hidden) el.style.display = "";
			p.line.remove();
			this.pending.delete(id);
		}
	}

	/**
	 * Removes live strokes over a page: all of them, or with `before`, the finished strokes that
	 * arrived before that time (the ones a newly synced image contains).
	 */
	clear(png: string, before?: number) {
		const o = this.overlays.get(png);
		if (!o) return;
		if (before !== undefined) {
			for (const el of Array.from(o.svg.querySelectorAll<SVGPathElement>("path[data-at]"))) {
				if (Number(el.dataset.at) < before) el.remove();
			}
			return;
		}
		for (const [id, p] of this.pending) if (p.overlay === o) this.pending.delete(id);
		o.svg.remove();
		this.overlays.delete(png);
	}

	private schedule() {
		if (!this.frame) this.frame = requestAnimationFrame(() => this.position());
	}

	/** Moves each overlay onto its image; runs every frame while any overlay exists. */
	private position() {
		this.frame = 0;
		// A line whose pen-up never arrived (a lost log line) is dropped after 20 s without updates.
		for (const [id, p] of this.pending) {
			if (Date.now() - p.at > 20_000) {
				p.line.remove();
				this.pending.delete(id);
			}
		}
		for (const o of [...this.overlays.values()]) {
			// Nothing left to draw, or the page has been off screen for a minute: drop the overlay,
			// so this per-frame loop stops once no live ink is showing.
			const pending = [...this.pending.values()].some((p) => p.overlay === o);
			if (!o.svg.childElementCount && !pending) {
				this.clear(o.png);
				continue;
			}
			const img = this.imageFor(o.png);
			if (!img) {
				o.svg.style.display = "none";
				if (Date.now() - o.seen > 60_000) this.clear(o.png);
				continue;
			}
			o.seen = Date.now();
			const r = img.getBoundingClientRect();
			const clip = (img.closest(".cm-scroller, .markdown-preview-view") ?? document.body).getBoundingClientRect();
			// The SVG covers only the visible part of the image (inside the note's scroll area). An
			// element over the tab header, even with pointer-events: none, stopped the window from
			// being dragged by it, so nothing is clipped visually instead.
			const left = Math.max(r.left, clip.left);
			const top = Math.max(r.top, clip.top);
			const right = Math.min(r.right, clip.right);
			const bottom = Math.min(r.bottom, clip.bottom);
			if (right <= left || bottom <= top || !r.width || !r.height) {
				o.svg.style.display = "none";
				continue;
			}
			const sx = img.naturalWidth / r.width;
			const sy = img.naturalHeight / r.height;
			o.svg.style.display = "";
			o.svg.style.left = `${left}px`;
			o.svg.style.top = `${top}px`;
			o.svg.style.width = `${right - left}px`;
			o.svg.style.height = `${bottom - top}px`;
			o.svg.setAttribute("preserveAspectRatio", "none");
			o.svg.setAttribute("viewBox", `${(left - r.left) * sx} ${o.top + (top - r.top) * sy} ${(right - left) * sx} ${(bottom - top) * sy}`);
		}
		if (this.overlays.size) this.schedule();
	}
}
