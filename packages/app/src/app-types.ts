import type { AgentFolderKind } from "./agent-folder-access.js";
import type {
	AgentKind, CodexApprovalControlStatus, DesktopIntegrationStatus, DeviceConnectionStatus,
	ManagedTaskDetail, NeoDeviceInfo, ReasoningEffort, SystemStatus, Task,
} from "@streamdeck-supervisor/shared";
import type { SupervisorConfig, SupervisorProject } from "@streamdeck-supervisor/daemon";

export interface AgentInstallationStatus {
	enabled: boolean;
	detected: boolean;
	health: SystemStatus["adapters"]["codex"]["status"];
	detail: string;
	runningCount: number;
	decisionCount: number;
}

export interface DesktopStatus {
	version: string;
	mas?: boolean;
	agentFolders?: Partial<Record<AgentFolderKind, string>>;
	platformSupported: boolean;
	inApplicationsFolder: boolean;
	configured: boolean;
	runtimeRunning: boolean;
	openAtLogin: boolean;
	elgatoRunning: boolean;
	desktopIntegration: DesktopIntegrationStatus;
	agents: { codex: AgentInstallationStatus; claude: AgentInstallationStatus };
	codexApprovalControl: CodexApprovalControlStatus;
	device: DeviceConnectionStatus & { scannedDevices: NeoDeviceInfo[] };
	config: SupervisorConfig;
	monitor?: SystemStatus["monitor"];
	lastError?: string;
}

export interface SaveSettingsRequest {
	config: SupervisorConfig;
	/** Present only after the user changes the login toggle. */
	startAtLoginChoice?: boolean;
}

export interface OperationResult {
	ok: boolean;
	message: string;
	path?: string;
}

export interface SupervisorBridge {
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

export const IPC_CHANNELS = {
	status: "supervisor:get-status",
	chooseProject: "supervisor:choose-project",
	chooseAgentFolder: "supervisor:choose-agent-folder",
	revokeAgentFolder: "supervisor:revoke-agent-folder",
	saveSettings: "supervisor:save-settings",
	setMode: "supervisor:set-mode",
	diagnostics: "supervisor:run-diagnostics",
	requestCodexApprovalPermission: "supervisor:request-codex-approval-permission",
	repairCodexApprovalPermission: "supervisor:repair-codex-approval-permission",
	rebuildMenuBarIcon: "supervisor:rebuild-menu-bar-icon",
	removeIntegration: "supervisor:remove-integration",
} as const;
