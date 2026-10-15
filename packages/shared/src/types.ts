/**
 * Stream Deck Neo AI 控制台 — 统一数据模型
 *
 * 这是插件(Device Layer)、Daemon 和各 Adapter 共享的唯一类型定义来源。
 * 参见 V3 Direct HID 架构。任何一方都不应该定义自己的一份平行 Task 结构——
 * 两套 schema 迟早会漂移,是这个共享包存在的唯一理由。
 */

/** 两个被监督的 Agent。 */
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
 * 统一任务状态。对应方案 §二 / 原方案 §6.1 的状态表。
 *
 * - IDLE:      空白/无任务占用此槽位
 * - QUEUED:    已提交,尚未开始执行
 * - RUNNING:   正在执行,不需要人工介入
 * - APPROVAL:  明确的二选一权限审批请求(Approve/Reject 应该点亮)
 * - NEEDS_INPUT: 开放式问题,不是二选一(只有 OPEN/REPLY 进入强态,Approve/Reject 保持弱态)
 * - DONE_UNREAD: 完成但用户还没确认查看
 * - DONE:       已确认查看的完成任务；保留槽位但降低视觉权重
 * - ERROR:     执行错误/桥接错误/验证失败
 * - PAUSED:    当前执行已中断；对话本身仍可继续发起新的执行
 * - STALE:     请求已过期未处理,或状态长时间未更新——绝不能静默消失,必须转到这个可见状态
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

/** 待处理请求的风险分级，供桌面详情页展示与决策校验。 */
export type RiskTier = 1 | 2;

/** Approve/Reject 实际会走哪条真实决定路径。 */
export type DecisionPath = "claude-hook" | "codex-shortcut" | null;

export interface TaskRequest {
	/** Explicit request addressed to a person, not inferred from tool execution. */
	humanRequired?: boolean;
	/** 不可复用的请求 ID。Approve/Reject 必须绑定 (agentId, taskId, requestId) 三元组。 */
	requestId: string;
	/** 请求类型,例如 "permission" | "network" | "file-access" | "input"。也是风险分级的依据之一。 */
	type: string;
	/** 命令/域名/路径等关键目标——用于 Infobar/按键摘要,也用于风险分级,避免"盲批"。 */
	target: string;
	riskTier: RiskTier;
	createdAt: number;
	expiresAt: number;
	decisionPath: DecisionPath;
}

/**
 * 中央页渲染"这个任务能做什么操作"只看这个对象,不写 `if (agent === "codex")` 这种判断。
 * capability 只代表当前请求此刻确实存在可用响应通道；持久化记录或观察型事件不能点亮决策键。
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

/** macOS 上向 Codex Desktop 的准确审批卡发送 Return/Escape 的就绪状态。 */
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

/** 数据来源——用于排障:这条任务状态是从哪个信号源拿到的。 */
export type TaskSource = "hook-event" | "catalog-sqlite" | "transcript-tail" | "jsonl-tail" | "app-server-events" | "mock";

export interface Task {
	/** Daemon 分配的稳定 ID,在该 Session/Thread 生命周期内不变。 */
	taskId: string;
	/** 当前执行实例的稳定 ID；Codex 为 turn_id，Claude 为每次 UserPromptSubmit 生成的 ID。 */
	executionId?: string;
	/** Device Layer 使用的稳定 0-based 槽位。状态变化不能改变这个位置。 */
	slot?: number;
	agent: AgentKind;
	/** Immutable trust boundary: Observer tasks can never acquire Managed writes. */
	ownership: TaskOwnership;
	/** Claude: session_id;Codex: rollout jsonl 标识。 */
	externalId: string;
	projectId: string;
	/** 按键第一行,建议 3-9 字符。 */
	projectLabel: string;
	/** Original workspace path, kept even when projectId is normalized by config. */
	cwd?: string;
	/** 按键第二行,名词/动宾短语,不是完整句子。 */
	titleShort: string;
	/** Current per-conversation reasoning effort, when the local app exposes it. */
	reasoningEffort?: ReasoningEffort;
	/** Actual model observed for this conversation. */
	model?: string;
	status: TaskStatus;
	/**
	 * V2 兼容字段。V3 中由 attentionVersion / acknowledgedAttentionVersion 派生，
	 * Adapter 不再拥有“是否已经提醒过用户”的决定权。
	 */
	attentionCount: number;
	/** 同一任务每产生一次新的待处理事件便递增。由 Daemon Registry 维护并持久化。 */
	attentionVersion?: number;
	/** 用户已经处理/查看到的 attentionVersion。小于 attentionVersion 时才显示角标。 */
	acknowledgedAttentionVersion?: number;
	/** DONE/ERROR reminders expire automatically; decisions and questions never use this field. */
	attentionExpiresAt?: number;
	request?: TaskRequest;
	capabilities: TaskCapabilities;
	progress: TaskProgress;
	openRef: OpenRef;
	/** 仅用于本机桌面中断/聚焦；不含命令内容或提示词。 */
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

/** 单个 Adapter 的健康状态。 */
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
 * 独立于任何单个任务的"系统健康"对象——这是方案里最重要的一条架构决策的落地:
 * 一个任务是否需要关注,和整个系统是否健康,是两件不同的事,不能混在一起。
 * 插件端的整机离线看门狗(见 daemon-client.ts)不依赖这个对象本身
 * (Daemon 死了就发不出任何东西,包括这个对象),但 Daemon 存活时靠它汇报每个 Adapter 的健康度。
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
	/** 0 → 设备应显示 SETUP 状态,而不是 IDLE 或 OFFLINE。 */
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

/** 每个 Agent 各自维护当前选中项,互不覆盖——对应方案 §8.5 "双 Agent 不互相打断"的规则。 */
export interface UiFocus {
	selectedTaskId: Record<AgentKind, string | null>;
	/** 当前中央控制页操作的 Agent；与两个 Agent 各自的 selectedTask 分开保存。 */
	activeAgent: AgentKind | null;
	/** New Chat 的持久目标；只由成功点击中央 Agent Logo 改变。 */
	newChatAgent: AgentKind;
}

/** 中央 Agent 汇总键可能需要主动提醒用户的状态。 */
export function isAttentionTask(task: Pick<Task, "status">): boolean {
	return task.status === "APPROVAL" || task.status === "NEEDS_INPUT" || task.status === "ERROR" || task.status === "DONE_UNREAD";
}

/** 左右任务页唯一允许显示的“仍在进行中或被用户阻塞”的状态。 */
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

/** 兼容旧快照，同时以 V3 的持久化版本水位为唯一事实源。 */
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

/** 中央页可以成为动作上下文的任务：活动任务或尚未验收的完成/错误。 */
export function isMainContextTask(
	task: Pick<Task, "status" | "attentionCount" | "attentionVersion" | "acknowledgedAttentionVersion" | "attentionExpiresAt">,
): boolean {
	return isLiveTask(task) || isPendingAttentionTask(task);
}

/** Agent Logo 是否应该进入强状态；应用进程是否打开不参与判断。 */
export function isAgentLitTask(
	task: Pick<Task, "status" | "attentionCount" | "attentionVersion" | "acknowledgedAttentionVersion" | "attentionExpiresAt">,
): boolean {
	return isLiveTask(task) || isPendingAttentionTask(task);
}
