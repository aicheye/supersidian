import { promises as fs } from "fs";
import * as http from "http";
import * as path from "path";
import { DeviceNotebook, cachePath } from "./core";

/**
 * Receives notebooks and live ink from the tablet without adb on the network. The tablet plugin
 * sends HTTPS requests to this machine's Tailscale name; `tailscale serve` terminates TLS and
 * passes them to this server on 127.0.0.1, so nothing listens on the tablet and nothing here
 * listens beyond localhost. Requests carry a token the laptop gives the tablet over USB.
 *
 * - GET /have?rel=<rel>: bytes of the notebook already held here, and whether USB is in (the
 *   tablet then sends nothing, since adb covers both notebooks and live ink).
 * - POST /note?rel=<rel>&from=<n>&size=<total>&savedAt=<ms>: the notebook's bytes from `from`.
 *   `from` is at most OVERLAP bytes before the end of the copy here; those bytes are compared to
 *   confirm the copy is a prefix of the tablet's file (a save only appends, a compaction
 *   rewrites). 409 means the copy is not a prefix and the whole file must be sent.
 * - POST /live: a JSON array of {id, kind, payload}, the same messages the tablet writes to
 *   the Android log for the logcat stream.
 */

export const PUSH_PORT = 47300;
const OVERLAP = 64 * 1024;
const MAX_BODY = 512 * 1024 * 1024;

export interface PushedNotebook {
	rel: string;
	size: number;
	/** the tablet's upload counters (tablet/uplink.ts readStats), for checking its upload cost */
	stats?: unknown;
	/** the tablet's clock when it saved */
	savedAt: number;
}

export interface PushHandlers {
	token: () => string;
	/** true while the tablet is on USB; pushes are then declined */
	usb: () => Promise<boolean>;
	/** `t` and `s` are the tablet's clock when it produced the message and when it sent it */
	live: (id: string, kind: string, payload: unknown, t?: number, s?: number) => void;
	notebook: (nb: PushedNotebook) => void;
	error: (e: Error) => void;
}

/** Notebooks received since Obsidian started, and when the tablet last made any request. */
export const pushed = new Map<string, PushedNotebook>();
export let lastContact = 0;

/** A notebook path relative to the tablet's Note folder: <term>/<course>/<name>.note. */
function validRel(rel: string | null): rel is string {
	return !!rel && /^[^/]+\/[^/]+\/[^/]+\.note$/.test(rel) && !rel.split("/").includes("..");
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (d: Buffer) => {
			size += d.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(d);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function reply(res: http.ServerResponse, code: number, body: object) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Writes the new copy of a notebook next to the old one and renames it over, so readers never see a partial file. */
async function storeNote(rel: string, from: number, size: number, body: Buffer): Promise<boolean> {
	const file = cachePath(rel);
	await fs.mkdir(path.dirname(file), { recursive: true });
	let next: Buffer;
	if (from === 0) next = body;
	else {
		const old = await fs.readFile(file).catch(() => null);
		if (!old || from > old.length) return false;
		const overlap = old.length - from;
		if (body.length < overlap || !body.subarray(0, overlap).equals(old.subarray(from))) return false;
		next = Buffer.concat([old.subarray(0, from), body]);
	}
	if (next.length !== size) return false;
	const tmp = `${file}.part`;
	await fs.writeFile(tmp, next);
	await fs.rename(tmp, file);
	return true;
}

/** Starts the server on 127.0.0.1:PUSH_PORT; returns a function that stops it. */
export function startPushServer(h: PushHandlers): () => void {
	// Uploads of one notebook run one at a time, since each builds on the last copy.
	const queues = new Map<string, Promise<unknown>>();
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (!h.token() || req.headers.authorization !== `Bearer ${h.token()}`) return reply(res, 401, { error: "token" });
			lastContact = Date.now();
			const usb = await h.usb();
			const rel = url.searchParams.get("rel");
			if (req.method === "GET" && url.pathname === "/have") {
				if (!validRel(rel)) return reply(res, 400, { error: "rel" });
				const st = await fs.stat(cachePath(rel)).catch(() => null);
				return reply(res, 200, { size: st?.size ?? 0, usb });
			}
			if (req.method === "POST" && url.pathname === "/live") {
				const body = await readBody(req);
				// Over USB the logcat stream delivers the same messages; taking both could reorder pen points.
				if (!usb) {
					for (const m of JSON.parse(body.toString("utf8")) as { id: string; kind: string; payload: unknown; t?: number; s?: number }[]) h.live(m.id, m.kind, m.payload, m.t, m.s);
				}
				return reply(res, 200, { usb });
			}
			if (req.method === "POST" && url.pathname === "/note") {
				if (!validRel(rel)) return reply(res, 400, { error: "rel" });
				const from = Number(url.searchParams.get("from"));
				const size = Number(url.searchParams.get("size"));
				const savedAt = Number(url.searchParams.get("savedAt"));
				const body = await readBody(req);
				if (usb) return reply(res, 200, { usb });
				if (![from, size, savedAt].every(Number.isFinite)) return reply(res, 400, { error: "params" });
				const run = (queues.get(rel) ?? Promise.resolve()).catch(() => undefined).then(() => storeNote(rel, from, size, body));
				queues.set(rel, run);
				if (!(await run)) return reply(res, 409, { error: "not a prefix" });
				const nb = { rel, size, savedAt, stats: JSON.parse(url.searchParams.get("stats") ?? "null") };
				pushed.set(rel, nb);
				h.notebook(nb);
				return reply(res, 200, { usb });
			}
			reply(res, 404, { error: "not found" });
		} catch (e) {
			h.error(e instanceof Error ? e : new Error(String(e)));
			if (!res.headersSent) reply(res, 500, { error: String(e) });
		}
	});
	server.on("error", (e) => h.error(e));
	server.listen(PUSH_PORT, "127.0.0.1");
	return () => {
		server.close();
		// close() keeps open keep-alive connections, which would still reach this unloaded plugin.
		server.closeAllConnections();
	};
}

/** Pushed notebooks as sync sources: the copy here is the file to render. */
export function pushedNotebooks(): DeviceNotebook[] {
	return [...pushed.values()].map((p) => {
		const parts = p.rel.split("/");
		return {
			file: cachePath(p.rel),
			via: "push",
			rel: p.rel,
			course: parts[1],
			name: parts[2].slice(0, -".note".length),
			mtimeMs: p.savedAt,
			size: p.size,
		};
	});
}
