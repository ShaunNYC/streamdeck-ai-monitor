import type { AgentKind, Task, UiFocus, SystemStatus } from "@streamdeck-supervisor/shared";
import { emptyTaskProgress, isAttentionTask, isClearableTask, isMainContextTask, isPendingAttentionTask, taskCapabilities, taskExecutionKey } from "@streamdeck-supervisor/shared";

export type RegistryListener = () => void;
export type TerminalAcknowledgements = Record<string, number>;
export type ObservationBaseline = Record<AgentKind, number>;
export interface ClearedExecution {
	executionId?: string;
	turnStartedAt: number;
	lastEventAt: number;
	lastExecutionActivityAt: number;
	/** A genuinely new execution record can recover an execution declared lost. */
	allowActivityResume: boolean;
}
export type ClearedExecutions = Record<string, ClearedExecution>;

const PRIORITY: Task["status"][] = ["APPROVAL", "NEEDS_INPUT", "ERROR", "DONE_UNREAD", "RUNNING"];
const MAX_TRACKED_TASKS_PER_AGENT = 64;
export const TERMINAL_REMINDER_MS = 10 * 60_000;
export const RUNNING_STALE_MS = 30 * 60_000;

function executionActivityAt(task: Task): number {
	return task.lastExecutionActivityAt ?? Math.max(task.lastEventAt, task.progress.latestActivity?.at ?? 0, task.progress.turnStartedAt ?? 0);
}

function expiredStoppedTask(task: Task, now: number, retentionMs: number): boolean {
	return isClearableTask(task) && (now - task.lastEventAt >= retentionMs
		|| (task.attentionExpiresAt !== undefined && task.attentionExpiresAt <= now)
		|| (task.status === "STALE" && now - executionActivityAt(task) >= RUNNING_STALE_MS));
}

function resumesClearedExecution(task: Task, cleared: ClearedExecution): boolean {
	const activityAt = executionActivityAt(task);
	if (cleared.allowActivityResume && task.status !== "IDLE" && activityAt > cleared.lastExecutionActivityAt) return true;
	const turnStartedAt = task.progress.turnStartedAt ?? 0;
	if (turnStartedAt > cleared.turnStartedAt && turnStartedAt > cleared.lastEventAt) return true;
	if (turnStartedAt && cleared.turnStartedAt && turnStartedAt <= cleared.turnStartedAt) return false;
	if (task.executionId && cleared.executionId) return task.executionId !== cleared.executionId && activityAt > cleared.lastEventAt;
	// Older Hook-only records have no turn start. Require a fresh active lifecycle,
	// never a metadata/title update or a repeat of a terminal result.
	return !task.executionId && !cleared.executionId
		&& ["RUNNING", "QUEUED", "APPROVAL", "NEEDS_INPUT"].includes(task.status)
		&& task.lastEventAt > cleared.lastEventAt && activityAt > cleared.lastExecutionActivityAt;
}

function emptyFocus(): UiFocus {
	return { selectedTaskId: { codex: null, claude: null }, activeAgent: null, newChatAgent: "codex" };
}

function isSameAgent(task: Task | undefined, agent: AgentKind): task is Task {
	return !!task && task.agent === agent;
}

function isOrphanClaudeSessionEnd(task: Task): boolean {
	return task.agent === "claude"
		&& task.source === "hook-event"
		&& task.titleShort === "Session ended"
		&& (task.status === "DONE" || task.status === "DONE_UNREAD")
		&& task.startedAt === task.lastEventAt;
}

function attentionVersion(task: Task | undefined): number {
	if (!task) return 0;
	return task.attentionVersion ?? (isAttentionTask(task) && task.attentionCount > 0 ? 1 : 0);
}

function acknowledgedVersion(task: Task | undefined): number {
	return task?.acknowledgedAttentionVersion ?? 0;
}

function validTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function initializeAttention(task: Task): Task {
	const version = attentionVersion(task);
	const acknowledged = task.acknowledgedAttentionVersion ?? (task.status === "DONE" ? version : 0);
	const pending = isAttentionTask(task) && version > acknowledged;
	return {
		...task,
		attentionVersion: version,
		acknowledgedAttentionVersion: acknowledged,
		attentionCount: pending ? Math.max(1, task.attentionCount) : 0,
	};
}

