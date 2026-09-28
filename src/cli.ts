// Runs one sync against a vault folder on disk, without Obsidian. Used for testing.
// Usage: node cli.js VAULT_DIR STATE_JSON PYTHON RENDER_PY [NOTE_ROOT]
import { promises as fs } from "fs";
import * as path from "path";
import { changed, findDeviceNoteRoot, listDeviceNotebooks, SyncState, syncNotebook, VaultIO } from "./core";

async function main() {
	const [vaultDir, statePath, python, renderScript, noteRootArg] = process.argv.slice(2);
	const abs = (p: string) => path.join(vaultDir, p);
	const vault: VaultIO = {
		exists: (p) => fs.access(abs(p)).then(() => true, () => false),
		read: (p) => fs.readFile(abs(p), "utf8"),
		write: (p, d) => fs.writeFile(abs(p), d),
		writeBinary: (p, d) => fs.writeFile(abs(p), Buffer.from(d)),
		mkdir: (p) => fs.mkdir(abs(p), { recursive: true }).then(() => undefined),
		remove: (p) => fs.rm(abs(p)),
		list: async (p) => {
			const entries = await fs.readdir(abs(p), { withFileTypes: true });
			const join = (n: string) => (p ? `${p}/${n}` : n);
			return {
				files: entries.filter((e) => e.isFile()).map((e) => join(e.name)),
				folders: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(e.name)),
			};
		},
	};

	const state: SyncState = await fs.readFile(statePath, "utf8").then(JSON.parse, () => ({ notebooks: {} }));
	const root = noteRootArg ?? (await findDeviceNoteRoot());
	if (!root) throw new Error("no Supernote mounted");
	for (const nb of await listDeviceNotebooks(root)) {
		const prev = state.notebooks[nb.rel];
		if (!changed(nb, prev)) continue;
		const t = Date.now();
		const out = await syncNotebook(vault, nb, prev, { python, renderScript });
		if (!out) continue;
		state.notebooks[nb.rel] = out.state;
		console.log(JSON.stringify({ ...out.result, ms: Date.now() - t }));
	}
	await fs.writeFile(statePath, JSON.stringify(state, null, 1));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
