import { createWriteStream } from "fs";
import * as net from "net";

/**
 * Talks to the adb server on 127.0.0.1:5037 (run on the host by adb-server.service, since the
 * Flatpak sandbox cannot reach USB devices). Used to list and copy notebooks: it does not
 * depend on the desktop auto-mounting the tablet over MTP, which it sometimes does not do
 * after the tablet reconnects, and it copies about twice as fast.
 */

/** An adb server request: its length as 4 hex digits, then the text. */
export function adbFrame(request: string): string {
	return request.length.toString(16).padStart(4, "0") + request;
}

/** A request to the adb server itself (not a device); returns its reply text. */
function hostQuery(request: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(5037, "127.0.0.1");
		let buf = Buffer.alloc(0);
		const fail = (e: Error) => {
			socket.destroy();
			reject(e);
		};
		socket.setTimeout(10_000, () => fail(new Error(`adb server timed out on ${request}`)));
		socket.on("error", fail);
		socket.on("connect", () => socket.write(adbFrame(request)));
		const finish = () => {
			if (buf.length < 8) return false;
			if (buf.subarray(0, 4).toString() !== "OKAY") {
				fail(new Error(`adb: ${buf.toString("latin1").slice(0, 120)}`));
				return true;
			}
			const len = parseInt(buf.subarray(4, 8).toString(), 16);
			if (buf.length < 8 + len) return false;
			socket.destroy();
			resolve(buf.subarray(8, 8 + len).toString("utf8"));
			return true;
		};
		socket.on("data", (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			finish();
		});
		socket.on("close", () => {
			if (!finish()) reject(new Error(`adb closed the connection on ${request}`));
		});
	});
}

export interface AdbDevice {
	serial: string;
	/** a network connection ("100.x.y.z:5555"), not USB */
	wireless: boolean;
}

/** Devices the adb server has connected and authorized. */
export async function adbDevices(): Promise<AdbDevice[]> {
	const out = await hostQuery("host:devices");
	return out
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.filter((p) => p.length === 2 && p[1] === "device")
		.map(([serial]) => ({ serial, wireless: /:\d+$/.test(serial) }));
}

let chosen: { device: AdbDevice | null; at: number } | null = null;

/**
 * The device to use: USB when the cable is in (about 1 ms per round trip, against 10 to 100 ms
 * over Wi-Fi), else the network connection. Requests name the device, since with both
 * connected the server has two and "transport-any" fails. Cached for 2 s.
 */
export async function adbDevice(): Promise<AdbDevice | null> {
	if (chosen && Date.now() - chosen.at < 2000) return chosen.device;
	const all = await adbDevices().catch(() => []);
	const device = all.find((d) => !d.wireless) ?? all[0] ?? null;
	chosen = { device, at: Date.now() };
	return device;
}

/** The adb server request that selects the device, or transport-any when none is known. */
export async function transportRequest(): Promise<string> {
	const d = await adbDevice();
	return d ? `host:transport:${d.serial}` : "host:transport-any";
}


/**
 * Runs `service` on the first attached device and passes its output to `onData` as it arrives.
 * Resolves when the device closes the stream. Handles the whole connection in one place, since
 * a short reply can arrive and close before a caller could attach listeners to a returned socket.
 */
async function run(service: string, onData: (chunk: Buffer) => void, transport?: string): Promise<void> {
	const via = transport ?? (await transportRequest());
	return new Promise((resolve, reject) => {
		const socket = net.connect(5037, "127.0.0.1");
		let head = Buffer.alloc(0);
		let accepted = false;
		const fail = (e: Error) => {
			socket.destroy();
			reject(e);
		};
		socket.setTimeout(5000, () => fail(new Error("adb server timed out")));
		socket.on("error", fail);
		// The service request is sent only after the server accepts the transport: sent together,
		// the server sometimes switched to the device before reading it, and the request was lost.
		let sentService = false;
		socket.on("connect", () => socket.write(adbFrame(via)));
		socket.on("data", (d: Buffer) => {
			if (accepted) return onData(d);
			head = Buffer.concat([head, d]);
			if (!sentService) {
				if (head.length < 4) return;
				if (head.subarray(0, 4).toString() !== "OKAY") return fail(new Error(`adb: ${head.toString("latin1").slice(0, 80)}`));
				head = head.subarray(4);
				sentService = true;
				socket.write(adbFrame(service));
			}
			if (head.length < 4) return;
			if (head.subarray(0, 4).toString() !== "OKAY") return fail(new Error(`adb: ${head.toString("latin1").slice(0, 80)}`));
			accepted = true;
			// Once running, give up only if the device sends nothing for 30 s.
			socket.setTimeout(30_000, () => fail(new Error(`adb: no output for 30 s from ${service.slice(0, 40)}`)));
			if (head.length > 4) onData(head.subarray(4));
		});
		socket.on("close", () => (accepted ? resolve() : reject(new Error("adb closed the connection"))));
	});
}

