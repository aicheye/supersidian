import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

export interface Transcription {
	transcript: string;
	topics: string[];
	concepts: string[];
}

/** Resolves the Claude Code binary: the configured path, else ~/.local/bin/claude, else "claude" on PATH. */
export async function findClaude(configured: string): Promise<string> {
	if (configured.trim()) return configured.trim();
	const local = path.join(os.homedir(), ".local", "bin", "claude");
	try {
		// Resolve the symlink so the binary also runs inside a Flatpak sandbox that has home access.
		return await fs.realpath(local);
	} catch {
		return "claude";
	}
}

function prompt(images: string[], context: string, known: string[]): string {
	return [
		`Read each of these ${images.length} images, in order:`,
		...images.map((p, i) => `${i + 1}. ${p}`),
		`Each is one page of handwritten ${context} notes: dark ink on a transparent background.`,
		`Return ONLY a JSON array of ${images.length} objects, one per image in the same order, with no prose before or after it. Each object has these keys:`,
		'- "transcript": a Markdown transcription that keeps the page structure. Highlighted or underlined titles become "### " headings, arrows and indented items become nested bullets, math uses $...$ or $$...$$ LaTeX, code goes in fenced blocks with a language, and small diagrams become fenced text drawings. Write [?] for illegible words. Use "" for a blank page.',
		'- "topics": 1 to 4 short phrases naming what the page covers.',
		'In topics, concepts and any wording of your own, use commas, colons or parentheses instead of em dashes.',
		'- "concepts": 3 to 10 canonical technical terms from the page, singular, lowercase except proper nouns and acronyms.',
		...(known.length
			? ["When a concept means the same as one already in use, spell it exactly as the existing one. Concepts already in use:", known.join("; ")]
			: []),
	].join("\n");
}

/**
 * Escapes raw control characters (such as a literal tab or newline) inside JSON strings,
 * which the model occasionally emits and JSON.parse rejects. Characters outside strings are
 * left alone, so whitespace between tokens stays valid.
 */
export function repairJson(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			else if (ch < " ") {
				out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
				continue;
			}
		} else if (ch === '"') inString = true;
		out += ch;
	}
	return out;
}

/** Extracts the [...] array from model output that may be wrapped in a code fence. */
function parseJson(text: string, count: number): Transcription[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error(`no JSON array in output: ${text.slice(0, 200)}`);
	const arr = JSON.parse(repairJson(text.slice(start, end + 1)));
	if (!Array.isArray(arr) || arr.length !== count) throw new Error(`expected ${count} transcripts, got ${Array.isArray(arr) ? arr.length : "none"}`);
	const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
	return arr.map((obj) => ({
		transcript: typeof obj?.transcript === "string" ? obj.transcript.trim() : "",
		topics: strings(obj?.topics),
		concepts: strings(obj?.concepts),
	}));
}

const TIMEOUT_MS = 480_000;

/**
 * Runs one `claude -p` over several page images (several pages per call spreads the fixed
 * cost of starting Claude Code) and returns their transcripts, topics and concepts in order.
 */
export function transcribePages(claude: string, model: string, images: string[], context: string, known: string[] = []): Promise<Transcription[]> {
	return new Promise((resolve, reject) => {
		const args = ["-p", prompt(images, context, known), "--allowedTools", "Read", "--output-format", "json"];
		if (model.trim()) args.push("--model", model.trim());
		const proc = spawn(claude, args, { cwd: path.dirname(images[0]), stdio: ["ignore", "pipe", "pipe"] });
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
				resolve(parseJson(String(envelope.result ?? ""), images.length));
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	});
}
