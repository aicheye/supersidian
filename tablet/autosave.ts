import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';
import { getConfig, onUplinkChange, sendLive, setUplinkWait, uploadNote } from './uplink';

/**
 * Saves the open notebook shortly after the pen stops, so the .note file on
 * the device (and the laptop reading it over USB) has the latest ink without
 * closing the notebook.
 */


export interface AutosaveStatus {
  penUps: number;
  /** pen-ups received while the plugin screen was closed */
  penUpsHidden: number;
  saves: number;
  lastSave: number | null;
  lastFile: string | null;
  lastError: string | null;
  /** strokes sent to the laptop for real-time drawing */
  liveSent: number;
  liveError: string | null;
}

export const status: AutosaveStatus = {
  penUps: 0,
  penUpsHidden: 0,
  saves: 0,
  lastSave: null,
  lastFile: null,
  lastError: null,
  liveSent: 0,
  liveError: null,
};

const watchers = new Set<() => void>();

/** Calls `fn` whenever the status changes; returns a function that stops it. */
export function watch(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function changed() {
  watchers.forEach(fn => fn());
}

interface Response<T> {
  success?: boolean;
  result?: T | null;
  error?: { code: number; message: string } | null;
}

function describe(res: Response<unknown> | null | undefined, what: string): string {
  if (res?.error) return `${what}: ${res.error.code} ${res.error.message}`;
  return `${what}: no result`;
}

let saving = false;
/** A save was requested during a save; save once more when it finishes. */
let pending = false;
/** Plugin lifecycle state; 2 means the plugin screen is showing. */
let lifeState = -1;

/**
 * Saves the open notebook now. Documents (PDF/EPUB) are skipped because only NOTE files can be
 * saved this way. Returns true when the note app saved; false when it declined, or when a save
 * was already running (this one then runs after it).
 */
export async function saveNow(): Promise<boolean> {
  if (saving) {
    pending = true;
    return false;
  }
  let saved = false;
  saving = true;
  pending = false;
  try {
    const path = (await PluginCommAPI.getCurrentFilePath()) as Response<string>;
    const file = path?.success ? path.result ?? null : null;
    if (!file) {
      status.lastError = describe(path, 'getCurrentFilePath');
      return false;
    }
    if (!file.toLowerCase().endsWith('.note')) return false;
    const started = Date.now();
    const res = (await PluginNoteAPI.saveCurrentNote()) as Response<boolean>;
    if (res?.success && res.result) {
      status.saves++;
      status.lastSave = Date.now();
      status.lastFile = file;
      status.lastError = null;
      saved = true;
      uploadNote(file, started);
    } else {
      status.lastError = describe(res, 'saveCurrentNote');
    }
  } catch (e) {
    status.lastError = String(e);
  } finally {
    saving = false;
    changed();
    // Chained on the promise, not a timer: React Native pauses JS timers while the plugin screen is closed.
    if (pending) saveNow();
  }
  return saved;
}

/**
 * Messages for the laptop go to the Android log, which the laptop streams over USB, and over
 * HTTPS when the laptop has given the tablet its address (uplink.ts); the laptop drops the copy
 * it gets second. Each message is split into chunks
 * "SSD1 <id> <index> <count> <kind> <JSON piece>" to stay well under the log line limit (4 KB for Log.println, 1 KB for the log shell tool).
 * The format must match startLogStream in the Obsidian plugin.
 */
let messageId = 0;
const CHUNK = 900;

function emit(kind: 'pen' | 'ink' | 'erase', payload: object) {
  const json = JSON.stringify(payload);
  const id = `${Date.now().toString(36)}${(messageId++).toString(36)}`;
  const count = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < count; i++) {
    console.log(`SSD1 ${id} ${i} ${count} ${kind} ${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  sendLive(id, kind, payload);
}

/** Screen-pixel bounding box of pen samples since the last /ink post, for the laptop to calibrate /pen positions. */
let screenBox: {minX: number; minY: number; maxX: number; maxY: number} | null = null;
/** Id of the stroke being drawn; increases on each pen-down. */
let strokeId = 0;

interface PenPost {
  stroke: number;
  points: Point[];
  end: boolean;
  file?: string;
  page?: number;
  width?: number;
  display?: {width: number; height: number};
}

/** Pen samples of the stroke being drawn that have not been sent yet. */
let penBuffer: Point[] = [];
/** Samples per pen message: 1 sends each position as soon as the tablet reports it. */
const PEN_BATCH = 1;

function flushPen(stroke: number, end: boolean) {
  if (!penBuffer.length && !end) return;
  emit('pen', {stroke, points: penBuffer, end});
  penBuffer = [];
}

/** Looks up the notebook, page and sizes for a new stroke and sends them with a post. */
async function sendStrokeMeta(stroke: number) {
  try {
    const path = (await PluginCommAPI.getCurrentFilePath()) as Response<string>;
    const page = (await PluginCommAPI.getCurrentPageNum()) as Response<number>;
    const display = (await PluginCommAPI.getPageDisplaySize()) as Response<{width: number; height: number}>;
    const pen = (await PluginCommAPI.getPenInfo()) as Response<{type: number; color: number; width: number}>;
    const file = path?.success ? path.result : null;
    const pageNum = page?.success ? page.result : null;
    if (!file || pageNum === null || pageNum === undefined || !file.toLowerCase().endsWith('.note')) return;
    const key = `${file}#${pageNum}`;
    // Save only when the pen moves to a different page: that stores the page just left
    // (including erasures) and any new page. Each save appends to the .note file, so saving
    // more often bloats it; the laptop shows strokes live in the meantime.
    pageSeen(key);
    let size = pageSizes.get(key);
    if (!size) {
      const res = (await PluginFileAPI.getPageSize(file, pageNum)) as Response<{width: number; height: number}>;
      size = res?.success && res.result ? res.result : {width: 0, height: 0};
      pageSizes.set(key, size);
    }
    emit('pen', {
      stroke,
      points: [],
      end: false,
      file,
      page: pageNum,
      width: size.width,
      display: display?.success && display.result ? display.result : undefined,
      pen: pen?.success && pen.result ? pen.result : undefined,
    });
  } catch (e) {
    status.liveError = String(e);
  }
}

interface Motion {
  action: number;
  toolType: number;
  x: number;
  y: number;
}

/** Streams pen positions while a stroke is drawn, so the laptop can draw it before pen-up. */
function onMotion(m: Motion) {
  const lifted = m.action === 1 || m.action === 3;
  // Any tap may have turned or added a page (the page buttons, a finger swipe).
  if (lifted) checkPage();
  if (m.toolType !== 2) return; // strokes come from the pen only, not fingers
  if (m.action === 0) {
    penDown = true;
    strokeId++;
    sendStrokeMeta(strokeId);
  }
  penBuffer.push({x: m.x, y: m.y});
  screenBox = screenBox
    ? {minX: Math.min(screenBox.minX, m.x), minY: Math.min(screenBox.minY, m.y), maxX: Math.max(screenBox.maxX, m.x), maxY: Math.max(screenBox.maxY, m.y)}
    : {minX: m.x, minY: m.y, maxX: m.x, maxY: m.y};
  const end = m.action === 1 || m.action === 3;
  if (end) {
    penDown = false;
    lastLift = Date.now();
    const waiting = onLift;
    onLift = [];
    waiting.forEach(r => r());
  }
  if (end || penBuffer.length >= PEN_BATCH) flushPen(strokeId, end);
  if (end) checkErase(strokeId);
}
const pageSizes = new Map<string, {width: number; height: number}>();
/** "<file>#<page>" of the last stroke, to notice page switches. */
let lastPageKey: string | null = null;

/**
 * Called with "<file>#<page>" whenever the current page is known. On a page change it saves,
 * storing the page just left (the note app saves on page turns too, but not before the plugin
 * sees the next stroke), and marks the new page so its first stroke is saved at once: a page
 * with no strokes yet is not written by a save ("mTrailNumber 0"), so until that stroke is
 * saved the laptop has no page to show.
 */
function pageSeen(key: string) {
  if (key === lastPageKey) return;
  const first = lastPageKey === null;
  lastPageKey = key;
  if (first) return;
  newPage = true;
  saveNow();
}
let newPage = false;
let checkingPage = false;

/** Reads the current page shortly after a tap, to notice page turns and new pages without a stroke. */
async function checkPage() {
  if (checkingPage) return;
  checkingPage = true;
  try {
    await waitUntil(Date.now(), 400);
    const path = (await PluginCommAPI.getCurrentFilePath()) as Response<string>;
    const page = (await PluginCommAPI.getCurrentPageNum()) as Response<number>;
    const file = path?.success ? path.result : null;
    fileSeen(file ?? null);
    if (!file || !file.toLowerCase().endsWith('.note') || !page?.success || page.result === undefined) return;
    pageSeen(`${file}#${page.result}`);
  } finally {
    checkingPage = false;
  }
}

/** The notebook open at the last tap. */
let openNote: string | null = null;

/**
 * Called with the open file after each tap. When a notebook is closed or another file opened,
 * the note app saves it; it is uploaded 2 s later, once that save is written.
 */
function fileSeen(file: string | null) {
  const note = file && file.toLowerCase().endsWith('.note') ? file : null;
  if (openNote && note !== openNote) {
    const left = openNote;
    const closedAt = Date.now();
    waitUntil(Date.now(), 2000)
      .catch(() => undefined)
      .then(() => uploadNote(left, closedAt));
  }
  openNote = note;
}

/**
 * Saves a new page once its first stroke is drawn. The note app declines a save while it is
 * still processing a stroke, and a save that runs behind another reports false, so it is
 * tried up to 3 times, 1 s apart.
 */
async function saveNewPage() {
  for (let i = 0; i < 3; i++) {
    await waitForPenIdle();
    if (await saveNow()) return;
    await waitUntil(Date.now(), 1000);
  }
}

/** Ids of recent pen motions that erased (their pen-up event carried no elements). */
const erasedStrokes = new Set<number>();

/**
 * An eraser motion's pen-up event arrives about 150 ms after the lift with no elements (a lasso
 * motion's carries its loop as a stroke; the motion events and getPenInfo report the same tool
 * for all three). The laptop is told at once, so it can show the erase before the saved file
 * arrives, and the save runs 100 ms later: the note app has recorded the erase by then. The
 * second save catches an erase the note app was still processing.
 */
async function onErase(stroke: number) {
  erasedStrokes.add(stroke);
  if (erasedStrokes.size > 100) erasedStrokes.delete(erasedStrokes.values().next().value!);
  emit('erase', {stroke});
  await waitUntil(Date.now(), 100);
  await saveNow();
  await waitUntil(Date.now(), 1200);
  await waitForPenIdle();
  await saveNow();
}

/** Ids of recent pen motions that produced a stroke (their pen-up event carried ink). */
const inkedStrokes = new Set<number>();
/** Whether the pen is touching the screen, and when it last lifted. */
let penDown = false;
let lastLift = 0;
/** Resolved at the next pen lift. */
let onLift: (() => void)[] = [];
/** Waits until `ms` after `start`. JS timers pause while the plugin screen is closed, so this
 * waits on round trips to the note app instead (each takes a few milliseconds). */
async function waitUntil(start: number, ms: number) {
  while (Date.now() - start < ms) await PluginCommAPI.getCurrentPageNum();
}

/**
 * A pen motion that produced no stroke was an eraser (or lasso) motion, and its effect exists
 * only on the tablet until the notebook is saved. The note app records an erase about 50 ms
 * after the pen lifts and declines a save while it is still processing a stroke
 * (logcat: "isGetTrailFinish false"), so the save runs 0.8 s after the lift and once more at
 * 2 s. A save with nothing new to store writes nothing ("isSave false"), so the second one
 * costs nothing when the first worked.
 */
async function checkErase(stroke: number) {
  await waitUntil(Date.now(), 800);
  // By now the pen-up event of a stroke that drew ink has arrived.
  if (inkedStrokes.has(stroke) || erasedStrokes.has(stroke)) return;
  for (let i = 0; i < 2; i++) {
    await waitForPenIdle();
    await saveNow();
    await waitUntil(Date.now(), 1200);
  }
}

/** Waits until the pen has been lifted for 0.5 s: a save while a stroke is being processed is declined. */
async function waitForPenIdle() {
  for (;;) {
    // No polling while a stroke is drawn, so the wait adds no work for the note app then.
    if (penDown) await new Promise<void>(r => onLift.push(r));
    else if (Date.now() - lastLift < 500) await PluginCommAPI.getCurrentPageNum();
    else return;
  }
}

interface Point {
  x: number;
  y: number;
}

interface StrokeElement {
  type: number;
  pageNum: number;
  stroke?: {penType?: number; penColor?: number} | null;
  contoursSrc?: {size(): Promise<number>; getRange(start: number, count: number): Promise<Point[][]>};
}

/**
 * Sends the outlines of the strokes just finished to the laptop, which draws them over the
 * page image before the saved file syncs. Failures (no USB tunnel, laptop asleep) are only
 * recorded; saving does not depend on this.
 */
async function sendInk(elements: StrokeElement[]) {
  try {
    const strokes: {contours: Point[][]; penType?: number; penColor?: number}[] = [];
    let page = -1;
    for (const el of elements) {
      if (el.type !== 0 || !el.contoursSrc) continue;
      page = el.pageNum;
      const n = await el.contoursSrc.size();
      const contours = n ? await el.contoursSrc.getRange(0, n) : [];
      strokes.push({
        contours: contours.map(c => c.map(p => ({x: p.x, y: p.y}))),
        penType: el.stroke?.penType,
        penColor: el.stroke?.penColor,
      });
    }
    if (!strokes.length) return;
    // Taken before any await, so the box and stroke id belong to these strokes.
    const box = screenBox;
    const stroke = strokeId;
    screenBox = null;
    const path = (await PluginCommAPI.getCurrentFilePath()) as Response<string>;
    const file = path?.success ? path.result : null;
    if (!file || !file.toLowerCase().endsWith('.note')) return;
    const key = `${file}#${page}`;
    let size = pageSizes.get(key);
    if (!size) {
      const res = (await PluginFileAPI.getPageSize(file, page)) as Response<{width: number; height: number}>;
      size = res?.success && res.result ? res.result : {width: 0, height: 0};
      pageSizes.set(key, size);
    }
    emit('ink', {file, page, width: size.width, height: size.height, strokes, screen: box, penStroke: stroke});
    status.liveSent += strokes.length;
    status.liveError = null;
  } catch (e) {
    status.liveError = String(e);
  }
  changed();
}

/** Registers the pen-up listener. Call once from index.js after PluginManager.init(). */
export function startAutosave() {
  onUplinkChange(changed);
  setUplinkWait(ms => waitUntil(Date.now(), ms));
  getConfig();
  PluginManager.registerMotionListener(2, {
    onMsg(msg: unknown) {
      onMotion(msg as Motion);
    },
  });
  PluginManager.registerPluginLifeListener({
    onMsg(msg: {state?: number}) {
      lifeState = msg?.state ?? -1;
    },
  });
  // registerType 2 runs this after other plugins' pen-up handlers.
  PluginManager.registerEventListener('event_pen_up', 2, {
    onMsg(msg: unknown) {
      status.penUps++;
      if (lifeState !== 2) status.penUpsHidden++;
      const elements = (msg as StrokeElement[] | null) ?? [];
      if (!elements.length) onErase(strokeId);
      if (elements.some(e => e.type === 0)) {
        if (newPage) {
          newPage = false;
          saveNewPage();
        }
        inkedStrokes.add(strokeId);
        if (inkedStrokes.size > 100) inkedStrokes.delete(inkedStrokes.values().next().value!);
      }
      sendInk(elements);
    },
  });
}

export const WRITE_PERMISSION = 'plugin.permission.FILE:WRITE';
/** INTERNET lets the plugin send notebooks and live ink to the laptop over HTTPS (uplink.ts). */
const PERMISSIONS = ['plugin.permission.FILE:READ', WRITE_PERMISSION, 'plugin.permission.INTERNET'];

/** 1 when every permission the plugin uses is granted. */
export async function permissionsGranted(): Promise<number> {
  for (const permission of PERMISSIONS) if ((await PluginManager.hasPermission(permission)) !== 1) return 0;
  return 1;
}

/** Asks for read and write access to the Note folder. Returns true when both are granted. */
export async function ensureWritePermission(): Promise<boolean> {
  for (const permission of PERMISSIONS) {
    if ((await PluginManager.hasPermission(permission)) === 1) continue;
    const result = await PluginManager.requestPermission(
      permission,
      'Supersidian saves the open notebook as you write and sends it to your laptop. Choose "Always allow".',
    );
    if (result !== 1 && result !== 2) return false;
  }
  return true;
}
