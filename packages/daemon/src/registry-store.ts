import fs from "node:fs";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, type Task, type UiFocus } from "@streamdeck-supervisor/shared";
import type { ClearedExecutions, ObservationBaseline, TerminalAcknowledgements } from "./task-registry.js";

export interface PersistedRegistryState {
	version: 8;
	tasks: Task[];
	focus: UiFocus;
	terminalAcknowledgements: TerminalAcknowledgements;
	observationBaselineAt: ObservationBaseline;
	clearedExecutions: ClearedExecutions;
	savedAt: number;
}

type V7RegistryState = Omit<PersistedRegistryState, "version" | "clearedExecutions"> & { version: 7 };

interface V6RegistryState {
	version: 6;
	tasks: Task[];
	focus: UiFocus;
	terminalAcknowledgements: TerminalAcknowledgements;
	observationBaselineAt: ObservationBaseline;
	savedAt: number;
}

interface V5RegistryState {
	version: 5;
	tasks: Task[];
	focus: UiFocus;
	terminalAcknowledgements: TerminalAcknowledgements;
	savedAt: number;
}

interface V4RegistryState {
	version: 4;
	tasks: Task[];
	focus: Omit<UiFocus, "newChatAgent"> & { newChatAgent?: UiFocus["newChatAgent"] };
	terminalAcknowledgements: TerminalAcknowledgements;
	savedAt: number;
}

interface V3RegistryState {
	version: 3;
	tasks: Task[];
	focus: Omit<UiFocus, "newChatAgent"> & { newChatAgent?: UiFocus["newChatAgent"] };
	savedAt: number;
}

interface V2RegistryState {
	version: 2;
	tasks: Task[];
	focus: Omit<UiFocus, "newChatAgent"> & { newChatAgent?: UiFocus["newChatAgent"] };
	savedAt: number;
}

/** V8 persists cleared executions independently of visible task history. */
export class RegistryStore {
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly filePath: string) {}

	load(): PersistedRegistryState | null {
		try {
			const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedRegistryState | V7RegistryState | V6RegistryState | V5RegistryState | V4RegistryState | V3RegistryState | V2RegistryState;
			if (!Array.isArray(value.tasks) || !value.focus) return null;
			if (value.version === 8 || value.version === 7) {
				return {
					...value,
					version: 8,
					clearedExecutions: value.version === 8 ? sanitizeClearedExecutions(value.clearedExecutions) : {},
					tasks: value.tasks.map(migrateTaskToV7),
					focus: migrateFocus(value.focus),
					terminalAcknowledgements: sanitizeAcknowledgements(value.terminalAcknowledgements),
					observationBaselineAt: sanitizeBaseline(value.observationBaselineAt, value.savedAt),
				};
			}
			if (value.version === 6) return migrateToV7(value, sanitizeAcknowledgements(value.terminalAcknowledgements), value.observationBaselineAt);
			if (value.version === 5) return migrateToV7(value, sanitizeAcknowledgements(value.terminalAcknowledgements));
			if (value.version === 4) {
				return migrateToV7(value, sanitizeAcknowledgements(value.terminalAcknowledgements));
			}
			if (value.version === 3) {
				return migrateToV7(value, receiptsFromTasks(value.tasks));
			}
			if (value.version !== 2) return null;
			const tasks = value.tasks.map(migrateLegacyTask);
			return migrateToV7({ ...value, tasks }, receiptsFromTasks(tasks));
		} catch {
			return null;
		}
	}

	schedule(state: PersistedRegistryState): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.write(state), 150);
	}

	flush(state: PersistedRegistryState): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		this.write(state);
	}

	private write(state: PersistedRegistryState): void {
		this.saveTimer = undefined;
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, this.filePath);
		try {
			fs.chmodSync(this.filePath, 0o600);
		} catch {
			// Best effort on non-POSIX filesystems.
		}
	}
}

function migrateToV7(
	value: { tasks: Task[]; focus: Omit<UiFocus, "newChatAgent"> & { newChatAgent?: UiFocus["newChatAgent"] }; savedAt: number },
	receipts: TerminalAcknowledgements,
	previousBaseline?: Partial<ObservationBaseline>,
): PersistedRegistryState {
	const baseline = validTimestamp(value.savedAt) ?? Date.now();
	const terminalAcknowledgements = { ...receipts };
	const tasks = value.tasks.map((task) => {
		if (task.status !== "DONE" && task.status !== "DONE_UNREAD" && task.status !== "ERROR") return task;
		const pendingVersion = task.attentionVersion ?? Math.max(1, task.attentionCount);
		const acknowledgedVersion = task.acknowledgedAttentionVersion ?? 0;
		const recentPending = task.status !== "DONE"
			&& pendingVersion > acknowledgedVersion
			&& baseline - task.lastEventAt >= 0
			&& baseline - task.lastEventAt <= 10 * 60_000;
		if (recentPending) return {
			...task,
			attentionVersion: pendingVersion,
			acknowledgedAttentionVersion: acknowledgedVersion,
			attentionCount: 1,
			attentionExpiresAt: task.lastEventAt + 10 * 60_000,
		};
		terminalAcknowledgements[task.taskId] = Math.max(terminalAcknowledgements[task.taskId] ?? 0, task.lastEventAt);
		const version = pendingVersion;
		return {
			...task,
			status: task.status === "DONE_UNREAD" ? "DONE" as const : task.status,
			attentionVersion: version,
			acknowledgedAttentionVersion: version,
			attentionCount: 0,
			attentionExpiresAt: undefined,
		};
	});
	return {
		version: 8,
		clearedExecutions: {},
		tasks: tasks.map(migrateTaskToV7),
		focus: migrateFocus(value.focus),
		terminalAcknowledgements,
		observationBaselineAt: sanitizeBaseline(previousBaseline, baseline),
		savedAt: value.savedAt,
	};
}

