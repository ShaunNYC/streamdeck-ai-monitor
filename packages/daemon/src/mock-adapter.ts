import { emptyTaskProgress, taskCapabilities, type AgentKind, type Task, type TaskCapabilities, type TaskStatus } from "@streamdeck-supervisor/shared";
import { TaskRegistry } from "./task-registry.js";

function capabilities(status: TaskStatus): TaskCapabilities {
	return taskCapabilities({
		approve: status === "APPROVAL",
		reject: status === "APPROVAL",
		interrupt: status === "RUNNING",
		review: true,
		verify: true,
	});
}

function makeTask(
	agent: AgentKind,
	slot: number,
	data: Omit<Task, "agent" | "ownership" | "progress" | "slot" | "capabilities" | "source" | "openRef">,
): Task {
	return {
		...data,
		...(data.status === "RUNNING" && !data.executionId ? { executionId: `mock:${agent}:${data.externalId}:turn-1` } : {}),
		agent,
		ownership: "observer",
		progress: emptyTaskProgress(),
		slot,
		capabilities: capabilities(data.status),
		source: "mock",
		openRef: agent === "codex"
			? { kind: "url", value: `codex://threads/mock-codex-${slot}` }
			: { kind: "url", value: `claude://resume?session=mock-claude-${slot}` },
	};
}

export function createMockTasks(): Task[] {
	const now = Date.now();
	return [
		makeTask("codex", 0, { taskId: "codex-0", externalId: "mock-codex-0", projectId: "focus-app", projectLabel: "FOCUS", titleShort: "npm install", status: "RUNNING", attentionCount: 0, startedAt: now - 12 * 60_000, lastEventAt: now - 500, verifyProfile: { command: "npm test", cwd: ".", timeoutMs: 120_000 } }),
		makeTask("codex", 1, { taskId: "codex-1", externalId: "mock-codex-1", projectId: "stream-app", projectLabel: "STREAM", titleShort: "Write config", status: "APPROVAL", attentionCount: 1, request: { requestId: "req-codex-1", type: "file-access", target: "src/config.ts", riskTier: 1, createdAt: now - 30_000, expiresAt: now + 10 * 60_000, decisionPath: "codex-shortcut" }, startedAt: now - 40_000, lastEventAt: now - 30_000 }),
		makeTask("codex", 2, { taskId: "codex-2", externalId: "mock-codex-2", projectId: "sdk-tools", projectLabel: "SDK", titleShort: "rm -rf tmp/", status: "APPROVAL", attentionCount: 1, request: { requestId: "req-codex-2", type: "shell", target: "rm -rf tmp/", riskTier: 2, createdAt: now - 15_000, expiresAt: now + 10 * 60_000, decisionPath: "codex-shortcut" }, startedAt: now - 20_000, lastEventAt: now - 15_000 }),
		makeTask("codex", 3, { taskId: "codex-3", externalId: "mock-codex-3", projectId: "unity-game", projectLabel: "UNITY", titleShort: "Choose renderer", status: "NEEDS_INPUT", attentionCount: 1, startedAt: now - 60_000, lastEventAt: now - 5_000 }),
		makeTask("codex", 4, { taskId: "codex-4", externalId: "mock-codex-4", projectId: "focus-app", projectLabel: "FOCUS", titleShort: "6 files changed", status: "DONE_UNREAD", attentionCount: 1, reviewRef: { kind: "diff", value: "mock-diff-4" }, startedAt: now - 5 * 60_000, lastEventAt: now - 60_000 }),
		makeTask("codex", 5, { taskId: "codex-5", externalId: "mock-codex-5", projectId: "ios-app", projectLabel: "IOS", titleShort: "Build failed", status: "ERROR", attentionCount: 1, reviewRef: { kind: "log", value: "mock-log-5" }, startedAt: now - 8 * 60_000, lastEventAt: now - 90_000 }),
		makeTask("codex", 6, { taskId: "codex-6", externalId: "mock-codex-6", projectId: "sdk-tools", projectLabel: "SDK", titleShort: "Expired approval", status: "STALE", attentionCount: 0, startedAt: now - 20 * 60_000, lastEventAt: now - 12 * 60_000 }),
		makeTask("claude", 0, { taskId: "claude-0", externalId: "mock-claude-0", projectId: "stream-app", projectLabel: "STREAM", titleShort: "pytest suite", status: "RUNNING", attentionCount: 0, startedAt: now - 5 * 60_000, lastEventAt: now - 400 }),
		makeTask("claude", 1, { taskId: "claude-1", externalId: "mock-claude-1", projectId: "focus-app", projectLabel: "FOCUS", titleShort: "npm test", status: "APPROVAL", attentionCount: 1, request: { requestId: "req-claude-1", type: "shell", target: "npm test", riskTier: 1, createdAt: now - 10_000, expiresAt: now + 10 * 60_000, decisionPath: "claude-hook" }, startedAt: now - 15_000, lastEventAt: now - 10_000, verifyProfile: { command: "npm test", cwd: ".", timeoutMs: 120_000 } }),
		makeTask("claude", 2, { taskId: "claude-2", externalId: "mock-claude-2", projectId: "unity-game", projectLabel: "UNITY", titleShort: "Refactor done", status: "DONE_UNREAD", attentionCount: 1, reviewRef: { kind: "diff", value: "mock-diff-c2" }, startedAt: now - 10 * 60_000, lastEventAt: now - 3 * 60_000 }),
		makeTask("claude", 3, { taskId: "claude-3", externalId: "mock-claude-3", projectId: "sdk-tools", projectLabel: "SDK", titleShort: "Waiting resume", status: "PAUSED", attentionCount: 0, startedAt: now - 30 * 60_000, lastEventAt: now - 20 * 60_000 }),
		makeTask("claude", 4, { taskId: "claude-4", externalId: "mock-claude-4", projectId: "unity-game", projectLabel: "UNITY", titleShort: "Answer needed", status: "NEEDS_INPUT", attentionCount: 1, startedAt: now - 90_000, lastEventAt: now - 20_000 }),
		makeTask("claude", 5, { taskId: "claude-5", externalId: "mock-claude-5", projectId: "ios-app", projectLabel: "IOS", titleShort: "Lint failed", status: "ERROR", attentionCount: 1, reviewRef: { kind: "log", value: "mock-log-c5" }, startedAt: now - 8 * 60_000, lastEventAt: now - 90_000 }),
	];
}

export class MockAdapter {
	readonly registry: TaskRegistry;
	readonly configuredProjectCount = process.env.AI_CONTROL_SUPERVISOR_SETUP === "1" ? 0 : 4;

	constructor(registry?: TaskRegistry) {
		this.registry = registry ?? new TaskRegistry(createMockTasks());
		if (registry) for (const task of createMockTasks()) this.registry.upsertTask(task);
	}
}
