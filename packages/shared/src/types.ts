/**
 * Stream Deck Neo AI Console — Shared data model
 *
 * The device layer, daemon, and adapters share these type definitions.
 * Keep a single Task schema across the Direct HID architecture;
 * independent copies would eventually drift apart.
 */

/** The two monitored agents. */
export type AgentKind = "codex" | "claude";

/** Reasoning-effort values currently exposed by Codex and Claude desktop sessions. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Ignore unknown/future values until the device has an intentional label for them. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "low" || normalized === "medium" || normalized === "high"
		|| normalized === "xhigh" || normalized === "max" || normalized === "ultra"
		? normalized
		: undefined;
}

/**
 * Shared task states.
 *
 * - IDLE:      Empty slot with no task
 * - QUEUED:    Submitted but execution has not started
 * - RUNNING:   Executing without requiring user input
 * - APPROVAL:  Binary permission request (Approve/Reject are active)
 * - NEEDS_INPUT: Open-ended question (OPEN/REPLY are active; Approve/Reject remain quiet)
 * - DONE_UNREAD: Completed but not yet acknowledged by the user
 * - DONE:       Acknowledged completion; retain the slot with reduced emphasis
 * - ERROR:     Execution, bridge, or verification failure
 * - PAUSED:    Current execution interrupted; the conversation can start another execution
 * - STALE:     Expired request or stale state; remain visible instead of disappearing silently
 */
export type TaskStatus =
	| "IDLE"
	| "QUEUED"
	| "RUNNING"
	| "APPROVAL"
	| "NEEDS_INPUT"
	| "DONE_UNREAD"
	| "DONE"
	| "ERROR"
	| "PAUSED"
	| "STALE";

/** Pending request risk level for desktop details and decision validation. */
export type RiskTier = 1 | 2;

/** The actual decision path used by Approve/Reject. */
export type DecisionPath = "claude-hook" | "codex-shortcut" | null;

export interface TaskRequest {
	/** Explicit request addressed to a person, not inferred from tool execution. */
	humanRequired?: boolean;
	/** Unique, non-reusable request ID. Approve/Reject must bind to (agentId, taskId, requestId). */
	requestId: string;
	/** Request type, e.g. "permission" | "network" | "file-access" | "input"; also informs risk classification. */
	type: string;
	/** Command, domain, or path shown in Infobar/key summaries and used to assess risk before approval. */
	target: string;
	riskTier: RiskTier;
	createdAt: number;
	expiresAt: number;
	decisionPath: DecisionPath;
}

/**
 * The main page derives available actions from this object instead of agent-specific conditionals.
 * Capabilities require a live response channel; persisted records or observer events cannot enable decision keys.
 */
export interface TaskCapabilities {
	/** Capabilities exposed by the untrusted local-device WebSocket client. */
	device: {
		open: boolean;
		review: boolean;
		verify: boolean;
		answerChoice: boolean;
	};
	/** Capabilities revalidated by the trusted Electron main-process bridge. */
	desktop: {
		open: boolean;
		send: boolean;
		approve: boolean;
		reject: boolean;
		interrupt: boolean;
		review: boolean;
		verify: boolean;
		changeSettings: boolean;
	};
}

/** Ownership is assigned once when the task identity is first registered. */
export type TaskOwnership = "observer" | "managed";

export type ActivityCategory = "image" | "thinking" | "shell" | "file" | "search" | "browser" | "plan" | "agent" | "input" | "terminal" | "other";
export type ActivityState = "running" | "done" | "error" | "waiting";

export interface TaskActivity {
	category: ActivityCategory;
	/** A redacted device-safe summary; never a full command or tool argument. */
	label: string;
	state: ActivityState;
	at: number;
}

/** Durable process summary shared by Observer and Managed tasks. */
export interface TaskProgress {
	latestActivity?: TaskActivity;
	todoCompleted: number;
	todoTotal: number;
	currentTodo?: string;
	activeSubagents: number;
	totalSubagents: number;
	turnStartedAt?: number;
	durationMs: number;
	queueLength: number;
	queueFailed: number;
	/** Redacted last effective agent message, retained after the turn completes. */
	recap?: string;
}

