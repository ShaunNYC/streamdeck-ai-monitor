#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const configPath = process.env.AI_CONTROL_SUPERVISOR_CONFIG ?? path.join(dataDirectory, "config.json");
const tokenPath = path.join(dataDirectory, "token");
const port = Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10);
const application = process.env.AI_CONTROL_SUPERVISOR_APPLICATION_PATH ?? "/Applications/Agent Pulse.app";
const bundleId = "com.shaun-wang.streamdeck-ai-supervisor";
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// The packaged app ships its own Electron/Node runtime. A developer's current
// shell version is useful context, but it must not make a healthy DMG fail.
add("shell-node-informational", true, process.version);
add("platform", process.platform === "darwin" && process.arch === "arm64", `${process.platform}-${process.arch}`);

let config;
try {
	config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	add("config-v2", config?.version === 2 && Array.isArray(config.projects), configPath);
	for (const project of config.projects ?? []) {
		add(`project-metadata:${project.id}`, typeof project.cwd === "string" && fs.existsSync(project.cwd), project.cwd);
	}
} catch (error) {
	add("config-v2", false, messageOf(error));
}

const mode = config?.device?.mode;
add("mode", mode === "ai" || mode === "official", String(mode ?? "missing"));
add("data-directory-permissions", privateDirectory(dataDirectory), dataDirectory);
add("token-permissions", privateFile(tokenPath), tokenPath);
for (const file of privateRuntimeFiles(dataDirectory)) add(`private:${path.basename(file)}`, privateFile(file), file);

let snapshot;
try {
	snapshot = await authenticatedSnapshot(tokenPath, port);
		add("authenticated-ipc", true, `127.0.0.1:${port} protocol 4`);
	add("monitoring-scope", snapshot.status?.monitoringScope === "all-projects", String(snapshot.status?.monitoringScope ?? "legacy"));
	const strictRunning = (snapshot.tasks ?? []).filter((task) => task.status === "RUNNING").length;
	add("running-count", snapshot.status?.runningTaskCount === strictRunning, `reported=${snapshot.status?.runningTaskCount}; observed=${strictRunning}`);
	for (const agent of ["codex", "claude"]) {
		if (config?.agents?.[agent]?.enabled === false) continue;
		const health = snapshot.status?.adapters?.[agent]?.status;
		add(`adapter:${agent}`, health === "OK", String(health ?? "missing"));
	}
	if (config?.device?.startAtLogin !== false) {
		add("login-item", snapshot.status?.loginItemEnabled === true, `requested=true; enabled=${String(snapshot.status?.loginItemEnabled)}`);
	} else {
		add("login-item", snapshot.status?.loginItemEnabled !== true, `requested=false; enabled=${String(snapshot.status?.loginItemEnabled)}`);
	}
	if (mode === "ai") {
		const connection = snapshot.status?.deviceConnection;
		add("neo-hid", connection?.state === "CONNECTED", `${connection?.state ?? "missing"}${connection?.productName ? ` · ${connection.productName}` : ""}`);
	}
} catch (error) {
	add("authenticated-ipc", false, messageOf(error));
}

const officialRunning = childProcess.spawnSync("/usr/bin/pgrep", ["-x", "Stream Deck"], { stdio: "ignore" }).status === 0;
if (mode === "ai") add("exclusive-device-owner", !officialRunning, officialRunning ? "Official Stream Deck app is competing for HID" : "Direct HID only");
else add("official-mode", true, officialRunning ? "Stream Deck app is running" : "Stream Deck app is not currently running");

