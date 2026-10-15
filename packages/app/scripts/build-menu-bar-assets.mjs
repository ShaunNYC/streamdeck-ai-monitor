#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Transparent cutouts let macOS invert the same card silhouette in either theme.
const source = path.join(root, "assets", "menu-bar.svg");
for (const [filename, size, density] of [["menu-bar-Template.png", 16, 72], ["menu-bar-Template@2x.png", 32, 144]]) {
  const output = path.join(root, "assets", filename);
  await sharp(source, { density }).resize(size, size).withMetadata({ density }).png().toFile(output);
  fs.chmodSync(output, 0o644);
}
