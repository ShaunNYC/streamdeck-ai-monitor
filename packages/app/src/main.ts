import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, shell, Tray } from "electron";
import {
	MacCodexApprovalControl,
	getDataDirectory,
	normalizeSupervisorConfig,
	saveSupervisorConfig,
	type SupervisorConfig,
	type SupervisorProject,
} from "@streamdeck-supervisor/daemon";
import type {
	AdapterStatus, AgentKind, CodexApprovalControlStatus,
	DesktopIntegrationStatus, DeviceConnectionStatus, ManagedTaskDetail, ReasoningEffort,
} from "@streamdeck-supervisor/shared";
import { IPC_CHANNELS, type DesktopStatus, type OperationResult, type SaveSettingsRequest } from "./app-types.js";
import { runClaudeHookCli } from "./claude-hook-cli.js";
import { exportDiagnostics } from "./diagnostics.js";
import { loginItemSettings, reconcileLoginItem, saveLoginItemChoice, shouldStartInBackground } from "./launch-policy.js";
import {
	detectAgents,
	isElgatoRunning,
	loadAndMigrateConfig,
	migrateLegacyLaunchAgents,
	openElgato,
	quitElgato,
	syncClaudeHooks,
} from "./integration.js";
import { SupervisorRuntime } from "./runtime.js";
import { loadNativeMacOSControl } from "./native-macos-control.js";

import { AgentFolderAccess, AGENT_FOLDER_KINDS, type AgentFolderKind } from "./agent-folder-access.js";

const isMas = process.mas === true;
const APP_BUNDLE_ID = "com.shaun-wang.streamdeck-ai-supervisor";

if (isMas && (process.argv.includes("--claude-hook") || process.argv.includes("--remove-integration"))) {
	app.quit();
} else if (process.argv.includes("--claude-hook")) {
	// This is a headless, short-lived executable path. Electron's app.exit() can
	// abort before app readiness on macOS; terminate the main process only after
	// the hook response has been fully flushed to stdout.
	void runClaudeHookCli().finally(() => process.exit(0));
} else if (process.argv.includes("--remove-integration")) {
	void removeIntegrationHeadlessly().finally(() => process.exit(0));
} else {
	void startDesktopApp();
}

async function removeIntegrationHeadlessly(): Promise<void> {
	await app.whenReady();
	const config = loadAndMigrateConfig();
	config.device.mode = "official";
	config.device.startAtLogin = false;
	saveSupervisorConfig(config);
	if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
	syncClaudeHooks(false);
	migrateLegacyLaunchAgents();
	openElgato();
}

