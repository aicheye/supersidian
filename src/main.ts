import { App, Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { lineChanges } from "./diff";
import * as path from "path";
import { adbDevice, adbShell, clockSkewMs, measureClockSkew, shellArg } from "./adb";
import { lastContact, notePulled, PUSH_PORT, pushedNotebooks, startPushServer } from "./push";
import {
	changed,
	courseFolder,
	findDeviceNoteRoot,
	listAdbNotebooks,
	listDeviceNotebooks,
	NotebookBusy,
	NotebookResult,
	SyncState,
	syncNotebook,
	VaultIO,
} from "./core";
import { blankPng, cachePath, PageStroke, readPageStrokes } from "./core";
import {
	dateLabel,
	Extras,
	layoutOf,
	NotebookState,
	noteConcepts,
	pagePngs,
	RENDER_LAYOUT,
	writeCourseIndexes,
	writeNotebookNotes,
} from "./notes";
import { findClaude, transcribePages } from "./transcribe";
import { hideMarkers } from "./hide";
import { deliverLive, InkLayer, insidePolygon, LASSO_PEN, LiveHandlers, LiveInk, LivePen, PenInfo, Point, PX_PER_PEN_UNIT, startLogStream } from "./live";
import { randomBytes } from "crypto";
import { Progress } from "./progress";
import { checkInbox } from "./inbox";
import { signature, syncCalendar } from "./calendar";
import {
	applyHome,
	classStart,
	checkedInHome,
	Deadline,
	FollowUp,
	formatDeadlines,
	homeBlock,
	isoDate,
	Lecture,
	RecentLecture,
	parseDeadlines,
	plainTitle,
} from "./school";

interface Settings {
	pythonPath: string;
	pollSeconds: number;
	/** transcribe pages with Claude Code and fill in topics, concepts and related lectures */
	transcribe: boolean;
	/** Claude Code binary; empty means ~/.local/bin/claude */
	claudePath: string;
	model: string;
	/** a page is transcribed once it has not changed for this long */
	stableSeconds: number;
	/** keep Home.md's Today / Next 14 days block and Deadlines.md checkboxes in sync */
	dashboard: boolean;
	/** check Gmail through Claude Code for new deliverables and due date changes */
	inbox: boolean;
	inboxMinutes: number;
	/** mirror deadlines to Google Calendar through Claude Code */
	calendar: boolean;
	/** HTTPS address the tablet sends notebooks and live ink to without the cable (tailscale serve in front of PUSH_PORT); empty turns it off */
	pushUrl: string;
	/** second address for live ink (another tailscale serve port), so uploads on the first do not hold it back; empty uses pushUrl */
	pushLiveUrl: string;
}

const DEFAULT_SETTINGS: Settings = {
	pythonPath: "python3",
	pollSeconds: 1,
	transcribe: true,
	claudePath: "",
	model: "claude-sonnet-5",
	stableSeconds: 60,
	dashboard: true,
	inbox: true,
	inboxMinutes: 15,
	calendar: true,
	pushUrl: "",
	pushLiveUrl: "",
};

/** Calendar items handled per run, so one run stays within the claude -p timeout. */
const CALENDAR_BATCH = 10;

const DEADLINES = "Deadlines.md";
const HOME = "Home.md";

/** Pages per claude -p call; they all come from one notebook. */
const TRANSCRIBE_BATCH = 5;
/** claude -p calls running at once. */
const TRANSCRIBE_PARALLEL = 3;

/** A failed transcription is retried after this long. */
const RETRY_MS = 10 * 60_000;

const ERROR_AFTER = 3;

/** Bump when a default changes and saved settings should pick up the new value. */
const SETTINGS_VERSION = 2;

interface Data {
	settingsVersion?: number;
	settings: Settings;
	state: SyncState;
	lastSync: number | null;
	/** date (YYYY-MM-DD) the last successful inbox check started */
	lastInbox?: string;
	/** deadline id -> calendar event and the signature it was last synced with */
	calendar?: Record<string, { eventId: string; sig: string }>;
	/** pen type -> page pixels per pen width unit, measured from finished strokes */
	penScale?: Record<string, number>;
	/** secret the tablet sends with each HTTPS request; given to it over USB */
	pushToken?: string;
}

type Status = { kind: "idle" } | { kind: "absent" } | { kind: "syncing"; what: string } | { kind: "error"; message: string };

export default class Supersidian extends Plugin {
	data: Data = { settings: { ...DEFAULT_SETTINGS }, state: { notebooks: {} }, lastSync: null };
	private statusEl!: HTMLElement;
	private status: Status = { kind: "absent" };
	/** why the HTTPS receiver is not running, for the status bar */
	private pushError: string | null = null;
	/** how the tablet is reached, for the status bar */
	private link: "USB" | "Tailscale" = "USB";
	private busy = false;
	/** Consecutive failed polls; an error is shown only after ERROR_AFTER of them, since a notebook mid-save can fail to parse. */
	private failures = 0;
	private timer: number | null = null;
	/** pageid -> transcript, topics and concepts; kept in transcripts.json next to data.json */
	private extras: Extras = {};
	private concepts: Map<string, Set<string>> | null = null;
	/** pageids being transcribed right now */
	private transcribing = new Set<string>();
	/** serializes note rewrites, since several transcription batches can finish together */
	private rewriting: Promise<void> = Promise.resolve();
	/** pageid -> time of the last failed transcription */
	private failed = new Map<string, number>();

	async onload() {
		const saved = (await this.loadData()) ?? {};
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...saved.settings },
			state: saved.state ?? { notebooks: {} },
			lastSync: saved.lastSync ?? null,
			lastInbox: saved.lastInbox,
			calendar: saved.calendar ?? {},
			penScale: saved.penScale ?? {},
			pushToken: saved.pushToken ?? randomBytes(24).toString("base64url"),
		};
		// Live strokes do not survive a restart, so blank pages embedded for them have nothing to
		// show; the rewrite after layout drops them. New strokes embed them again.
		for (const nb of Object.values(this.data.state.notebooks)) delete nb.inked;
		// Version 2 lowered the poll interval from 10 s to 1 s.
		if ((saved.settingsVersion ?? 1) < 2) this.data.settings.pollSeconds = DEFAULT_SETTINGS.pollSeconds;
		this.data.settingsVersion = SETTINGS_VERSION;

		this.registerEditorExtension(hideMarkers);
		this.layer = new InkLayer();
		this.register(() => this.layer.destroy());
		// Remove the side panel from earlier versions if the workspace still has it.
		this.app.workspace.onLayoutReady(() => this.app.workspace.detachLeavesOfType("supersidian-live"));
		const live: LiveHandlers = {
			ink: (ink) => this.onInk(ink),
			erase: (e) => {
				this.layer.mode = "erase";
				const line = this.layer.pendingLine(e.stroke);
				if (line) this.finishErase(e.stroke, line.points);
				this.layer.eraseWith(e.stroke);
				this.unembedErased(e.stroke);
			},
			pen: (pen) => this.onPen(pen),
			// The tablet's page snapshots render the saved file, not unsaved strokes, so they are not used.
			preview: () => undefined,
			pages: (p) => this.dropDeletedPlaceholders(p.file.split("/Note/")[1], p.count),
			error: (e) => console.error("supersidian: live ink", e),
		};
		this.register(startLogStream(live));
		this.register(
			startPushServer({
				token: () => (this.data.settings.pushUrl ? this.data.pushToken ?? "" : ""),
				usb: async () => (await adbDevice())?.wireless === false,
				live: (id, kind, payload, t, sent) => {
					// Delay from the tablet producing a message to its arrival here, in the laptop's clock,
					// and the part of it spent waiting on the tablet before the request went out.
					if (t) this.liveDelays.push([Date.now(), Date.now() - (t - clockSkewMs), sent ? sent - t : -1]);
					if (this.liveDelays.length > 500) this.liveDelays.shift();
					deliverLive(live, id, kind, payload);
				},
				// Sync now rather than at the next poll; a sync already running picks it up on the next one.
				notebook: (nb) => {
					this.pushLog.push([Date.now(), nb.size, nb.stats]);
					if (this.pushLog.length > 100) this.pushLog.shift();
					// Also on disk, so the tablet's upload counters can be read without the developer console.
					this.app.vault.adapter
						.append(`${this.manifest.dir}/upload-stats.log`, `${JSON.stringify({ at: new Date().toISOString(), rel: nb.rel, size: nb.size, stats: nb.stats })}\n`)
						.catch((e) => console.error("supersidian: upload stats", e));
					this.sync({});
				},
				error: (e) => {
					console.error("supersidian: push", e);
					// Another process holds the port: say so in the status bar, since sync without the cable is off.
					if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
						this.pushError = `Sync without the cable is off: port ${PUSH_PORT} is in use by another program.`;
						this.render();
					}
				},
			}),
		);

		this.extras = await this.loadExtras();
		await this.migrateState();
		this.styleInk();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.statusEl.onClickEvent(() => this.sync({ manual: true }));
		this.render();
		// The status shows only with a note it concerns open (Home, Deadlines, course notes), not
		// in the graph, canvas or unrelated notes.
		const showStatus = () => {
			const p = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
			const courses = new Set(Object.values(this.data.state.notebooks).map((nb) => nb.course));
			const mine = !!p && (p === HOME || p === DEADLINES || [...courses].some((c) => c && p.startsWith(`${c}/`)));
			this.statusEl.toggle(mine);
			// Obsidian leaves the status bar's empty frame on screen when none of its items show
			// (e.g. in the graph), so it is hidden then. Checked after the other items update.
			requestAnimationFrame(() => {
				const bar = this.statusEl.parentElement;
				if (!bar) return;
				bar.removeClass("supersidian-empty");
				const shown = Array.from(bar.children).some((c) => (c as HTMLElement).offsetWidth > 0);
				bar.toggleClass("supersidian-empty", !shown);
			});
		};
		showStatus();
		this.registerEvent(this.app.workspace.on("active-leaf-change", showStatus));
		this.registerEvent(this.app.workspace.on("file-open", showStatus));
		this.registerEvent(this.app.workspace.on("layout-change", showStatus));
		this.register(() => this.statusEl.parentElement?.removeClass("supersidian-empty"));

		this.addCommand({ id: "process-note", name: "Process this note now (sync, transcribe, topics)", callback: () => this.processNote(false) });
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync({ manual: true }) });
		this.addCommand({
			id: "resync-all",
			name: "Re-render every page",
			callback: () => this.sync({ manual: true, force: true }),
		});
		this.addCommand({
			id: "retranscribe-note",
			name: "Transcribe the pages in this note again",
			callback: () => this.processNote(true),
		});
		this.addSettingTab(new SettingsTab(this.app, this));
		this.registerInterval(window.setInterval(() => this.transcribeNext(), 5_000));

		this.addCommand({ id: "check-inbox", name: "Check email for new deadlines and date changes", callback: () => this.inboxNow(true) });
		this.registerInterval(window.setInterval(() => this.refreshSchool(), 30_000));
		// While the cable is in: measure the clock skew and give the tablet its HTTPS sync config.
		const usbTasks = async () => {
			await measureClockSkew().catch(() => {});
			await this.giveTabletConfig().catch((e) => console.error("supersidian: tablet config", e));
		};
		usbTasks();
		this.registerInterval(window.setInterval(usbTasks, 10_000));
		this.registerInterval(window.setInterval(() => this.inboxNow(false), this.data.settings.inboxMinutes * 60_000));
		this.registerInterval(window.setInterval(() => this.calendarNow(false), 10 * 60_000));
		this.addCommand({ id: "sync-calendar", name: "Sync deadlines to Google Calendar", callback: () => this.calendarNow(true) });
		this.app.workspace.onLayoutReady(() => {
			this.refreshSchool();
			window.setTimeout(() => this.inboxNow(false), 20_000);
			window.setTimeout(() => this.calendarNow(false), 60_000);
			// Regenerate every block once, so formatting changes in a new build reach notes that
			// would otherwise wait for their next transcript or tablet change.
			window.setTimeout(() => this.rewriteNotes().catch((e) => console.error("supersidian: rewrite", e)), 3_000);
		});
		// Home.md follows every change to the notes it summarizes (Deadlines.md, lecture notes and
		// their follow-up questions, new pages and transcripts), and a task checked in Home.md is
		// applied to Deadlines.md. A refresh takes about 20 ms; changes within 0.5 s share one.
		let homeTimer = 0;
		const refreshHome = (f: TAbstractFile) => {
			if (!(f instanceof TFile) || f.extension !== "md") return;
			window.clearTimeout(homeTimer);
			homeTimer = window.setTimeout(() => this.refreshSchool(), f.path === HOME ? 300 : 500);
		};
		this.registerEvent(this.app.vault.on("modify", refreshHome));
		this.registerEvent(this.app.vault.on("create", refreshHome));
		this.registerEvent(this.app.vault.on("delete", refreshHome));
		this.registerEvent(this.app.vault.on("rename", refreshHome));
		// Retry writes skipped because an open note's editor did not match its saved file.
		this.registerInterval(
			window.setInterval(() => {
				if (!this.stale.size) return;
				this.stale.clear();
				this.rewriteAll()
					.then(() => this.refreshSchool())
					.catch((e) => console.error("supersidian: retry", e));
			}, 3_000),
		);
		// Apply deferred background rewrites once their notes are no longer open.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if ([...this.deferred].some((p) => !this.openEditor(p))) {
					this.deferred.clear();
					this.rewriteNotes().catch((e) => console.error("supersidian: rewrite", e));
				}
			}),
		);

		this.schedule();
		// Refresh the "synced Nm ago" label.
		this.registerInterval(window.setInterval(() => this.render(), 30_000));
	}

	onunload() {
		if (this.timer !== null) window.clearInterval(this.timer);
	}

	schedule() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = window.setInterval(() => this.sync({}), Math.max(1, this.data.settings.pollSeconds) * 1000);
		this.sync({});
	}

	async save() {
		await this.saveData(this.data);
	}

	private io(): VaultIO {
		const vault = this.app.vault;
		const a = vault.adapter;
		const file = (p: string) => {
			const f = vault.getAbstractFileByPath(p);
			return f instanceof TFile ? f : null;
		};
		return {
			exists: (p) => a.exists(p),
			// An open note is read from and written through its editor, so unsaved typing is kept
			// and CodeMirror keeps the scroll position. A plain file write makes Obsidian reload the view.
			// Always the saved file: while a tab switches notes its editor can briefly hold the
			// previous note's text, and reading that once wrote a lecture note into Home.md.
			// The exception is text the plugin itself put in the editor that Obsidian has not saved yet
			// (it saves about 2 s later): reading the file then would miss that write, so a change
			// back to what the file still had was skipped as "no change".
			read: async (p) => {
				const mine = this.lastWritten.get(p);
				if (mine !== undefined && this.openEditor(p)?.getValue() === mine) return mine;
				return a.read(p);
			},
			write: async (p, d) => {
				const editor = this.openEditor(p);
				if (editor && this.deferOpen) {
					// Background rewrites (after a transcription batch) wait until the note is closed.
					this.deferred.add(p);
					return;
				}
				if (editor) {
					// Edit through the editor (keeps scroll and cursor) only when it shows this note: the
					// saved file, or what the plugin last put in it (Obsidian saves an edit about 2 s
					// later). A tab mid-switch shows another note and matches neither. Otherwise (e.g.
					// unsaved typing) retry.
					const shown = editor.getValue();
					if (shown !== this.lastWritten.get(p) && shown !== (await a.read(p))) {
						this.stale.add(p);
						return;
					}
					this.keepScroll(p, () => replaceChanged(editor, d));
					this.lastWritten.set(p, d);
					return;
				}
				const f = file(p);
				if (f) await vault.modify(f, d);
				else await vault.create(p, d);
			},
			writeBinary: async (p, d, savedAt) => {
				const f = file(p);
				if (f) {
					await vault.modifyBinary(f, d);
					this.refreshImages(f, savedAt ?? Date.now());
				} else await vault.createBinary(p, d);
			},
			mkdir: (p) => a.mkdir(p),
			remove: async (p) => {
				const f = file(p);
				if (f) await vault.delete(f);
			},
			list: (p) => a.list(p),
		};
	}

	/**
	 * Applies an edit to an open note without moving what is on screen. In source and live preview
	 * mode CodeMirror keeps the text at the top of the view in place by itself, as long as page
	 * images keep their height while loading (styles.css). The plugin used to correct the scroll
	 * as well, which moved the view by the height of a page added just below the one on screen.
	 * Reading mode is put back at the line it showed.
	 */
	private keepScroll(p: string, edit: () => boolean) {
		const views = this.app.workspace
			.getLeavesOfType("markdown")
			.map((l) => l.view)
			.filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === p && v.getMode() !== "source");
		const lines = views.map((v) => v.currentMode.getScroll());
		if (!edit()) return;
		views.forEach((v, i) => requestAnimationFrame(() => v.currentMode.applyScroll(lines[i])));
	}

	private openEditor(p: string): Editor | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === p) return view.editor;
		}
		return null;
	}

	/** image path -> time live ink last arrived for that page */
	private liveAt = new Map<string, number>();
	/** image path -> time the last finished stroke with ink arrived (not eraser or lasso motions) */
	private inkAt = new Map<string, number>();
	/** image path -> pending swap timer */
	private swaps = new Map<string, number>();
	/** images being replaced by refreshImages, which clears their live strokes once loaded */
	private refreshing = new Set<string>();

	/**
	 * Pages of a notebook that got live ink after the tablet saved at `savedAt`. The save may have
	 * them blank (the page was erased, then written on again before the sync finished), and they
	 * stay embedded, since those strokes are not saved until the tablet next saves.
	 */
	private inkedSince(nb: NotebookState, savedAt: number): Record<string, boolean> {
		const out: Record<string, boolean> = {};
		for (const [pageid, png] of pagePngs(layoutOf(nb).assetDir, Object.keys(nb.pages))) {
			if ((this.inkAt.get(png) ?? 0) > savedAt) out[pageid] = true;
		}
		return out;
	}

	/**
	 * After a sync, live strokes that arrived before the tablet's save are in the synced images,
	 * or were erased before the save. Pages whose image changed are cleared by refreshImages once
	 * the new image loads; the rest are cleared now. Without this, a stroke written and erased
	 * between two saves stayed on screen, since its page image never changed.
	 */
	private settleLive(nb: NotebookState) {
		for (const png of pagePngs(layoutOf(nb).assetDir, Object.keys(nb.pages)).values()) {
			if (!this.refreshing.has(png)) this.layer.clear(png, nb.savedAt ?? nb.mtimeMs - 500);
		}
	}

	/**
	 * Obsidian does not redraw an embed when only the image file changes, so visible <img>s are
	 * pointed at the new version. While live ink is arriving for the page the swap waits until
	 * 1.5 s after the last stroke (the live strokes already show the ink), and the new file is
	 * loaded first, since the CSS mask that colors the ink shows nothing while it loads.
	 */
	private refreshImages(f: TFile, savedAt: number) {
		this.refreshing.add(f.path);
		const wait = Math.max(0, (this.liveAt.get(f.path) ?? 0) + 1500 - Date.now());
		window.clearTimeout(this.swaps.get(f.path));
		this.swaps.set(
			f.path,
			window.setTimeout(() => {
				this.swaps.delete(f.path);
				const base = this.app.vault.getResourcePath(f).split("?")[0];
				const fresh = `${base}?${Date.now()}`;
				const pre = new Image();
				pre.onload = () => {
					const url = (u: string) => `url("${u.replace(/"/g, "%22")}")`;
					const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter((img) => img.src.split("?")[0] === base);
					for (const img of imgs) {
						// Old and new masks together: until the new one is decoded it shows nothing,
						// and the old one keeps the ink on screen, so the swap has no empty frame.
						img.style.setProperty("--supersidian-src", `${url(fresh)}, ${url(img.src)}`);
						img.src = fresh;
					}
					window.setTimeout(() => {
						for (const img of imgs) if (img.src === fresh) img.style.setProperty("--supersidian-src", url(fresh));
						// The new image contains the strokes the tablet had saved; strokes that arrived
						// after the save stay until a later image has them.
						this.layer.clear(f.path, savedAt);
						this.refreshing.delete(f.path);
					}, 600);
				};
				pre.src = fresh;
			}, wait),
		);
	}

	private layer!: InkLayer;
	/** [arrival time, ms from the tablet producing it] of recent live messages over HTTPS, for measuring lag */
	liveDelays: [number, number, number][] = [];
	/** [arrival time, size] of recent notebook uploads over HTTPS */
	pushLog: [number, number, unknown][] = [];
	private liveLogged = 0;
	/** page each in-progress stroke is on */
	private penPages = new Map<number, { rel: string; page: number; width: number; displayWidth: number; pen?: PenInfo }>();
	private lastPage: { rel: string; page: number; width: number; displayWidth: number; pen?: PenInfo } | null = null;
	/** live messages for a page that has not synced yet, replayed after the next sync */
	private unplaced: { at: number; ink?: LiveInk; pen?: LivePen }[] = [];

	/** Replays live messages from the last 10 s whose page was missing, now that a sync ran. */
	private replayUnplaced() {
		const recent = this.unplaced.filter((u) => Date.now() - u.at < 10_000);
		this.unplaced = [];
		for (const u of recent) {
			if (u.pen) this.onPen(u.pen, true);
			if (u.ink) this.onInk(u.ink, true);
		}
	}

	/**
	 * The page image and geometry for a tablet notebook page, if the notebook has synced before.
	 * A page the synced copy does not have yet gets a placeholder (addPlaceholders).
	 */
	private pageTarget(rel: string, page: number, inkWidth: number, inked = false) {
		const nb = this.data.state.notebooks[rel];
		if (!nb) return null;
		const ids = Object.keys(nb.pages);
		const pageid = ids[page] ?? this.addPlaceholders(nb, page, inkWidth);
		// A finished stroke on a page left out as blank: mark it written on and embed it now, so
		// the strokes have an image to draw over. Pen motions alone do not count, since eraser
		// and lasso motions on a blank page send them too.
		if (inked && nb.blank?.[pageid] && !nb.inked?.[pageid]) {
			(nb.inked ??= {})[pageid] = true;
			(this.placeholderPngs.get(pageid) ?? Promise.resolve())
				.then(() => this.rewriteAll())
				.catch((e) => console.error("supersidian: embed page", e));
		}
		const png = pagePngs(layoutOf(nb).assetDir, ids).get(pageid)!;
		const [top, renderWidth] = nb.geometry?.[pageid] ?? [0, inkWidth];
		return { png, top, renderWidth, pageid };
	}

	/** pageid -> write of its placeholder image */
	private placeholderPngs = new Map<string, Promise<void>>();

	/**
	 * The tablet writes a page to the file only when it saves, which it does when you leave the
	 * page. Until then the page gets a placeholder: a blank page (hash "") with an empty image,
	 * named from the current time, so live ink shows at once in today's note. Returns the id for
	 * `page`, adding placeholders for any pages before it that are missing too. The sync that
	 * has the page replaces the placeholder (adoptPlaceholders).
	 */
	private addPlaceholders(nb: NotebookState, page: number, width: number): string {
		const d = new Date();
		const two = (n: number) => String(n).padStart(2, "0");
		const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
		const ids = Object.keys(nb.pages);
		for (let i = ids.length; i <= page; i++) {
			const pageid = `P${stamp}${String(i).padStart(6, "0")}live`;
			nb.pages[pageid] = "";
			nb.changedAt[pageid] = Date.now();
			(nb.blank ??= {})[pageid] = true;
			(nb.geometry ??= {})[pageid] = [0, width];
		}
		const all = Object.keys(nb.pages);
		const pngs = pagePngs(layoutOf(nb).assetDir, all);
		for (const pageid of all.slice(ids.length)) {
			// The Nomad's and A5X's pages are 3:4.
			const buf = blankPng(width, Math.round((width * 4) / 3));
			const write = this.app.vault.adapter.writeBinary(pngs.get(pageid)!, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
			this.placeholderPngs.set(pageid, write);
			write.finally(() => this.placeholderPngs.delete(pageid)).catch((e) => console.error("supersidian: placeholder page", e));
		}
		return all[page];
	}

	/**
	 * The tablet now has `count` pages: placeholders past that were for pages since deleted.
	 * Without this they stayed, since a sync keeps placeholders past the end of the file (the page
	 * may not be saved yet), and a pen tap on the page menu is enough to create one.
	 */
	private dropDeletedPlaceholders(rel: string | undefined, count: number) {
		const nb = rel ? this.data.state.notebooks[rel] : undefined;
		if (!nb) return;
		const ids = Object.keys(nb.pages);
		const gone = ids.filter((pageid, i) => i >= count && nb.pages[pageid] === "");
		if (!gone.length) return;
		const pngs = pagePngs(layoutOf(nb).assetDir, ids);
		for (const pageid of gone) {
			const png = pngs.get(pageid)!;
			this.layer.clear(png);
			this.liveAt.delete(png);
			this.inkAt.delete(png);
			delete nb.pages[pageid];
			delete nb.changedAt[pageid];
			delete nb.blank?.[pageid];
			delete nb.geometry?.[pageid];
			delete nb.inked?.[pageid];
			this.app.vault.adapter.remove(png).catch(() => undefined);
		}
		this.save()
			.then(() => this.rewriteAll())
			.catch((e) => console.error("supersidian: drop deleted pages", e));
	}

	/** Placeholders of `prev` that the synced file (`count` pages) does not have yet, to keep. */
	private keptPlaceholders(prev: NotebookState, count: number): { pageid: string; width: number }[] {
		return Object.entries(prev.pages)
			.map(([pageid, hash], i) => ({ pageid, hash, i }))
			.filter((p) => p.hash === "" && p.i >= count)
			.map((p) => ({ pageid: p.pageid, width: prev.geometry?.[p.pageid]?.[1] ?? 1920 }));
	}

	/** Moves the live ink of placeholders the sync replaced with real pages onto those pages' images. */
	private adoptPlaceholders(prev: NotebookState, next: NotebookState) {
		const dir = layoutOf(next).assetDir;
		const before = pagePngs(dir, Object.keys(prev.pages));
		const ids = Object.keys(next.pages);
		const after = pagePngs(dir, ids);
		Object.keys(prev.pages).forEach((pageid, i) => {
			if (prev.pages[pageid] !== "" || next.pages[pageid] !== undefined || !ids[i]) return;
			const from = before.get(pageid)!;
			const to = after.get(ids[i])!;
			this.layer.rename(from, to);
			for (const m of [this.liveAt, this.inkAt]) {
				const at = m.get(from);
				m.delete(from);
				if (at !== undefined) m.set(to, Math.max(at, m.get(to) ?? 0));
			}
		});
	}

	/** Draws strokes the tablet just finished over the matching page image. */
	private onInk(ink: LiveInk, replay = false) {
		const rel = ink.file.split("/Note/")[1];
		if (this.liveLogged < 5) {
			this.liveLogged++;
			// A few payload summaries for checking page numbering and coordinate units.
			const first = ink.strokes[0]?.contours[0]?.[0];
			this.app.vault.adapter.append(
				`${this.manifest.dir}/live-debug.log`,
				`${new Date().toISOString()} ink rel=${rel} page=${ink.page} size=${ink.width}x${ink.height} strokes=${ink.strokes.length} first=${JSON.stringify(first)} screen=${JSON.stringify(ink.screen)}\n`,
			);
		}
		if (!rel) return;
		// A lasso loop arrives as a stroke with pen type 4. It is not ink: drop it and its line.
		const lasso = ink.strokes.length > 0 && ink.strokes.every((s) => s.penType === LASSO_PEN);
		ink = { ...ink, strokes: ink.strokes.filter((s) => s.penType !== LASSO_PEN) };
		if (lasso) {
			if (ink.penStroke !== undefined) this.layer.dropPending(ink.penStroke);
			this.layer.mode = "lasso";
			return;
		}
		this.lastPage = { rel, page: ink.page, width: ink.width, displayWidth: this.lastPage?.displayWidth ?? 0 };
		const t = this.pageTarget(rel, ink.page, ink.width, ink.strokes.length > 0);
		if (!t && !replay) this.unplaced.push({ at: Date.now(), ink });
		if (t) {
			this.liveAt.set(t.png, Date.now());
			if (ink.strokes.length) this.inkAt.set(t.png, Date.now());
			this.layer.addStrokes(t.png, ink.strokes, t.top, t.renderWidth, ink.width);
		}
		if (ink.penStroke !== undefined) this.layer.dropPending(ink.penStroke);
		// The pen drew ink, so new lines are drawn as ink again.
		if (ink.strokes.length) this.layer.mode = "ink";
	}

	/** Extends the line of a stroke being drawn right now. */
	private onPen(pen: LivePen, replay = false) {
		if (pen.file && this.liveLogged < 10) {
			this.liveLogged++;
			this.app.vault.adapter.append(
				`${this.manifest.dir}/live-debug.log`,
				`${new Date().toISOString()} pen stroke=${pen.stroke} page=${pen.page} width=${pen.width} display=${JSON.stringify(pen.display)}\n`,
			);
		}
		if (pen.file) {
			const rel = pen.file.split("/Note/")[1];
			if (rel && pen.page !== undefined && pen.width) {
				this.penPages.set(pen.stroke, { rel, page: pen.page, width: pen.width, displayWidth: pen.display?.width ?? 0, pen: pen.pen });
			}
		}
		// The tablet sends a stroke's first points before the message naming its page (that one
		// waits on four calls to the note app). Drawn on the last known page, the start of the
		// first stroke after a page turn showed on the old page, so points wait here for the page,
		// up to PEN_META_WAIT_MS or the pen lift.
		const held = this.heldPen.get(pen.stroke);
		if (!this.penPages.has(pen.stroke) && !pen.end && Date.now() - (held?.at ?? Date.now()) < PEN_META_WAIT_MS) {
			if (held) held.pens.push(pen);
			else this.heldPen.set(pen.stroke, { at: Date.now(), pens: [pen] });
			return;
		}
		if (held) {
			this.heldPen.delete(pen.stroke);
			for (const p of held.pens) this.drawPen(p, replay);
		}
		this.drawPen(pen, replay);
	}

	/** Pen messages of strokes whose page is not known yet. */
	private heldPen = new Map<number, { at: number; pens: LivePen[] }>();

	private drawPen(pen: LivePen, replay: boolean) {
		const ctx = this.penPages.get(pen.stroke) ?? this.lastPage;
		if (pen.end) {
			this.penPages.delete(pen.stroke);
			// A finished stroke arrives as ink within a moment; a line still pending after that
			// was an eraser or lasso motion.
			const id = pen.stroke;
			window.setTimeout(() => this.layer.dropIfPending(id), 1000);
		}
		if (!ctx) return;
		const t = this.pageTarget(ctx.rel, ctx.page, ctx.width);
		if (!t) {
			// A new page: hold its strokes until the sync that adds it.
			if (!replay) this.unplaced.push({ at: Date.now(), pen: { ...pen, file: pen.file ?? `/Note/${ctx.rel}`, page: ctx.page, width: ctx.width } });
			return;
		}
		// Pen positions are in display pixels with the page drawn from the top-left corner; on the
		// Nomad the display size equals the page size, so this is 1:1 (verified from live-debug.log).
		const scale = ctx.displayWidth ? ctx.width / ctx.displayWidth : 1;
		const k = t.renderWidth / ctx.width;
		const points: Point[] = pen.points.map((p) => ({ x: p.x * scale * k, y: p.y * scale * k }));
		// A fixed width from the pen's setting, the same for every stroke with that pen.
		const penInfo = ctx.pen;
		const width = (penInfo ? Math.max(1, penInfo.width * PX_PER_PEN_UNIT) : 4) * k;
		this.liveAt.set(t.png, Date.now());
		if (points.length) this.layer.extendStroke(pen.stroke, t.png, points, t.top, t.renderWidth, width, ERASER_PAGE_PX * k);
		if (penInfo) this.layer.stylePending(pen.stroke, penInfo, width);
		this.motionPages.set(pen.stroke, { rel: ctx.rel, pageid: t.pageid, png: t.png, k });
		this.loadStrokes(ctx.rel, t.pageid);
		if (this.motionPages.size > 50) this.motionPages.delete(this.motionPages.keys().next().value!);
		const line = this.layer.pendingLine(pen.stroke);
		if (line?.eraser) {
			if (points.length) this.eraseAlong(pen.stroke, points);
			// Drawn as an eraser: the loop is complete, so erase inside it now rather than at the
			// erase message. A lasso motion ends up as ink and undoes this (InkLayer.dropPending).
			if (pen.end) this.eraseAlong(pen.stroke, line.points, true);
		}
	}

	/**
	 * An eraser motion is confirmed: erase along it and inside its loop. When the page's strokes
	 * are still loading, the erase is applied once they arrive.
	 */
	private finishErase(id: number, points: Point[]) {
		const m = this.motionPages.get(id);
		if (!m) return;
		if (!this.pageStrokes.has(m.pageid)) {
			const waiting = this.eraseWaiting.get(m.pageid) ?? [];
			waiting.push({ id, points: [...points] });
			this.eraseWaiting.set(m.pageid, waiting);
		}
		this.eraseAlong(id, points);
		this.eraseAlong(id, points, true);
	}

	/**
	 * A blank page embedded only for its live ink (`inked`) whose live strokes eraser motion `id`
	 * has all erased: leave it out again. Without this it stayed in the note until the tablet's
	 * next save, and the note app often does not save after an erase, since the file is unchanged.
	 */
	private unembedErased(id: number) {
		const m = this.motionPages.get(id);
		if (!m) return;
		const nb = this.data.state.notebooks[m.rel];
		if (!nb?.blank?.[m.pageid] || !nb.inked?.[m.pageid] || this.layer.hasInk(m.png)) return;
		delete nb.inked[m.pageid];
		if (!Object.keys(nb.inked).length) delete nb.inked;
		this.inkAt.delete(m.png);
		this.rewriteAll().catch((e) => console.error("supersidian: unembed page", e));
	}

	/** pageid -> confirmed eraser motions that arrived before the page's strokes had loaded */
	private eraseWaiting = new Map<string, { id: number; points: Point[] }[]>();

	/** Page and image scale of recent pen motions, for erasing along them. */
	private motionPages = new Map<number, { rel: string; pageid: string; png: string; k: number }>();
	/** pageid -> its visible strokes (render.py page_strokes), for showing whole-stroke erases at once */
	private pageStrokes = new Map<string, PageStroke[]>();
	private loadingStrokes = new Set<string>();
	/** motion id -> indexes of the page strokes it has covered */
	private covered = new Map<number, Set<number>>();

	/**
	 * Reads a page's visible strokes from the local notebook copy when they are not known yet (the
	 * page has not been re-rendered since Obsidian started), so an erase on it can show at once.
	 */
	private loadStrokes(rel: string, pageid: string) {
		if (this.pageStrokes.has(pageid) || this.loadingStrokes.has(pageid)) return;
		this.loadingStrokes.add(pageid);
		readPageStrokes(this.data.settings.pythonPath, this.renderScript(), cachePath(rel), pageid)
			.then((st) => {
				if (!this.pageStrokes.has(pageid)) this.pageStrokes.set(pageid, st);
				const waiting = this.eraseWaiting.get(pageid) ?? [];
				this.eraseWaiting.delete(pageid);
				for (const w of waiting) {
					this.eraseAlong(w.id, w.points);
					this.eraseAlong(w.id, w.points, true);
				}
			})
			.catch((e) => console.error("supersidian: page strokes", e))
			.finally(() => this.loadingStrokes.delete(pageid));
	}

	/**
	 * Shows what eraser motion `id` erases, with `points` in image pixels. The tablet's eraser
	 * removes every stroke its path touches and, once the pen lifts, every stroke inside the loop
	 * it drew (`loop`: the path taken as a closed polygon). Each such stroke of the page image is
	 * covered with its own shape in the background color, and such live strokes are hidden.
	 */
	private eraseAlong(id: number, points: Point[], loop = false) {
		const m = this.motionPages.get(id);
		if (!m || !points.length || (loop && points.length < 3)) return;
		this.layer.hideLiveNear(id, m.png, points, (ERASE_REACH_PX + 3) * m.k, loop);
		const strokes = this.pageStrokes.get(m.pageid);
		if (!strokes) return;
		const done = this.covered.get(id) ?? new Set<number>();
		this.covered.set(id, done);
		if (this.covered.size > 20) this.covered.delete(this.covered.keys().next().value!);
		const page = points.map((q) => ({ x: q.x / m.k, y: q.y / m.k }));
		const reach = ERASE_REACH_PX;
		strokes.forEach((st, i) => {
			if (done.has(i)) return;
			const reach2 = (reach + (st.w * PX_PER_PEN_UNIT) / 2) ** 2;
			for (let j = 0; j < st.p.length; j += 2) {
				const q = { x: st.p[j], y: st.p[j + 1] };
				if (loop ? !insidePolygon(q, page) : !page.some((e) => (e.x - q.x) ** 2 + (e.y - q.y) ** 2 <= reach2)) continue;
				done.add(i);
				// Pressure pens draw up to about 1.5 times the set width; 5 px more covers antialiasing.
				this.layer.coverStroke(id, m.png, st.p.map((v) => v * m.k), (st.w * PX_PER_PEN_UNIT * 1.6 + 5) * m.k);
				return;
			}
		});
	}

	private renderScript(): string {
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		return path.join(adapter.getBasePath(), this.manifest.dir ?? "", "render.py");
	}

	async sync({ manual = false, force = false, progress }: { manual?: boolean; force?: boolean; progress?: Progress }) {
		if (this.busy) {
			// A manual sync waits for the running one, then runs, so it covers the latest save.
			if (!manual) return;
			while (this.busy) await new Promise((r) => window.setTimeout(r, 200));
		}
		this.busy = true;
		const owned = manual && !progress;
		if (owned) progress = new Progress(force ? "Supernote: re-rendering every page" : "Supernote: syncing");
		progress?.status("Looking for the tablet");
		try {
			// adb first; the desktop's MTP mount only when adb has no tablet.
			let notebooks = await listAdbNotebooks();
			if (notebooks) this.link = (await adbDevice())?.wireless ? "Tailscale" : "USB";
			// Any request from the tablet counts (live ink, WebSocket, upload): after the plugin loads,
			// no notebook has been pushed until the tablet's next save.
			else if (lastContact && Date.now() - lastContact < PUSH_FRESH_MS) {
				notebooks = pushedNotebooks();
				this.link = "Tailscale";
			} else {
				const root = await findDeviceNoteRoot();
				if (!root) {
					this.setStatus({ kind: "absent" });
					if (owned) progress?.fail("Supernote not connected (USB or Tailscale).");
					return;
				}
				notebooks = await listDeviceNotebooks(root);
				this.link = "USB";
			}
			const results: NotebookResult[] = [];
			const vault = this.io();
			const todo = notebooks.filter((nb) => {
				const prev = this.data.state.notebooks[nb.rel];
				// Notebooks synced before blank pages and geometry were recorded sync once more to record them.
				const unmeasured = !!prev && (prev.renderLayout !== RENDER_LAYOUT || Object.keys(prev.pages).some((id) => !prev.geometry?.[id]));
				return force || unmeasured || changed(nb, prev);
			});
			for (const [i, nb] of todo.entries()) {
				const prev = this.data.state.notebooks[nb.rel];
				progress?.step(i, todo.length, `rendering ${nb.rel.replace(/\.note$/, "")}`);
				this.setStatus({ kind: "syncing", what: nb.rel });
				// A stuck step (adb, renderer) must not leave the plugin busy and stop all syncing.
				const out = await withTimeout(SYNC_TIMEOUT_MS, `sync of ${nb.rel}`, syncNotebook(vault, nb, prev, {
					python: this.data.settings.pythonPath,
					renderScript: this.renderScript(),
					force,
					extras: this.extras,
					concepts: await this.conceptMap(),
					inked: (savedAt) => (prev ? this.inkedSince(prev, savedAt) : {}),
					strokes: (pageid, strokes) => this.pageStrokes.set(pageid, strokes),
					placeholders: (count) => (prev ? this.keptPlaceholders(prev, count) : []),
				}));
				if (!out) continue;
				if (nb.via === "adb") notePulled(nb.rel, nb.size, nb.mtimeMs);
				this.data.state.notebooks[nb.rel] = out.state;
				if (prev) this.adoptPlaceholders(prev, out.state);
				this.settleLive(out.state);
				results.push(out.result);
				await this.save();
			}
			// Over Tailscale the tablet sends when it has something, so "synced" is its last request.
			this.data.lastSync = this.link === "Tailscale" && !(await adbDevice()) ? lastContact : Date.now();
			// data.json is written only when a notebook changed, not on every 1 s poll.
			if (results.length) {
				await this.save();
				this.replayUnplaced();
			}
			this.failures = 0;
			this.setStatus({ kind: "idle" });
			if (owned) progress?.done(this.report(results));
		} catch (e) {
			if (e instanceof NotebookBusy && !manual) return;
			if (e instanceof NotebookBusy) {
				if (owned) progress?.fail("Supernote: the tablet was saving; run the command again.");
				return;
			}
			const message = e instanceof Error ? e.message : String(e);
			console.error("supersidian", e);
			if (++this.failures < ERROR_AFTER && !manual) return;
			this.setStatus({ kind: "error", message });
			if (manual) progress?.fail(`Supernote sync failed: ${message}`);
		} finally {
			this.busy = false;
		}
	}

	/** State saved before notes.ts lacks course, name and changedAt; derive them from the device path. */
	private async migrateState() {
		for (const [rel, nb] of Object.entries(this.data.state.notebooks)) {
			if (nb.course && nb.changedAt) continue;
			const [term, course, file] = rel.split("/");
			const folder = await courseFolder(this.io(), term ?? "", course ?? "");
			if (!folder || !file) continue;
			this.data.state.notebooks[rel] = { ...nb, course: folder, name: file.replace(/\.note$/, ""), changedAt: nb.changedAt ?? {} };
		}
	}

	private extrasPath(): string {
		return `${this.manifest.dir}/transcripts.json`;
	}

	private async loadExtras(): Promise<Extras> {
		try {
			return JSON.parse(await this.app.vault.adapter.read(this.extrasPath()));
		} catch {
			return {};
		}
	}

	private async conceptMap(): Promise<Map<string, Set<string>>> {
		if (!this.concepts) this.concepts = await noteConcepts(this.io(), Object.values(this.data.state.notebooks).filter((n) => n.course), this.extras);
		return this.concepts;
	}

	/** set while rewriteNotes runs, so writes to open notes are deferred */
	private deferOpen = false;
	/** open notes whose background rewrite is waiting for them to close */
	private deferred = new Set<string>();
	/** open notes whose write was skipped because the editor did not match the saved file */
	private stale = new Set<string>();
	/** note path -> text the plugin last put into its open editor */
	private lastWritten = new Map<string, string>();

	/**
	 * Rewrites every notebook's notes from saved state, e.g. after a transcript arrives. No
	 * device needed. Notes open in an editor are skipped and rewritten once they are closed,
	 * since each edit to an open note nudges its view.
	 */
	private async rewriteNotes() {
		this.deferOpen = true;
		try {
			await this.rewriteAll();
		} finally {
			this.deferOpen = false;
		}
	}

	private async rewriteAll() {
		this.concepts = null;
		const concepts = await this.conceptMap();
		const notebookFolders = new Set<string>();
		for (const [rel, nb] of Object.entries(this.data.state.notebooks)) {
			if (!nb.course) continue;
			notebookFolders.add(layoutOf(nb).datedFolder);
			const out = await writeNotebookNotes(this.io(), nb, this.extras, concepts);
			this.data.state.notebooks[rel] = { ...nb, notes: out.holding };
		}
		await writeCourseIndexes(this.io(), notebookFolders, concepts);
		await this.save();
	}

	/**
	 * Transcribes one page whose transcript is missing or older than its ink, newest pages
	 * first, once the page has not changed for stableSeconds. Runs one page at a time.
	 */
	private async transcribeNext() {
		if (!this.data.settings.transcribe) return;
		// Each batch started in this call is added to `transcribing` before the next is chosen.
		while (this.inflight < TRANSCRIBE_PARALLEL && this.startBatch()) {
			/* started one */
		}
	}

	private inflight = 0;

	/** Starts one transcription batch; returns false when no page is ready. */
	private startBatch(): boolean {
		const now = Date.now();
		const stable = this.data.settings.stableSeconds * 1000;
		// Pages of a note that is open wait until it is closed, so writing and annotating are not interrupted.
		const open = new Set(
			this.app.workspace
				.getLeavesOfType("markdown")
				.map((l) => (l.view instanceof MarkdownView ? l.view.file?.path : undefined))
				.filter((p): p is string => !!p),
		);
		const isOpen = (folder: string, index: string, date: string | undefined) =>
			open.has(index) || (!!date && [...open].some((p) => p.startsWith(`${folder}/`) && p.endsWith(`${date}.md`)));
		const candidates: { pageid: string; hash: string; png: string; context: string; rel: string }[] = [];
		for (const [rel, nb] of Object.entries(this.data.state.notebooks)) {
			if (!nb.course) continue;
			const layout = layoutOf(nb);
			const pngs = pagePngs(layout.assetDir, Object.keys(nb.pages));
			for (const [pageid, hash] of Object.entries(nb.pages)) {
				if (this.extras[pageid]?.hash === hash || nb.blank?.[pageid] || this.transcribing.has(pageid)) continue;
				const date = /^P(\d{4})(\d{2})(\d{2})/.exec(pageid);
				// Pages a command asked for (processNote) do not wait.
				if (!this.requested.has(pageid)) {
					if (isOpen(layout.datedFolder, layout.indexPath, date ? `${date[1]}-${date[2]}-${date[3]}` : undefined)) continue;
					if (now - (nb.changedAt?.[pageid] ?? 0) < stable) continue;
					if (now - (this.failed.get(pageid) ?? 0) < RETRY_MS) continue;
				}
				candidates.push({ pageid, hash, png: pngs.get(pageid)!, context: layout.label, rel });
			}
		}
		if (!candidates.length) return false;
		// Requested pages first, then newest first; the rest of the batch comes from the same notebook.
		candidates.sort((a, b) => Number(this.requested.has(b.pageid)) - Number(this.requested.has(a.pageid)) || b.pageid.localeCompare(a.pageid));
		const batch = candidates.filter((c) => c.rel === candidates[0].rel).slice(0, TRANSCRIBE_BATCH);
		for (const b of batch) this.transcribing.add(b.pageid);
		this.inflight++;
		this.render();
		this.runBatch(batch);
		return true;
	}

	private async runBatch(batch: { pageid: string; hash: string; png: string; context: string }[]) {
		try {
			const adapter = this.app.vault.adapter as FileSystemAdapter;
			const claude = await findClaude(this.data.settings.claudePath);
			const known = [...new Set(Object.values(this.extras).flatMap((e) => e.concepts))].slice(0, 400);
			const results = await transcribePages(
				claude,
				this.data.settings.model,
				batch.map((b) => adapter.getFullPath(b.png)),
				batch[0].context,
				known,
			);
			batch.forEach((b, i) => (this.extras[b.pageid] = { hash: b.hash, ...results[i] }));
			// A failed rewrite must not block later ones, so the chain continues after errors.
			this.rewriting = this.rewriting.catch(() => undefined).then(async () => {
				await adapter.write(this.extrasPath(), JSON.stringify(this.extras));
				await this.rewriteNotes();
			});
			await this.rewriting;
		} catch (e) {
			console.error("supersidian: transcription failed", batch.map((b) => b.pageid), e);
			for (const b of batch) this.failed.set(b.pageid, Date.now());
		} finally {
			for (const b of batch) {
				this.transcribing.delete(b.pageid);
				this.requested.delete(b.pageid);
			}
			this.inflight--;
			this.render();
		}
	}

	/** pages a command asked to transcribe now, even while their note is open */
	private requested = new Set<string>();

	/** The tablet pages shown in the active dated note, with their current hashes. */
	private activePages(): { pageid: string; hash: string }[] | null {
		const file = this.app.workspace.getActiveFile();
		const date = file && /(\d{4}-\d{2}-\d{2})\.md$/.exec(file.path)?.[1];
		if (!file || !date) return null;
		const out: { pageid: string; hash: string }[] = [];
		for (const nb of Object.values(this.data.state.notebooks)) {
			if (!nb.course || !file.path.startsWith(`${layoutOf(nb).datedFolder}/`)) continue;
			for (const [pageid, hash] of Object.entries(nb.pages)) {
				if (pageid.slice(1, 9) === date.replace(/-/g, "") && !nb.blank?.[pageid]) out.push({ pageid, hash });
			}
		}
		return out;
	}

	/**
	 * Brings the active note fully up to date: syncs the tablet, then transcribes its pages that
	 * have no transcript for their current ink (all of them with `again`), which also rewrites
	 * topics and concept tags. One notice shows the progress throughout.
	 */
	private async processNote(again: boolean) {
		if (!this.activePages()) {
			new Notice("Open a dated lecture note first.");
			return;
		}
		if (!this.data.settings.transcribe) {
			new Notice("Transcription is off in the Supersidian settings.");
			return;
		}
		const progress = new Progress(again ? "Supernote: transcribing this note again" : "Supernote: processing this note");
		try {
			await this.sync({ manual: true, progress });
			const pages = this.activePages() ?? [];
			const todo = pages.filter((p) => again || this.extras[p.pageid]?.hash !== p.hash);
			if (!todo.length) {
				progress.done(pages.length ? "Supernote: this note is up to date." : "Supernote: this note has no pages yet.");
				return;
			}
			for (const p of todo) {
				if (again) delete this.extras[p.pageid];
				this.failed.delete(p.pageid);
				this.requested.add(p.pageid);
			}
			this.transcribeNext();
			const n = todo.length;
			const label = `${n} page${n === 1 ? "" : "s"}`;
			const deadline = Date.now() + PROCESS_TIMEOUT_MS;
			for (;;) {
				const left = todo.filter((p) => this.requested.has(p.pageid)).length;
				progress.step(n - left, n, left ? `transcribing ${label} with Claude` : "updating the note");
				if (!left) break;
				if (Date.now() > deadline) throw new Error(`transcription took over ${PROCESS_TIMEOUT_MS / 60_000} minutes`);
				await new Promise((r) => window.setTimeout(r, 500));
			}
			await this.rewriting;
			// The rewrite after a transcription batch skips open notes (rewriteNotes); this command
			// was run on the open note, so it is rewritten now, through its editor.
			await this.rewriteAll();
			const failed = todo.filter((p) => this.extras[p.pageid]?.hash !== p.hash).length;
			if (failed) progress.fail(`Supernote: ${failed} of ${label} failed to transcribe (see the developer console).`);
			else progress.done(`Supernote: transcribed ${label}; topics and concepts updated.`);
		} catch (e) {
			progress.fail(`Supernote: ${e instanceof Error ? e.message : e}`);
		}
	}

	/**
	 * Recolors page images to the theme's text color. Each image is used as a CSS mask over a
	 * var(--text-normal) background (see styles.css), so ink follows light and dark themes.
	 */
	private styleInk() {
		const PAGE = /\/assets\/[^?]*\/\d{8}-\d{6}(-\d{6})?\.png(\?|$)/;
		const tag = (img: HTMLImageElement) => {
			if (!PAGE.test(decodeURI(img.src))) return;
			img.classList.add("supersidian-ink");
			// refreshImages may have set an old-and-new mask pair that already includes this source.
			if (!img.style.getPropertyValue("--supersidian-src").includes(img.src.replace(/"/g, "%22"))) {
				img.style.setProperty("--supersidian-src", `url("${img.src.replace(/"/g, "%22")}")`);
			}
		};
		document.querySelectorAll<HTMLImageElement>("img").forEach(tag);
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				if (r.type === "attributes" && r.target instanceof HTMLImageElement) tag(r.target);
				r.addedNodes.forEach((n) => {
					if (n instanceof HTMLImageElement) tag(n);
					else if (n instanceof HTMLElement) n.querySelectorAll<HTMLImageElement>("img").forEach(tag);
				});
			}
		});
		observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
		this.register(() => observer.disconnect());
	}

	private inboxBusy = false;
	private schoolBusy = false;

	/**
	 * Applies tasks checked in Home.md to Deadlines.md, gives new deadlines ids, and rewrites
	 * Home.md's managed block (today's lectures, overdue, next 14 days).
	 */
	private async refreshSchool(apply?: (items: Deadline[]) => boolean) {
		if (!this.data.settings.dashboard || this.schoolBusy) return;
		this.schoolBusy = true;
		try {
			const vault = this.io();
			if (!(await vault.exists(DEADLINES))) return;
			const text = await vault.read(DEADLINES);
			const file = parseDeadlines(text);
			let dirty = file.dirty;
			const home = (await vault.exists(HOME)) ? await vault.read(HOME) : null;
			for (const id of home ? checkedInHome(home) : []) {
				const item = file.items.find((d) => d.id === id);
				if (item && !item.done) {
					item.done = true;
					dirty = true;
				}
			}
			if (apply && apply(file.items)) dirty = true;
			// Rewrite Deadlines.md only for a real change, so typing a new item is not reformatted mid-edit.
			if (dirty) {
				const next = formatDeadlines(file);
				if (next !== text) await vault.write(DEADLINES, next);
			}
			if (home !== null) {
				const today = isoDate(new Date());
				const next = applyHome(
					home,
					homeBlock({
						items: file.items,
						today,
						lectures: await this.lecturesOn(today),
						recent: await this.recentLectures(today),
						followUps: await this.followUps(today),
						status: this.statusLine(),
					}),
				);
				if (next !== home) await vault.write(HOME, next);
			}
		} catch (e) {
			console.error("supersidian: dashboard", e);
		} finally {
			this.schoolBusy = false;
		}
	}

	/** Course folders <TERM>/<COURSE> under term folders such as 2A and 1B. */
	private async courseFolders(): Promise<{ path: string; name: string }[]> {
		const vault = this.io();
		const out: { path: string; name: string }[] = [];
		for (const term of (await vault.list("")).folders) {
			const t = term.replace(/^\/+/, "");
			if (!/^\d[AB]$/i.test(t)) continue;
			for (const c of (await vault.list(t)).folders) {
				const p = c.replace(/^\/+/, "");
				out.push({ path: p, name: p.split("/").pop()! });
			}
		}
		return out;
	}

	/** Dated notes for `date` in any <TERM>/<COURSE>/<folder>/, sorted by the class time in the note. */
	private async lecturesOn(date: string): Promise<Lecture[]> {
		const vault = this.io();
		const found: (Lecture & { minutes: number })[] = [];
		for (const { path: c, name: courseName } of await this.courseFolders()) {
			for (const sub of (await vault.list(c)).folders) {
				for (const f of (await vault.list(sub)).files) {
					if (!f.endsWith(`${date}.md`)) continue;
					const text = await vault.read(f);
					// "CS241E", or "ECE222 lab" for a class that is not a lecture; the time is shown beside it.
					const section = f.replace(/^\/+/, "").split("/")[2] ?? "";
					const kind = { Tutorials: " tutorial", Labs: " lab" }[section] ?? "";
					// Only scheduled classes: notes the plugin created for a day's pages have no time.
					const minutes = classStart(text);
					if (minutes === null) continue;
					// "· 11:30 AM–12:50 PM, MC 2066 ·" on the note's course line
					const when = /· (\d{1,2}:\d{2} ?[AP]M[^·\n]*?)(?: ·|\n|$)/.exec(text)?.[1]?.trim();
					found.push({ path: f.replace(/^\/+/, ""), label: `${courseName}${kind}`, when, minutes });
				}
			}
		}
		return found.sort((a, b) => a.minutes - b.minutes).map(({ path, label, when }) => ({ path, label, when }));
	}

	/** The latest dated note with handwriting in each current course, newest first. */
	private async recentLectures(today: string): Promise<RecentLecture[]> {
		const vault = this.io();
		// Candidate notes per course, newest first; the first scheduled class (its course line has a
		// time, see lecturesOn) is the course's latest lecture. Past terms (over 120 days) are skipped.
		const byCourse = new Map<string, { path: string; date: string }[]>();
		for (const nb of Object.values(this.data.state.notebooks)) {
			if (!nb.course) continue;
			for (const note of nb.notes ?? []) {
				const date = /(\d{4}-\d{2}-\d{2})\.md$/.exec(note)?.[1];
				if (!date || date > today || daysApart(date, today) > 120) continue;
				byCourse.set(nb.course, [...(byCourse.get(nb.course) ?? []), { path: note, date }]);
			}
		}
		const out: RecentLecture[] = [];
		for (const [course, notes] of byCourse) {
			let found: { path: string; date: string; text: string } | null = null;
			for (const n of notes.sort((a, b) => b.date.localeCompare(a.date))) {
				if (!(await vault.exists(n.path))) continue;
				const text = await vault.read(n.path);
				if (classStart(text) !== null) {
					found = { ...n, text };
					break;
				}
			}
			if (!found) continue;
			const { path, date, text } = found;

			const section = /^## Topics[ \t]*\n([^]*?)(?=^## |<!-- supersidian:begin|(?![^]))/m.exec(text)?.[1] ?? "";
			const topics = section
				.split("\n")
				.map((l) => /^\s*- (.+)$/.exec(l)?.[1]?.trim())
				.filter((t): t is string => !!t && t !== "[ ]");
			out.push({ path, label: `${course.split("/").pop()} · ${dateLabel(date)}`, date, topics });
		}
		return out.sort((a, b) => b.date.localeCompare(a.date));
	}

	/** Unchecked, non-empty items under "## Questions / follow-ups" in this term's dated notes up to today. */
	private async followUps(today: string): Promise<FollowUp[]> {
		const vault = this.io();
		const out: (FollowUp & { date: string })[] = [];
		for (const { path: c, name: courseName } of await this.courseFolders()) {
			for (const sub of (await vault.list(c)).folders) {
				for (const f of (await vault.list(sub)).files) {
					const date = /(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1];
					if (!date || date > today) continue;
					const text = await vault.read(f);
					const section = /^## Questions[^\n]*\n([^]*?)(?=^## |(?![^]))/m.exec(text)?.[1] ?? "";
					for (const line of section.split("\n")) {
						const q = /^\s*- \[ \] (.*\S)/.exec(line)?.[1];
						if (q) out.push({ path: f.replace(/^\/+/, ""), label: `${courseName} ${dateLabel(date)}`, text: q, date });
					}
				}
			}
		}
		return out.sort((a, b) => b.date.localeCompare(a.date)).map(({ path, label, text }) => ({ path, label, text }));
	}

	/** "Tablet connected · 12 pages waiting for transcription", or null before the first sync. */
	private statusLine(): string | null {
		if (!this.data.lastSync) return null;
		let waiting = 0;
		for (const nb of Object.values(this.data.state.notebooks)) {
			for (const [pageid, hash] of Object.entries(nb.pages)) {
				if (!nb.blank?.[pageid] && this.extras[pageid]?.hash !== hash) waiting++;
			}
		}
		// No "synced N min ago" here: it would rewrite Home.md every minute.
		const parts = [this.status.kind === "absent" ? "Tablet not connected" : "Tablet connected"];
		if (this.data.settings.transcribe && waiting) parts.push(`${waiting} page${waiting === 1 ? "" : "s"} waiting for transcription`);
		return parts.join(" · ");
	}

	/** Runs the Gmail check through Claude Code and applies its results to Deadlines.md. */
	private async inboxNow(manual: boolean) {
		if ((!this.data.settings.inbox && !manual) || this.inboxBusy) return;
		const vault = this.io();
		if (!(await vault.exists(DEADLINES))) return;
		this.inboxBusy = true;
		const started = new Date();
		let progress: Progress | undefined;
		try {
			const today = isoDate(started);
			const recent = isoDate(new Date(started.getTime() - 14 * 86_400_000));
			const parsed = parseDeadlines(await vault.read(DEADLINES));
			// Ids are only stable once refreshSchool has written them to the file.
			if (parsed.dirty) return;
			const items = parsed.items;
			const open = items.filter((d) => !d.done && d.date >= recent);
			// Course folders that have dated notes are this term's; the prompt and links use their names.
			const current = new Map<string, string>();
			for (const c of await this.courseFolders()) {
				const subs = (await vault.list(c.path)).folders;
				for (const sub of subs) if ((await vault.list(sub)).files.some((f) => /\d{4}-\d{2}-\d{2}\.md$/.test(f))) current.set(c.name, c.path);
			}
			const courses = [...current.keys()];
			const since = this.data.lastInbox ?? recent;
			progress = manual ? new Progress("Supernote: checking email") : undefined;
			progress?.status("Claude is reading recent course email");
			const claude = await findClaude(this.data.settings.claudePath);
			const actions = await checkInbox(claude, this.data.settings.model, open, courses, since);
			const messages: string[] = [];
			await this.refreshSchool((all) => {
				let changed = false;
				for (const a of actions.update) {
					const d = all.find((x) => x.id === a.id);
					if (!d || d.date === a.date) continue;
					d.detail.push(`✉️ Due date moved from ${d.date} (${today}): ${a.evidence}`);
					d.date = a.date;
					messages.push(`📅 ${plainTitle(d.title)} → ${a.date}`);
					changed = true;
				}
				for (const a of actions.add) {
					const taken = new Set(all.map((x) => x.id));
					let id: string;
					do id = `dl-${Math.random().toString(36).slice(2, 8)}`;
					while (taken.has(id));
					const course = a.course.trim();
					const folder = current.get(course);
					const link = folder ? `[[${folder}/${course}|${course}]] ` : "";
					all.push({ id, done: false, date: a.date, title: `${link}${a.title.trim()}`, detail: [a.detail?.trim(), `✉️ Added from email (${today}): ${a.evidence}`].filter(Boolean) as string[] });
					messages.push(`➕ ${a.title.trim()} (${a.date})`);
					changed = true;
				}
				return changed;
			});
			this.data.lastInbox = today;
			await this.save();
			for (const m of messages) new Notice(m, 8000);
			progress?.done(messages.length ? `Supernote: ${messages.length} deadline change${messages.length === 1 ? "" : "s"} from email.` : "Supernote: no new deadlines or date changes in email.");
		} catch (e) {
			console.error("supersidian: inbox", e);
			const text = `Email check failed: ${e instanceof Error ? e.message : e}`;
			if (progress) progress.fail(text);
			else if (manual) new Notice(text);
		} finally {
			this.inboxBusy = false;
		}
	}

	private calendarBusy = false;

	/**
	 * Mirrors deadlines from yesterday onward to Google Calendar, CALENDAR_BATCH items per run,
	 * skipping items whose event already matches their current signature.
	 */
	private async calendarNow(manual: boolean) {
		if ((!this.data.settings.calendar && !manual) || this.calendarBusy) return;
		const vault = this.io();
		if (!(await vault.exists(DEADLINES))) return;
		this.calendarBusy = true;
		let progress: Progress | undefined;
		try {
			const synced = (this.data.calendar ??= {});
			const from = isoDate(new Date(Date.now() - 86_400_000));
			const parsed = parseDeadlines(await vault.read(DEADLINES));
			if (parsed.dirty) return;
			const pending = parsed.items.filter((d) => d.date >= from && synced[d.id]?.sig !== signature(d))
				.slice(0, CALENDAR_BATCH);
			if (!pending.length) {
				if (manual) new Notice("Google Calendar is up to date.");
				return;
			}
			progress = manual ? new Progress("Supernote: syncing Google Calendar") : undefined;
			progress?.status(`Claude is updating ${pending.length} event${pending.length === 1 ? "" : "s"}`);
			const claude = await findClaude(this.data.settings.claudePath);
			const entries = await syncCalendar(claude, this.data.settings.model, pending.map((d) => ({ d, eventId: synced[d.id]?.eventId })));
			for (const e of entries) {
				const d = pending.find((x) => x.id === e.id);
				if (d) synced[d.id] = { eventId: e.eventId, sig: signature(d) };
			}
			await this.save();
			progress?.done(`Google Calendar: ${entries.length} event${entries.length === 1 ? "" : "s"} synced.`);
		} catch (e) {
			console.error("supersidian: calendar", e);
			const text = `Calendar sync failed: ${e instanceof Error ? e.message : e}`;
			if (progress) progress.fail(text);
			else if (manual) new Notice(text);
		} finally {
			this.calendarBusy = false;
		}
	}

	/** The result of a manual sync, for its notice. */
	private report(results: NotebookResult[]): string {
		const rendered = results.reduce((n, r) => n + r.rendered, 0);
		const notes = results.flatMap((r) => r.notesUpdated);
		if (!rendered && !notes.length) return "Supernote: nothing new.";
		const names = notes.map((n) => path.basename(n, ".md"));
		const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
		return `Supernote: ${rendered} page${rendered === 1 ? "" : "s"} rendered` + (notes.length ? `, updated ${shown}` : "");
	}

	/** Config the tablet plugin reads for HTTPS sync; written over USB when it changes. */
	private tabletConfig = "";

	/** Gives the tablet the address and token for HTTPS sync, through adb while the cable is in. */
	private async giveTabletConfig() {
		const url = this.data.settings.pushUrl.replace(/\/+$/, "");
		if ((await adbDevice())?.wireless !== false) return;
		const liveUrl = this.data.settings.pushLiveUrl.replace(/\/+$/, "");
		const json = JSON.stringify(url ? { url, ...(liveUrl ? { liveUrl } : {}), token: this.data.pushToken } : {});
		if (json === this.tabletConfig) return;
		await adbShell(`echo ${shellArg(json)} > ${TABLET_CONFIG}`);
		this.tabletConfig = json;
	}

	private setStatus(s: Status) {
		// Home.md says whether the tablet is connected.
		const connected = (x: Status) => x.kind !== "absent";
		if (connected(s) !== connected(this.status)) window.setTimeout(() => this.refreshSchool(), 0);
		this.status = s;
		this.render();
	}

	private render() {
		if (!this.statusEl) return;
		const s = this.status;
		let text: string;
		let title = "Click to sync now";
		if (s.kind === "absent") {
			text = "Supernote · not connected";
		}
		else if (s.kind === "error") {
			text = "Supernote · error";
			title = `${s.message}\nClick to retry`;
		} else {
			// "syncing" keeps the idle text so the status bar does not change on every 1 s poll.
			text = `Supernote · ${this.link} · synced ${ago(this.data.lastSync)}`;
			if (s.kind === "syncing") title = `Syncing ${s.what}`;
			const n = this.transcribing.size;
			if (n) {
				text += ` · transcribing ${n} page${n === 1 ? "" : "s"}`;
				title = "Claude is transcribing pages whose ink changed; topics and concepts update after";
			}
		}
		if (this.pushError) title = `${this.pushError}\n${title}`;
		// Touch the DOM only when something changed, so polling does not redraw the status bar.
		if (this.statusEl.getText() !== text) this.statusEl.setText(text);
		if (this.statusEl.getAttr("aria-label") !== title) this.statusEl.setAttr("aria-label", title);
	}
}

