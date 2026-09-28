import { spawn } from "child_process";
import * as os from "os";
import { Deadline, plainTitle } from "./school";

/**
 * Puts open deadlines on the user's Google Calendar through Claude Code's Calendar
 * connector. Each event's description carries "supersidian:<id>" so reruns find and update
 * the existing event instead of creating a duplicate.
 */

export interface CalendarEntry {
	id: string;
	eventId: string;
}

const TOOLS = [
	"mcp__claude_ai_Google_Calendar__search_events",
	"mcp__claude_ai_Google_Calendar__get_event",
	"mcp__claude_ai_Google_Calendar__create_event",
	"mcp__claude_ai_Google_Calendar__update_event",
];
const TIMEOUT_MS = 600_000;

/** What an event should say; a change here means the event needs updating. */
export function signature(d: Deadline): string {
	return `${d.done}|${d.date}|${plainTitle(d.title)}|${d.detail.filter((l) => !l.startsWith("✉️")).join(" ")}`;
}

function prompt(items: { d: Deadline; eventId?: string }[], timeZone: string): string {
	const list = items
		.map(({ d, eventId }) =>
			JSON.stringify({ id: d.id, done: d.done, date: d.date, title: plainTitle(d.title), detail: d.detail.filter((l) => !l.startsWith("✉️")).join(" "), eventId: eventId ?? null }),
		)
		.join("\n");
	return [
		`Sync these school deadlines to the user's primary Google Calendar (time zone ${timeZone}).`,
		"For each item:",
		'1. Find its event: the eventId if set; otherwise an event whose description contains "supersidian:<id>"; otherwise an event on the same date whose title matches the item title (ignoring a leading "✅ "). Update the event you find. Create one only if none exists.',
		'2. Title: the item title, prefixed with "✅ " when done is true. Description: keep any existing description text, make sure it contains the detail, and end it with a line "supersidian:<id>".',
		"3. Timing, for created events and for existing events whose date changed: if the detail states a time for an in-person event (quiz, midterm, lab, test with a time), use that time with a sensible duration. If it states a due time (for example 'Due 9:00 PM' or '11:59 PM'), make a 30-minute event ending at that time. Otherwise make an all-day event on the date.",
		"4. For created events, add a popup reminder 1 day before. Leave reminders on existing events alone.",
		"Items (one JSON per line):",
		list,
		'Return ONLY a JSON array, no prose: [{"id":"dl-…","eventId":"<calendar event id>"}] with one entry per item you created or updated.',
	].join("\n");
}

function parse(text: string): CalendarEntry[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error(`no JSON array in output: ${text.slice(0, 200)}`);
	const arr = JSON.parse(text.slice(start, end + 1));
	return Array.isArray(arr) ? arr.filter((x) => x && typeof x.id === "string" && typeof x.eventId === "string") : [];
}

export function syncCalendar(claude: string, model: string, items: { d: Deadline; eventId?: string }[]): Promise<CalendarEntry[]> {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return new Promise((resolve, reject) => {
		const args = ["-p", prompt(items, timeZone), "--allowedTools", ...TOOLS, "--output-format", "json"];
		if (model.trim()) args.push("--model", model.trim());
		const proc = spawn(claude, args, { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => proc.kill("SIGTERM"), TIMEOUT_MS);
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().split("\n").pop()}`));
			try {
				const envelope = JSON.parse(stdout);
				if (envelope.is_error) return reject(new Error(`claude: ${envelope.result}`));
				resolve(parse(String(envelope.result ?? "")));
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	});
}