if (fs.existsSync(application)) {
	const info = path.join(application, "Contents", "Info.plist");
	const installedVersion = plistValue(info, "CFBundleShortVersionString");
	const expectedVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	add("installed-version", installedVersion === expectedVersion, `${installedVersion ?? "missing"}; expected=${expectedVersion}`);
	add("bundle-id", plistValue(info, "CFBundleIdentifier") === bundleId, plistValue(info, "CFBundleIdentifier") ?? "missing");
	const executable = path.join(application, "Contents", "MacOS", plistValue(info, "CFBundleExecutable") ?? "Agent Pulse");
	const architectures = capture("/usr/bin/lipo", ["-archs", executable]);
	add("app-architecture", architectures.split(/\s+/).includes("arm64"), architectures.trim());
	const nativeFiles = listFiles(path.join(application, "Contents", "Resources", "app.asar.unpacked"));
	add("node-hid-runtime", nativeFiles.some((file) => file.includes(`${path.sep}node-hid${path.sep}`) && file.endsWith(".node")), "bundled user-space arm64 HID runtime");
	const macControl = path.join(application, "Contents", "Resources", "build-native", "macos-control.node");
	add("native-post-event-control", fs.existsSync(macControl) && capture("/usr/bin/lipo", ["-archs", macControl]).split(/\s+/).includes("arm64"), macControl);
} else {
	add("installed-app", false, application);
}

if (snapshot?.status?.codexApprovalControl && config?.agents?.codex?.enabled !== false) {
	const control = snapshot.status.codexApprovalControl;
	add("approval-input-owner", control.provider === "native-main-process" && control.permissionKind === "post-event" && control.bundleId === bundleId, `${control.provider ?? "missing"}; ${control.permissionKind ?? "missing"}; ${control.bundleId ?? "missing"}`);
	add("approval-post-event-permission", control.status === "READY", String(control.status ?? "missing"));
}

if (snapshot?.status?.desktopIntegration) {
	const desktop = snapshot.status.desktopIntegration;
	if (config?.device?.showInMenuBar !== false) add("menu-bar-icon", desktop.menuBar?.state === "VISIBLE" && desktop.menuBar?.imageLoaded === true, JSON.stringify(desktop.menuBar));
}

for (const label of [`${bundleId}.device`, bundleId]) {
	const legacy = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
	add(`legacy-launchagent-absent:${label.split(".").at(-1)}`, !fs.existsSync(legacy), legacy);
}

const result = { ok: checks.every((check) => check.ok), mode, checks };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;

async function authenticatedSnapshot(file, ipcPort) {
	const token = fs.readFileSync(file, "utf8").trim();
	if (!token) throw new Error("Session token is empty");
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${ipcPort}`);
		const timer = setTimeout(() => finish(new Error("Authenticated IPC timeout")), 4_000);
		const finish = (error, value) => {
			clearTimeout(timer);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
			error ? reject(error) : resolve(value);
		};
		socket.once("open", () => socket.send(JSON.stringify({
			type: "client.hello",
			token,
			payload: { client: "direct-hid-device", protocolVersion: 4 },
		})));
		socket.on("message", (raw) => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === "system.snapshot") finish(undefined, message.payload);
			} catch (error) { finish(error); }
		});
		socket.once("error", (error) => finish(error));
	});
}

function privateRuntimeFiles(directory) {
	const candidates = ["config.json", "config.json.bak", "state.json", "mode.json", "managed-codex.json"].map((name) => path.join(directory, name));
	const logs = path.join(directory, "logs");
	try {
		for (const entry of fs.readdirSync(logs, { withFileTypes: true })) if (entry.isFile()) candidates.push(path.join(logs, entry.name));
	} catch { /* No logs. */ }
	return candidates.filter((candidate) => fs.existsSync(candidate));
}

function privateDirectory(directory) {
	try { return fs.statSync(directory).isDirectory() && (fs.statSync(directory).mode & 0o077) === 0; }
	catch { return false; }
}

function privateFile(file) {
	try { return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o077) === 0; }
	catch { return false; }
}

function plistValue(info, key) {
	const result = childProcess.spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", info], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function capture(command, args) {
	const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout : result.stderr || result.stdout;
}

function listFiles(directory) {
	if (!fs.existsSync(directory)) return [];
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(candidate));
		else if (entry.isFile()) files.push(candidate);
	}
	return files;
}

function messageOf(error) { return error instanceof Error ? error.message : String(error); }
