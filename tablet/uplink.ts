/**
 * Sends notebooks and live ink to the laptop over HTTPS, for syncing without the cable. The
 * laptop runs `tailscale serve` in front of the Obsidian plugin (src/push.ts), so the tablet
 * only makes outgoing requests and nothing on it listens. The address and a token are written
 * by the laptop over USB to CONFIG; without that file nothing is sent.
 *
 * While the cable is in, the laptop answers {usb: true} and the tablet stops sending, since adb
 * already pulls the notebooks and streams the log. It asks again after USB_RECHECK_MS.
 */

const CONFIG = '/sdcard/Note/.supersidian.json';
/** Bytes before the end of the laptop's copy that are sent again, so it can confirm its copy is a prefix. */
const OVERLAP = 64 * 1024;
const USB_RECHECK_MS = 10_000;
/** After a failed request, live messages are dropped for this long instead of queued. */
const RETRY_MS = 5_000;

export const uplinkStatus = {
  sent: 0,
  lastUpload: null as number | null,
  lastError: null as string | null,
  usb: false,
  configured: false,
};

/** Called whenever uplinkStatus changes, to redraw the status screen. */
let onChange = () => {};
export function onUplinkChange(fn: () => void) {
  onChange = fn;
}

/** Waits `ms`; set by autosave.ts, since JS timers pause while the plugin screen is closed. */
let wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export function setUplinkWait(fn: (ms: number) => Promise<void>) {
  wait = fn;
}


/**
 * url: where notebooks go; liveUrl: where live messages go. The laptop's tailscale serve speaks
 * HTTP/2, so requests to one address share one TCP connection, and a live message sent during a
 * notebook upload waited behind its megabytes (up to 1.1 s). A second port gets its own connection.
 */
let config: {url: string; liveUrl?: string; token: string} | null = null;
let configAt = 0;

/** Reads CONFIG, at most every 10 s while it is missing. */
export async function getConfig() {
  if (config || Date.now() - configAt < 10_000) return config;
  configAt = Date.now();
  try {
    const c = await (await fetch(`file://${CONFIG}`)).json();
    config = c?.url && c?.token ? c : null;
  } catch {
    config = null;
  }
  uplinkStatus.configured = !!config;
  onChange();
  return config;
}

let usbAt = 0;
let failedAt = 0;

async function request(method: string, path: string, body?: string | Blob, signal?: AbortSignal, live = false): Promise<Response | null> {
  const c = await getConfig();
  if (!c) return null;
  try {
    const res = await fetch(`${live ? c.liveUrl ?? c.url : c.url}${path}`, {method, body, headers: {Authorization: `Bearer ${c.token}`}, signal});
    // The laptop has a new token (it gives it to the tablet again next time the cable is in).
    if (res.status === 401) config = null;
    if (res.ok) answeredAt = Date.now();
    uplinkStatus.lastError = res.ok || res.status === 409 ? null : `${method} ${path.split('?')[0]}: HTTP ${res.status}`;
    return res;
  } catch (e) {
    failedAt = Date.now();
    uplinkStatus.lastError = `${method} ${path.split('?')[0]}: ${e}`;
    return null;
  } finally {
    onChange();
  }
}

/** Records whether the laptop says the cable is in. */
async function noteUsb(res: Response | null): Promise<unknown> {
  if (!res?.ok) return null;
  const json = await res.json().catch(() => null);
  uplinkStatus.usb = !!json?.usb;
  if (uplinkStatus.usb) usbAt = Date.now();
  return json;
}

function skip(): boolean {
  return (uplinkStatus.usb && Date.now() - usbAt < USB_RECHECK_MS) || Date.now() - failedAt < RETRY_MS;
}

/** When a request last got an answer; see ping. */
let answeredAt = 0;
const PING_MS = 60_000;

/**
 * Tells the laptop the tablet is reachable, at most every PING_MS. Called on every touch, also
 * outside notebooks, because the laptop reports the tablet as not connected after 30 minutes
 * without a request.
 */
