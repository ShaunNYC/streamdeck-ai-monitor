#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const deviceLabel = "com.shaun-wang.streamdeck-ai-supervisor.device";
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${deviceLabel}.plist`);
const dataDirectory = path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
try { childProcess.execFileSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" }); } catch { /* already stopped */ }
childProcess.execFileSync("open", ["-b", "com.elgato.StreamDeck"], { stdio: "ignore" });
fs.writeFileSync(path.join(dataDirectory, "mode.json"), `${JSON.stringify({ mode: "official", changedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
console.log("Official mode active. Elgato Stream Deck owns the device.");
