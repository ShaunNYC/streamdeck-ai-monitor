#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = "com.shaun-wang.streamdeck-ai-supervisor";
const labels = [base, `${base}.device`];
const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
const domain = `gui/${process.getuid()}`;
const dataDirectory = path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");

try { childProcess.execFileSync("osascript", ["-e", 'tell application id "com.elgato.StreamDeck" to quit'], { stdio: "ignore", timeout: 5000 }); } catch { /* not running */ }
await new Promise((resolve) => setTimeout(resolve, 1200));
for (const label of labels) {
	const plist = path.join(launchAgents, `${label}.plist`);
	if (!fs.existsSync(plist)) throw new Error(`Missing ${plist}; run npm run setup first.`);
	try { childProcess.execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }); }
	catch { childProcess.execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" }); }
	childProcess.execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
}
fs.writeFileSync(path.join(dataDirectory, "mode.json"), `${JSON.stringify({ mode: "ai", changedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
console.log("AI mode active. The Direct HID controller owns Stream Deck Neo.");