function migrateTaskToV7(task: Task): Task {
	const rawCapabilities = task.capabilities as Task["capabilities"] & Record<string, unknown>;
	const desktop = rawCapabilities?.desktop;
	const capabilities = rawCapabilities?.device && desktop
		? rawCapabilities
		: taskCapabilities({
			open: true,
			approve: rawCapabilities?.approve === true,
			reject: rawCapabilities?.reject === true,
			interrupt: rawCapabilities?.stop === true,
			review: rawCapabilities?.review === true,
			verify: rawCapabilities?.verify === true,
		});
	const progress = task.progress && typeof task.progress === "object"
		? { ...emptyTaskProgress(), ...task.progress }
		: emptyTaskProgress();
	return {
		...task,
		ownership: task.ownership === "managed" ? "managed" : "observer",
		capabilities,
		progress,
		lastExecutionActivityAt: validTimestamp(task.lastExecutionActivityAt)
			?? Math.max(validTimestamp(task.lastEventAt) ?? 0, validTimestamp(progress.latestActivity?.at) ?? 0, validTimestamp(progress.turnStartedAt) ?? 0),
	};
}

function sanitizeBaseline(value: unknown, fallback: number): ObservationBaseline {
	const baseline = value && typeof value === "object" ? value as Partial<ObservationBaseline> : {};
	const safeFallback = validTimestamp(fallback) ?? Date.now();
	return {
		codex: validTimestamp(baseline.codex) ?? safeFallback,
		claude: validTimestamp(baseline.claude) ?? safeFallback,
	};
}

function validTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function migrateFocus(focus: Omit<UiFocus, "newChatAgent"> & { newChatAgent?: UiFocus["newChatAgent"] }): UiFocus {
	return {
		selectedTaskId: {
			codex: focus.selectedTaskId?.codex ?? null,
			claude: focus.selectedTaskId?.claude ?? null,
		},
		activeAgent: focus.activeAgent === "codex" || focus.activeAgent === "claude" ? focus.activeAgent : null,
		newChatAgent: focus.newChatAgent === "claude" ? "claude" : "codex",
	};
}

function sanitizeAcknowledgements(value: unknown): TerminalAcknowledgements {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => (
		typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0
	)));
}

function sanitizeClearedExecutions(value: unknown): ClearedExecutions {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).flatMap(([taskId, item]) => {
		if (!taskId || !item || typeof item !== "object") return [];
		const record = item as ClearedExecutions[string];
		if (validTimestamp(record.turnStartedAt) === undefined || validTimestamp(record.lastEventAt) === undefined
			|| validTimestamp(record.lastExecutionActivityAt) === undefined) return [];
		return [[taskId, {
			...(typeof record.executionId === "string" && record.executionId ? { executionId: record.executionId } : {}),
			turnStartedAt: record.turnStartedAt,
			lastEventAt: record.lastEventAt,
			lastExecutionActivityAt: record.lastExecutionActivityAt,
			allowActivityResume: record.allowActivityResume === true,
		}]];
	}));
}

function receiptsFromTasks(tasks: Task[]): TerminalAcknowledgements {
	return Object.fromEntries(tasks.flatMap((task): Array<[string, number]> => {
		const version = task.attentionVersion ?? (task.attentionCount > 0 ? 1 : 0);
		const acknowledged = task.acknowledgedAttentionVersion ?? (task.status === "DONE" ? version : 0);
		const terminal = task.status === "DONE" || task.status === "DONE_UNREAD" || task.status === "ERROR";
		return terminal && acknowledged >= version ? [[task.taskId, task.lastEventAt]] : [];
	}));
}

function migrateLegacyTask(task: Task): Task {
	const wasAttention = task.status === "APPROVAL" || task.status === "NEEDS_INPUT" || task.status === "DONE_UNREAD" || task.status === "ERROR";
	const version = wasAttention ? 1 : 0;
	const keepPending = task.status === "APPROVAL" || task.status === "NEEDS_INPUT";
	return {
		...task,
		status: task.status === "DONE_UNREAD" ? "DONE" : task.status,
		attentionVersion: version,
		acknowledgedAttentionVersion: keepPending ? 0 : version,
		attentionCount: keepPending ? Math.max(1, task.attentionCount) : 0,
	};
}