/** Width of the eraser line drawn while erasing, in page pixels. */
const ERASER_PAGE_PX = 24;

/**
 * How close (page pixels) an eraser sample must come to a stroke's centre line, beyond half the
 * stroke's width, to erase it. The tablet's own rule is not known; erased strokes in saved files
 * were within 2.2 px of the eraser's samples.
 */
const ERASE_REACH_PX = 6;

/** How long a stroke's pen points wait for the message naming its page before they are drawn on the last known page. */
const PEN_META_WAIT_MS = 1000;

/** Where the tablet plugin reads the HTTPS sync address and token (tablet/uplink.ts). */
const TABLET_CONFIG = "/sdcard/Note/.supersidian.json";

/** Without adb, the tablet counts as connected this long after its last HTTPS request. */
const PUSH_FRESH_MS = 30 * 60_000;

/** "Process this note now" gives up waiting for its transcripts after this long. */
const PROCESS_TIMEOUT_MS = 10 * 60_000;

/** One notebook sync may take this long (large archive notebooks render in about a minute). */
const SYNC_TIMEOUT_MS = 180_000;

/** Rejects if `promise` has not settled after `ms`. */
function withTimeout<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
		promise.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Replaces the lines of the editor's text that differ from `next`, as separate changes (see
 * lineChanges), so lines both have (page images on screen) stay in place. A single span from the
 * first difference to the last covered everything between an edit to Topics and one lower down,
 * which re-created the images in view and made the note jump. Returns false when nothing changed.
 */