export async function ping() {
  if (skip() || Date.now() - answeredAt < PING_MS) return;
  answeredAt = Date.now();
  await noteUsb(await request('GET', '/ping'));
}

let queue: {id: string; kind: string; payload: object; t: number}[] = [];
let inflight = false;
/** When the live request in flight started, and how to cancel it. */
let inflightAt = 0;
let inflightAbort: AbortController | null = null;
/**
 * A live request older than this is cancelled at the next message. A request cut off mid-way
 * (the laptop's plugin reloaded) never settled and held back every live message after it.
 * Checked on each message rather than with a timer, since timers pause while the plugin screen
 * is closed.
 */
const LIVE_TIMEOUT_MS = 5_000;

/**
 * Sends a live message. One request is in flight at a time and the messages queued meanwhile go
 * in the next one. (A WebSocket was tried in 0.0.30 to 0.0.32: the laptop accepted each
 * connection, but the plugin host never reported it open and nothing was sent over it.)
 */
export function sendLive(id: string, kind: string, payload: object) {
  checkUploadStuck();
  if (skip()) return;
  // t: when the tablet produced it, so the laptop can measure the delay.
  const msg = {id, kind, payload, t: Date.now()};
  queue.push(msg);
  if (inflight && Date.now() - inflightAt > LIVE_TIMEOUT_MS) inflightAbort?.abort();
  pump();
}

async function pump() {
  if (inflight || !queue.length) return;
  inflight = true;
  inflightAt = Date.now();
  inflightAbort = new AbortController();
  const batch = queue;
  queue = [];
  try {
    // s: when the batch was sent, so the laptop can tell time queued here from time in transit.
    const s = Date.now();
    const res = await request('POST', '/live', JSON.stringify(batch.map(m => ({...m, s}))), inflightAbort.signal, true);
    await noteUsb(res);
    if (res?.ok) {
      uplinkStatus.sent += batch.length;
      // The laptop answers again: send notebooks whose upload failed.
      unsent.forEach(f => uploadNote(f));
      unsent.clear();
    }
  } finally {
    inflight = false;
    // Chained on the promise: timers pause while the plugin screen is closed.
    if (skip()) queue = [];
    else pump();
  }
}

/** Waits before reading a notebook again after an upload, to catch a save still being written. */
const SETTLE_MS = [1000, 1500, 2500];
/** Size of each notebook as last sent or confirmed, so an unchanged file costs no request. */
const sentSize = new Map<string, number>();

/** Notebooks whose last upload failed; sent again once a request gets through. */
const unsent = new Set<string>();
/** Notebooks waiting for an upload, and whether one is running. */
const waiting = new Set<string>();
let uploading = false;
/** When the current upload step started, and how to cancel it; see checkUploadStuck. */
let uploadAt = 0;
/** An upload step (read, ask, send) is running, as opposed to waiting for the pen to rest. */
let uploadStep = false;
let uploadAbort = new AbortController();
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Cancels an upload step that has run for over UPLOAD_TIMEOUT_MS: a request cut off mid-way never
 * settled and held back every later upload. Called on each live message and upload request,
 * since timers pause while the plugin screen is closed.
 */
function checkUploadStuck() {
  if (uploadStep && Date.now() - uploadAt > UPLOAD_TIMEOUT_MS) {
    uplinkStatus.lastError = 'upload: no answer in 30 s, retrying';
    uploadAbort.abort();
  }
}

/** Sends the notebook's new bytes to the laptop. Uploads run one at a time. */
/**
 * When the notebook's newest save started, in the tablet's clock. The laptop keeps live strokes
 * drawn after this on screen, since the uploaded file does not have them yet. It is not the
 * upload time: an upload can run seconds after the save (see SETTLE_MS), and strokes drawn in
 * between would be removed from the laptop's screen as if they were erased.
 */
const savedTimes = new Map<string, number>();