/**
 * Escapes a shell argument with backslashes. Single quotes are never used: from inside
 * Obsidian, adb shell requests containing a single quote got no reply from the tablet (the
 * same bytes sent from outside Obsidian worked), while backslash escapes work in both.
 */
export function shellArg(s: string): string {
	return s.replace(/[^A-Za-z0-9_./-]/g, (c) => `\\${c}`);
}

/** Runs a shell command on the tablet and returns its output. */
export async function adbShell(command: string, transport?: string): Promise<string> {
	const chunks: Buffer[] = [];
	await run(`shell:${command}`, (d) => chunks.push(d), transport);
	return Buffer.concat(chunks).toString("utf8");
}

/** Copies a file from the tablet to a local path, byte for byte (the exec: service, unlike shell:, does not translate line endings). */
export async function adbPull(remote: string, local: string): Promise<void> {
	const file = createWriteStream(local);
	const written = new Promise<void>((resolve, reject) => {
		file.on("finish", resolve);
		file.on("error", reject);
	});
	try {
		await run(`exec:cat ${shellArg(remote)}`, (d) => file.write(d));
	} finally {
		file.end();
	}
	await written;
}

/** Copies the bytes of a remote file from `offset` on, appending them to a local file. */
export async function adbPullFrom(remote: string, offset: number, local: string): Promise<void> {
	const file = createWriteStream(local, { flags: "a" });
	const written = new Promise<void>((resolve, reject) => {
		file.on("finish", resolve);
		file.on("error", reject);
	});
	try {
		// tail -c +N starts at byte N, counting from 1.
		await run(`exec:tail -c +${offset + 1} ${shellArg(remote)}`, (d) => file.write(d));
	} finally {
		file.end();
	}
	await written;
}

export interface RemoteFile {
	path: string;
	mtimeMs: number;
	size: number;
}

/** Lists files under `dir` matching `pattern` with their modified time and size. */
export async function adbList(dir: string, pattern: string): Promise<RemoteFile[]> {
	const out = await adbShell(`find ${shellArg(dir)} -name ${shellArg(pattern)} -exec stat -c %Y:%s:%n {} +`);
	return out
		.split("\n")
		.map((l) => /^(\d+):(\d+):(.+?)\r?$/.exec(l))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => ({ path: m[3], mtimeMs: Number(m[1]) * 1000, size: Number(m[2]) }));
}

/**
 * Modified time and size of one file, or null when it is gone. `mtimeMs` is whole seconds (as
 * listed by adbList, for change checks); `savedAt` is the exact time converted to the laptop's
 * clock with clockSkewMs.
 */
export async function adbStat(path: string): Promise<{ mtimeMs: number; size: number; savedAt: number } | null> {
	const out = await adbShell(`stat -c %Y:%s:%y ${shellArg(path)} 2>/dev/null`);
	const m = /^(\d+):(\d+):(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)? ([+-]\d\d)(\d\d)/.exec(out.trim());
	if (!m) return null;
	const exact = Date.parse(`${m[3]}T${m[4]}${(m[5] ?? "").slice(0, 4)}${m[6]}:${m[7]}`);
	const mtimeMs = Number(m[1]) * 1000;
	return { mtimeMs, size: Number(m[2]), savedAt: (Number.isNaN(exact) ? mtimeMs : exact) - clockSkewMs };
}

/** How far the tablet's clock is ahead of the laptop's (about 0.3 s when measured). */
export let clockSkewMs = 0;

/** Measures clockSkewMs from one round trip, assuming the reply took half of it. */
export async function measureClockSkew(): Promise<void> {
	const before = Date.now();
	const out = await adbShell("date +%s%N");
	const after = Date.now();
	const tablet = Number(out.trim()) / 1e6;
	// A slow round trip (over 200 ms) says little about the clock; keep the last measurement.
	if (Number.isFinite(tablet) && after - before < 200) clockSkewMs = tablet - (before + after) / 2;
}