async function startDesktopApp(): Promise<void> {
	app.setName("Agent Pulse");
	if (!app.requestSingleInstanceLock()) return app.quit();
	await app.whenReady();
	nativeTheme.themeSource = "light";
	const wasOpenedAtLogin = app.isPackaged && process.platform === "darwin"
		? app.getLoginItemSettings().wasOpenedAtLogin
		: false;
	const startInBackground = shouldStartInBackground({
		argv: process.argv,
		isPackaged: app.isPackaged,
		platform: process.platform,
		wasOpenedAtLogin,
	});
	if (process.platform === "darwin") {
		app.setActivationPolicy("accessory");
		app.dock?.hide();
	}
	Menu.setApplicationMenu(process.platform === "darwin"
		? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }])
		: null);

	if (isMas) process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = path.join(app.getPath("userData"), "Supervisor");
	let config = loadAndMigrateConfig();
	const loginSystem = {
		get: () => app.isPackaged ? app.getLoginItemSettings().openAtLogin : config.device.startAtLogin,
		set: (enabled: boolean) => {
			if (app.isPackaged) app.setLoginItemSettings(loginItemSettings(enabled, process.platform));
			else config.device.startAtLogin = enabled;
		},
	};
	let loginStartupError: string | undefined;
	try {
		Object.assign(config.device, reconcileLoginItem(config.device, loginSystem));
		config = saveSupervisorConfig(config);
	} catch (error) { loginStartupError = messageOf(error); }
	// A legacy, unconsented login launch must not start monitoring in the background.
	if (wasOpenedAtLogin && (loginStartupError || !config.device.startAtLogin)) return app.quit();
	const folderAccess = new AgentFolderAccess(path.join(getDataDirectory(), "agent-folders.json"), bookmark => { const stop = app.startAccessingSecurityScopedResource(bookmark); return () => stop(); });
	if (isMas) folderAccess.restore();
	const runtimeConfig = (): SupervisorConfig => {
		if (!isMas) return config;
		const next = structuredClone(config);
		const codex = folderAccess.get("codex");
		const claude = folderAccess.get("claude");
		const desktop = folderAccess.get("claudeDesktop");
		next.agents.codex = { enabled: next.agents.codex.enabled && !!codex, stateDirectory: codex };
		next.agents.claude = {
			enabled: next.agents.claude.enabled && !!claude,
			transcriptDirectory: claude,
			desktopSessionDirectory: desktop ?? path.join(getDataDirectory(), "unselected-claude-desktop"),
		};
		next.projects = next.projects.map(({ verify: _verify, ...project }) => project);
		return next;
	};
	const detectConfiguredAgents = () => isMas ? {
		codex: { detected: !!folderAccess.get("codex"), detail: folderAccess.get("codex") ? "Codex log folder access granted" : "Choose the ~/.codex folder" },
		claude: { detected: !!folderAccess.get("claude"), detail: folderAccess.get("claude") ? "Claude log folder access granted" : "Choose the ~/.claude/projects folder" },
	} : detectAgents();
	let nativeControl: ReturnType<typeof loadNativeMacOSControl>;
	let nativeControlError: string | undefined;
	try { if (!isMas) nativeControl = loadNativeMacOSControl(); } catch (error) { nativeControlError = messageOf(error); }
	let permissionRequesting = false;
	const codexApprovalStatus = (): CodexApprovalControlStatus => {
		const base = { lastCheckedAt: Date.now(), permissionKind: "post-event" as const, provider: "native-main-process" as const, bundleId: APP_BUNDLE_ID };
		if (process.platform !== "darwin" || !nativeControl) return { ...base, status: "UNAVAILABLE", ...(nativeControlError ? { lastError: nativeControlError } : {}) };
		try { return { ...base, status: permissionRequesting ? "REQUESTING" : nativeControl.preflightPostEventAccess() ? "READY" : "PERMISSION_REQUIRED" }; }
		catch (error) { return { ...base, status: "ERROR", lastError: messageOf(error) }; }
	};
	const codexApprovalControl = nativeControl
		? new MacCodexApprovalControl({
			getStatus: codexApprovalStatus,
			bridge: {
				activateThread: (url) => nativeControl!.activateCodexThread(url),
				frontmostBundleId: () => nativeControl!.frontmostBundleId(),
				postDecision: (decision) => nativeControl!.postDecision(decision),
			},
		})
		: new MacCodexApprovalControl({
			getStatus: codexApprovalStatus,
			bridge: { activateThread: () => false, frontmostBundleId: () => "", postDecision: () => false },
		});
	let readDesktopIntegration: () => DesktopIntegrationStatus | undefined = () => undefined;
	const runtime = new SupervisorRuntime(
		codexApprovalControl,
		() => app.isPackaged ? app.getLoginItemSettings().openAtLogin : config.device.startAtLogin,
		() => readDesktopIntegration(),
		undefined,
		isMas,
	);

	let mainWindow: BrowserWindow | null = null;
	let tray: Tray | null = null;
	let trayImageLoaded = false;
	let trayError: string | undefined;
	let dockVisible = false;
	let lastError: string | undefined = loginStartupError;
	let quitting = false;
	let runtimeStopped = false;

	if (!isMas && (app.isPackaged || process.env.AI_CONTROL_SUPERVISOR_MIGRATE_LEGACY === "1")) migrateLegacyLaunchAgents();
	const detectedAtStartup = detectConfiguredAgents();
	if (app.isPackaged && !isMas) {
		try { syncClaudeHooks(app.isInApplicationsFolder() && config.agents.claude.enabled && detectedAtStartup.claude.detected); }
		catch (error) { lastError = messageOf(error); }
	}
	if (config.device.mode === "ai" && !isMas) {
		try { await quitElgato(); } catch (error) { lastError = messageOf(error); config = persistMode(config, "official"); }
	}
	try { await runtime.start(runtimeConfig()); } catch (error) { lastError = messageOf(error); }

	const createWindow = (): BrowserWindow => {
		if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
		const directory = path.dirname(fileURLToPath(import.meta.url));
		mainWindow = new BrowserWindow({
			width: 940,
			height: 760,
			minWidth: 820,
			minHeight: 660,
			show: false,
			title: "Agent Pulse",
			backgroundColor: "#00FFFFFF",
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 18, y: 17 },
			transparent: true,
			vibrancy: "under-window",
			visualEffectState: "followWindow",
			hasShadow: true,
			webPreferences: {
				preload: path.join(directory, "..", "preload", "preload.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				devTools: !app.isPackaged,
			},
		});
		void mainWindow.loadFile(path.join(directory, "..", "renderer", "index.html"));
		mainWindow.once("ready-to-show", showWindow);
		mainWindow.on("close", (event) => {
			if (quitting) return;
			event.preventDefault();
			mainWindow?.hide();
			setDockVisibility(false);
		});
		mainWindow.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https:\/\//.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		return mainWindow;
	};

	const showWindow = () => {
		const window = createWindow();
		setDockVisibility(true);
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	};
	const directory = path.dirname(fileURLToPath(import.meta.url));
	const trayImagePath = path.join(directory, "..", "assets", "menu-bar-Template.png");
	const setTrayVisibility = (visible: boolean): void => {
		if (!visible) {
			tray?.destroy();
			tray = null;
			return;
		}
		if (tray && !tray.isDestroyed()) return;
		try {
			const trayImage = nativeImage.createFromPath(trayImagePath);
			if (trayImage.isEmpty()) throw new Error(`Menu bar image is empty: ${trayImagePath}`);
			trayImage.setTemplateImage(true);
			trayImageLoaded = trayImage.isTemplateImage();
			tray = new Tray(trayImage, "693cd853-4b9e-4c2a-bb36-3c8a10bb4476");
			tray.setToolTip("Agent Pulse");
			tray.on("click", showWindow);
			trayError = undefined;
		} catch (error) {
			tray = null;
			trayImageLoaded = false;
			trayError = messageOf(error);
		}
	};

	const setDockVisibility = (visible: boolean): void => {
		if (process.platform !== "darwin" || !app.dock) return;
		dockVisible = visible;
		if (visible) {
			app.setActivationPolicy("regular");
			void app.dock.show();
		} else {
			app.dock.hide();
			app.setActivationPolicy("accessory");
		}
	};

	const desktopIntegration = (): DesktopIntegrationStatus => {
		const bounds = tray && !tray.isDestroyed() ? tray.getBounds() : undefined;
		return {
			menuBar: {
				requested: config.device.showInMenuBar,
				state: trayError ? "ERROR" : tray && !tray.isDestroyed() && bounds && bounds.width > 0 ? "VISIBLE" : "HIDDEN",
				imageLoaded: trayImageLoaded,
				...(bounds ? { bounds } : {}),
				...(trayError ? { lastError: trayError } : {}),
			},
			dock: { state: !app.dock ? "UNAVAILABLE" : dockVisible ? "VISIBLE" : "HIDDEN", windowVisible: !!mainWindow?.isVisible() },
		};
	};
	readDesktopIntegration = desktopIntegration;

	const updateTray = async () => {
		if (!tray) return;
		const status = await buildStatus();
		const connection = status.config.device.mode === "official" ? "Stream Deck mode" : deviceLabel(status.device);
		tray.setToolTip(`Agent Pulse · ${connection}`);
		tray.setContextMenu(Menu.buildFromTemplate([
			{ label: `Status: ${connection}`, enabled: false },
			{ label: "Open Settings", click: showWindow },
			{ type: "separator" },
			{ label: "Enable AI Mode", enabled: status.config.device.mode !== "ai", click: () => void setMode("ai") },
			{ label: "Switch to Stream Deck Mode", enabled: status.config.device.mode !== "official", click: () => void setMode("official") },
			{ type: "separator" },
			{ label: "Quit", click: () => app.quit() },
		]));
	};

	const buildStatus = async (): Promise<DesktopStatus> => {
		const detections = detectConfiguredAgents();
		const system = runtime.systemStatus;
		const scannedDevices = await runtime.scanDevices();
		const stopped: DeviceConnectionStatus = { state: "STOPPED", devices: [] };
		const device = config.device.mode === "ai" ? runtime.connectionStatus : stopped;
		const disabled: AdapterStatus["status"] = "DISABLED";
		const codexHealth = config.agents.codex.enabled ? system?.adapters.codex.status ?? "OFFLINE" : disabled;
		const claudeHealth = config.agents.claude.enabled ? system?.adapters.claude.status ?? "OFFLINE" : disabled;
		const platformSupported = process.platform === "darwin" && process.arch === "arm64" && Number.parseInt(os.release(), 10) >= 22;
		const inApplicationsFolder = !app.isPackaged || app.isInApplicationsFolder();
		const hasAgent = (config.agents.codex.enabled && detections.codex.detected) || (config.agents.claude.enabled && detections.claude.detected);

		return {
			version: isMas ? app.getVersion().replace(/-.*/, "") : app.getVersion(),
			mas: isMas,
			...(isMas ? { agentFolders: folderAccess.paths() } : {}),
			platformSupported,
			inApplicationsFolder,
			configured: platformSupported && inApplicationsFolder && hasAgent && scannedDevices.length > 0,
			runtimeRunning: runtime.isRunning,
			openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : config.device.startAtLogin,
			elgatoRunning: isElgatoRunning(),
			desktopIntegration: desktopIntegration(),
			agents: {
				codex: { enabled: config.agents.codex.enabled, detected: detections.codex.detected, health: codexHealth, detail: detections.codex.detail, runningCount: system?.agentRuntime?.codex.runningCount ?? 0, decisionCount: system?.agentRuntime?.codex.decisionCount ?? 0 },
				claude: { enabled: config.agents.claude.enabled, detected: detections.claude.detected, health: claudeHealth, detail: detections.claude.detail, runningCount: system?.agentRuntime?.claude.runningCount ?? 0, decisionCount: system?.agentRuntime?.claude.decisionCount ?? 0 },
			},
			codexApprovalControl: codexApprovalControl.getStatus(),
			device: { ...device, scannedDevices },
			config: { ...structuredClone(config), device: { ...config.device, startAtLogin: loginSystem.get() && config.device.loginItemConsentVersion === 1 } },
			monitor: system?.monitor,
			...(lastError || runtime.error ? { lastError: lastError ?? runtime.error } : {}),
		};
	};

	const setMode = async (mode: "ai" | "official"): Promise<OperationResult> => {
		const previous = structuredClone(config);
		try {
			if (mode === "ai") {
				const status = await buildStatus();
				if (!status.platformSupported) throw new Error("Agent Pulse requires an Apple Silicon Mac running macOS 13 or later.");
				if (!status.inApplicationsFolder) throw new Error("Move Agent Pulse to the Applications folder first.");
				const anyAgent = (config.agents.codex.enabled && status.agents.codex.detected) || (config.agents.claude.enabled && status.agents.claude.detected);
				if (!anyAgent) throw new Error("Install and enable at least one of Codex or Claude.");
				const neos = await runtime.scanDevices(true);
				if (neos.length === 0) throw new Error("No Stream Deck Neo found. Connect it by USB and try again.");
				if (neos.length > 1 && !config.device.serialNumber) throw new Error("Multiple Neo devices found. Choose a device in Settings.");
				if (config.device.serialNumber && !neos.some((neo) => neo.serialNumber === config.device.serialNumber)) throw new Error("The selected Neo is not connected.");
				if (!isMas) await quitElgato();
			} else {
				await runtime.stop();
			}
			config = persistMode(config, mode);
			await runtime.restart(runtimeConfig());
			if (mode === "official") openElgato();
			lastError = undefined;
			await updateTray();
			return { ok: true, message: mode === "ai" ? "AI mode enabled. Agent Pulse now controls Neo." : "Neo released to the Stream Deck app." };
		} catch (error) {
			lastError = messageOf(error);
			config = previous;
			saveSupervisorConfig(config);
			await runtime.restart(runtimeConfig()).catch(() => undefined);
			await updateTray();
			return { ok: false, message: lastError };
		}
	};

	registerIpcHandlers({
		getStatus: buildStatus,
		chooseAgentFolder: async (kind) => {
			if (!isMas) return { ok: false, message: "The independent edition discovers log folders automatically." };
			const labels: Record<AgentFolderKind, string> = { codex: "~/.codex", claude: "~/.claude/projects", claudeDesktop: "~/Library/Application Support/Claude/claude-code-sessions" };
			const options = {
				title: "Grant Agent Log Access",
				message: `Choose ${labels[kind]} to read task status and save working time locally. Revoke access in Settings at any time. Press Command+Shift+G to enter a path.`,
				properties: ["openDirectory", "showHiddenFiles"] as Array<"openDirectory" | "showHiddenFiles">,
				securityScopedBookmarks: true,
			};
			const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
			if (result.canceled) return { ok: false, message: "Folder selection canceled" };
			if (!result.filePaths[0] || !result.bookmarks?.[0]) return { ok: false, message: "Folder access was not granted. Please choose the folder again." };
			await runtime.stop();
			try {
				folderAccess.set(kind, result.filePaths[0], result.bookmarks[0]);
				await runtime.start(runtimeConfig());
				return { ok: true, message: "Folder access granted. Monitoring started." };
			} catch (error) {
				await runtime.start(runtimeConfig()).catch(() => undefined);
				return { ok: false, message: messageOf(error) };
			}
		},
		chooseProject: async () => {
			const options = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
			const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
			if (result.canceled || !result.filePaths[0]) return null;
			return projectFromPath(result.filePaths[0]);
		},
		revokeAgentFolder: async (kind) => {
			if (!isMas) return { ok: false, message: "Disable the corresponding agent integration in the independent edition." };
			await runtime.stop();
			try {
				folderAccess.revoke(kind);
				await runtime.start(runtimeConfig());
				return { ok: true, message: "Folder access revoked. Reading stopped; local history is retained." };
			} catch (error) {
				await runtime.start(runtimeConfig()).catch(() => undefined);
				return { ok: false, message: messageOf(error) };
			}
		},
		saveSettings: async (request) => {
			try {
				const next = validateSettingsRequest(request);
				// Ignore consent fields copied from renderer config or stale settings.
				delete next.device.loginItemConsentVersion;
				const loginChoice = saveLoginItemChoice(config.device, request.startAtLoginChoice, loginSystem);
				Object.assign(next.device, { startAtLogin: loginChoice.startAtLogin, loginItemConsentVersion: loginChoice.loginItemConsentVersion });
				try { config = saveSupervisorConfig(next); }
				catch (error) {
					if (request.startAtLoginChoice === true) loginSystem.set(false);
					throw error;
				}
				const detections = detectConfiguredAgents();
				if (app.isPackaged && !isMas) syncClaudeHooks(app.isInApplicationsFolder() && config.agents.claude.enabled && detections.claude.detected);
				await runtime.restart(runtimeConfig());
				setTrayVisibility(config.device.showInMenuBar);
				lastError = undefined;
				await updateTray();
				return { ok: true, message: "Settings saved. Agent Pulse reloaded." };
			} catch (error) {
				lastError = messageOf(error);
				return { ok: false, message: lastError };
			}
		},
		setMode,
		runDiagnostics: async () => exportDiagnostics(mainWindow, await buildStatus()),
		requestCodexApprovalPermission: async () => {
			if (process.platform !== "darwin") return { ok: false, message: "Codex approval shortcuts require macOS." };
			if (!nativeControl) return { ok: false, message: nativeControlError ?? "The native keyboard control module is unavailable." };
			permissionRequesting = true;
			try {
				const granted = nativeControl.requestPostEventAccess();
				return granted
					? { ok: true, message: "Keyboard control access enabled for Agent Pulse." }
					: { ok: true, message: "Allow Agent Pulse in System Settings > Accessibility, then reopen the app." };
			} finally { permissionRequesting = false; }
		},
		repairCodexApprovalPermission: async () => {
			if (isMas) return { ok: false, message: "Handle approvals in Codex when using the App Store edition." };
			if (process.platform !== "darwin") return { ok: false, message: "Permission repair requires macOS." };
			try {
				await runTccReset(APP_BUNDLE_ID);
				setTimeout(() => {
					const relaunchArgs = process.argv.slice(1).filter((argument) => argument !== "--hidden" && argument !== "--permission-repair");
					app.relaunch({ args: [...relaunchArgs, "--permission-repair"] });
					app.quit();
				}, 350);
				return { ok: true, message: "Reset the previous Agent Pulse permission. The app will restart and open the relevant System Settings page." };
			} catch (error) { return { ok: false, message: messageOf(error) }; }
		},
		rebuildMenuBarIcon: async () => {
			tray?.destroy(); tray = null; trayError = undefined; trayImageLoaded = false;
			setTrayVisibility(config.device.showInMenuBar);
			await updateTray();
			return desktopIntegration().menuBar.state === "VISIBLE" ? { ok: true, message: "Menu bar icon rebuilt" } : { ok: false, message: trayError ?? "Could not create the menu bar icon" };
		},
		removeIntegration: async () => {
			try {
				await runtime.stop();
				config = persistMode(config, "official");
				config.device.startAtLogin = false;
				saveSupervisorConfig(config);
				saveLoginItemChoice(config.device, false, loginSystem);
				if (isMas) folderAccess.revokeAll();
				if (!isMas) { syncClaudeHooks(false); migrateLegacyLaunchAgents(); }
				openElgato();
				lastError = undefined;
				await updateTray();
				return { ok: true, message: isMas ? "Login item disabled, folder access revoked, and Neo released. Settings and logs retained." : "Login item, Claude hooks, and legacy services removed. Settings and logs retained." };
			} catch (error) {
				lastError = messageOf(error);
				return { ok: false, message: lastError };
			}
		},

	});

	setTrayVisibility(config.device.showInMenuBar);
	await updateTray();
	if (!startInBackground) showWindow();
	if (!isMas && process.argv.includes("--permission-repair")) {
		setTimeout(() => {
			try { nativeControl?.requestPostEventAccess(); } catch (error) { lastError = messageOf(error); }
			void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
		}, 600);
	}

	powerMonitor.on("suspend", () => runtime.setSuspended(true));
	powerMonitor.on("resume", () => runtime.setSuspended(false));
	app.on("second-instance", showWindow);
	app.on("activate", () => {
		// A login launch can emit an activation event even though it should stay
		// headless. The tray and a later explicit launch still open the window.
		if (!startInBackground || mainWindow) showWindow();
	});
	app.on("window-all-closed", () => undefined);
	app.on("before-quit", (event) => {
		if (runtimeStopped) return;
		event.preventDefault();
		if (quitting) return;
		quitting = true;
		void runtime.stop().finally(() => {
			folderAccess.close();
			runtimeStopped = true;
			// Let the cancelled native quit unwind before starting the final quit.
			// A nested quit from this promise microtask is ignored on macOS.
			setImmediate(() => app.quit());
		});
	});

}