export function emptyTaskProgress(): TaskProgress {
	return {
		todoCompleted: 0,
		todoTotal: 0,
		activeSubagents: 0,
		totalSubagents: 0,
		durationMs: 0,
		queueLength: 0,
		queueFailed: 0,
	};
}

export function taskCapabilities(options: Partial<TaskCapabilities["desktop"]> & { deviceOpen?: boolean; answerChoice?: boolean } = {}): TaskCapabilities {
	return {
		device: {
			open: options.deviceOpen ?? options.open ?? true,
			review: options.review ?? false,
			verify: options.verify ?? false,
			answerChoice: options.answerChoice ?? false,
		},
		desktop: {
			open: options.open ?? true,
			send: options.send ?? false,
			approve: options.approve ?? false,
			reject: options.reject ?? false,
			interrupt: options.interrupt ?? false,
			review: options.review ?? false,
			verify: options.verify ?? false,
			changeSettings: options.changeSettings ?? false,
		},
	};
}

export interface OpenRef {
	kind: "url";
	value: string;
}

export interface ReviewRef {
	kind: "diff" | "log" | "result" | "pr";
	value: string;
}

export interface VerifyProfile {
	command: string;
	cwd: string;
	timeoutMs: number;
}

/** The latest user-triggered verification for this task. Kept separate from agent status. */
export interface TaskWorkflow {
	kind: "verify";
	state: "running" | "pass" | "fail";
	lastRunAt: number;
	logPath?: string;
}

/** A choice that can be answered directly from the Stream Deck Neo. */
export interface PlanOption {
	/** The exact value Codex expects in the app-server response. */
	label: string;
	/** The copy shown as the main content of the Neo key. */
	description: string;
}

/** One supported request_user_input question. */
export interface PlanQuestion {
	id: string;
	header: string;
	question: string;
	options: PlanOption[];
}

/**
 * Ephemeral bridge state for an active Codex app-server user-input request.
 * It is intentionally not part of Task persistence: the app-server request id
 * is only valid for the live JSON-RPC connection.
 */
export interface PendingPlanInput {
	/** Supervisor-local stable id used by the device IPC action. */
	requestId: string;
	taskId: string;
	threadId: string;
	turnId: string;
	itemId: string;
	questionIndex: number;
	questions: PlanQuestion[];
}

export interface AppServerStatus {
	status: "OK" | "CONNECTING" | "OFFLINE" | "DEGRADED";
	lastPollAt: number;
	lastError?: string;
}

/** Readiness to send Return/Escape to the exact Codex Desktop approval card on macOS. */
export interface CodexApprovalControlStatus {
	status: "READY" | "PERMISSION_REQUIRED" | "REQUESTING" | "UNAVAILABLE" | "ERROR";
	lastCheckedAt: number;
	/** The exact macOS TCC service used by the in-process keyboard controller. */
	permissionKind?: "post-event";
	/** Approval input must originate from the packaged main process, never osascript/node helpers. */
	provider?: "native-main-process";
	bundleId?: string;
	lastError?: string;
}

/** Signal source that supplied the task state, for troubleshooting. */
export type TaskSource = "hook-event" | "catalog-sqlite" | "transcript-tail" | "jsonl-tail" | "app-server-events" | "mock";

