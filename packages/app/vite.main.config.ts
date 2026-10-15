import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const nativeExternals = ["electron", "sharp", "ws", "@elgato-stream-deck/node", "lucide-static"];

export default defineConfig({
	build: {
		target: "node24",
		outDir: "dist/main",
		emptyOutDir: true,
		sourcemap: false,
		ssr: "src/main.ts",
		rollupOptions: {
			external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...nativeExternals],
			output: { format: "es", entryFileNames: "main.js" },
		},
	},
});