function normalizeTaskSchema(task: Task): Task {
	const raw = task.capabilities as Task["capabilities"] & Record<string, unknown>;
	const capabilities = raw?.device && raw?.desktop ? raw : taskCapabilities({
		open: true,
		approve: raw?.approve === true,
		reject: raw?.reject === true,
		interrupt: raw?.stop === true,
		review: raw?.review === true,
		verify: raw?.verify === true,
	});
	return {
		...task,
		ownership: task.ownership === "managed" ? "managed" : "observer",
		progress: { ...emptyTaskProgress(), ...(task.progress ?? {}) },
		capabilities,
	};
}

function carryAttention(task: Task, previous: Task | undefined, preserveEvent: boolean): Task {
	if (!previous) return initializeAttention(task);
	const previousVersion = attentionVersion(previous);
	const previousAcknowledged = acknowledgedVersion(previous);

	if (!isAttentionTask(task)) {
		return {
			...task,
			attentionVersion: previousVersion,
			acknowledgedAttentionVersion: Math.max(previousAcknowledged, previousVersion),
			attentionCount: 0,
		};
	}

	const declaredVersion = task.attentionVersion ?? 0;
	const newEvent = !preserveEvent && (
		!isAttentionTask(previous)
		|| task.status !== previous.status
		|| task.lastEventAt > previous.lastEventAt
		|| declaredVersion > previousVersion
	);
	const version = newEvent ? Math.max(previousVersion + 1, declaredVersion) : previousVersion;
	const acknowledged = newEvent ? previousAcknowledged : Math.max(previousAcknowledged, task.acknowledgedAttentionVersion ?? 0);
	return {
		...task,
		attentionVersion: version,
		acknowledgedAttentionVersion: acknowledged,
		attentionCount: version > acknowledged ? 1 : 0,
	};
}

function isTerminal(task: Pick<Task, "status">): boolean {
	return task.status === "DONE_UNREAD" || task.status === "DONE" || task.status === "ERROR";
}

/** Daemon 内存事实源；负责提醒版本、持久焦点和任务身份。 */
export class TaskRegistry {
	private readonly tasks = new Map<string, Task>();
	private readonly allocatedSlots = new Map<string, number>();
	private readonly terminalAcknowledgements = new Map<string, number>();
	private readonly clearedExecutions = new Map<string, ClearedExecution>();
	private readonly observationBaselineAt: ObservationBaseline;
	private focus: UiFocus = emptyFocus();
	private readonly listeners = new Set<RegistryListener>();

	constructor(
		initialTasks: Task[],
		initialFocus?: UiFocus,
		initialTerminalAcknowledgements: TerminalAcknowledgements = {},
		initialObservationBaselineAt?: Partial<ObservationBaseline>,
		initialClearedExecutions: ClearedExecutions = {},
	) {
		const now = Date.now();
		this.observationBaselineAt = {
			codex: validTimestamp(initialObservationBaselineAt?.codex) ?? now,
			claude: validTimestamp(initialObservationBaselineAt?.claude) ?? now,
		};
		for (const [taskId, lastEventAt] of Object.entries(initialTerminalAcknowledgements)) {
			if (Number.isFinite(lastEventAt) && lastEventAt >= 0) this.terminalAcknowledgements.set(taskId, lastEventAt);
		}
		for (const [taskId, cleared] of Object.entries(initialClearedExecutions)) this.clearedExecutions.set(taskId, cleared);
		for (const incoming of initialTasks) {
			const task = normalizeTaskSchema(incoming);
			const cleared = this.clearedExecutions.get(task.taskId);
			if (!isOrphanClaudeSessionEnd(task) && (!cleared || resumesClearedExecution(task, cleared))) this.tasks.set(task.taskId, initializeAttention(task));
		}
		this.sweep(Date.now());
		if (initialFocus) this.focus = {
			selectedTaskId: { ...initialFocus.selectedTaskId },
			activeAgent: initialFocus.activeAgent,
			newChatAgent: initialFocus.newChatAgent === "claude" ? "claude" : "codex",
		};
		for (const agent of ["codex", "claude"] as const) {
			this.enforceCapacity(agent);
			this.normalizeSlots(agent);
		}
		this.normalizeFocus();
	}

