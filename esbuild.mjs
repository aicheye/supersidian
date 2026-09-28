import esbuild from "esbuild";
import { builtinModules } from "module";

const common = { bundle: true, platform: "node", target: "es2020", logLevel: "info" };
await esbuild.build({
	...common,
	entryPoints: ["src/main.ts"],
	outfile: "main.js",
	format: "cjs",
	external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtinModules],
});
await esbuild.build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", format: "cjs" });
