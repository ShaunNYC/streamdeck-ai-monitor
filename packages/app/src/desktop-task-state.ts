import fs from "node:fs";
import path from "node:path";
import { getDataDirectory } from "@streamdeck-supervisor/daemon";
import type { Task, TaskStatus } from "@streamdeck-supervisor/shared";

const STATE_VERSION = 1;
const COMPLETED_RETENTION_MS = 2 * 60 * 60_000;
const CLEARABLE_STATUSES = new Set<TaskStatus>(["IDLE", "DONE", "DONE_UNREAD", "ERROR", "PAUSED", "STALE"]);
const RESUMED_STATUSES = new Set<TaskStatus>(["QUEUED", "RUNNING", "APPROVAL", "NEEDS_INPUT"]);

interface HiddenTaskWatermark {
	executionId?: string;
	lastEventAt: number;
	hiddenAt: number;
}

interface DesktopTaskState {
	version: 1;
	hiddenTasks: Record<string, HiddenTaskWatermark>;
}

export class DesktopTaskStateStore {
	private state: DesktopTaskState;

	constructor(private readonly filePath = path.join(getDataDirectory(), "desktop-task-state.json")) {
		this.state = loadState(filePath);
	}

	project(tasks: readonly Task[], now = Date.now()): Task[] {
		const projected: Task[] = [];
		let stateChanged = false;
		for (const source of tasks) {
			const hidden = this.state.hiddenTasks[source.taskId];
			if (hidden) {
				if (isNewTurn(source, hidden)) {
					delete this.state.hiddenTasks[source.taskId];
					stateChanged = true;
				} else {
					continue;
				}
			}

			const task = normalizeDesktopTask(source);
			if (task.status === "DONE" && now - task.lastEventAt > COMPLETED_RETENTION_MS) continue;
			projected.push(withDesktopActivity(task));
		}
		if (stateChanged) this.save();
		return projected;
	}

	hideTasks(taskIds: readonly string[], tasks: readonly Task[], now = Date.now()): number {
		const byId = new Map(tasks.map((task) => [task.taskId, task]));
		let hiddenCount = 0;
		for (const taskId of new Set(taskIds)) {
			const task = byId.get(taskId);
			if (!task || this.state.hiddenTasks[taskId]) continue;
			this.state.hiddenTasks[taskId] = {
				...(task.executionId ? { executionId: task.executionId } : {}),
				lastEventAt: task.lastEventAt,
				hiddenAt: now,
			};
			hiddenCount += 1;
		}
		if (hiddenCount > 0) this.save();
		return hiddenCount;
	}

	clearHistory(tasks: readonly Task[], now = Date.now()): number {
		return this.hideTasks(tasks.filter((task) => CLEARABLE_STATUSES.has(task.status)).map((task) => task.taskId), tasks, now);
	}

	private save(): void {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, this.filePath);
		try { fs.chmodSync(this.filePath, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
	}
}

export function validateDesktopTaskIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error("Select 1–128 desktop tasks.");
	const ids = value.map((taskId) => {
		if (typeof taskId !== "string" || !taskId || taskId.length > 512) throw new Error("Invalid desktop task ID.");
		return taskId;
	});
	return [...new Set(ids)];
}

function loadState(filePath: string): DesktopTaskState {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopTaskState>;
		if (value.version !== STATE_VERSION) return emptyState();
		return {
			version: STATE_VERSION,
			hiddenTasks: sanitizeHiddenTasks(value.hiddenTasks),
		};
	} catch {
		return emptyState();
	}
}

function emptyState(): DesktopTaskState {
	return { version: STATE_VERSION, hiddenTasks: {} };
}

function sanitizeHiddenTasks(value: unknown): Record<string, HiddenTaskWatermark> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).flatMap(([taskId, candidate]) => {
		if (!taskId || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const watermark = candidate as Partial<HiddenTaskWatermark>;
		if (!validTimestamp(watermark.lastEventAt) || !validTimestamp(watermark.hiddenAt)) return [];
		return [[taskId, {
			...(typeof watermark.executionId === "string" && watermark.executionId ? { executionId: watermark.executionId } : {}),
			lastEventAt: watermark.lastEventAt,
			hiddenAt: watermark.hiddenAt,
		}]];
	}));
}

function isNewTurn(task: Task, hidden: HiddenTaskWatermark): boolean {
	if (task.executionId) return task.executionId !== hidden.executionId;
	return !hidden.executionId && task.lastEventAt > hidden.lastEventAt && RESUMED_STATUSES.has(task.status);
}

function normalizeDesktopTask(task: Task): Task {
	const projected = structuredClone(task);
	if (projected.status === "DONE_UNREAD") projected.status = "DONE";
	return projected;
}

function withDesktopActivity(task: Task): Task {
	const terminal = terminalActivity(task.status);
	if (!terminal) return task;
	return {
		...task,
		progress: {
			...task.progress,
			latestActivity: {
				category: "terminal",
				label: terminal.label,
				state: terminal.state,
				at: task.lastEventAt,
			},
		},
	};
}

function terminalActivity(status: TaskStatus): { label: string; state: "done" | "error" } | undefined {
	switch (status) {
		case "DONE":
		case "DONE_UNREAD": return { label: "Completed", state: "done" };
		case "ERROR": return { label: "Error", state: "error" };
		case "PAUSED": return { label: "Paused", state: "done" };
		case "STALE": return { label: "Expired", state: "error" };
		default: return undefined;
	}
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
