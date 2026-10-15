import { UsageCalendar } from "./usage-calendar.js";
import type { SupervisorConfig, SupervisorProject } from "@streamdeck-supervisor/daemon";
import type { AgentFolderKind } from "../agent-folder-access.js";
import type { DesktopStatus, OperationResult, SupervisorBridge } from "../app-types.js";

declare global { interface Window { supervisor: SupervisorBridge } }

interface ConfirmOptions {
	title: string;
	subtitle: string;
	body: string;
	confirmLabel: string;
	danger?: boolean;
	action: () => void | Promise<void>;
}

let status: DesktopStatus;
let draft: SupervisorConfig;
let dirty = false;
let startAtLoginChoice: boolean | undefined;
let busy = false;
let confirmAction: ConfirmOptions["action"] | undefined;
let refreshInFlight: Promise<void> | undefined;
let fullRefreshPending = false;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const confirmSheet = byId<HTMLDialogElement>("confirm-sheet");
const contentScroll = byId<HTMLElement>("content-scroll");

const usageCalendar = new UsageCalendar(document.querySelector<HTMLElement>(".usage-panel")!);

void refresh(true);
setInterval(() => { if (!busy && !confirmSheet.open) void refresh(false); }, 1_000);

async function refresh(full: boolean): Promise<void> {
	fullRefreshPending ||= full;
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		do {
			const resetDraft = fullRefreshPending;
			fullRefreshPending = false;
			try {
				status = await window.supervisor.getStatus();
				if (resetDraft || !draft) {
					draft = structuredClone(status.config);
					startAtLoginChoice = undefined;
					dirty = false;
				}
				render();
			} catch (error) { showNotice(messageOf(error), "error"); }
		} while (fullRefreshPending);
	})();
	try { await refreshInFlight; }
	finally { refreshInFlight = undefined; }
}

