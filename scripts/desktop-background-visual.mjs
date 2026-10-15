import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "packages", "app", "dist", "renderer", "index.html");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const output = path.join(root, "artifacts", "ui-qa-liquid-glass", "desktop-background");

if (!fs.existsSync(renderer)) throw new Error("Desktop renderer is missing. Run npm run build first.");
if (!fs.existsSync(chrome)) throw new Error("Google Chrome is required for desktop background visual QA.");
fs.mkdirSync(output, { recursive: true });

for (const [width, height] of [[820, 660], [940, 760]]) {
	for (let refresh = 0; refresh < 1; refresh += 1) {
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neo-desktop-background-"));
		try {
			const file = path.join(output, `${width}x${height}-refresh-${refresh + 1}.png`);
			const result = childProcess.spawnSync(chrome, [
				"--headless=new",
				"--allow-file-access-from-files",
				"--disable-gpu",
				"--disable-background-networking",
				"--hide-scrollbars",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-component-update",
				"--disable-extensions",
				"--run-all-compositor-stages-before-draw",
				"--timeout=1000",
				`--user-data-dir=${profile}`,
				`--window-size=${width},${height}`,
				`--screenshot=${file}`,
				`${pathToFileURL(renderer).href}?refresh=${refresh + 1}`,
			], { cwd: root, encoding: "utf8", timeout: 8_000 });
			assert.equal(result.status, 0, result.stderr || result.stdout || "Chrome desktop capture failed");
			assert.ok(fs.existsSync(file), `Chrome did not write ${file}`);
			await assertBackgroundSamples(file);
		} finally {
			fs.rmSync(profile, { recursive: true, force: true });
		}
	}
}
console.log("[desktop-background-visual] light native-material fallback is readable across approved window sizes and repeated loads: ok");

async function assertBackgroundSamples(file) {
	const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const points = [
		[8, 8], [info.width - 9, 8],
		[8, Math.floor(info.height / 2)], [info.width - 9, Math.floor(info.height / 2)],
		[8, info.height - 9], [info.width - 9, info.height - 9],
	];
	for (const [x, y] of points) {
		const offset = (y * info.width + x) * info.channels;
		const actual = [...data.subarray(offset, offset + 3)];
		const luminance = (actual[0] * .2126) + (actual[1] * .7152) + (actual[2] * .0722);
		assert.ok(luminance >= 220, `${path.basename(file)} lost its light fallback at ${x},${y}: ${actual.join(",")}`);
		assert.ok(Math.max(...actual) - Math.min(...actual) <= 32, `${path.basename(file)} fallback is too saturated at ${x},${y}: ${actual.join(",")}`);
	}
}
