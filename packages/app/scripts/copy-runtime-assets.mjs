#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(appRoot, "..", "device", "assets");
const destination = path.join(appRoot, "dist", "assets");

fs.mkdirSync(destination, { recursive: true });
for (const filename of ["codex-color.svg", "claude-color.svg"]) {
	fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
}

for (const filename of ["menu-bar-Template.png", "menu-bar-Template@2x.png"]) {
	fs.copyFileSync(path.join(appRoot, "assets", filename), path.join(destination, filename));
}