export interface Task {
	/** Stable daemon-assigned ID for the lifetime of the session/thread. */
	taskId: string;
	/** Stable execution ID: Codex turn_id, or an ID generated for each Claude UserPromptSubmit. */
	executionId?: string;
	/** Stable zero-based device slot; state changes must not move it. */
	slot?: number;
	agent: AgentKind;
	/** Immutable trust boundary: Observer tasks can never acquire Managed writes. */
	ownership: TaskOwnership;
	/** Claude: session_id; Codex: rollout JSONL identifier. */
	externalId: string;
	projectId: string;
	/** First key line; prefer 3–9 characters. */
	projectLabel: string;
	/** Original workspace path, kept even when projectId is normalized by config. */
	cwd?: string;
	/** Second key line; use a short noun or action phrase. */
	titleShort: string;
	/** Current per-conversation reasoning effort, when the local app exposes it. */
	reasoningEffort?: ReasoningEffort;
	/** Actual model observed for this conversation. */
	model?: string;
	status: TaskStatus;
	/**
	 * V2 compatibility field; V3 derives it from attentionVersion / acknowledgedAttentionVersion.
	 * Adapters no longer decide whether the user has already been notified.
	 */
	attentionCount: number;
	/** Incremented for each new attention event on this task; maintained and persisted by the daemon registry. */
	attentionVersion?: number;
	/** Last attentionVersion handled or viewed by the user; show a badge only when it trails attentionVersion. */
	acknowledgedAttentionVersion?: number;
	/** DONE/ERROR reminders expire automatically; decisions and questions never use this field. */
	attentionExpiresAt?: number;
	request?: TaskRequest;
	capabilities: TaskCapabilities;
	progress: TaskProgress;
	openRef: OpenRef;
	/** Used only for local desktop interruption/focus; contains no command or prompt text. */
	processId?: number;
	reviewRef?: ReviewRef;
	verifyProfile?: VerifyProfile;
	workflow?: TaskWorkflow;
	source: TaskSource;
	lastEventAt: number;
	/** Last time a live adapter positively observed this task. Not an attention timestamp. */
	lastObservedAt?: number;
	/** Latest execution activity or authoritative live-turn signal; polling/metadata do not renew it. */
	lastExecutionActivityAt?: number;
	startedAt: number;
}

export interface ManagedQueueMessage {
	id: string;
	text: string;
	createdAt: number;
	state: "queued" | "sending" | "failed";
	error?: string;
}

export interface ManagedDesktopRequest {
	requestId: string;
	threadId: string;
	turnId: string;
	itemId: string;
	kind: "command-approval" | "file-approval" | "question";
	summary: string;
	createdAt: number;
	questions?: PlanQuestion[];
}

export interface ManagedTaskDetail {
	task: Task;
	model?: string;
	queue: ManagedQueueMessage[];
	requests: ManagedDesktopRequest[];
}

export interface CodexModelDescriptor {
	id: string;
	label: string;
	description?: string;
	defaultEffort?: ReasoningEffort;
	supportedEfforts: ReasoningEffort[];
	isDefault: boolean;
}

export interface CreateManagedTaskRequest {
	prompt: string;
	cwd: string;
	model?: string;
	effort?: ReasoningEffort;
}

/** Health of an individual adapter. */
export interface AdapterStatus {
	status: "OK" | "DEGRADED" | "OFFLINE" | "DISABLED";
	lastPollAt: number;
	lastError?: string;
}

/** Direct-HID connection state exposed to the desktop settings app. */
export type DeviceConnectionState = "STOPPED" | "SEARCHING" | "CONNECTED" | "NOT_FOUND" | "MULTIPLE" | "BUSY" | "ERROR";

export interface NeoDeviceInfo {
	model: string;
	path: string;
	serialNumber?: string;
}

export interface DeviceConnectionStatus {
	state: DeviceConnectionState;
	devices: NeoDeviceInfo[];
	selectedSerialNumber?: string;
	productName?: string;
	lastError?: string;
}

export interface AgentRuntimeStatus {
	runningCount: number;
	decisionCount: number;
	terminalReminder?: {
		status: "DONE" | "ERROR";
		count: number;
		expiresAt: number;
	};
}

export interface MenuBarRuntimeStatus {
	requested: boolean;
	state: "VISIBLE" | "HIDDEN" | "ERROR";
	imageLoaded: boolean;
	bounds?: { x: number; y: number; width: number; height: number };
	lastError?: string;
}

export interface DockRuntimeStatus {
	state: "VISIBLE" | "HIDDEN" | "UNAVAILABLE";
	windowVisible: boolean;
}

export interface DesktopIntegrationStatus {
	menuBar: MenuBarRuntimeStatus;
	dock: DockRuntimeStatus;
}

/**
 * System health is independent of any individual task.
 * Task attention and overall system health must remain separate concepts.
 * The device-side offline watchdog in daemon-client.ts does not depend on this object:
 * a stopped daemon cannot send it. While running, the daemon uses it to report adapter health.
 */
export interface UsageDay { codex: number; claude: number; }
export interface DeviceSlot { taskId: string; executionId: string; slot: number; durationMs: number; }
export interface MonitorSummary { selectedAgent?: AgentKind; days: Record<string, UsageDay>; slots: Record<AgentKind, DeviceSlot[]>; }

