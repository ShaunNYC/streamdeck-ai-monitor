import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentKind, Task, TaskStatus } from "@streamdeck-supervisor/shared";
import { emptyTaskProgress, isPendingAttentionTask, taskCapabilities } from "@streamdeck-supervisor/shared";
import { RegistryStore } from "../packages/daemon/src/registry-store.js";
import { TaskRegistry } from "../packages/daemon/src/task-registry.js";
import { lifecycleFromRollout } from "../packages/daemon/src/adapters/codex-catalog-adapter.js";
import { reduceProgressEvents, type ProgressEvent } from "../packages/daemon/src/progress-reducer.js";

const now = Date.now();

function withTemporaryDirectory<T>(prefix: string, run: (directory: string) => T): T {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return run(directory);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

{
	const events: ProgressEvent[] = [
		{ id: "terminal-old", at: now + 50, turnId: "turn-1", type: "turn.terminal", terminal: "error" },
		{ id: "todo", at: now + 20, turnId: "turn-1", type: "todo", items: [
			{ text: "Inspect state", completed: true },
			{ text: "Build installer", completed: false, active: true },
		] },
		{ id: "agent-start", at: now + 30, turnId: "turn-1", type: "subagent", childId: "child-1", state: "started" },
		{ id: "start", at: now, turnId: "turn-1", type: "turn.started" },
		{ id: "agent-done", at: now + 40, turnId: "turn-1", type: "subagent", childId: "child-1", state: "completed" },
		{ id: "activity", at: now + 25, turnId: "turn-1", type: "activity", category: "shell", label: "npm test --token sk-proj-1234567890abcdefghijklmnop", state: "running" },
		{ id: "terminal-final", at: now + 60, turnId: "turn-1", type: "turn.terminal", terminal: "completed" },
		{ id: "terminal-final", at: now + 60, turnId: "turn-1", type: "turn.terminal", terminal: "completed" },
		{ id: "recap", at: now + 55, turnId: "turn-1", type: "recap", text: "Finished with sk-proj-1234567890abcdefghijklmnop hidden." },
	];
	const reduced = reduceProgressEvents(events.reverse(), now + 100);
	assert.equal(reduced.terminal, "completed", "The latest terminal wins after out-of-order replay");
	assert.equal(reduced.progress.todoCompleted, 1);
	assert.equal(reduced.progress.todoTotal, 2);
	assert.equal(reduced.progress.currentTodo, "Build installer");
	assert.equal(reduced.progress.activeSubagents, 0);
	assert.equal(reduced.progress.totalSubagents, 1, "Duplicate and reordered sub-agent events keep one identity");
	assert.ok(!reduced.progress.latestActivity?.label.includes("sk-proj"), "Progress activity is redacted before device storage");
	assert.ok(!reduced.progress.recap?.includes("sk-proj"), "Recap is redacted without another model call");
}

{
	const events: ProgressEvent[] = [
		{ id: "turn-1-start", at: now, turnId: "turn-1", type: "turn.started" },
		{ id: "turn-1-todo", at: now + 10, turnId: "turn-1", type: "todo", items: [{ text: "Old step", completed: false, active: true }] },
		{ id: "turn-1-agent", at: now + 20, turnId: "turn-1", type: "subagent", childId: "old-child", state: "started" },
		{ id: "turn-2-start", at: now + 30, turnId: "turn-2", type: "turn.started" },
		{ id: "turn-2-work", at: now + 40, turnId: "turn-2", type: "activity", category: "file", label: "Current turn", state: "running" },
		{ id: "late-old-todo", at: now + 50, turnId: "turn-1", type: "todo", items: [{ text: "Late old step", completed: false, active: true }] },
	];
	const currentTurn = reduceProgressEvents(events, now + 100).progress;
	assert.equal(currentTurn.todoTotal, 0, "A new turn clears the previous turn Todo even if an old event arrives late");
	assert.equal(currentTurn.currentTodo, undefined);
	assert.equal(currentTurn.totalSubagents, 0, "A new turn clears previous sub-agent counters");
	assert.equal(currentTurn.latestActivity?.label, "Current turn");

	const completed = reduceProgressEvents([
		{ id: "complete-start", at: now, turnId: "turn-complete", type: "turn.started" },
		{ id: "complete-todo", at: now + 1, turnId: "turn-complete", type: "todo", items: [
			{ text: "One", completed: true }, { text: "Two", completed: true },
		] },
	], now + 2).progress;
	assert.equal(completed.todoCompleted, 2);
	assert.equal(completed.todoTotal, 2);
	assert.equal(completed.currentTodo, undefined, "A fully completed plan retains the ratio without a stale current step");

	const cleared = reduceProgressEvents([
		{ id: "clear-start", at: now, turnId: "turn-clear", type: "turn.started" },
		{ id: "clear-set", at: now + 1, turnId: "turn-clear", type: "todo", items: [{ text: "Temporary", completed: false }] },
		{ id: "clear-empty", at: now + 2, turnId: "turn-clear", type: "todo", items: [] },
	], now + 3).progress;
	assert.equal(cleared.todoTotal, 0, "An explicit empty Todo event clears the current plan");
	assert.equal(cleared.currentTodo, undefined);
}

function task(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
	const agent: AgentKind = overrides.agent ?? "codex";
	return {
		taskId: id,
		...(status === "RUNNING" ? { executionId: `${agent}:${id}:turn-1` } : {}),
		agent,
		ownership: "observer",
		externalId: id,
		projectId: "test",
		projectLabel: "TEST",
		titleShort: id,
		status,
		attentionCount: ["APPROVAL", "NEEDS_INPUT", "ERROR", "DONE_UNREAD"].includes(status) ? 1 : 0,
		capabilities: taskCapabilities({ approve: status === "APPROVAL", reject: status === "APPROVAL", interrupt: status === "RUNNING", review: true, verify: true }),
		progress: emptyTaskProgress(),
		openRef: { kind: "url", value: `codex://threads/${id}` },
		reviewRef: { kind: "result", value: id },
		verifyProfile: { command: "true", cwd: process.cwd(), timeoutMs: 1_000 },
		source: "mock",
		lastEventAt: now,
		startedAt: now - 60_000,
		...overrides,
	};
}

{
	const oldLifecycleAt = now - 2 * 60 * 60_000;
	const registry = new TaskRegistry([task("long-running", "RUNNING", {
		lastEventAt: oldLifecycleAt,
		lastObservedAt: now - 1_000,
		lastExecutionActivityAt: now - 1_000,
	})]);
	assert.equal(registry.sweep(now, 30 * 60_000), false,
		"Fresh execution activity keeps a long task running despite an old start event");
	assert.equal(registry.getTask("long-running")?.status, "RUNNING");
	assert.equal(registry.sweep(now + 31 * 60_000, 30 * 60_000), true);
	assert.equal(registry.getTask("long-running"), undefined, "Lost executions leave both clients");
}

{
	const registry = new TaskRegistry([task("done", "DONE_UNREAD", { slot: 3 })]);
	assert.equal(registry.selectTask("codex", "done"), true);
	assert.equal(registry.getTask("done")?.status, "DONE_UNREAD", "Selecting must never acknowledge completion");
	assert.equal(isPendingAttentionTask(registry.getTask("done")!), true);
	assert.equal(registry.acknowledgeReview("done"), true);
	assert.equal(registry.getTask("done")?.status, "DONE", "Successful OPEN/REVIEW may acknowledge completion");
	assert.equal(registry.getTask("done")?.slot, 3, "Acknowledgement must not move task identity");
}

{
	const completedAt = now - 3 * 60 * 60_000;
	const completed = task("retained-receipt", "DONE_UNREAD", { lastEventAt: completedAt });
	const registry = new TaskRegistry([completed]);
	assert.equal(registry.acknowledgeReview(completed.taskId), false, "Expired history is removed on startup");
	assert.equal(registry.getPersistedState().terminalAcknowledgements[completed.taskId], completedAt);
	assert.equal(registry.sweep(now), false, "Startup already removed expired history");
	assert.equal(registry.getTask(completed.taskId), undefined);
	registry.upsertTask(completed);
	assert.equal(registry.getTask(completed.taskId), undefined, "Polling a pruned completion must not restore it");
	registry.upsertTask({ ...completed, executionId: "new-completion", progress: { ...completed.progress, turnStartedAt: now + 1_000 }, lastEventAt: completedAt + 4 * 60 * 60_000 });
	assert.equal(registry.getTask(completed.taskId)?.status, "DONE_UNREAD", "A genuinely newer completion must alert again");
	assert.equal(isPendingAttentionTask(registry.getTask(completed.taskId)!), true);
}

{
	const original = task("error", "ERROR", { lastEventAt: now });
	const registry = new TaskRegistry([original]);
	assert.equal(registry.acknowledgeReview("error"), true);
	const acknowledgedVersion = registry.getTask("error")?.acknowledgedAttentionVersion;
	registry.upsertTask({ ...original });
	assert.equal(isPendingAttentionTask(registry.getTask("error")!), false, "Polling the same error must not relight it");
	assert.equal(registry.getTask("error")?.acknowledgedAttentionVersion, acknowledgedVersion);
	registry.upsertTask({ ...original, workflow: { kind: "verify", state: "pass", lastRunAt: now + 500 } });
	assert.equal(isPendingAttentionTask(registry.getTask("error")!), false, "Workflow results are independent and must not manufacture Agent attention");
	registry.upsertTask({ ...original, lastEventAt: now + 1_000, titleShort: "new failure" });
	assert.equal(isPendingAttentionTask(registry.getTask("error")!), true, "A newer error event must relight");
}

{
	const original = task("evicted-error", "ERROR", { lastEventAt: now - 1_000 });
	const running = Array.from({ length: 63 }, (_, index) => task(`capacity-${index}`, "RUNNING"));
	const registry = new TaskRegistry([original, ...running]);
	assert.equal(registry.acknowledgeReview(original.taskId), true);
	registry.upsertTask(task("capacity-trigger", "RUNNING"));
	assert.equal(registry.getTask(original.taskId), undefined, "Capacity eviction should remove the acknowledged terminal task");
	registry.upsertTask(original);
	assert.equal(isPendingAttentionTask(registry.getTask(original.taskId)!), false, "Capacity eviction must not discard the terminal receipt");
}

{
	const registry = new TaskRegistry([task("running", "RUNNING"), task("done", "DONE_UNREAD")]);
	assert.equal(registry.focusAgent("codex")?.taskId, "done", "Logo must focus the highest-priority context");
	assert.equal(registry.focusAgent("codex")?.taskId, "done", "Repeated Logo presses must not cycle");
	assert.equal(isPendingAttentionTask(registry.getTask("done")!), true, "Logo focus must not acknowledge");
}

{
	const registry = new TaskRegistry([task("codex-running", "RUNNING"), task("claude-running", "RUNNING", { agent: "claude" })]);
	assert.equal(registry.getFocus().newChatAgent, "codex", "New Chat defaults to Codex");
	registry.selectTask("claude", "claude-running");
	assert.equal(registry.getFocus().newChatAgent, "codex", "Task selection must not retarget New Chat");
	registry.focusAgent("claude");
	assert.equal(registry.getFocus().newChatAgent, "codex", "Automatic/legacy focus must not retarget New Chat");
	registry.activateAgent("claude");
	assert.equal(registry.getFocus().newChatAgent, "claude", "A successful central Logo activation retargets New Chat");
	registry.activateAgent("codex");
	assert.equal(registry.getFocus().newChatAgent, "codex");
	const empty = new TaskRegistry([]);
	assert.equal(empty.activateAgent("claude"), undefined);
	assert.equal(empty.getFocus().newChatAgent, "claude", "Opening an idle Agent still persists its New Chat target");
}

{
	const registry = new TaskRegistry([task("running", "RUNNING")]);
	registry.selectTask("codex", "running");
	registry.upsertTask(task("approval", "APPROVAL", { lastEventAt: now + 1_000 }));
	assert.equal(registry.getFocus().selectedTaskId.codex, "approval", "A new decision must preempt a running selection");
	assert.equal(registry.getFocus().activeAgent, "codex");
}

{
	const previous = task("claude-session", "RUNNING", {
		agent: "claude",
		source: "hook-event",
		lastEventAt: now,
		titleShort: "User Prompt Submit",
	});
	const registry = new TaskRegistry([previous]);
	registry.upsertTask(task("claude-session", "ERROR", {
		agent: "claude",
		source: "transcript-tail",
		lastEventAt: now - 24 * 60 * 60_000,
		titleShort: "Historical API error",
	}));
	assert.equal(registry.getTask("claude-session")?.status, "RUNNING", "An old transcript terminal state must not override a newer Claude hook signal");
	assert.equal(isPendingAttentionTask(registry.getTask("claude-session")!), false, "Opening an old failed transcript must not manufacture attention");
}

{
	const contaminated = task("claude-transcript", "ERROR", {
		agent: "claude",
		source: "transcript-tail",
		lastEventAt: now,
		attentionVersion: 4,
		acknowledgedAttentionVersion: 3,
	});
	const registry = new TaskRegistry([contaminated]);
	registry.upsertTask({ ...contaminated, lastEventAt: now - 24 * 60 * 60_000, attentionVersion: undefined, acknowledgedAttentionVersion: undefined });
	assert.equal(registry.getTask("claude-transcript"), undefined, "Reconciled expired history is removed");
}

{
	const baseline = now;
	const registry = new TaskRegistry([], undefined, {}, { codex: baseline, claude: baseline });
	registry.upsertTask(task("claude-history", "ERROR", {
		agent: "claude",
		source: "transcript-tail",
		lastEventAt: baseline - 6 * 24 * 60 * 60_000,
		lastObservedAt: baseline + 1_000,
	}));
	assert.equal(registry.getTask("claude-history"), undefined, "A six-day-old Claude error is removed even when observed now");
	assert.equal(registry.getTask("claude-history")?.attentionExpiresAt, undefined);
	registry.upsertTask(task("claude-recent", "DONE_UNREAD", {
		agent: "claude",
		lastEventAt: baseline - 60_000,
	}));
	assert.equal(isPendingAttentionTask(registry.getTask("claude-recent")!, baseline), true, "A terminal event from the last ten minutes survives a cold-start baseline");

	registry.upsertTask(task("claude-live", "RUNNING", { agent: "claude", lastEventAt: baseline + 2_000 }));
	registry.upsertTask(task("claude-live", "ERROR", { agent: "claude", lastEventAt: baseline + 3_000 }));
	const fresh = registry.getTask("claude-live")!;
	assert.equal(isPendingAttentionTask(fresh, baseline + 3_000), true);
	assert.equal(fresh.attentionExpiresAt, baseline + 3_000 + 10 * 60_000);
	registry.sweep(fresh.attentionExpiresAt!);
	assert.equal(registry.getTask("claude-live"), undefined, "A fresh terminal reminder leaves both clients after ten minutes");
}

{
	const orphan = task("claude-orphan", "DONE_UNREAD", {
		agent: "claude",
		source: "hook-event",
		titleShort: "Session ended",
		startedAt: now,
		lastEventAt: now,
	});
	const registry = new TaskRegistry([orphan]);
	assert.equal(registry.getTask("claude-orphan"), undefined, "A terminal-only Claude hook session must be removed from persisted state");
}

{
	const expiring = task("expired", "APPROVAL", {
		request: { requestId: "request-1", type: "permission", target: "test", riskTier: 1, createdAt: now - 10_000, expiresAt: now - 1, decisionPath: "claude-hook" },
	});
	const registry = new TaskRegistry([expiring]);
	assert.equal(registry.getTask("expired")?.status, "STALE");
	assert.equal(isPendingAttentionTask(registry.getTask("expired")!), false, "Expired requests must clear their badge");
	assert.equal(registry.getTask("expired")?.capabilities.desktop.approve, false);
	assert.equal(registry.getTask("expired")?.capabilities.desktop.reject, false);
}

{
	const requestId = "claude-request";
	const approval = task("claude-approval", "APPROVAL", {
		agent: "claude",
		executionId: "claude:approval:turn-1",
		processId: 42,
		request: { requestId, type: "permission", target: "Bash", riskTier: 1, createdAt: now, expiresAt: now + 30_000, decisionPath: "claude-hook" },
	});
	const registry = new TaskRegistry([approval]);
	assert.equal(registry.resolveApproval(approval.taskId, "wrong-request"), false, "A Claude response cannot resolve another request");
	assert.equal(registry.resolveApproval(approval.taskId, requestId, now + 1), true);
	const resumed = registry.getTask(approval.taskId)!;
	assert.equal(resumed.status, "RUNNING", "Claude allow/deny delivery returns to RUNNING until real lifecycle Hooks finish");
	assert.equal(resumed.request, undefined);
	assert.equal(resumed.capabilities.desktop.approve, false);
	assert.equal(resumed.capabilities.desktop.reject, false);
	assert.equal(resumed.capabilities.desktop.interrupt, true, "The same verified Claude execution remains stoppable after approval");
	assert.equal(isPendingAttentionTask(resumed), false, "A delivered Claude decision clears approval attention without fabricating completion");
}

{
	const requestId = "codex-request";
	const approval = task("codex-approval", "APPROVAL", {
		request: { requestId, type: "permission", target: "npm test", riskTier: 1, createdAt: now, expiresAt: now + 30_000, decisionPath: "codex-shortcut" },
	});
	const registry = new TaskRegistry([approval]);
	assert.equal(registry.markApprovalSubmitted(approval.taskId, "wrong-request"), false);
	assert.equal(registry.markApprovalSubmitted(approval.taskId, requestId), true);
	assert.equal(registry.getTask(approval.taskId)?.status, "APPROVAL", "Codex shortcut submission must not forge completion or RUNNING");
	assert.equal(registry.getTask(approval.taskId)?.capabilities.desktop.approve, false, "Submitted Codex approval cannot be repeated");
	assert.equal(registry.getTask(approval.taskId)?.capabilities.desktop.reject, false, "Submitted Codex rejection cannot be repeated");
}

{
	const registry = new TaskRegistry([task("running", "RUNNING")]);
	assert.equal(registry.applyMockAction("stop", "running"), true);
	assert.equal(registry.getTask("running")?.status, "PAUSED");
	assert.equal(registry.getSelectedTask("codex"), undefined, "Paused tasks are hidden from the device context");
}

{
	const original = task("paused-execution", "RUNNING", { executionId: "turn-old", lastEventAt: now });
	const registry = new TaskRegistry([original]);
	assert.equal(registry.pauseExecution(original.taskId, "wrong-turn"), false, "STOP cannot pause a different execution");
	assert.equal(registry.pauseExecution(original.taskId, "turn-old", now + 1), true);
	registry.upsertTask({ ...original, status: "ERROR", titleShort: "late abort", lastEventAt: now + 2 });
	assert.equal(registry.getTask(original.taskId)?.status, "PAUSED", "Late events from the interrupted execution must not relight it");
	assert.equal(registry.getTask(original.taskId)?.capabilities.desktop.interrupt, false);
	assert.equal(isPendingAttentionTask(registry.getTask(original.taskId)!), false);
	registry.upsertTask({ ...original, executionId: "turn-new", status: "RUNNING", titleShort: "new prompt", lastEventAt: now + 3 });
	assert.equal(registry.getTask(original.taskId)?.status, "RUNNING", "Only a new execution identity may resume a paused conversation");
	assert.equal(registry.getTask(original.taskId)?.executionId, "turn-new");
}

{
	const registry = new TaskRegistry([task("slot-0", "RUNNING"), task("slot-1", "RUNNING")]);
	assert.deepEqual(registry.getTasksForAgent("codex").map((item) => item.slot), [0, 1]);
	registry.removeTask("slot-0");
	registry.upsertTask(task("replacement", "RUNNING"));
	assert.equal(registry.getTask("replacement")?.slot, 0, "Released daemon identity slots remain reusable");
}

{
	withTemporaryDirectory("streamdeck-codex-turn-id-", (directory) => {
		const rollout = path.join(directory, "rollout.jsonl");
		fs.writeFileSync(rollout, [
			JSON.stringify({ timestamp: new Date(now - 1_000).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn-old" } }),
			JSON.stringify({ timestamp: new Date(now - 500).toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-old" } }),
			JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn-new" } }),
			JSON.stringify({ timestamp: new Date(now).toISOString(), type: "response_item", payload: { type: "reasoning", content: "x".repeat(600_000) } }),
		].join("\n"));
		const lifecycle = lifecycleFromRollout(rollout);
		assert.equal(lifecycle.status, "RUNNING");
		assert.equal(lifecycle.executionId, "turn-new", "Codex STOP finds the latest rollout turn_id even beyond the 512 KB hot tail");
	});
}

{
	withTemporaryDirectory("streamdeck-v3-migration-", (directory) => {
		const file = path.join(directory, "state.json");
		const legacyTasks = [task("old-done", "DONE_UNREAD"), task("old-error", "ERROR"), task("live-approval", "APPROVAL")];
		fs.writeFileSync(file, JSON.stringify({ version: 2, tasks: legacyTasks, focus: { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, savedAt: now }));
		const migrated = new RegistryStore(file).load();
		assert.equal(migrated?.version, 8);
		assert.ok(migrated?.tasks.every((item) => item.ownership === "observer"), "Legacy tasks migrate to immutable Observer ownership");
		assert.equal(migrated?.focus.newChatAgent, "codex", "Old state defaults New Chat to Codex");
		assert.equal(isPendingAttentionTask(migrated!.tasks.find((item) => item.taskId === "old-done")!), false, "Historical completion must be baselined as read");
		assert.equal(isPendingAttentionTask(migrated!.tasks.find((item) => item.taskId === "old-error")!), false, "Historical error must be baselined as reviewed");
		assert.equal(isPendingAttentionTask(migrated!.tasks.find((item) => item.taskId === "live-approval")!), true, "Live approval must survive migration");
		assert.equal(migrated?.terminalAcknowledgements["old-done"], now);
		assert.equal(migrated?.terminalAcknowledgements["old-error"], now);
		assert.equal(migrated?.terminalAcknowledgements["live-approval"], undefined);
	});
}

{
	withTemporaryDirectory("streamdeck-v3-receipts-", (directory) => {
		const file = path.join(directory, "state.json");
		const acknowledgedDone = task("v3-done", "DONE", { attentionVersion: 2, acknowledgedAttentionVersion: 2, attentionCount: 0 });
		const acknowledgedError = task("v3-error", "ERROR", { attentionVersion: 3, acknowledgedAttentionVersion: 3, attentionCount: 0 });
		const pendingDone = task("v3-pending", "DONE_UNREAD", { attentionVersion: 4, acknowledgedAttentionVersion: 3, attentionCount: 1 });
		fs.writeFileSync(file, JSON.stringify({
			version: 3,
			tasks: [acknowledgedDone, acknowledgedError, pendingDone],
			focus: { selectedTaskId: { codex: null, claude: null }, activeAgent: null },
			savedAt: now,
		}));
		const migrated = new RegistryStore(file).load()!;
		assert.equal(migrated.version, 8);
		assert.equal(migrated.focus.newChatAgent, "codex");
		assert.equal(migrated.terminalAcknowledgements[acknowledgedDone.taskId], now);
		assert.equal(migrated.terminalAcknowledgements[acknowledgedError.taskId], now);
		assert.equal(migrated.terminalAcknowledgements[pendingDone.taskId], undefined, "A genuinely recent pre-beta.3 terminal reminder survives migration");
		assert.equal(isPendingAttentionTask(migrated.tasks.find((item) => item.taskId === pendingDone.taskId)!), true);
	});
}

{
	withTemporaryDirectory("streamdeck-v4-focus-", (directory) => {
		const file = path.join(directory, "state.json");
		const running = task("v4-running", "RUNNING");
		fs.writeFileSync(file, JSON.stringify({
			version: 4,
			tasks: [running],
			focus: { selectedTaskId: { codex: running.taskId, claude: null }, activeAgent: "codex" },
			terminalAcknowledgements: {},
			savedAt: now,
		}));
		const migrated = new RegistryStore(file).load()!;
		assert.equal(migrated.version, 8);
		assert.equal(migrated.tasks[0]?.taskId, running.taskId, "V4 task identity survives the focus migration");
		assert.equal(migrated.focus.selectedTaskId.codex, running.taskId);
		assert.equal(migrated.focus.activeAgent, "codex");
		assert.equal(migrated.focus.newChatAgent, "codex");
	});
}

{
	withTemporaryDirectory("streamdeck-v5-restart-", (directory) => {
		const file = path.join(directory, "state.json");
		const completedAt = now - 3 * 60 * 60_000;
		const completed = task("restart-receipt", "DONE_UNREAD", { lastEventAt: completedAt });
		const beforeRestart = new TaskRegistry([completed]);
		beforeRestart.acknowledgeReview(completed.taskId);
		beforeRestart.sweep(now);
		const store = new RegistryStore(file);
		beforeRestart.activateAgent("claude");
		store.flush({ version: 8, ...beforeRestart.getPersistedState(), savedAt: now });
		const persisted = store.load()!;
		assert.equal(persisted.focus.newChatAgent, "claude", "New Chat target survives restart");
		const afterRestart = new TaskRegistry(persisted.tasks, persisted.focus, persisted.terminalAcknowledgements, persisted.observationBaselineAt, persisted.clearedExecutions);
		afterRestart.upsertTask(completed);
		assert.equal(afterRestart.getTask(completed.taskId), undefined, "A restart preserves the cleared execution after pruning");
	});
}

console.log("[state-regression] V2–V8 migration, expiring terminal reminders and execution-bound PAUSED state: ok");
