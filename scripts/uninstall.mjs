#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const application = "/Applications/Agent Pulse.app";
const executable = path.join(application, "Contents", "MacOS", "Agent Pulse");
const base = "com.shaun-wang.streamdeck-ai-supervisor";
const domain = `gui/${process.getuid()}`;

// Prefer the packaged app's own migration/removal code so modern SM login
// items and Claude hooks are removed with exactly the same identity that added
// them. This command intentionally preserves config, state and logs.
if (fs.existsSync(executable)) {
	try { childProcess.execFileSync("/usr/bin/osascript", ["-e", 'tell application id "com.shaun-wang.streamdeck-ai-supervisor" to quit'], { stdio: "ignore", timeout: 5_000 }); }
	catch { /* App was not running or lacks Apple Events access. */ }
	childProcess.execFileSync(executable, ["--remove-integration"], { stdio: "inherit", timeout: 30_000 });
}

for (const label of [`${base}.device`, base]) {
	const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
	try { childProcess.execFileSync("/bin/launchctl", ["bootout", domain, plist], { stdio: "ignore" }); } catch { /* already stopped */ }
	if (fs.existsSync(plist)) fs.rmSync(plist);
}

console.log("Removed this app's login item, Claude hooks and legacy LaunchAgents; switched back to official Stream Deck mode.");
console.log(`The app and data were preserved. To finish uninstalling, move ${application} to Trash.`);
console.log(`Optional app data: ${path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor")}`);