function render(): void {
	document.body.classList.toggle("mas-edition", status.mas === true);
	byId("version").textContent = `v${status.version}`;
	const runtimePill = byId("runtime-pill");
	runtimePill.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span>${status.runtimeRunning ? "Running" : "Service error"}</span>`;
	runtimePill.className = `runtime-pill ${status.runtimeRunning ? "ok" : "error"}`;
	byId("setup-state").textContent = status.configured ? "All essential checks passed" : "Setup needs attention";
	if (status.lastError) showNotice(status.lastError, "error");
	usageCalendar.update(status.monitor);
	if (dirty) return;

	const hasAgent = (draft.agents.codex.enabled && status.agents.codex.detected) || (draft.agents.claude.enabled && status.agents.claude.detected);
	const hasNeo = status.device.scannedDevices.length > 0;
	byId("readiness").innerHTML = [
		readiness("Applications", status.inApplicationsFolder, status.inApplicationsFolder ? "Installed in Applications" : "Move the app to Applications"),
		readiness("Codex / Claude", hasAgent, hasAgent ? "At least one agent is available" : status.mas ? "Grant access to an agent log folder" : "Install and enable an agent"),
		readiness("Monitoring Scope", true, status.mas ? "All projects in authorized logs" : draft.projects.length ? `All projects · ${draft.projects.length} custom labels` : "All projects · No project folders required"),
		readiness("Stream Deck Neo", hasNeo, hasNeo ? `${status.device.scannedDevices.length} connected` : "Connect Neo by USB"),
		status.mas ? readiness("Log Folders", hasAgent, hasAgent ? "Authorized folders read locally" : "Choose agent log folders below") : readiness("Managed Codex", status.runtimeRunning && draft.agents.codex.enabled, draft.agents.codex.enabled ? "Local app-server starts on demand" : "Codex disabled"),
	].join("");

	byId("agents").innerHTML = (["codex", "claude"] as const).map((agent) => {
		const state = status.agents[agent];
		const name = agent === "codex" ? "Codex" : "Claude";
		const monitor = state.detected
			? `${state.health === "OK" ? "Monitoring" : state.health} · ${state.runningCount} running${state.decisionCount ? ` · ${state.decisionCount} need attention` : ""}`
			: status.mas ? "Choose a log folder" : "Not installed";
		return `<div class="agent-row"><div class="agent-copy"><span class="agent-dot ${agent}" aria-hidden="true"></span><div><strong>${name} Observer</strong><p>${escapeHtml(monitor)}</p></div></div><div class="agent-row-actions">${status.mas ? `<button class="button quiet-button" data-agent-folder="${agent}" aria-label="Choose ${name} log folder" type="button">${state.detected ? "Change folder" : "Choose log folder"}</button>${state.detected ? `<button class="button quiet-button" data-revoke-folder="${agent}" type="button">Revoke access</button>` : ""}` : ""}<span class="health-pill ${healthClass(state.health, state.detected)}">${state.detected ? healthLabel(state.health) : status.mas ? "No folder access" : "Not installed"}</span><label class="switch-only" aria-label="Enable ${name}"><input data-agent="${agent}" type="checkbox" ${draft.agents[agent].enabled ? "checked" : ""}/><span class="toggle" aria-hidden="true"></span></label></div></div>`;
	}).join("");
	document.querySelectorAll<HTMLInputElement>("[data-agent]").forEach((input) => input.addEventListener("change", () => {
		const agent = input.dataset.agent as "codex" | "claude";
		draft.agents[agent].enabled = input.checked;
		markDirty();
	}));
	if (status.mas) {
		byId("agents").insertAdjacentHTML("beforeend", `<div class="agent-row agent-folder-extra"><div class="agent-copy"><div><strong>Claude Desktop model data (optional)</strong><p>${status.agentFolders?.claudeDesktop ? "Folder access granted" : "Read additional model and reasoning settings"}</p></div></div><button class="button quiet-button" data-agent-folder="claudeDesktop" type="button">Choose folder</button>${status.agentFolders?.claudeDesktop ? `<button class="button quiet-button" data-revoke-folder="claudeDesktop" type="button">Revoke access</button>` : ""}</div><div class="info-callout"><p>Handle approvals in Codex or Claude. Quit the Stream Deck app before enabling Neo control.</p></div>`);
		document.querySelectorAll<HTMLButtonElement>("[data-agent-folder]").forEach(button => {
			button.onclick = () => void runOperation(() => window.supervisor.chooseAgentFolder(button.dataset.agentFolder as AgentFolderKind));
		});
		document.querySelectorAll<HTMLButtonElement>("[data-revoke-folder]").forEach(button => {
			button.onclick = () => void runOperation(() => window.supervisor.revokeAgentFolder(button.dataset.revokeFolder as AgentFolderKind));
		});
		byId("repair-codex-permission").classList.add("hidden");
		byId("project-help").textContent = "Set device display labels for project folders.";
	}
	renderCodexApprovalControl();
	renderProjects();
	renderDevice();
}

function renderCodexApprovalControl(): void {
	const container = byId("codex-approval-control");
	if (status.mas || !draft.agents.codex.enabled) {
		container.classList.add("hidden");
		container.innerHTML = "";
		return;
	}
	container.classList.remove("hidden");
	const control = status.codexApprovalControl;
	const ready = control.status === "READY";
	const detail = ready
		? "System control permission is ready."
		: control.status === "PERMISSION_REQUIRED"
			? "Grant keyboard control access to this app."
			: control.status === "REQUESTING"
				? "Waiting for macOS permission."
				: control.lastError ?? "Codex approval shortcuts are unavailable in this environment.";
	container.innerHTML = `<div><strong>Codex Approval Control</strong><p>${escapeHtml(detail)}</p><small>Permission holder: ${escapeHtml(control.bundleId ? "Agent Pulse" : "Unavailable")} · ${escapeHtml(control.provider ?? "None")}</small></div><div class="permission-actions"><span class="health-pill ${ready ? "ok" : "warn"}">${ready ? "Ready" : escapeHtml(control.status)}</span>${control.status === "PERMISSION_REQUIRED" ? '<button id="request-codex-permission" class="button quiet-button" type="button">Authorize this app</button>' : ""}</div>`;
	const requestPermission = document.getElementById("request-codex-permission") as HTMLButtonElement | null;
	if (requestPermission) requestPermission.onclick = () => void runOperation(() => window.supervisor.requestCodexApprovalPermission());
	byId<HTMLButtonElement>("repair-codex-permission").onclick = () => openConfirmation({
		title: "Repair previous permission?",
		subtitle: "Reset the Agent Pulse Accessibility permission",
		body: "Permissions for other apps are retained. Grant Agent Pulse system access again after the reset.",
		confirmLabel: "Repair permission",
		action: () => void runOperation(() => window.supervisor.repairCodexApprovalPermission()),
	});
}

function openConfirmation(options: ConfirmOptions): void {
	if (busy) return;
	confirmAction = options.action;
	byId("confirm-sheet-title").textContent = options.title;
	byId("confirm-sheet-subtitle").textContent = options.subtitle;
	byId("confirm-sheet-content").innerHTML = `<div class="confirmation-copy"><p>${escapeHtml(options.body)}</p></div>`;
	const submit = byId<HTMLButtonElement>("confirm-sheet-submit");
	submit.textContent = options.confirmLabel;
	submit.className = `button ${options.danger ? "destructive" : "primary"}`;
	confirmSheet.showModal();
}

function closeConfirmation(): void {
	if (confirmSheet.open) confirmSheet.close();
	confirmAction = undefined;
}

function renderProjects(): void {
	const container = byId("projects");
	if (draft.projects.length === 0) {
		container.innerHTML = `<div class="empty-state compact-empty">All projects are monitored. Add a folder to customize labels${status.mas ? "" : " or verification commands"}.</div>`;
		return;
	}
	container.innerHTML = draft.projects.map((project, index) => `<div class="project-card"><label class="field path-field"><span>Project path</span><input value="${escapeHtml(project.cwd)}" readonly title="${escapeHtml(project.cwd)}" /></label><label class="field"><span>Display label</span><input data-project-label="${index}" value="${escapeHtml(project.label)}" /></label><label class="field verify-field ${status.mas ? "hidden" : ""}"><span>Verification command (optional)</span><input data-verify="${index}" value="${escapeHtml(project.verify?.command ?? "")}" placeholder="e.g. npm test" /></label><button class="icon-button" data-remove-project="${index}" type="button" aria-label="Remove ${escapeHtml(project.label)}">×</button></div>`).join("");
	document.querySelectorAll<HTMLInputElement>("[data-project-label]").forEach((input) => input.addEventListener("input", () => {
		const project = draft.projects[Number(input.dataset.projectLabel)];
		if (!project) return;
		project.label = input.value;
		markDirty();
	}));
	document.querySelectorAll<HTMLInputElement>("[data-verify]").forEach((input) => input.addEventListener("input", () => {
		const project = draft.projects[Number(input.dataset.verify)];
		if (!project) return;
		const command = input.value.trim();
		project.verify = command ? { command, cwd: project.cwd, timeoutMs: 180_000 } : undefined;
		markDirty();
	}));
	document.querySelectorAll<HTMLButtonElement>("[data-remove-project]").forEach((button) => button.addEventListener("click", () => {
		draft.projects.splice(Number(button.dataset.removeProject), 1);
		markDirty();
		renderProjects();
	}));
}

function renderDevice(): void {
	const state = byId("device-state");
	state.textContent = deviceText();
	state.className = `device-state ${status.device.state === "CONNECTED" ? "ok" : ["ERROR", "BUSY"].includes(status.device.state) ? "error" : "warn"}`;
	const select = byId<HTMLSelectElement>("device-select");
	const devices = status.device.scannedDevices;
	select.innerHTML = devices.length === 0
		? `<option value="">No Neo found</option>`
		: devices.map((device, index) => `<option value="${escapeHtml(device.serialNumber ?? device.path)}" ${(draft.device.serialNumber ?? (devices.length === 1 ? device.serialNumber : "")) === device.serialNumber ? "selected" : ""}>Neo ${escapeHtml(device.serialNumber ?? `#${index + 1}`)}</option>`).join("");
	select.disabled = devices.length === 0;
	select.onchange = () => {
		const device = devices.find((candidate) => (candidate.serialNumber ?? candidate.path) === select.value);
		draft.device.serialNumber = device?.serialNumber;
		markDirty();
	};
	const login = byId<HTMLInputElement>("login-toggle");
	login.checked = startAtLoginChoice ?? status.openAtLogin;
	login.onchange = () => { startAtLoginChoice = login.checked; draft.device.startAtLogin = login.checked; markDirty(); };
	const menuBar = byId<HTMLInputElement>("menu-bar-toggle");
	menuBar.checked = draft.device.showInMenuBar;
	menuBar.onchange = () => { draft.device.showInMenuBar = menuBar.checked; markDirty(); };
	const menuStatus = status.desktopIntegration.menuBar;
	byId("menu-bar-status").textContent = menuStatus.state === "VISIBLE" ? "Menu bar icon visible" : menuStatus.state === "ERROR" ? `Menu bar icon error: ${menuStatus.lastError ?? "Unknown"}` : "Menu bar icon hidden";
	byId("dock-status").textContent = status.desktopIntegration.dock.state === "VISIBLE" ? "Settings window visible in Dock" : "Dock icon hides when the window closes";
	const toggle = byId<HTMLInputElement>("takeover-toggle");
	toggle.checked = status.config.device.mode === "ai";
	toggle.disabled = busy;
	byId("mode-explanation").textContent = toggle.checked ? "Agent Pulse controls Neo. Turn this off to return Neo to the Stream Deck app." : "Neo control is off. The Stream Deck app can use the device.";
}

byId("add-project").addEventListener("click", async () => {
	const project = await window.supervisor.chooseProject();
	if (!project) return;
	project.id = uniqueProjectId(project.id);
	if (!draft.projects.some((item) => item.cwd === project.cwd)) draft.projects.push(project);
	markDirty();
	renderProjects();
});
byId("save").addEventListener("click", () => void runOperation(async () => {
	const result = await window.supervisor.saveSettings({ config: draft, ...(startAtLoginChoice !== undefined ? { startAtLoginChoice } : {}) });
	if (result.ok) { dirty = false; startAtLoginChoice = undefined; }
	return result;
}));
byId<HTMLInputElement>("takeover-toggle").addEventListener("change", event => { void switchMode((event.target as HTMLInputElement).checked ? "ai" : "official"); });
byId("diagnostics").addEventListener("click", () => void runOperation(() => window.supervisor.runDiagnostics()));
byId("rebuild-menu-bar").addEventListener("click", () => void runOperation(() => window.supervisor.rebuildMenuBarIcon()));
byId("remove-integration").addEventListener("click", () => openConfirmation({
	title: "Remove integrations?",
	subtitle: "Return Neo to the Stream Deck app",
	body: status.mas ? "Disable launch at login, revoke all log folder access, and release Neo. Settings and local history are retained." : "Remove the login item, Claude hooks, and legacy services. Settings and logs are retained.",
	confirmLabel: "Remove integrations",
	danger: true,
	action: () => void runOperation(() => window.supervisor.removeIntegration()),
}));
byId("confirm-sheet-cancel").addEventListener("click", closeConfirmation);
byId("confirm-sheet-submit").addEventListener("click", () => {
	const action = confirmAction;
	closeConfirmation();
	void action?.();
});
confirmSheet.addEventListener("cancel", (event) => { event.preventDefault(); closeConfirmation(); });

async function switchMode(mode: "ai" | "official"): Promise<void> {
	await runOperation(async () => {
		if (dirty) {
			const saved = await window.supervisor.saveSettings({ config: draft, ...(startAtLoginChoice !== undefined ? { startAtLoginChoice } : {}) });
			if (!saved.ok) return saved;
			dirty = false;
		}
		return window.supervisor.setMode(mode);
	});
}

async function runOperation(operation: () => Promise<OperationResult>): Promise<void> {
	if (busy) return;
	busy = true;
	setButtonsDisabled(true);
	try {
		const result = await operation();
		showNotice(result.message, result.ok ? "success" : "error");
		await refresh(true);
	} catch (error) { showNotice(messageOf(error), "error"); }
	finally { busy = false; setButtonsDisabled(false); }
}

function markDirty(): void {
	dirty = true;
	byId("save").textContent = "Save settings · Unsaved changes";
}

function setButtonsDisabled(disabled: boolean): void {
	document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = disabled; });
	if (!disabled) {
		byId("save").textContent = dirty ? "Save settings · Unsaved changes" : "Save settings";
		renderDevice();
		usageCalendar.update(status.monitor);
	}
}

function showNotice(message: string, kind: "success" | "error" | "warn" = "warn"): void {
	const notice = byId("notice");
	notice.textContent = message;
	notice.className = `notice ${kind}`;
	setTimeout(() => { if (notice.textContent === message) notice.classList.add("hidden"); }, 7_000);
}

function readiness(title: string, ready: boolean, detail: string): string {
	return `<div class="readiness-item ${ready ? "ready" : "pending"}"><span class="readiness-state" aria-hidden="true">${ready ? "✓" : "!"}</span><div><strong>${title}</strong><span>${escapeHtml(detail)}</span></div></div>`;
}

function healthClass(health: string, detected: boolean): string {
	if (!detected || health === "DEGRADED" || health === "OFFLINE") return "error";
	if (health === "DISABLED") return "warn";
	return "ok";
}

function healthLabel(health: string): string {
	return ({ OK: "Healthy", DEGRADED: "Limited", OFFLINE: "Offline", DISABLED: "Disabled" } as Record<string, string>)[health] ?? health;
}

function deviceText(): string {
	if (draft.device.mode === "official") return status.elgatoRunning ? "Stream Deck mode · App running" : "Stream Deck mode";
	const labels: Record<string, string> = {
		CONNECTED: "AI mode · Connected", SEARCHING: "Searching for Neo", NOT_FOUND: "Neo not found",
		MULTIPLE: "Choose a Neo", BUSY: "Neo is in use", ERROR: "Connection error", STOPPED: "Device control stopped",
	};
	return labels[status.device.state] ?? status.device.state;
}

function shortIdentity(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function truncateText(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function cssEscape(value: string): string { return CSS.escape(value); }

function uniqueProjectId(base: string): string {
	let id = base;
	let suffix = 2;
	while (draft.projects.some((project) => project.id === id)) id = `${base}-${suffix++}`;
	return id;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
