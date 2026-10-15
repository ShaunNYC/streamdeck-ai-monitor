#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(root, "packages", "app");
const lock = JSON.parse(fs.readFileSync(path.join(appRoot, "package-lock.json"), "utf8"));
const packagesById = new Map();
const bundledBuildDependencies = new Set(["electron"]);

for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
	if (!lockPath.startsWith("node_modules/")) continue;
	const packageDirectory = path.join(appRoot, lockPath);
	let manifest = {};
	try { manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")); } catch { /* Optional package for another platform. */ }
	const name = manifest.name ?? lockPath.slice("node_modules/".length);
	if (metadata.dev === true && !bundledBuildDependencies.has(name)) continue;
	const version = manifest.version ?? metadata.version ?? "unknown";
	const license = manifest.license ?? metadata.license ?? "UNKNOWN";
	const source = repositoryUrl(manifest) ?? manifest.homepage ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
	const licenseText = readLicense(packageDirectory);
	const id = `${name}@${version}`;
	if (!packagesById.has(id)) packagesById.set(id, { name, version, license, source, licenseText });
}

const packages = [...packagesById.values()];
packages.sort((a, b) => a.name.localeCompare(b.name));
const groups = new Map();
const withoutText = [];
for (const item of packages) {
	if (!item.licenseText) { withoutText.push(item); continue; }
	const hash = crypto.createHash("sha256").update(item.licenseText).digest("hex");
	const group = groups.get(hash) ?? { text: item.licenseText, packages: [] };
	group.packages.push(item);
	groups.set(hash, group);
}

const lines = [
	"# Third-party notices",
	"",
	"Agent Pulse original code is source-available under the Agent Pulse Source-Available License 1.0 (see LICENSE). Third-party components retain their own licenses; the restrictions on Agent Pulse do not replace or limit those licenses. The following notices cover the production dependencies distributed with the macOS app.",
	"",
	"The app dynamically loads Sharp/libvips components. libvips is distributed under LGPL-3.0-or-later; corresponding upstream source is available at https://github.com/libvips/libvips and the packaged libraries remain replaceable within the application bundle.",
	"",
	"Electron is listed even though it is a build dependency because its framework is part of the distributed application. Electron's packaged LICENSE and LICENSES.chromium.html files remain inside the app bundle and contain the complete Chromium third-party notices.",
	"",
	"## Distributed dependency inventory",
	"",
	"| Package | Version | License | Source |",
	"|---|---:|---|---|",
	...packages.map((item) => `| ${escapeTable(item.name)} | ${escapeTable(item.version)} | ${escapeTable(item.license)} | [upstream](${item.source}) |`),
	"",
	"## License texts",
	"",
];

for (const group of [...groups.values()].sort((a, b) => a.packages[0].name.localeCompare(b.packages[0].name))) {
	lines.push(`### ${group.packages.map((item) => `${item.name}@${item.version}`).join(", ")}`, "", "```text", group.text.trim(), "```", "");
}
if (withoutText.length > 0) {
	lines.push("## Packages whose manifest supplies an SPDX expression", "", "The following installed packages did not include a separate license file; their manifest license expression and upstream source are listed in the inventory above.", "", withoutText.map((item) => `- ${item.name}@${item.version}: ${item.license}`).join("\n"), "");
}
const assetNotices = fs.readFileSync(path.join(root, "ASSET_NOTICES.md"), "utf8").trim();
lines.push(assetNotices.replace(/^#/gm, "##"), "");

fs.writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n").trimEnd()}\n`);
console.log(`Wrote notices for ${packages.length} distributed packages.`);

function readLicense(directory) {
	try {
		const name = fs.readdirSync(directory).find((candidate) => /^(license|licence|copying)(\.|$)/i.test(candidate));
		if (!name) return undefined;
		const text = fs.readFileSync(path.join(directory, name), "utf8");
		return text.length <= 100_000
			? text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()
			: undefined;
	} catch { return undefined; }
}

function repositoryUrl(manifest) {
	const value = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
	if (!value) return undefined;
	const normalized = String(value)
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\.git$/, "");
	return /^[a-z]+:\/\//i.test(normalized) ? normalized : `https://github.com/${normalized}`;
}

function escapeTable(value) { return String(value).replace(/\|/g, "\\|"); }
