#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const configPath = path.join(dataDirectory, "config.json");
const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
const daemonLabel = "com.shaun-wang.streamdeck-ai-supervisor";
const deviceLabel = `${daemonLabel}.device`;
const daemonPlist = path.join(launchAgents, `${daemonLabel}.plist`);
const devicePlist = path.join(launchAgents, `${deviceLabel}.plist`);
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const daemonEntry = path.join(root, "packages", "daemon", "dist", "index.js");
const deviceEntry = path.join(root, "packages", "device", "dist", "index.js");
const hookEntry = path.join(root, "scripts", "claude-hook.mjs");
const domain = `gui/${process.getuid?.() ?? 501}`;

if (Number.parseInt(process.versions.node, 10) < 24) throw new Error("Run setup with Node 24: fnm exec --using=24 npm run setup");
for (const entry of [daemonEntry, deviceEntry]) if (!fs.existsSync(entry)) throw new Error(`Build output missing: ${entry}. Run npm run build first.`);

fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dataDirectory, "logs"), { recursive: true, mode: 0o700 });
ensureConfig();
installClaudeHooks();
installLaunchAgents();
quitOfficialApp();
bootstrap(daemonPlist, daemonLabel);
bootstrap(devicePlist, deviceLabel);
writePrivate(path.join(dataDirectory, "mode.json"), `${JSON.stringify({ mode: "ai", changedAt: new Date().toISOString() }, null, 2)}\n`);

console.log("Agent Pulse V3.3 installed in Direct HID mode.");
console.log(`Daemon: ${daemonLabel}`);
console.log(`Device controller: ${deviceLabel}`);
console.log(`Config: ${configPath}`);
console.log(`Claude hooks: ${settingsPath}`);

function ensureConfig() {
	if (fs.existsSync(configPath)) return;
	const config = {
		version: 2,
		projects: [{
			id: "stream-deck", label: "STREAMDEC", cwd: root,
			verify: { command: "npm test", cwd: root, timeoutMs: 180000 },
		}],
		agents: { codex: { enabled: true }, claude: { enabled: true } },
		device: { mode: "ai", startAtLogin: true, showInMenuBar: true },
	};
	writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function installClaudeHooks() {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	const existingText = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "{}";
	let settings;
	try { settings = JSON.parse(existingText); } catch { throw new Error(`${settingsPath} is not valid JSON; refusing to overwrite it.`); }
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${settingsPath} must contain a JSON object.`);
	const before = JSON.stringify(settings);
	const command = `${shellQuote(process.execPath)} ${shellQuote(hookEntry)}`;
	const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
	for (const eventName of ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure"]) addHook(hooks, eventName, { type: "command", command, async: true, timeout: 60 });
	addHook(hooks, "PermissionRequest", { type: "command", command, timeout: 660 });
	settings.hooks = hooks;
	if (JSON.stringify(settings) === before) return;
	if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.streamdeck-supervisor.${Date.now()}.bak`);
	writePrivate(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function addHook(hooks, eventName, handler) {
	const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
	const installed = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((candidate) => candidate?.type === "command" && candidate?.command === handler.command));
	if (!installed) groups.push({ hooks: [handler] });
	hooks[eventName] = groups;
}

function installLaunchAgents() {
	fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
	writePrivate(daemonPlist, plist({
		label: daemonLabel, entry: daemonEntry, stdout: "daemon.out.log", stderr: "daemon.err.log",
		env: {
			AI_CONTROL_SUPERVISOR_ADAPTER_MODE: "real", AI_CONTROL_SUPERVISOR_CLAUDE_HOOK_MODE: "blocking",
			AI_CONTROL_SUPERVISOR_DATA_DIR: dataDirectory, AI_CONTROL_SUPERVISOR_CONFIG: configPath,
		},
	}));
	writePrivate(devicePlist, plist({
		label: deviceLabel, entry: deviceEntry, stdout: "device.out.log", stderr: "device.err.log",
		env: { AI_CONTROL_SUPERVISOR_DATA_DIR: dataDirectory },
	}));
}

function plist({ label, entry, stdout, stderr, env }) {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xml(path.join(dataDirectory, "logs", stdout))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(dataDirectory, "logs", stderr))}</string>\n</dict></plist>\n`;
}

function bootstrap(plistPath, label) {
	try { childProcess.execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" }); } catch { /* not loaded */ }
	childProcess.execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
	childProcess.execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
}

function quitOfficialApp() {
	try { childProcess.execFileSync("osascript", ["-e", 'tell application id "com.elgato.StreamDeck" to quit'], { stdio: "ignore", timeout: 5000 }); } catch { /* not running */ }
}

function writePrivate(filePath, contents) { fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 }); try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ } }
function shellQuote(value) { return `'${value.replace(/'/g, "'\\''")}'`; }
function xml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
