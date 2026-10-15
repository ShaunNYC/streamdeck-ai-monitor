import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		target: "node24",
		outDir: "dist/preload",
		emptyOutDir: true,
		sourcemap: false,
		lib: { entry: "src/preload.ts", formats: ["cjs"], fileName: () => "preload.cjs" },
		rollupOptions: { external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
	},
});
