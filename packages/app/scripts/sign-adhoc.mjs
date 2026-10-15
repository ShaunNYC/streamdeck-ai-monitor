#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";

const directory = path.dirname(fileURLToPath(import.meta.url));
const app = process.argv[2];
if (!app?.endsWith(".app")) throw new Error("Pass the path to an Electron .app bundle.");

await signAsync({
	app: path.resolve(app),
	identity: "-",
	identityValidation: false,
	optionsForFile: () => ({
		entitlements: path.resolve(directory, "..", "entitlements.plist"),
		hardenedRuntime: false,
		timestamp: "none",
	}),
});