export interface SystemStatus {
	monitor?: MonitorSummary;
	daemonUptimeMs: number;
	daemonPid: number;
	adapters: Record<"claude" | "codex" | "workflow", AdapterStatus>;
	/** Optional for backwards-compatible snapshots from older daemons. */
	codexAppServer?: AppServerStatus;
	/** Optional for backwards-compatible snapshots and non-desktop daemon launches. */
	codexApprovalControl?: CodexApprovalControlStatus;
	/** 0 means the device should show SETUP rather than IDLE or OFFLINE. */
	configuredProjectCount: number;
	/** Optional for protocol-v3 compatibility with older daemons. */
	monitoringScope?: "all-projects";
	/** Current Direct-HID state, supplied by the packaged desktop runtime. */
	deviceConnection?: DeviceConnectionStatus;
	/** Actual macOS login-item state when hosted by the packaged app. */
	loginItemEnabled?: boolean;
	/** Unique top-level Codex/Claude conversations currently in RUNNING. */
	runningTaskCount: number;
	/** Optional protocol-v3 extension separating installation/health from actual activity. */
	agentRuntime?: Record<AgentKind, AgentRuntimeStatus>;
	/** Optional actual macOS UI state supplied by the packaged desktop host. */
	desktopIntegration?: DesktopIntegrationStatus;
	/** App-wide fallback used only while the selected conversation is genuinely RUNNING. */
	reasoningDefaults?: Partial<Record<AgentKind, ReasoningEffort>>;
}

/** Each agent keeps its own selection without overwriting the other agent. */
export interface UiFocus {
	selectedTaskId: Record<AgentKind, string | null>;
	/** Agent targeted by the main control page, stored separately from each agent's selectedTask. */
	activeAgent: AgentKind | null;
	/** Persistent New Chat target; changed only by a successful main-page agent logo action. */
	newChatAgent: AgentKind;
}

/** States that may require attention on the main agent summary key. */
export function isAttentionTask(task: Pick<Task, "status">): boolean {
	return task.status === "APPROVAL" || task.status === "NEEDS_INPUT" || task.status === "ERROR" || task.status === "DONE_UNREAD";
}

/** States eligible for active or user-blocked work on the task pages. */
export function isLiveTask(task: Pick<Task, "status">): boolean {
	return task.status === "RUNNING" || task.status === "APPROVAL" || task.status === "NEEDS_INPUT";
}

/** Executions which can leave both device and desktop without losing pending work. */
export function isClearableTask(task: Pick<Task, "status">): boolean {
	return ["IDLE", "DONE", "DONE_UNREAD", "ERROR", "PAUSED", "STALE"].includes(task.status);
}

export function taskExecutionKey(task: Pick<Task, "executionId" | "progress" | "startedAt">): string {
	return task.executionId ?? String(task.progress.turnStartedAt ?? task.startedAt);
}

/** Support older snapshots while treating V3 persisted version counters as the source of truth. */
export function isPendingAttentionTask(
	task: Pick<Task, "status" | "attentionCount" | "attentionVersion" | "acknowledgedAttentionVersion" | "attentionExpiresAt">,
	now = Date.now(),
): boolean {
	if (!isAttentionTask(task)) return false;
	if ((task.status === "DONE_UNREAD" || task.status === "ERROR")
		&& task.attentionExpiresAt !== undefined
		&& task.attentionExpiresAt <= now) return false;
	const version = task.attentionVersion ?? (task.attentionCount > 0 ? 1 : 0);
	const acknowledged = task.acknowledgedAttentionVersion ?? 0;
	return version > acknowledged;
}

/** Tasks eligible as main-page action context: active work or unacknowledged completion/error. */
export function isMainContextTask(
	task: Pick<Task, "status" | "attentionCount" | "attentionVersion" | "acknowledgedAttentionVersion" | "attentionExpiresAt">,
): boolean {
	return isLiveTask(task) || isPendingAttentionTask(task);
}

/** Whether the agent logo is active; independent of whether the app process is open. */
export function isAgentLitTask(
	task: Pick<Task, "status" | "attentionCount" | "attentionVersion" | "acknowledgedAttentionVersion" | "attentionExpiresAt">,
): boolean {
	return isLiveTask(task) || isPendingAttentionTask(task);
}