	onChange(listener: RegistryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	getTasks(): Task[] {
		return [...this.tasks.values()].sort((a, b) => a.agent.localeCompare(b.agent) || (a.slot ?? 99) - (b.slot ?? 99));
	}

	getTask(taskId: string): Task | undefined {
		return this.tasks.get(taskId);
	}

	getTasksForAgent(agent: AgentKind): Task[] {
		return this.getTasks().filter((task) => task.agent === agent);
	}

	getFocus(): UiFocus {
		return {
			selectedTaskId: { ...this.focus.selectedTaskId },
			activeAgent: this.focus.activeAgent,
			newChatAgent: this.focus.newChatAgent,
		};
	}

	getSnapshot(status: SystemStatus) {
		return { tasks: this.getTasks(), focus: this.getFocus(), status };
	}

	getPersistedState(): { tasks: Task[]; focus: UiFocus; terminalAcknowledgements: TerminalAcknowledgements; observationBaselineAt: ObservationBaseline; clearedExecutions: ClearedExecutions } {
		return {
			tasks: this.getTasks(),
			focus: this.getFocus(),
			terminalAcknowledgements: Object.fromEntries(this.terminalAcknowledgements),
			observationBaselineAt: { ...this.observationBaselineAt },
			clearedExecutions: Object.fromEntries(this.clearedExecutions),
		};
	}

	/** 请求过期、运行失联和已读完成清理都不能制造新的提醒事件。 */
	sweep(now = Date.now(), runningStaleMs = RUNNING_STALE_MS, completedRetentionMs = TERMINAL_REMINDER_MS): boolean {
		let didChange = false;
		const toDelete: string[] = [];
		for (const task of this.tasks.values()) {
			if (expiredStoppedTask(task, now, completedRetentionMs)) {
				this.rememberCleared(task, task.status === "STALE");
				toDelete.push(task.taskId);
				continue;
			}
			if (task.request && task.request.expiresAt <= now && task.status === "APPROVAL") {
				task.status = "STALE";
				task.request = undefined;
				task.capabilities = { ...task.capabilities, desktop: { ...task.capabilities.desktop, approve: false, reject: false } };
				task.acknowledgedAttentionVersion = attentionVersion(task);
				task.attentionCount = 0;
				task.lastEventAt = now;
				didChange = true;
				continue;
			}
			if (task.status === "RUNNING" && now - executionActivityAt(task) >= runningStaleMs) {
				task.status = "STALE";
				this.rememberCleared(task, true);
				toDelete.push(task.taskId);
				continue;
			}
		}
		for (const taskId of toDelete) {
			this.deleteTask(taskId);
			didChange = true;
		}
		if (didChange) {
			this.normalizeFocus();
			this.changed();
		}
		return didChange;
	}

	/** Authoritative clearing for both clients, including tasks without device slots. */
	dismissExecutions(agent: AgentKind, executions: Array<{ taskId: string; executionId: string }>): number {
		let removed = 0;
		for (const execution of executions) {
			const task = this.tasks.get(execution.taskId);
			if (!task || task.agent !== agent || !isClearableTask(task) || taskExecutionKey(task) !== execution.executionId) continue;
			this.rememberCleared(task);
			if (this.deleteTask(task.taskId)) removed++;
		}
		if (removed) { this.normalizeFocus(); this.changed(); }
		return removed;
	}

	private rememberCleared(task: Task, allowActivityResume = false): void {
		if (isTerminal(task)) this.acknowledgeTerminal(task);
		this.clearedExecutions.set(task.taskId, {
			...(task.executionId ? { executionId: task.executionId } : {}),
			turnStartedAt: task.progress.turnStartedAt ?? 0,
			lastEventAt: task.lastEventAt,
			lastExecutionActivityAt: executionActivityAt(task),
			allowActivityResume,
		});
	}

	upsertTask(incoming: Task): void {
		incoming = normalizeTaskSchema(incoming);
		const cleared = this.clearedExecutions.get(incoming.taskId);
		if (cleared && !resumesClearedExecution(incoming, cleared)) return;
		const previous = this.tasks.get(incoming.taskId);
		// UserPromptSubmit is received slightly before/after its transcript row.
		// Reconcile those starts as the same execution, preserving its clock/id.
		const hookTranscriptStart = previous?.agent === "claude" && previous.source === "hook-event"
			&& incoming.source === "transcript-tail" && previous.progress.turnStartedAt && incoming.progress.turnStartedAt
			&& !(isTerminal(incoming) && incoming.lastEventAt < previous.progress.turnStartedAt)
			&& !(isTerminal(previous) && incoming.progress.turnStartedAt > previous.lastEventAt)
			&& Math.abs(incoming.progress.turnStartedAt - previous.progress.turnStartedAt) <= 2_000;
		if (previous?.progress.turnStartedAt && incoming.progress.turnStartedAt
			&& incoming.progress.turnStartedAt < previous.progress.turnStartedAt && !hookTranscriptStart) return;
		const newClaudeTurn = incoming.agent === "claude" && incoming.progress.turnStartedAt !== undefined
			&& (!previous?.progress.turnStartedAt || (incoming.progress.turnStartedAt > previous.progress.turnStartedAt && !hookTranscriptStart));
		const partialClaudeHook = incoming.agent === "claude" && incoming.source === "hook-event"
			&& incoming.progress.turnStartedAt === undefined;
		let task = {
			...incoming,
			ownership: previous?.ownership ?? incoming.ownership,
			progress: previous && !newClaudeTurn && incoming.source !== "transcript-tail"
				? partialClaudeHook
					? { ...previous.progress, ...(incoming.progress.latestActivity ? { latestActivity: incoming.progress.latestActivity } : {}) }
					: { ...previous.progress, ...incoming.progress }
				: incoming.progress,
		};
		if (!previous && isTerminal(task) && task.lastEventAt < this.observationBaselineAt[task.agent]) {
			if (this.observationBaselineAt[task.agent] - task.lastEventAt <= TERMINAL_REMINDER_MS) {
				task.attentionExpiresAt = task.lastEventAt + TERMINAL_REMINDER_MS;
			} else {
				task = this.baselineTerminalTask(task);
			}
		}
		if (previous?.lastObservedAt && !task.lastObservedAt) task.lastObservedAt = previous.lastObservedAt;
		const carrySettings = task.agent !== "claude" || (partialClaudeHook && !newClaudeTurn);
		if (carrySettings && !task.model && previous?.model) task.model = previous.model;
		if (carrySettings && !task.reasoningEffort && previous?.reasoningEffort) task.reasoningEffort = previous.reasoningEffort;
		if (task.agent === "claude" && task.source === "transcript-tail" && !newClaudeTurn && previous?.executionId) {
			task.executionId ??= previous.executionId;
		}
		if (task.agent === "claude" && task.source === "hook-event" && isTerminal(task) && task.progress.turnStartedAt) {
			task.progress = { ...task.progress, durationMs: Math.max(0, task.lastEventAt - task.progress.turnStartedAt) };
		}
		let preserveAttentionEvent = false;
		if (previous?.source === "transcript-tail"
			&& task.source === "transcript-tail"
			&& task.status === previous.status
			&& task.lastEventAt < previous.lastEventAt) {
			// A transcript lifecycle timestamp is immutable. A regression means an
			// older terminal record was previously stamped with a newer hook time.
			// Reconcile to the transcript and retire the manufactured watermark.
			const version = attentionVersion(previous);
			task.attentionVersion = version;
			task.acknowledgedAttentionVersion = version;
			task.attentionCount = 0;
			preserveAttentionEvent = true;
		}

		if (previous && task.projectId === "codex" && previous.projectId !== "codex") {
			task = {
				...task,
				projectId: previous.projectId,
				projectLabel: previous.projectLabel,
				verifyProfile: previous.verifyProfile ?? task.verifyProfile,
			};
		}
		if (previous?.status === "APPROVAL" && previous.source === "hook-event" && task.source !== "hook-event" && task.status === "RUNNING") {
			task = {
				...task,
				status: previous.status,
				request: previous.request,
				capabilities: previous.capabilities,
				attentionCount: previous.attentionCount,
			};
			preserveAttentionEvent = true;
		}
		if (previous?.source === "hook-event" && task.source === "transcript-tail") {
			const transcriptPredatesHook = task.lastEventAt + 2_000 < previous.lastEventAt
				|| (isTerminal(previous) && task.status === "RUNNING" && task.lastEventAt <= previous.lastEventAt);
			task = {
				...task,
				executionId: task.executionId ?? (newClaudeTurn ? undefined : previous.executionId),
				processId: previous.processId,
				capabilities: {
					...task.capabilities,
					desktop: { ...task.capabilities.desktop, interrupt: previous.capabilities.desktop.interrupt },
				},
			};
			if (transcriptPredatesHook) {
				task = {
					...task,
					status: previous.status,
					titleShort: previous.titleShort,
					request: previous.request,
					reviewRef: previous.reviewRef,
					source: previous.source,
					lastEventAt: previous.lastEventAt,
					lastExecutionActivityAt: executionActivityAt(previous),
					progress: previous.progress,
					capabilities: previous.capabilities,
				};
				preserveAttentionEvent = true;
			} else if (previous.status === "APPROVAL" || previous.status === "NEEDS_INPUT") {
				task.status = previous.status;
				task.request = previous.request;
				task.capabilities = previous.capabilities;
				task.attentionCount = previous.attentionCount;
				preserveAttentionEvent = true;
			}
		}
		// A Claude prompt submitted after the pause is a new execution even when
		// only the transcript has seen it (no Hook-assigned execution id yet).
		const claudeTurnAfterPause = newClaudeTurn && previous?.status === "PAUSED"
			&& (task.progress.turnStartedAt ?? 0) > previous.lastEventAt;
		if (previous?.status === "PAUSED"
			&& previous.executionId
			&& !claudeTurnAfterPause
			&& (!task.executionId || task.executionId === previous.executionId)) {
			// A poll/transcript event without a newer execution identity cannot
			// revive an execution already interrupted from the desktop detail view.
			task = {
				...task,
				executionId: previous.executionId,
				status: "PAUSED",
				titleShort: previous.titleShort,
				request: undefined,
				capabilities: {
					...task.capabilities,
					desktop: {
						...task.capabilities.desktop,
						approve: false,
						reject: false,
						interrupt: false,
					},
				},
				attentionVersion: attentionVersion(previous),
				acknowledgedAttentionVersion: attentionVersion(previous),
				attentionCount: 0,
				lastEventAt: previous.lastEventAt,
				lastExecutionActivityAt: executionActivityAt(previous),
			};
			preserveAttentionEvent = true;
		}
		if (previous?.status === "DONE" && task.status === "DONE_UNREAD" && task.lastEventAt <= previous.lastEventAt) {
			task = { ...task, status: "DONE", attentionCount: 0 };
			preserveAttentionEvent = true;
		}
		const acknowledgedTerminalAt = this.terminalAcknowledgements.get(task.taskId);
		if ((task.status === "DONE_UNREAD" || task.status === "ERROR")
			&& acknowledgedTerminalAt !== undefined
			&& task.lastEventAt <= acknowledgedTerminalAt) {
			const version = Math.max(1, attentionVersion(previous), task.attentionVersion ?? 0);
			task = {
				...task,
				status: task.status === "DONE_UNREAD" ? "DONE" : "ERROR",
				attentionVersion: version,
				acknowledgedAttentionVersion: version,
				attentionCount: 0,
			};
			preserveAttentionEvent = true;
		}

		if (previous && task.startedAt > previous.startedAt) task.startedAt = previous.startedAt;
		task = carryAttention(task, previous, preserveAttentionEvent);
		const now = Date.now();
		const lost = task.status === "RUNNING" && now - executionActivityAt(task) >= RUNNING_STALE_MS;
		if (lost || expiredStoppedTask(task, now, TERMINAL_REMINDER_MS)) {
			if (lost) task.status = "STALE";
			this.rememberCleared(task, task.status === "STALE");
			if (this.deleteTask(task.taskId)) { this.normalizeFocus(); this.changed(); }
			else this.changed(); // Persist the watermark even if this was the first observation.
			return;
		}
		if (!previous) this.makeRoom(task.agent);
		if (task.slot === undefined) task.slot = previous?.slot ?? this.allocateSlot(task);
		const terminalTransition = isTerminal(task) && (!previous || !isTerminal(previous) || task.lastEventAt > previous.lastEventAt);
		if ((task.status === "DONE_UNREAD" || task.status === "ERROR") && isPendingAttentionTask(task)) {
			if (terminalTransition && task.lastEventAt >= this.observationBaselineAt[task.agent]) {
				task.attentionExpiresAt = task.lastEventAt + TERMINAL_REMINDER_MS;
			} else if (previous?.attentionExpiresAt && task.lastEventAt <= previous.lastEventAt) {
				task.attentionExpiresAt = previous.attentionExpiresAt;
			}
		}
		this.tasks.set(task.taskId, task);
		this.normalizeSlots(task.agent);

		const isNewPendingEvent = isPendingAttentionTask(task) && attentionVersion(task) > attentionVersion(previous);
		if (isNewPendingEvent) {
			this.focus.selectedTaskId[task.agent] = task.taskId;
			this.focus.activeAgent = task.agent;
		} else {
			this.normalizeFocus();
		}
		this.changed();
	}

	removeTask(taskId: string): void {
		if (!this.deleteTask(taskId)) return;
		this.normalizeFocus();
		this.changed();
	}

	markRequestStale(taskId: string): boolean {
		const task = this.getTask(taskId);
		if (!task || task.status !== "APPROVAL") return false;
		task.status = "STALE";
		task.request = undefined;
		task.capabilities = { ...task.capabilities, desktop: { ...task.capabilities.desktop, approve: false, reject: false } };
		task.acknowledgedAttentionVersion = attentionVersion(task);
		task.attentionCount = 0;
		task.lastEventAt = Date.now();
		this.normalizeFocus();
		this.changed();
		return true;
	}

	/** A real Claude allow/deny was delivered; Claude continues until later lifecycle Hooks settle the task. */
	resolveApproval(taskId: string, requestId: string, now = Date.now()): boolean {
		const task = this.getTask(taskId);
		if (!task?.request || task.status !== "APPROVAL" || task.request.requestId !== requestId) return false;
		this.upsertTask({
			...task,
			status: "RUNNING",
			request: undefined,
			capabilities: {
				...task.capabilities,
				desktop: {
					...task.capabilities.desktop,
					approve: false,
					reject: false,
					interrupt: !!task.executionId && !!task.processId,
				},
			},
			lastEventAt: now,
		});
		return true;
	}

	/** Keep a submitted Codex card visible while preventing a second Return/Escape. */
	markApprovalSubmitted(taskId: string, requestId: string): boolean {
		const task = this.getTask(taskId);
		if (!task?.request || task.status !== "APPROVAL" || task.request.requestId !== requestId) return false;
		task.capabilities = { ...task.capabilities, desktop: { ...task.capabilities.desktop, approve: false, reject: false } };
		this.changed();
		return true;
	}

	/** Mark a live app-server choice as attention without persisting its RPC id. */
	markPlanInput(taskId: string): boolean {
		const task = this.getTask(taskId);
		if (!task) return false;
		const version = attentionVersion(task) + 1;
		task.status = "NEEDS_INPUT";
		task.attentionVersion = version;
		task.attentionCount = 1;
		task.lastEventAt = Date.now();
		this.focus.selectedTaskId[task.agent] = task.taskId;
		this.focus.activeAgent = task.agent;
		this.changed();
		return true;
	}

	selectTask(agent: AgentKind, taskId: string): boolean {
		const task = this.getTask(taskId);
		if (!isSameAgent(task, agent)) return false;
		this.focus.selectedTaskId[agent] = taskId;
		this.focus.activeAgent = agent;
		this.changed();
		return true;
	}

	/** Logo 按键只切换到该 Agent 的最高优先级上下文，不循环、不确认。 */
	focusAgent(agent: AgentKind): Task | undefined {
		const task = this.highestPriority(agent);
		if (!task) return undefined;
		this.focus.selectedTaskId[agent] = task.taskId;
		this.focus.activeAgent = agent;
		this.changed();
		return task;
	}

	/** Central Logo activation is the sole owner of the persistent New Chat target. */
	activateAgent(agent: AgentKind): Task | undefined {
		const task = this.getSelectedTask(agent);
		this.focus.newChatAgent = agent;
		if (task) {
			this.focus.selectedTaskId[agent] = task.taskId;
			this.focus.activeAgent = agent;
		}
		this.changed();
		return task;
	}

	/** 只有成功打开完成/错误结果后才能确认；审批和输入必须由真实状态变化解决。 */
	acknowledgeReview(taskId: string, notify = true): boolean {
		const task = this.getTask(taskId);
		if (!task || !isPendingAttentionTask(task) || (task.status !== "DONE_UNREAD" && task.status !== "ERROR")) return false;
		this.acknowledgeTerminal(task);
		this.normalizeFocus();
		if (notify) this.changed();
		return true;
	}

	private baselineTerminalTask(task: Task): Task {
		if (!isTerminal(task)) return task;
		const version = Math.max(1, attentionVersion(task));
		this.terminalAcknowledgements.set(task.taskId, Math.max(this.terminalAcknowledgements.get(task.taskId) ?? 0, task.lastEventAt));
		return {
			...task,
			status: task.status === "DONE_UNREAD" ? "DONE" : task.status,
			attentionVersion: version,
			acknowledgedAttentionVersion: version,
			attentionCount: 0,
			attentionExpiresAt: undefined,
		};
	}

	private acknowledgeTerminal(task: Task): void {
		this.terminalAcknowledgements.set(task.taskId, Math.max(this.terminalAcknowledgements.get(task.taskId) ?? 0, task.lastEventAt));
		task.acknowledgedAttentionVersion = attentionVersion(task);
		task.attentionCount = 0;
		task.attentionExpiresAt = undefined;
		if (task.status === "DONE_UNREAD") task.status = "DONE";
	}

	getSelectedTask(agent: AgentKind): Task | undefined {
		const selected = this.getTask(this.focus.selectedTaskId[agent] ?? "");
		if (isSameAgent(selected, agent) && isMainContextTask(selected)) return selected;
		return this.highestPriority(agent);
	}

	applyMockAction(action: "approve" | "reject" | "stop", taskId: string): boolean {
		const task = this.getTask(taskId);
		if (!task) return false;
		if ((action === "approve" || action === "reject") && task.status !== "APPROVAL") return false;
		if (action === "stop" && task.status !== "RUNNING") return false;
		return this.applyDecision(task, action, Date.now());
	}

	pauseExecution(taskId: string, executionId: string, now = Date.now()): boolean {
		const task = this.getTask(taskId);
		if (!task?.executionId || task.executionId !== executionId) return false;
		this.upsertTask({
			...task,
			status: "PAUSED",
			titleShort: "Paused",
			request: undefined,
			capabilities: {
				...task.capabilities,
				desktop: { ...task.capabilities.desktop, approve: false, reject: false, interrupt: false },
			},
			attentionCount: 0,
			lastEventAt: now,
		});
		return true;
	}

	applyDecision(task: Task, action: "approve" | "reject" | "stop", now = Date.now()): boolean {
		if (action === "approve") {
			this.upsertTask({ ...task, status: "DONE_UNREAD", titleShort: "Approved", request: undefined, lastEventAt: now });
		} else if (action === "reject") {
			this.upsertTask({ ...task, status: "ERROR", titleShort: "Rejected", request: undefined, lastEventAt: now });
		} else {
			if (task.executionId) return this.pauseExecution(task.taskId, task.executionId, now);
			this.upsertTask({
				...task,
				status: "PAUSED",
				titleShort: "Paused",
				request: undefined,
				capabilities: {
					...task.capabilities,
					desktop: { ...task.capabilities.desktop, approve: false, reject: false, interrupt: false },
				},
				lastEventAt: now,
			});
		}
		return true;
	}

	private highestPriority(agent: AgentKind): Task | undefined {
		return this.getTasksForAgent(agent).filter(isMainContextTask).sort(taskPriority)[0];
	}

	private normalizeFocus(): void {
		for (const agent of ["codex", "claude"] as const) {
			const selected = this.getTask(this.focus.selectedTaskId[agent] ?? "");
			if (!isSameAgent(selected, agent) || !isMainContextTask(selected)) {
				this.focus.selectedTaskId[agent] = this.highestPriority(agent)?.taskId ?? null;
			}
		}
		if (this.focus.activeAgent && this.getSelectedTask(this.focus.activeAgent)) return;
		const candidates = [this.highestPriority("codex"), this.highestPriority("claude")]
			.filter((task): task is Task => !!task)
			.sort(taskPriority);
		this.focus.activeAgent = candidates[0]?.agent ?? null;
	}

	private allocateSlot(task: Task): number {
		const existing = this.allocatedSlots.get(task.taskId);
		if (existing !== undefined) return existing;
		const used = new Set(this.getTasksForAgent(task.agent).map((candidate) => candidate.slot).filter((slot): slot is number => slot !== undefined));
		return this.firstFreeSlot(task.taskId, used);
	}

	private firstFreeSlot(taskId: string, used: Set<number>): number {
		let slot = 0;
		while (used.has(slot)) slot += 1;
		this.allocatedSlots.set(taskId, slot);
		return slot;
	}

	private makeRoom(agent: AgentKind): void {
		while (this.getTasksForAgent(agent).length >= MAX_TRACKED_TASKS_PER_AGENT) {
			const candidate = this.pickEvictionCandidate(agent);
			if (!candidate) return;
			this.deleteTask(candidate.taskId);
		}
	}

	private enforceCapacity(agent: AgentKind): void {
		while (this.getTasksForAgent(agent).length > MAX_TRACKED_TASKS_PER_AGENT) {
			const candidate = this.pickEvictionCandidate(agent);
			if (!candidate) return;
			this.deleteTask(candidate.taskId);
		}
	}

	private pickEvictionCandidate(agent: AgentKind): Task | undefined {
		const selectedId = this.focus.selectedTaskId[agent];
		const candidates = this.getTasksForAgent(agent).filter((task) => task.taskId !== selectedId && !isMainContextTask(task));
		return [...candidates].sort((a, b) => evictionScore(b) - evictionScore(a) || a.lastEventAt - b.lastEventAt)[0];
	}

	private deleteTask(taskId: string): boolean {
		const task = this.tasks.get(taskId);
		if (!task) return false;
		this.tasks.delete(taskId);
		this.allocatedSlots.delete(taskId);
		if (this.focus.selectedTaskId[task.agent] === taskId) this.focus.selectedTaskId[task.agent] = null;
		return true;
	}

	private normalizeSlots(agent: AgentKind): void {
		const used = new Set<number>();
		for (const task of this.getTasksForAgent(agent)) {
			if (task.slot !== undefined && task.slot >= 0 && !used.has(task.slot)) {
				used.add(task.slot);
				this.allocatedSlots.set(task.taskId, task.slot);
				continue;
			}
			task.slot = this.firstFreeSlot(task.taskId, used);
			used.add(task.slot);
		}
	}
}

function taskPriority(a: Task, b: Task): number {
	return PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status) || b.lastEventAt - a.lastEventAt;
}

function evictionScore(task: Task): number {
	switch (task.status) {
		case "IDLE": return 9;
		case "DONE": return 8;
		case "STALE": return 7;
		case "PAUSED": return 6;
		case "QUEUED": return 5;
		case "ERROR": return isPendingAttentionTask(task) ? 0 : 4;
		case "DONE_UNREAD": return isPendingAttentionTask(task) ? 0 : 3;
		case "RUNNING":
		case "NEEDS_INPUT":
		case "APPROVAL":
			return 0;
	}
}