function replaceChanged(editor: Editor, next: string): boolean {
	const changes = lineChanges(editor.getValue(), next);
	if (!changes.length) return false;
	// Straight to CodeMirror: Editor.replaceRange also scrolls the cursor into view, which moved
	// the note to wherever the cursor was (usually the top) on every plugin edit.
	const cm = (editor as unknown as { cm?: EditorView }).cm;
	if (cm) cm.dispatch(cm.state.update({ changes }));
	else for (const c of [...changes].reverse()) editor.replaceRange(c.insert, editor.offsetToPos(c.from), editor.offsetToPos(c.to));
	return true;
}

/** Whole days from one YYYY-MM-DD date to a later one. */
function daysApart(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function ago(t: number | null): string {
	if (!t) return "never";
	const s = Math.round((Date.now() - t) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	return `${Math.floor(s / 3600)}h ago`;
}

class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: Supersidian) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.data.settings;

		new Setting(containerEl).setName("Tablet").setHeading();

		new Setting(containerEl)
			.setName("Python interpreter")
			.setDesc("Absolute path to a Python with supernotelib installed.")
			.addText((t) =>
				t.setValue(s.pythonPath).onChange(async (v) => {
					s.pythonPath = v.trim() || DEFAULT_SETTINGS.pythonPath;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc("How often to check the tablet over USB, and the notebooks it sent over Tailscale, for changes.")
			.addText((t) =>
				t.setValue(String(s.pollSeconds)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n) || n < 1) return;
					s.pollSeconds = n;
					await this.plugin.save();
					this.plugin.schedule();
				}),
			);

		new Setting(containerEl)
			.setName("Sync address without the cable")
			.setDesc("This computer's HTTPS address on Tailscale, served by `tailscale serve --bg --https=8443 http://127.0.0.1:47300`, e.g. https://laptop.tailnet.ts.net:8443. The tablet gets it, with a secret token, the next time the cable is in. Empty turns this off.")
			.addText((t) =>
				t.setValue(s.pushUrl).onChange(async (v) => {
					s.pushUrl = v.trim();
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Live ink address")
			.setDesc("A second HTTPS port for strokes as you write, e.g. https://laptop.tailnet.ts.net:10000 served by `tailscale serve --bg --https=10000 http://127.0.0.1:47300`. Requests to one address share one connection, so without it a notebook upload delays live ink. Empty uses the address above.")
			.addText((t) =>
				t.setValue(s.pushLiveUrl).onChange(async (v) => {
					s.pushLiveUrl = v.trim();
					await this.plugin.save();
				}),
			);

		new Setting(containerEl).setName("Transcription").setHeading();

		new Setting(containerEl)
			.setName("Transcribe pages")
			.setDesc("Use Claude Code (your own login, no API key) to transcribe each page once it is unchanged for a minute and its note is closed, fill in Topics, tag concepts and link related lectures.")
			.addToggle((t) =>
				t.setValue(s.transcribe).onChange(async (v) => {
					s.transcribe = v;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Claude model")
			.setDesc("Model passed to claude --model.")
			.addText((t) =>
				t.setValue(s.model).onChange(async (v) => {
					s.model = v.trim();
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Claude Code path")
			.setDesc("Leave empty to use ~/.local/bin/claude.")
			.addText((t) =>
				t.setValue(s.claudePath).onChange(async (v) => {
					s.claudePath = v.trim();
					await this.plugin.save();
				}),
			);

		new Setting(containerEl).setName("School").setHeading();

		new Setting(containerEl)
			.setName("Dashboard")
			.setDesc("Keep Home.md's block (today's classes, this week, coming up, recent lectures, open questions) up to date, and apply tasks checked there to Deadlines.md.")
			.addToggle((t) =>
				t.setValue(s.dashboard).onChange(async (v) => {
					s.dashboard = v;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Check email")
			.setDesc("Every 15 minutes, have Claude Code read Gmail for new deliverables and due date changes, and update Deadlines.md.")
			.addToggle((t) =>
				t.setValue(s.inbox).onChange(async (v) => {
					s.inbox = v;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Google Calendar")
			.setDesc("Mirror deadlines to your primary Google Calendar through Claude Code. Finished items get a ✅ in the event title.")
			.addToggle((t) =>
				t.setValue(s.calendar).onChange(async (v) => {
					s.calendar = v;
					await this.plugin.save();
				}),
			);
	}
}
