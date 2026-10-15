import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-control-config-test-"));
process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = temporary;

void main();

async function main(): Promise<void> {
	try {
	const {
		defaultSupervisorConfig,
		getConfigPath,
		loadSupervisorConfig,
		normalizeSupervisorConfig,
		saveSupervisorConfig,
	} = await import("../packages/daemon/src/supervisor-config.ts");
	const { claudeHookFailureResponse } = await import("../packages/app/src/claude-hook-cli.ts");
	const { loginItemSettings, shouldStartInBackground, reconcileLoginItem, saveLoginItemChoice } = await import("../packages/app/src/launch-policy.ts");
	const { syncClaudeHooks } = await import("../packages/app/src/integration.ts");
	const realHome = os.homedir;
	try {
		os.homedir = () => temporary;
		const settingsFile = path.join(temporary, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [
			{ type: "command", command: "'/Applications/AI Control Supervisor.app/Contents/MacOS/AI Control Supervisor' --claude-hook" },
			{ type: "command", command: "'/Applications/Agent Pulse.app/Contents/MacOS/Agent Pulse' --claude-hook" },
			{ type: "command", command: "my-independent-hook" },
		] }] } }));
		const executable = "/Applications/Agent Pulse.app/Contents/MacOS/Agent Pulse";
		syncClaudeHooks(true, executable);
		const hooks = JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks;
		const commands = hooks.Stop.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
		assert.equal(commands.filter((command: string) => command.includes("--claude-hook")).length, 1, "Renaming replaces old and duplicate hooks");
		assert.equal(hooks.StopFailure.length, 1, "An API-failed turn must have a terminal Hook so its running clock stops");
		assert.equal(hooks.StopFailure[0].hooks[0].async, true, "Failure observation must not block Claude");
		assert.ok(commands.includes("my-independent-hook"), "Other integrations survive rename");
		assert.ok(commands.some((command: string) => command.includes(executable)));
		assert.equal(syncClaudeHooks(true, executable), false, "Reinstalling the renamed hook is idempotent");
		syncClaudeHooks(false, executable);
		assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks.Stop[0].hooks, [{ type: "command", command: "my-independent-hook" }]);
	} finally { os.homedir = realHome; }

	const projectDirectory = path.join(temporary, "sample-project");
	fs.mkdirSync(projectDirectory);
	const legacy = normalizeSupervisorConfig({
		version: 1,
		projects: [{
			id: "sample",
			label: "SAMPLE",
			cwd: projectDirectory,
			verify: { command: "npm test", cwd: projectDirectory, timeoutMs: 12_000 },
		}],
		claude: { transcriptDirectory: path.join(temporary, "claude") },
		codex: { stateDirectory: path.join(temporary, "codex") },
	});
	assert.equal(legacy.version, 2);
	assert.equal(legacy.agents.codex.enabled, true);
	assert.equal(legacy.agents.claude.enabled, true);
	assert.equal(legacy.agents.codex.stateDirectory, path.join(temporary, "codex"));
	assert.equal(legacy.agents.claude.transcriptDirectory, path.join(temporary, "claude"));
	assert.equal(legacy.device.mode, "ai");
	assert.equal(legacy.device.startAtLogin, false);
	assert.equal(legacy.device.showInMenuBar, true);
	assert.equal(legacy.projects[0]?.verify?.command, "npm test");

	legacy.agents.claude.enabled = false;
	legacy.device.mode = "ai";
	legacy.device.serialNumber = "NEO-TEST";
	saveSupervisorConfig(legacy);
	assert.equal(fs.statSync(getConfigPath()).mode & 0o077, 0);
	const loaded = loadSupervisorConfig();
	assert.equal(loaded.agents.claude.enabled, false);
	assert.equal(loaded.device.serialNumber, "NEO-TEST");
	assert.equal(loaded.projects[0]?.cwd, projectDirectory);

	loaded.device.mode = "official";
	loaded.device.showInMenuBar = false;
	saveSupervisorConfig(loaded);
	assert.ok(fs.existsSync(`${getConfigPath()}.bak`), "Saving an existing config should keep one recoverable backup");
	assert.equal(loadSupervisorConfig().device.showInMenuBar, false);

	const defaults = defaultSupervisorConfig(projectDirectory);
	assert.equal(defaults.device.startAtLogin, false);
	assert.equal(loadSupervisorConfig().device.startAtLogin, false);
	for (const startAtLogin of [undefined, null, true, false, "true", 1]) {
		assert.equal(normalizeSupervisorConfig({ version: 2, device: { startAtLogin } }).device.startAtLogin, false, "Legacy/malformed preferences cannot prove consent");
	}
	const enabled = normalizeSupervisorConfig({ device: { startAtLogin: true, loginItemConsentVersion: 1 } });
	assert.equal(enabled.device.startAtLogin, true);
	saveSupervisorConfig(enabled);
	assert.equal(loadSupervisorConfig().device.loginItemConsentVersion, 1, "Explicit consent survives restart");
	let registered = false;
	const calls: boolean[] = [];
	const system = { get: () => registered, set: (value: boolean) => { calls.push(value); registered = value; } };
	let preferences = reconcileLoginItem(defaults.device, system);
	assert.deepEqual(calls, [], "First launch must not register a login item");
	registered = true;
	preferences = reconcileLoginItem({ startAtLogin: true }, system);
	assert.equal(registered, false, "Upgrade removes a legacy registration without evidence of consent");
	assert.deepEqual(calls, [false]);
	calls.length = 0;
	preferences = saveLoginItemChoice(preferences, undefined, system);
	assert.deepEqual(calls, [], "Saving an unrelated setting must not enable login startup");
	preferences = saveLoginItemChoice(preferences, true, system);
	assert.equal(registered, true);
	assert.equal(preferences.loginItemConsentVersion, 1);
	assert.deepEqual(calls, [true], "Only an explicit toggle choice registers");
	calls.length = 0;
	preferences = reconcileLoginItem(preferences, system);
	assert.deepEqual(calls, [], "A consented restart never re-registers");
	registered = false; // User disables it in System Settings.
	preferences = saveLoginItemChoice(preferences, undefined, system);
	assert.equal(preferences.startAtLogin, false);
	assert.deepEqual(calls, [], "System Settings opt-out survives unrelated saves and restart");
	preferences = saveLoginItemChoice(preferences, false, system);
	assert.equal(preferences.startAtLogin, false);
	assert.throws(() => saveLoginItemChoice(preferences, "true", system), /Invalid/);
	assert.throws(() => saveLoginItemChoice(preferences, true, { get: () => false, set: () => {} }), /did not take effect/, "Silent OS failure must be reported");
	assert.throws(() => saveLoginItemChoice(preferences, true, { get: () => false, set: () => { throw new Error("OS denied"); } }), /OS denied/);
	assert.throws(() => reconcileLoginItem({ startAtLogin: false }, { get: () => true, set: () => {} }), /Could not disable the legacy login item/, "A failed legacy unregistration must be visible instead of claiming success");
	assert.equal(defaults.projects[0]?.verify, undefined, "Commercial onboarding must not execute a verification command by default");
	assert.deepEqual(JSON.parse(claudeHookFailureResponse(true)), {
		hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: { behavior: "deny", message: "Neo approval service was unavailable or timed out." },
		},
	}, "Claude permission timeout must fail closed");
	assert.equal(claudeHookFailureResponse(false), "{}", "Non-blocking lifecycle Hooks remain fail-open notifications");
	assert.equal(shouldStartInBackground({ argv: [], isPackaged: true, platform: "darwin", wasOpenedAtLogin: true }), true);
	assert.equal(shouldStartInBackground({ argv: [], isPackaged: true, platform: "darwin", wasOpenedAtLogin: false }), false);
	assert.equal(shouldStartInBackground({ argv: ["--hidden"], isPackaged: false, platform: "darwin" }), true);
	assert.deepEqual(loginItemSettings(true, "darwin"), { openAtLogin: true }, "macOS login items must not rely on Windows-only arguments");
	assert.deepEqual(loginItemSettings(true, "win32"), { openAtLogin: true, args: ["--hidden"] });
		console.log("[app-config] migration, permissions, safe defaults and fail-closed Claude approvals: ok");
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}