interface IpcOperations {
	getStatus(): Promise<DesktopStatus>;
	chooseProject(): Promise<SupervisorProject | null>;
	chooseAgentFolder(kind: AgentFolderKind): Promise<OperationResult>;
	revokeAgentFolder(kind: AgentFolderKind): Promise<OperationResult>;
	saveSettings(request: SaveSettingsRequest): Promise<OperationResult>;
	setMode(mode: "ai" | "official"): Promise<OperationResult>;
	runDiagnostics(): Promise<OperationResult>;
	requestCodexApprovalPermission(): Promise<OperationResult>;
	repairCodexApprovalPermission(): Promise<OperationResult>;
	rebuildMenuBarIcon(): Promise<OperationResult>;
	removeIntegration(): Promise<OperationResult>;
}

function registerIpcHandlers(operations: IpcOperations): void {
	for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel);
	ipcMain.handle(IPC_CHANNELS.status, () => operations.getStatus());
	ipcMain.handle(IPC_CHANNELS.chooseProject, () => operations.chooseProject());
	ipcMain.handle(IPC_CHANNELS.chooseAgentFolder, (_event, kind: unknown) => {
		if (typeof kind !== "string" || !AGENT_FOLDER_KINDS.includes(kind as AgentFolderKind)) return { ok: false, message: "Invalid agent folder type" };
		return operations.chooseAgentFolder(kind as AgentFolderKind);
	});
	ipcMain.handle(IPC_CHANNELS.revokeAgentFolder, (_event, kind: unknown) => {
		if (typeof kind !== "string" || !AGENT_FOLDER_KINDS.includes(kind as AgentFolderKind)) return { ok: false, message: "Invalid agent folder type" };
		return operations.revokeAgentFolder(kind as AgentFolderKind);
	});
	ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, request: SaveSettingsRequest) => operations.saveSettings(request));
	ipcMain.handle(IPC_CHANNELS.setMode, (_event, mode: unknown) => {
		if (mode !== "ai" && mode !== "official") return { ok: false, message: "Invalid mode" };
		return operations.setMode(mode);
	});
	ipcMain.handle(IPC_CHANNELS.diagnostics, () => operations.runDiagnostics());
	ipcMain.handle(IPC_CHANNELS.requestCodexApprovalPermission, () => operations.requestCodexApprovalPermission());
	ipcMain.handle(IPC_CHANNELS.repairCodexApprovalPermission, () => operations.repairCodexApprovalPermission());
	ipcMain.handle(IPC_CHANNELS.rebuildMenuBarIcon, () => operations.rebuildMenuBarIcon());
	ipcMain.handle(IPC_CHANNELS.removeIntegration, () => operations.removeIntegration());
}

