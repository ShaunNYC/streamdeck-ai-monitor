import { emptyTaskProgress, redactSensitiveText, taskCapabilities, type AdapterStatus, type AgentKind, type Task, type TaskCapabilities } from "@streamdeck-supervisor/shared";
import type { TaskRegistry } from "../task-registry.js";

export type AdapterName = "claude" | "codex";

export interface AdapterContext {
	readonly registry: TaskRegistry;
	upsertTask(task: Task): void;
	removeTask(taskId: string): void;
	setStatus(adapter: AdapterName, status: AdapterStatus["status"], lastError?: string): void;
}

export interface SupervisorAdapter {
	readonly name: AdapterName;
	start(): Promise<void>;
	stop(): Promise<void>;
	getStatus(): AdapterStatus;
}

export function safeTaskTitle(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = redactSensitiveText(value)
		.replace(/<image[^>]*>/gi, " ")
		.replace(/\[[^\]]*image[^\]]*\]/gi, " ")
		.replace(/[#*_`>]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return fallback;
	return normalized.length > 42 ? `${normalized.slice(0, 41)}…` : normalized;
}

export function projectLabelFromCwd(cwd: string | undefined, fallback: string): string {
	if (!cwd) return fallback;
	const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback;
	return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 9).toUpperCase() || fallback;
}

export function baseTask(
	agent: AgentKind,
	data: Pick<Task, "taskId" | "externalId" | "projectId" | "projectLabel" | "cwd" | "titleShort" | "status" | "lastEventAt" | "startedAt" | "source" | "openRef">
		& Partial<Pick<Task, "reasoningEffort" | "model" | "executionId" | "lastObservedAt" | "lastExecutionActivityAt">>,
	capabilities: Partial<TaskCapabilities["desktop"]> & { deviceOpen?: boolean; answerChoice?: boolean },
): Task {
	return {
		...data,
		agent,
		ownership: "observer",
		progress: emptyTaskProgress(),
		lastObservedAt: data.lastObservedAt ?? Date.now(),
		lastExecutionActivityAt: data.lastExecutionActivityAt ?? data.lastEventAt,
		attentionCount: data.status === "APPROVAL" || data.status === "NEEDS_INPUT" || data.status === "ERROR" || data.status === "DONE_UNREAD" ? 1 : 0,
		capabilities: taskCapabilities(capabilities),
	};
}
