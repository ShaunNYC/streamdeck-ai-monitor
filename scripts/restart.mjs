#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = "com.shaun-wang.streamdeck-ai-supervisor";
const domain = `gui/${process.getuid()}`;
const dataDirectory = path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
let mode = "ai";
try { mode = JSON.parse(fs.readFileSync(path.join(dataDirectory, "mode.json"), "utf8")).mode; } catch { /* default AI */ }
const labels = mode === "ai" ? [base, `${base}.device`] : [base];
for (const label of labels) execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
console.log(`Restarted ${labels.join(" and ")}.`);
