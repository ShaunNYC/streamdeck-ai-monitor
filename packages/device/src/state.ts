import type { AgentKind, PendingPlanInput, ReasoningEffort, SystemStatus, Task, UiFocus } from "@streamdeck-supervisor/shared";
import { emptyTaskProgress, isLiveTask, isMainContextTask, isPendingAttentionTask, taskCapabilities } from "@streamdeck-supervisor/shared";

export type StateListener = () => void;
export type AgentVisualState = "quiet" | "running" | "attention" | "done" | "error";

export interface AgentSummary {
	visualState: AgentVisualState;
	actionable: boolean;
	badge: number;
	runningCount: number;
	decisionCount: number;
	liveCount: number;
	terminalReminder?: "DONE" | "ERROR";
	needsInput?: boolean;
	planReady?: boolean;
}

export interface MainActionAvailability {
	open: boolean;
	review: boolean;
	verify: boolean;
	openLabel: "OPEN" | "REPLY";
}

const EMPTY_FOCUS: UiFocus = {
	selectedTaskId: { codex: null, claude: null },
	activeAgent: null,
	newChatAgent: "codex",
};

export class DeviceState {
	private tasks = new Map<string, Task>();
	private focus: UiFocus = structuredClone(EMPTY_FOCUS);
	private status: SystemStatus | null = null;
	private planInputs = new Map<string, PendingPlanInput>();
	private online = false;
	private initialized = false;
	private attentionGeneration = 0;
	private readonly seenAttentionVersions = new Map<string, number>();
	private readonly liveSlots: Record<AgentKind, Map<string, number>> = { codex: new Map(), claude: new Map() };
	private readonly listeners = new Set<StateListener>();

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	setSnapshot(tasks: Task[], focus: UiFocus, status: SystemStatus, planInputs: PendingPlanInput[] = []): void {
		let hasNewAttention = false;
		for (const task of tasks) {
			const version = task.attentionVersion ?? (task.attentionCount > 0 ? 1 : 0);
			const seen = this.seenAttentionVersions.get(task.taskId);
			if (this.initialized && isPendingAttentionTask(task) && (seen === undefined || version > seen)) hasNewAttention = true;
			if (seen === undefined || version > seen) this.seenAttentionVersions.set(task.taskId, version);
		}

		this.tasks = new Map(tasks.map((task) => {
			const raw = task.capabilities as Task["capabilities"] & Record<string, unknown>;
			const normalized: Task = {
				...task,
				ownership: task.ownership === "managed" ? "managed" : "observer",
				progress: { ...emptyTaskProgress(), ...(task.progress ?? {}) },
				capabilities: raw?.device && raw?.desktop ? raw : taskCapabilities({
					open: true,
					approve: raw?.approve === true,
					reject: raw?.reject === true,
					interrupt: raw?.stop === true,
					review: raw?.review === true,
					verify: raw?.verify === true,
				}),
			};
			return [normalized.taskId, normalized];
		}));
		this.focus = {
			selectedTaskId: { ...focus.selectedTaskId },
			activeAgent: focus.activeAgent,
			newChatAgent: focus.newChatAgent === "claude" ? "claude" : "codex",
		};
		this.status = status;
		this.planInputs = new Map(planInputs.map((input) => [input.requestId, input]));
		this.online = true;
		this.syncLiveSlots("codex");
		this.syncLiveSlots("claude");
		if (hasNewAttention) this.attentionGeneration += 1;
		this.initialized = true;
		this.changed();
	}

	setStatus(status: SystemStatus): void {
		this.status = status;
		this.online = true;
		this.changed();
	}

	setOffline(): void {
		if (!this.online) return;
		this.online = false;
		this.changed();
	}

	isOffline(): boolean { return !this.online; }
	isSetup(): boolean {
		return this.online
			&& this.status?.monitoringScope !== "all-projects"
			&& (this.status?.configuredProjectCount ?? 0) === 0;
	}
	isCodexAppServerReady(): boolean { return this.status?.codexAppServer?.status === "OK"; }
	getStatus(): SystemStatus | null { return this.status; }
	getAttentionGeneration(): number { return this.attentionGeneration; }

	isAgentHealthy(agent: AgentKind): boolean {
		return this.online && this.status?.adapters[agent].status === "OK";
	}

	isAgentDisabled(agent: AgentKind): boolean {
		return this.online && this.status?.adapters[agent].status === "DISABLED";
	}