/** Sends the notebook's new bytes to the laptop; `savedAt` is when the save that wrote them started. */
export async function uploadNote(file: string, savedAt?: number) {
  if (savedAt !== undefined) savedTimes.set(file, savedAt);
  const rel = file.split('/Note/')[1];
  if (!rel || !file.toLowerCase().endsWith('.note')) return;
  // The laptop files notebooks by term and course and answers 400 for any other path.
  if (!/^[^/]+\/[^/]+\/[^/]+\.note$/i.test(rel)) {
    uplinkStatus.lastError = `not sent: ${rel} is not in Note/<term>/<course>/`;
    onChange();
    return;
  }
  waiting.add(file);
  checkUploadStuck();
  if (uploading) return;
  uploading = true;
  try {
    while (waiting.size) {
      const next = waiting.values().next().value!;
      waiting.delete(next);
      const rel = next.split('/Note/')[1];
      // saveCurrentNote can return before the note app has written everything (a new page was
      // sometimes missing), so the file is read again until its size stops changing.
      let last = await uploadOne(next, rel, 0);
      for (const [i, ms] of SETTLE_MS.entries()) {
        if (last === null) break;
        await wait(ms);
        const size = await uploadOne(next, rel, i + 1);
        if (size === last) break;
        last = size;
      }
    }
  } finally {
    uploading = false;
  }
}

/** Sends what the laptop lacks of one notebook; returns the file's size, or null when nothing could be sent. */
async function uploadOne(file: string, rel: string, attempt: number): Promise<number | null> {
  uploadStep = true;
  try {
    return await uploadStepRun(file, rel, attempt);
  } finally {
    uploadStep = false;
  }
}

/**
 * Counts for checking whether the re-reads after a save (SETTLE_MS) find anything: reads of a
 * notebook, total time spent reading, and uploads per attempt (0 is the read right after the save).
 */
const readStats = {reads: 0, readMs: 0, sentByAttempt: [0, 0, 0, 0]};

async function uploadStepRun(file: string, rel: string, attempt: number): Promise<number | null> {
  if (uplinkStatus.usb && Date.now() - usbAt < USB_RECHECK_MS) return null;
  uploadAt = Date.now();
  uploadAbort = new AbortController();
  const signal = uploadAbort.signal;
  const savedAt = savedTimes.get(file) ?? Date.now();
  let blob: Blob;
  try {
    const t0 = Date.now();
    blob = await (await fetch(`file://${file}`, {signal})).blob();
    readStats.reads++;
    readStats.readMs += Date.now() - t0;
  } catch (e) {
    uplinkStatus.lastError = `read ${rel}: ${e}`;
    return null;
  }
  const size = blob.size;
  if (sentSize.get(file) === size) return size;
  const q = `rel=${encodeURIComponent(rel)}`;
  const have = (await noteUsb(await request('GET', `/have?${q}`, undefined, signal))) as {size?: number; usb?: boolean} | null;
  if (!have) {
    if (config) unsent.add(file);
    return null;
  }
  if (have.usb) return null;
  const known = have.size ?? 0;
  if (known === size) {
    sentSize.set(file, size);
    return size;
  }
  // The file grew: send from a little before the laptop's end. Otherwise it was rewritten.
  let from = known > 0 && size > known ? Math.max(0, known - OVERLAP) : 0;
  for (;;) {
    readStats.sentByAttempt[attempt]++;
    const stats = encodeURIComponent(JSON.stringify({attempt, ...readStats}));
    const res = await request('POST', `/note?${q}&from=${from}&size=${size}&savedAt=${savedAt}&stats=${stats}`, from ? blob.slice(from) : blob, signal);
    if (res?.status === 409 && from > 0) {
      from = 0;
      continue;
    }
    await noteUsb(res);
    if (res?.ok) {
      sentSize.set(file, size);
      uplinkStatus.lastUpload = Date.now();
      onChange();
      return size;
    }
    unsent.add(file);
    if (res) uplinkStatus.lastError = `upload ${rel}: HTTP ${res.status}`;
    return null;
  }
}
