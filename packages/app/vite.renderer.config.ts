import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: path.join(directory, "src", "renderer"),
	base: "./",
	build: {
		target: "es2022",
		outDir: path.join(directory, "dist", "renderer"),
		emptyOutDir: true,
		sourcemap: false,
	},
});