	getTask(taskId: string): Task | undefined {
		return this.tasks.get(taskId);
	}

	getTasks(agent: AgentKind): Task[] {
		return [...this.tasks.values()].filter((task) => task.agent === agent).sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999));
	}

	getLiveTasks(agent: AgentKind): Task[] {
		return this.getTasks(agent)
			.filter(isLiveTask)
			.sort((a, b) => (this.liveSlots[agent].get(a.taskId) ?? 999) - (this.liveSlots[agent].get(b.taskId) ?? 999));
	}

	getPendingAttentionTasks(agent: AgentKind): Task[] {
		return this.getTasks(agent).filter(isPendingAttentionTask).sort(taskPriority);
	}


	getPlanInputs(agent: AgentKind = "codex"): PendingPlanInput[] {
		return [...this.planInputs.values()]
			.filter((input) => this.tasks.get(input.taskId)?.agent === agent)
			.sort((a, b) => taskPriority(this.tasks.get(a.taskId), this.tasks.get(b.taskId)));
	}

	getActivePlanInput(agent: AgentKind = "codex"): PendingPlanInput | undefined {
		return this.getPlanInputs(agent)[0];
	}

	getAgentSummary(agent: AgentKind): AgentSummary {
		const tasks = this.getTasks(agent);
		const live = tasks.filter(isLiveTask);
		const decisions = tasks.filter((task) => (task.status === "APPROVAL" || task.status === "NEEDS_INPUT") && isPendingAttentionTask(task));
		const terminals = tasks.filter((task) => (task.status === "DONE_UNREAD" || task.status === "ERROR") && isPendingAttentionTask(task));
		const terminal = terminals.sort(taskPriority)[0];
		const badge = decisions.length + terminals.length;
		const needsInput = tasks.some((task) => task.status === "NEEDS_INPUT");
		return {
			visualState: decisions.length > 0 ? "attention" : tasks.some((task) => task.status === "RUNNING") ? "running" : terminal?.status === "ERROR" ? "error" : terminal ? "done" : "quiet",
			actionable: badge > 0 || live.length > 0,
			badge,
			runningCount: tasks.filter((task) => task.status === "RUNNING").length,
			decisionCount: decisions.length,
			liveCount: live.length,
			...(terminal ? { terminalReminder: terminal.status === "ERROR" ? "ERROR" as const : "DONE" as const } : {}),
			...(needsInput ? { needsInput: true } : {}),
			...(agent === "codex" && this.getPlanInputs(agent).length > 0 ? { planReady: true } : {}),
		};
	}

	getDisplayTask(agent: AgentKind, slot: number, overflowIndex = 0): { task?: Task; overflowCount: number } {
		const stored = this.status?.monitor?.slots[agent];
		if (stored) {
			const task = this.tasks.get(stored.find(item => item.slot === slot)?.taskId ?? "");
			return { task: task && !this.isAgentHealthy(agent) && isLiveTask(task) ? {...task,status:"STALE"} : task, overflowCount: 0 };
		}
		const tasks = this.getLiveTasks(agent);
		return { task: slot >= 0 && slot < 12 ? tasks.find(task => this.liveSlots[agent].get(task.taskId) === slot) : undefined, overflowCount: 0 };
	}

	getSlot(task: Task) { return this.status?.monitor?.slots[task.agent].find(s => s.taskId === task.taskId); }
	getOverflowCount(agent: AgentKind): number {
		const ids = new Set(this.status?.monitor?.slots[agent].map(s => s.taskId) ?? [...this.liveSlots[agent]].filter(([,slot])=>slot<12).map(([id])=>id));
		return this.getLiveTasks(agent).filter(t => !ids.has(t.taskId)).length;
	}
	getFocus(): UiFocus {
		return {
			selectedTaskId: { ...this.focus.selectedTaskId },
			activeAgent: this.focus.activeAgent,
			newChatAgent: this.focus.newChatAgent,
		};
	}

	getNewChatAgent(): AgentKind { return this.focus.newChatAgent; }

	/** True only when the Logo would visibly change Agent or task focus. */
	canFocusAgent(agent: AgentKind): boolean {
		const target = this.highestPriority(agent);
		if (!target) return false;
		return this.getActiveAgent() !== agent || this.getSelectedTask(agent)?.taskId !== target.taskId;
	}

	getSelectedTask(agent: AgentKind | null): Task | undefined {
		if (!agent) return undefined;
		const selected = this.tasks.get(this.focus.selectedTaskId[agent] ?? "");
		if (selected?.agent === agent && isMainContextTask(selected)) return selected;
		return this.highestPriority(agent);
	}

	/** Process cards may retain the most recent terminal task after it stops being actionable. */
	getProgressTask(agent: AgentKind | null): Task | undefined {
		if (!agent) return [...this.tasks.values()].sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
		const exact = this.tasks.get(this.focus.selectedTaskId[agent] ?? "");
		if (exact?.agent === agent) return exact;
		return this.getTasks(agent).sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
	}

	/** Exact persisted focus only; dangerous actions must never use priority fallback. */
	getExplicitlySelectedTask(): Task | undefined {
		const agent = this.focus.activeAgent;
		if (!agent) return undefined;
		const task = this.tasks.get(this.focus.selectedTaskId[agent] ?? "");
		return task?.agent === agent && isMainContextTask(task) ? task : undefined;
	}

	getReasoningEffort(agent: AgentKind): ReasoningEffort | undefined {
		const task = this.getSelectedTask(agent);
		if (task?.status !== "RUNNING") return undefined;
		return task.reasoningEffort ?? (agent === "codex" ? this.status?.reasoningDefaults?.codex : undefined);
	}

	hasRunningReasoningTask(agent: AgentKind): boolean {
		return this.getSelectedTask(agent)?.status === "RUNNING";
	}

	getActiveAgent(): AgentKind | null {
		if (this.focus.activeAgent && this.getSelectedTask(this.focus.activeAgent)) return this.focus.activeAgent;
		const candidates = [this.highestPriority("codex"), this.highestPriority("claude")]
			.filter((task): task is Task => !!task)
			.sort(taskPriority);
		return candidates[0]?.agent ?? null;
	}

	getMainActionAvailability(task: Task | undefined): MainActionAvailability {
		const off: MainActionAvailability = {
			open: false, review: false, verify: false, openLabel: "OPEN",
		};
		if (!task || !isMainContextTask(task)) return off;
		if (task.status === "RUNNING") {
			return { ...off, open: task.capabilities.device.open && !!task.openRef.value, openLabel: "OPEN" };
		}
		if (task.status === "APPROVAL") {
			return { ...off, open: task.capabilities.device.open && !!task.openRef.value, openLabel: "OPEN" };
		}
		if (task.status === "NEEDS_INPUT") {
			return { ...off, open: task.capabilities.device.open && !!task.openRef.value, openLabel: "REPLY" };
		}
		if (task.status === "DONE_UNREAD" || task.status === "ERROR") {
			return {
				...off,
				open: task.capabilities.device.open && !!task.openRef.value,
				review: task.capabilities.device.review && !!task.reviewRef,
				verify: task.capabilities.device.verify && !!task.verifyProfile && task.workflow?.state !== "running",
				openLabel: "OPEN",
			};
		}
		return off;
	}

	private highestPriority(agent: AgentKind): Task | undefined {
		return this.getTasks(agent).filter(isMainContextTask).sort(taskPriority)[0];
	}

	private syncLiveSlots(agent: AgentKind): void {
		const slots = this.liveSlots[agent];
		const live = this.getTasks(agent).filter(isLiveTask);
		const liveIds = new Set(live.map((task) => task.taskId));
		for (const taskId of [...slots.keys()]) if (!liveIds.has(taskId)) slots.delete(taskId);

		const used = new Set(slots.values());
		const unassigned = live
			.filter((task) => !slots.has(task.taskId))
			.sort((a, b) => a.startedAt - b.startedAt || a.lastEventAt - b.lastEventAt);
		for (const task of unassigned) {
			let slot = 0;
			while (used.has(slot)) slot += 1;
			slots.set(task.taskId, slot);
			used.add(slot);
		}
	}
}

const STATUS_PRIORITY: Task["status"][] = ["APPROVAL", "NEEDS_INPUT", "ERROR", "DONE_UNREAD", "RUNNING", "PAUSED", "QUEUED", "STALE", "DONE", "IDLE"];

function taskPriority(a: Task | undefined, b: Task | undefined): number {
	return STATUS_PRIORITY.indexOf(a?.status ?? "STALE") - STATUS_PRIORITY.indexOf(b?.status ?? "STALE") || (b?.lastEventAt ?? 0) - (a?.lastEventAt ?? 0);
}

export const deviceState = new DeviceState();
