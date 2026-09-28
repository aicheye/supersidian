import { spawn } from "child_process";
import * as os from "os";
import { Deadline } from "./school";

/**
 * Asks Claude Code, through the user's Gmail connector, which new deliverables were
 * announced and which due dates moved. The tools are limited to Gmail search and read,
 * so the job cannot send or change mail.
 */

export interface InboxActions {
	add: { date: string; course: string; title: string; detail: string; evidence: string }[];
	update: { id: string; date: string; evidence: string }[];
}

const TOOLS = ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"];
const TIMEOUT_MS = 300_000;

function prompt(open: Deadline[], courses: string[], since: string): string {
	const list = open.map((d) => `${d.id} | ${d.date} | ${d.title.replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1")}`).join("\n");
	return [
		"You maintain a university student's deadline list by reading their Gmail (school mail is forwarded there).",
		`Look only at email received on or after ${since}.`,
		`Their courses (vault folder names): ${courses.join(", ")}.`,
		"Open deadlines (id | due date | title):",
		list,
		"",
		"Search for new graded deliverables announced by instructors or platforms (for example Crowdmark 'New assignment', course announcements, Piazza digests from instructors), and official due date changes.",
		"Read a thread before relying on it. Rules:",
		"- add: only graded deliverables with a stated due date that are not already in the list (match loosely: 'Asn 2' = 'A02').",
		"- update: only when an instructor or platform announcement changes the due date of a listed item.",
		"- evidence: one short sentence naming the email (sender, subject, date).",
		"Return ONLY a JSON object, no prose:",
		'{"add":[{"date":"YYYY-MM-DD","course":"<vault folder>","title":"<course code> <item> due","detail":"<platform, time, weight if stated>","evidence":"…"}],"update":[{"id":"dl-…","date":"YYYY-MM-DD","evidence":"…"}]}',
	].join("\n");
}

function parse(text: string): InboxActions {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error(`no JSON object in output: ${text.slice(0, 200)}`);
	const o = JSON.parse(text.slice(start, end + 1));
	const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
	const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
	return {
		add: arr(o.add).filter((x) => date(x.date) && typeof x.title === "string" && typeof x.course === "string"),
		update: arr(o.update).filter((x) => typeof x.id === "string" && date(x.date)),
	};
}

export function checkInbox(claude: string, model: string, open: Deadline[], courses: string[], since: string): Promise<InboxActions> {
	return new Promise((resolve, reject) => {
		const args = ["-p", prompt(open, courses, since), "--allowedTools", ...TOOLS, "--output-format", "json"];
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
