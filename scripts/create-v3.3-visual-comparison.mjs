#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const output = path.join(root, "artifacts", "ui-qa-neo-refresh");
const header = 38;
const pageWidth = 384;
const pageHeight = 192;
const states = [
	["main-idle.png", "IDLE · quiet process placeholders"],
	["main-codex-running.png", "RUNNING · Activity / Todo / Agents"],
	["main-approval.png", "INPUT · status only, no decision keys"],
	["main-terminal-recap.png", "RECAP · final data muted, no live color"],
];

await sharp({ create: { width: pageWidth * states.length, height: header * 2 + pageHeight, channels: 4, background: "#000" } })
	.composite([
		{ input: label(pageWidth * states.length, header, "NEO READABILITY REFRESH · simplified surfaces and stable text hierarchy"), left: 0, top: 0 },
		...states.map(([, title], index) => ({ input: label(pageWidth, header, title), left: index * pageWidth, top: header })),
		...states.map(([name], index) => ({ input: fs.readFileSync(path.join(output, name)), left: index * pageWidth, top: header * 2 })),
	])
	.png()
	.toFile(path.join(output, "main-process-comparison.png"));

const cards = await Promise.all([5, 6, 7].map((key) => sharp(path.join(output, "main-codex-running.png"))
	.extract({ left: (key % 4) * 96, top: Math.floor(key / 4) * 96, width: 96, height: 96 })
	.resize(288, 288, { kernel: "nearest" })
	.png()
	.toBuffer()));
await sharp({ create: { width: 864, height: header * 2 + 288, channels: 4, background: "#000" } })
	.composite([
		{ input: label(864, header, "STATUS CARDS · visible, current, and deliberately non-actionable"), left: 0, top: 0 },
		...(["ACTIVITY", "TODO", "AGENTS + RUNTIME"].map((title, index) => ({ input: label(288, header, title), left: index * 288, top: header }))),
		...cards.map((input, index) => ({ input, left: index * 288, top: header * 2 })),
	])
	.png()
	.toFile(path.join(output, "status-card-comparison.png"));

const terminalCards = await Promise.all([5, 6, 7].map((key) => sharp(path.join(output, "main-terminal-recap.png"))
	.extract({ left: (key % 4) * 96, top: Math.floor(key / 4) * 96, width: 96, height: 96 })
	.resize(288, 288, { kernel: "nearest" })
	.png()
	.toBuffer()));
await sharp({ create: { width: 864, height: header * 2 + 288, channels: 4, background: "#000" } })
	.composite([
		{ input: label(864, header, "TERMINAL CARDS · final values remain readable without live color"), left: 0, top: 0 },
		...(["ACTIVITY · MUTED", "TODO · MUTED", "AGENTS · MUTED"].map((title, index) => ({ input: label(288, header, title), left: index * 288, top: header }))),
		...terminalCards.map((input, index) => ({ input, left: index * 288, top: header * 2 })),
	])
	.png()
	.toFile(path.join(output, "terminal-status-card-comparison.png"));

await sharp({ create: { width: pageWidth * 2, height: header + pageHeight, channels: 4, background: "#000" } })
	.composite([
		{ input: label(pageWidth, header, "CODEX TASKS · activity + Todo"), left: 0, top: 0 },
		{ input: label(pageWidth, header, "CLAUDE TASKS · input + process"), left: pageWidth, top: 0 },
		{ input: fs.readFileSync(path.join(output, "codex-live-page.png")), left: 0, top: header },
		{ input: fs.readFileSync(path.join(output, "claude-live-page.png")), left: pageWidth, top: header },
	])
	.png()
	.toFile(path.join(output, "task-process-comparison.png"));

const readabilityStates = [
	["main-codex-running.png", "MAIN · aligned icons and two-line detail"],
	["codex-live-page.png", "TASKS · split metadata and two-line titles"],
	["long-content-page.png", "STRESS · Chinese, Emoji and long tokens"],
];
await sharp({ create: { width: pageWidth * readabilityStates.length, height: header + pageHeight, channels: 4, background: "#000" } })
	.composite([
		...readabilityStates.map(([, title], index) => ({ input: label(pageWidth, header, title), left: index * pageWidth, top: 0 })),
		...readabilityStates.map(([name], index) => ({ input: fs.readFileSync(path.join(output, name)), left: index * pageWidth, top: header })),
	])
	.png()
	.toFile(path.join(output, "readability-1x.png"));

const stressCards = await Promise.all([0, 1, 2, 3].map((key) => sharp(path.join(output, "long-content-page.png"))
	.extract({ left: key * 96, top: 0, width: 96, height: 96 })
	.resize(288, 288, { kernel: "nearest" })
	.png()
	.toBuffer()));
await sharp({ create: { width: 1_152, height: header * 2 + 288, channels: 4, background: "#000" } })
	.composite([
		{ input: label(1_152, header, "3× TEXT STRESS · every dynamic field stays inside its safe region"), left: 0, top: 0 },
		...(["TASK + OVERFLOW", "PLAN CHOICE", "SYSTEM STATE", "PROCESS DETAIL"].map((title, index) => ({ input: label(288, header, title), left: index * 288, top: header }))),
		...stressCards.map((input, index) => ({ input, left: index * 288, top: header * 2 })),
	])
	.png()
	.toFile(path.join(output, "readability-3x.png"));

const marqueeFrames = ["start", "middle", "end"];
await sharp({ create: { width: 248 * marqueeFrames.length, height: header + 58, channels: 4, background: "#000" } })
	.composite([
		...marqueeFrames.map((name, index) => ({ input: label(248, header, `LCD · ${name.toUpperCase()}`), left: index * 248, top: 0 })),
		...marqueeFrames.map((name, index) => ({ input: fs.readFileSync(path.join(output, `infobar-marquee-${name}.png`)), left: index * 248, top: header })),
	])
	.png()
	.toFile(path.join(output, "infobar-marquee-comparison.png"));

console.log("[visual-comparison] NEO 1x/3x readability and LCD marquee evidence created");

function label(width, height, value) {
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#080D14"/><text x="12" y="25" fill="#D8E0EA" font-family="-apple-system,Helvetica,Arial" font-size="13" font-weight="700">${escapeXml(value)}</text></svg>`);
}

function escapeXml(value) {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}