function validateSettingsRequest(request: SaveSettingsRequest): SupervisorConfig {
	if (!request || typeof request !== "object" || !request.config) throw new Error("Invalid settings data.");
	const config = normalizeSupervisorConfig(request.config);
	const ids = new Set<string>();
	for (const project of config.projects) {
		let stat: fs.Stats;
		if (!isMas) {
			try { stat = fs.statSync(project.cwd); } catch { throw new Error(`Project folder does not exist: ${project.cwd}`); }
			if (!stat.isDirectory()) throw new Error(`Project path is not a folder: ${project.cwd}`);
		} else { delete project.verify; }
		if (ids.has(project.id)) throw new Error(`Duplicate project ID: ${project.id}`);
		ids.add(project.id);
	}
	return config;
}

function projectFromPath(cwd: string): SupervisorProject {
	const name = path.basename(cwd);
	return {
		id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `project-${Date.now()}`,
		label: name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 9).toUpperCase() || "PROJECT",
		cwd,
	};
}

function persistMode(config: SupervisorConfig, mode: "ai" | "official"): SupervisorConfig {
	const next = structuredClone(config);
	next.device.mode = mode;
	return saveSupervisorConfig(next);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function operationResult(message: string, operation: () => Promise<void>): Promise<OperationResult> {
	try { await operation(); return { ok: true, message }; }
	catch (error) { return { ok: false, message: messageOf(error) }; }
}

async function runTccReset(bundleId: string): Promise<void> {
	for (const service of ["PostEvent", "Accessibility"]) {
		await new Promise<void>((resolve, reject) => {
			execFile("/usr/bin/tccutil", ["reset", service, bundleId], { timeout: 5_000 }, (error) => error ? reject(error) : resolve());
		});
	}
}

function deviceLabel(status: DesktopStatus["device"]): string {
	switch (status.state) {
		case "CONNECTED": return "Neo connected";
		case "SEARCHING": return "Searching for Neo";
		case "MULTIPLE": return "Choose a Neo";
		case "BUSY": return "Neo is in use";
		case "NOT_FOUND": return "Neo not found";
		case "ERROR": return "Neo connection error";
		default: return "Neo stopped";
	}
}
