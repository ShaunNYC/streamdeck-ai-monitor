import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	getConfigPath,
	loadSupervisorConfig,
	normalizeSupervisorConfig,
	saveSupervisorConfig,
	type SupervisorConfig,
} from "@streamdeck-supervisor/daemon";

const LEGACY_LABELS = ["com.shaun-wang.streamdeck-ai-supervisor.device", "com.shaun-wang.streamdeck-ai-supervisor"];
const CLAUDE_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure"];

export interface AgentDetection {
	codex: { detected: boolean; detail: string };
	claude: { detected: boolean; detail: string };
}

export function loadAndMigrateConfig(): SupervisorConfig {
	const configPath = getConfigPath();
	let raw: unknown;
	try { raw = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { raw = undefined; }
	const config = raw === undefined ? loadSupervisorConfig() : normalizeSupervisorConfig(raw);
	const rawConfig = raw as { version?: number; device?: { startAtLogin?: unknown; showInMenuBar?: unknown } } | undefined;
	if (rawConfig?.version !== 2) {
		try {
			const mode = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "mode.json"), "utf8")) as { mode?: string };
			if (mode.mode === "ai" || mode.mode === "official") config.device.mode = mode.mode;
		} catch { /* No legacy mode. */ }
		saveSupervisorConfig(config);
	} else if (typeof rawConfig.device?.startAtLogin !== "boolean" || typeof rawConfig.device?.showInMenuBar !== "boolean") {
		saveSupervisorConfig(config);
	}
	return config;
}

export function detectAgents(): AgentDetection {
	const home = os.homedir();
	const codexState = path.join(home, ".codex");
	const claudeState = path.join(home, ".claude");
	const codexApp = fs.existsSync("/Applications/ChatGPT.app");
	const claudeApp = fs.existsSync("/Applications/Claude.app");
	const codexData = directoryHas(codexState, (name) => /^state_\d+\.sqlite$/.test(name));
	const claudeData = fs.existsSync(path.join(claudeState, "projects")) || fs.existsSync(path.join(claudeState, "settings.json"));
	return {
		codex: { detected: codexApp || codexData, detail: codexApp ? "Codex App detected" : codexData ? "Codex state detected" : "Codex not detected" },
		claude: { detected: claudeApp || claudeData, detail: claudeApp ? "Claude App detected" : claudeData ? "Claude data detected" : "Claude not detected" },
	};
}

export function migrateLegacyLaunchAgents(): string[] {
	const removed: string[] = [];
	const directory = path.join(os.homedir(), "Library", "LaunchAgents");
	const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
	for (const label of LEGACY_LABELS) {
		const plist = path.join(directory, `${label}.plist`);
		try { childProcess.execFileSync("/bin/launchctl", ["bootout", domain, plist], { stdio: "ignore" }); } catch { /* Not loaded. */ }
		if (!fs.existsSync(plist)) continue;
		fs.unlinkSync(plist);
		removed.push(plist);
	}
	return removed;
}

export function syncClaudeHooks(enabled: boolean, executablePath = process.execPath): boolean {
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	if (!enabled && !fs.existsSync(settingsPath)) return false;
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	const settings = readJsonObject(settingsPath);
	const before = JSON.stringify(settings);
	const command = `${shellQuote(executablePath)} --claude-hook`;
	const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
		? settings.hooks as Record<string, unknown>
		: {};

	for (const [eventName, rawGroups] of Object.entries(hooks)) {
		if (!Array.isArray(rawGroups)) continue;
		const groups = rawGroups
			.map((rawGroup) => {
				const group = rawGroup && typeof rawGroup === "object" && !Array.isArray(rawGroup) ? rawGroup as Record<string, unknown> : {};
				const handlers = Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isSupervisorHook(handler, command)) : [];
				return { ...group, hooks: handlers };
			})
			.filter((group) => group.hooks.length > 0);
		if (groups.length > 0) hooks[eventName] = groups;
		else delete hooks[eventName];
	}

	if (enabled) {
		for (const eventName of CLAUDE_EVENTS) addHook(hooks, eventName, { type: "command", command, async: true, timeout: 60 });
	}
	if (Object.keys(hooks).length > 0) settings.hooks = hooks;
	else delete settings.hooks;
	if (JSON.stringify(settings) === before) return false;
	writeJsonPrivate(settingsPath, settings);
	return true;
}

export function isElgatoRunning(): boolean {
	return childProcess.spawnSync("/usr/bin/pgrep", ["-x", "Stream Deck"], { stdio: "ignore" }).status === 0;
}

export async function quitElgato(): Promise<void> {
	const result = childProcess.spawnSync("/usr/bin/pgrep", ["-x", "Stream Deck"], { encoding: "utf8" });
	const pids = result.status === 0 ? result.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
	for (const pid of pids) {
		const command = childProcess.spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1_000 }).stdout.trim();
		if (!/Elgato Stream Deck\.app|\/Stream Deck(?:\s|$)/.test(command)) continue;
		try { process.kill(pid, "SIGTERM"); } catch { /* Process exited. */ }
	}
	const deadline = Date.now() + 5_000;
	while (isElgatoRunning() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
	if (isElgatoRunning()) throw new Error("The Stream Deck app is still using Neo. Quit it and try again.");
}

export function openElgato(): void {
	childProcess.spawn("/usr/bin/open", ["-b", "com.elgato.StreamDeck"], { detached: true, stdio: "ignore" }).unref();
}

function directoryHas(directory: string, predicate: (name: string) => boolean): boolean {
	try { return fs.readdirSync(directory).some(predicate); } catch { return false; }
}

function readJsonObject(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON object.`);
	return parsed as Record<string, unknown>;
}

function writeJsonPrivate(filePath: string, value: unknown): void {
	if (fs.existsSync(filePath)) {
		const backup = `${filePath}.ai-control-supervisor.${Date.now()}.bak`;
		fs.copyFileSync(filePath, backup);
		try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
	}
	const temporary = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, filePath);
	try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function addHook(hooks: Record<string, unknown>, eventName: string, handler: Record<string, unknown>): void {
	const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] as Array<Record<string, unknown>> : [];
	const installed = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((candidate) => (candidate as Record<string, unknown>)?.command === handler.command));
	if (!installed) groups.push({ hooks: [handler] });
	hooks[eventName] = groups;
}

function isSupervisorHook(value: unknown, currentCommand: string): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const command = String((value as Record<string, unknown>).command ?? "");
	return command === currentCommand
		|| /(?:AI Control Supervisor|Agent Pulse).*--claude-hook/i.test(command)
		|| (/claude-hook\.mjs/i.test(command) && /stream.?deck|streamdeck-supervisor/i.test(command));
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
