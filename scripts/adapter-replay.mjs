import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClaudeHookAdapter } from "../packages/daemon/dist/adapters/claude-hook-adapter.js";
import { ClaudeHookActivityGate, claudeDecisionResponse, parseClaudeHookEvent } from "../packages/daemon/dist/adapters/claude-events.js";
import { parseClaudeTranscript, readClaudeDefaultReasoningEffort, readClaudeDesktopSessionEfforts } from "../packages/daemon/dist/adapters/claude-transcript.js";
import { CodexCatalogAdapter, lifecycleFromRollout, readCodexDefaultReasoningEffort, readThreads } from "../packages/daemon/dist/adapters/codex-catalog-adapter.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-replay-project-"));
process.on("exit", () => fs.rmSync(cwd, { recursive: true, force: true }));
const permission = parseClaudeHookEvent({ session_id: "session-replay-1", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const duplicatePermission = parseClaudeHookEvent({ session_id: "session-replay-1", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
assert.equal(permission?.task.status, "APPROVAL");
assert.equal(permission?.task.openRef.value, "claude://resume?session=session-replay-1");
assert.equal(permission?.task.capabilities.desktop.approve, true);
assert.equal(permission?.request?.decisionPath, "claude-hook");
assert.notEqual(permission?.request?.requestId, duplicatePermission?.request?.requestId, "Identical concurrent Hooks must still receive unique request IDs");
assert.deepEqual(claudeDecisionResponse("PermissionRequest", "allow", ""), {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
});
assert.deepEqual(claudeDecisionResponse("PermissionRequest", "deny", "Rejected by Neo"), {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Rejected by Neo" } },
});

const staleHookTasks = [];
const hookTransitions = [];
let visibleHookTask;
const hookContext = {
	registry: {
		markRequestStale: (taskId) => { staleHookTasks.push(taskId); return true; },
		resolveApproval: (taskId, requestId) => {
			if (visibleHookTask?.taskId !== taskId || visibleHookTask.request?.requestId !== requestId) return false;
			visibleHookTask = { ...visibleHookTask, status: "RUNNING", request: undefined };
			hookTransitions.push("RUNNING");
			return true;
		},
	},
	upsertTask: (task) => { visibleHookTask = task; hookTransitions.push(task.request?.requestId ?? task.status); },
	removeTask: () => undefined,
	setStatus: () => undefined,
};
const hookAdapter = new ClaudeHookAdapter(hookContext, "test-token", undefined, "blocking");
const allowRequestId = permission.request.requestId;
const allowPending = hookAdapter.waitForDecision(permission.task, allowRequestId, Date.now() + 10_000);
const queuedRequestId = duplicatePermission.request.requestId;
const queuedPending = hookAdapter.waitForDecision(duplicatePermission.task, queuedRequestId, Date.now() + 10_000);
assert.deepEqual(hookTransitions, [allowRequestId], "Only the FIFO head may be published to the device");
assert.equal(hookAdapter.hasPendingDecision(permission.task.taskId, allowRequestId), true);
assert.equal(hookAdapter.hasPendingDecision(permission.task.taskId, queuedRequestId), false, "A queued request cannot be decided before it reaches the head");
assert.equal(hookAdapter.decide({ ...permission.task, taskId: "another-task" }, allowRequestId, "allow"), false, "A Claude task cannot answer another task's Hook");
assert.equal(hookAdapter.decide(permission.task, "another-request", "allow"), false, "A stale requestId cannot answer the current Hook");
assert.equal(hookAdapter.decide(permission.task, allowRequestId, "allow"), true);
assert.equal(await allowPending, "allow");
assert.equal(hookAdapter.hasPendingDecision(permission.task.taskId, allowRequestId), false);
assert.equal(hookAdapter.hasPendingDecision(permission.task.taskId, queuedRequestId), true, "Resolving the head must atomically promote the next request");
assert.deepEqual(hookTransitions, [allowRequestId, queuedRequestId], "FIFO promotion must not publish an intermediate RUNNING state");
assert.equal(hookAdapter.decide(duplicatePermission.task, queuedRequestId, "deny"), true);
assert.equal(await queuedPending, "deny");
assert.deepEqual(hookTransitions, [allowRequestId, queuedRequestId, "RUNNING"]);

const disconnectedRequestId = `${allowRequestId}-disconnected`;
const disconnectedPending = hookAdapter.waitForDecision(permission.task, disconnectedRequestId, Date.now() + 10_000);
assert.equal(hookAdapter.expirePendingDecision(permission.task.taskId, disconnectedRequestId), true);
assert.equal(await disconnectedPending, "deny", "A disconnected Claude Hook fails closed");
assert.deepEqual(staleHookTasks, [permission.task.taskId], "A disconnected Hook immediately marks its request STALE");
assert.equal(hookAdapter.hasPendingDecision(permission.task.taskId, disconnectedRequestId), false);

const expiringHead = parseClaudeHookEvent({ session_id: "session-expiry", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const expiringQueued = parseClaudeHookEvent({ session_id: "session-expiry", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const promotedAfterExpiry = parseClaudeHookEvent({ session_id: "session-expiry", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const expiringHeadResult = hookAdapter.waitForDecision(expiringHead.task, expiringHead.request.requestId, Date.now() + 10_000);
const expiringQueuedResult = hookAdapter.waitForDecision(expiringQueued.task, expiringQueued.request.requestId, Date.now() + 10_000);
assert.equal(hookAdapter.expirePendingDecision(expiringQueued.task.taskId, expiringQueued.request.requestId), true);
assert.equal(await expiringQueuedResult, "deny", "A disconnected queued Hook is denied without disturbing the visible head");
assert.equal(hookAdapter.hasPendingDecision(expiringHead.task.taskId, expiringHead.request.requestId), true);
const promotedResult = hookAdapter.waitForDecision(promotedAfterExpiry.task, promotedAfterExpiry.request.requestId, Date.now() + 10_000);
assert.equal(hookAdapter.expirePendingDecision(expiringHead.task.taskId, expiringHead.request.requestId), true);
assert.equal(await expiringHeadResult, "deny");
assert.equal(hookAdapter.hasPendingDecision(promotedAfterExpiry.task.taskId, promotedAfterExpiry.request.requestId), true, "Expiring the FIFO head promotes the next live request");
assert.deepEqual(staleHookTasks, [permission.task.taskId], "A task stays actionable while its FIFO still has a live request");
assert.equal(hookAdapter.decide(promotedAfterExpiry.task, promotedAfterExpiry.request.requestId, "allow"), true);
assert.equal(await promotedResult, "allow");

const shutdownHead = parseClaudeHookEvent({ session_id: "session-shutdown", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const shutdownQueued = parseClaudeHookEvent({ session_id: "session-shutdown", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking");
const shutdownHeadResult = hookAdapter.waitForDecision(shutdownHead.task, shutdownHead.request.requestId, Date.now() + 10_000);
const shutdownQueuedResult = hookAdapter.waitForDecision(shutdownQueued.task, shutdownQueued.request.requestId, Date.now() + 10_000);
await hookAdapter.stop();
assert.deepEqual(await Promise.all([shutdownHeadResult, shutdownQueuedResult]), ["deny", "deny"], "Adapter shutdown denies every queued Hook");
assert.equal(staleHookTasks.filter((taskId) => taskId === shutdownHead.task.taskId).length, 1, "Shutdown marks only the visible FIFO head stale once");

const dangerous = parseClaudeHookEvent({ session_id: "session-replay-2", cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" } }, "observe");
assert.equal(dangerous?.request, undefined);
assert.equal(dangerous?.task.status, "RUNNING", "Observer lets Claude handle automatic approval");
assert.equal(dangerous?.task.capabilities.desktop.approve, false);
assert.equal(permission.request.riskTier, 1, "A known local command remains a one-click Claude approval");

const riskDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-risk-"));
const linkedOutside = path.join(riskDirectory, "linked-outside");
fs.symlinkSync("/etc", linkedOutside);
const risk = (tool_name, tool_input) => parseClaudeHookEvent({
	session_id: crypto.randomUUID(), cwd: riskDirectory, hook_event_name: "PermissionRequest", tool_name, tool_input,
}, "blocking")?.request?.riskTier;
const installedProcessCwd = process.cwd();
process.chdir("/");
const installedCwdRisk = risk("Edit", { file_path: path.join(riskDirectory, "src", "installed.ts") });
process.chdir(installedProcessCwd);
assert.equal(installedCwdRisk, 1, "The Hook cwd, not the packaged app process cwd, defines the project boundary");
assert.equal(parseClaudeHookEvent({ session_id: crypto.randomUUID(), cwd: "/", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking")?.request?.riskTier, 2, "A root cwd cannot prove a project boundary and fails closed");
assert.equal(parseClaudeHookEvent({ session_id: crypto.randomUUID(), hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } }, "blocking")?.request?.riskTier, 2, "A missing Hook cwd cannot borrow the packaged process cwd for a Tier-1 decision");
assert.equal(risk("Edit", { file_path: path.join(riskDirectory, "src", "new.ts") }), 1, "A new file inside the task cwd is Tier 1");
assert.equal(risk("Edit", { file_path: "/etc/hosts" }), 2, "An absolute path outside the task cwd is Tier 2 even when the packaged cwd is /");
assert.equal(risk("Write", { file_path: "../outside.txt" }), 2, "Parent-directory escape is Tier 2");
assert.equal(risk("Bash", { command: "printf safe > ./../outside.txt" }), 2, "A shell path using ./../ cannot disguise a parent-directory escape");
assert.equal(risk("Edit", { file_path: path.join(linkedOutside, "hosts") }), 2, "A symlink escape is Tier 2");
assert.equal(risk("WebFetch", { url: "https://example.com" }), 2);
assert.equal(risk("UnknownPermissionTool", {}), 2, "Unknown permission tools fail closed to Tier 2");
fs.rmSync(riskDirectory, { recursive: true });

const activity = new ClaudeHookActivityGate();
const hook = (session, event, extra = {}) => parseClaudeHookEvent({ session_id: session, cwd, hook_event_name: event, ...extra });
assert.equal(activity.accept(hook("opened-only", "SessionStart")), false, "Opening Claude alone must not create a running task");
assert.equal(activity.accept(hook("opened-only", "SessionEnd")), false, "Closing an untouched conversation must not create DONE_UNREAD");
assert.equal(activity.accept(hook("real-turn", "UserPromptSubmit")), true, "A real user turn starts tracked work");
assert.equal(activity.accept(hook("real-turn", "Stop")), true, "The first completion after real work is accepted");
assert.equal(activity.accept(hook("real-turn", "SessionEnd")), false, "SessionEnd after Stop must not duplicate completion attention");
assert.equal(activity.accept(hook("idle", "Notification", { notification_type: "idle_prompt" })), true, "An idle prompt is a real input request");
assert.equal(hook("idle", "Notification", { notification_type: "idle_prompt" }).task.status, "NEEDS_INPUT");

const transcript = parseClaudeTranscript([
	{ type: "custom-title", customTitle: "Polish the controller", sessionId: "transcript-session", cwd, timestamp: "2026-08-07T04:59:00.000Z" },
	{ type: "assistant", sessionId: "transcript-session", cwd, effort: "xhigh", timestamp: "2026-08-07T05:00:00.000Z", message: { model: "claude-opus-4-6", stop_reason: "end_turn" } },
	{ type: "mode", sessionId: "transcript-session", cwd },
], "/tmp/transcript-session.jsonl");
assert.equal(transcript?.status, "DONE_UNREAD");
assert.equal(transcript?.source, "transcript-tail");
assert.equal(transcript?.titleShort, "Polish the controller");
assert.equal(transcript?.openRef.value, "claude://resume?session=transcript-session");
assert.equal(transcript?.reasoningEffort, "xhigh");
assert.equal(transcript?.model, "claude-opus-4-6");
assert.equal(transcript?.lastEventAt, Date.parse("2026-08-07T05:00:00.000Z"), "metadata appended while opening Claude must not create a new attention event");

const claudeProcess = parseClaudeTranscript([
	{ type: "user", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:00.000Z", message: { content: "Build the release" } },
	{ type: "assistant", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:01.000Z", message: { stop_reason: "tool_use", content: [
		{ type: "tool_use", id: "todo-create", name: "TaskCreate", input: { taskId: "todo-1", subject: "Build installer" } },
		{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "Check package" } },
	] } },
	{ type: "user", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:02.000Z", message: { content: [
		{ type: "tool_result", tool_use_id: "todo-create", content: "created" },
		{ type: "tool_result", tool_use_id: "agent-1", content: "checked" },
	] } },
	{ type: "assistant", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:03.000Z", message: { stop_reason: "tool_use", content: [
		{ type: "tool_use", id: "todo-update", name: "TaskUpdate", input: { taskId: "todo-1", status: "completed" } },
	] } },
	{ type: "user", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:04.000Z", message: { content: [
		{ type: "tool_result", tool_use_id: "todo-update", content: "updated" },
	] } },
	{ type: "assistant", sessionId: "claude-process", cwd, timestamp: "2026-08-07T06:00:05.000Z", message: { stop_reason: "end_turn", content: [
		{ type: "text", text: "Built and checked the release without token sk-proj-1234567890abcdefghijklmnop." },
	] } },
], "/tmp/claude-process.jsonl");
assert.equal(claudeProcess?.progress.todoCompleted, 1);
assert.equal(claudeProcess?.progress.todoTotal, 1);
assert.equal(claudeProcess?.progress.activeSubagents, 0);
assert.equal(claudeProcess?.progress.totalSubagents, 1);
assert.ok(claudeProcess?.progress.recap?.startsWith("Built and checked"));
assert.ok(!claudeProcess?.progress.recap?.includes("sk-proj"), "Claude recap is redacted before persistence/device rendering");

const claudeClearedTodo = parseClaudeTranscript([
	{ type: "user", sessionId: "claude-clear-todo", cwd, timestamp: "2026-08-07T06:10:00.000Z", message: { content: "Check Todo clearing" } },
	{ type: "assistant", sessionId: "claude-clear-todo", cwd, timestamp: "2026-08-07T06:10:01.000Z", message: { stop_reason: "tool_use", content: [
		{ type: "tool_use", id: "todo-set", name: "TodoWrite", input: { todos: [{ content: "Temporary step", status: "in_progress" }] } },
	] } },
	{ type: "assistant", sessionId: "claude-clear-todo", cwd, timestamp: "2026-08-07T06:10:02.000Z", message: { stop_reason: "end_turn", content: [
		{ type: "tool_use", id: "todo-clear", name: "TodoWrite", input: { todos: [] } },
	] } },
], "/tmp/claude-clear-todo.jsonl");
assert.equal(claudeClearedTodo?.progress.todoTotal, 0, "Claude TodoWrite with an explicit empty list clears the current Turn Todo");
assert.equal(claudeClearedTodo?.progress.currentTodo, undefined);

const claudeNewTurn = parseClaudeTranscript([
	{ type: "user", sessionId: "claude-new-turn", cwd, timestamp: "2026-08-07T06:20:00.000Z", message: { content: "First turn" } },
	{ type: "assistant", sessionId: "claude-new-turn", cwd, timestamp: "2026-08-07T06:20:01.000Z", message: { stop_reason: "end_turn", content: [
		{ type: "tool_use", id: "todo-first", name: "TaskCreate", input: { taskId: "first", subject: "Old task" } },
	] } },
	{ type: "user", sessionId: "claude-new-turn", cwd, timestamp: "2026-08-07T06:21:00.000Z", message: { content: "Second turn without a plan" } },
	{ type: "assistant", sessionId: "claude-new-turn", cwd, timestamp: "2026-08-07T06:21:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "No plan needed." }] } },
], "/tmp/claude-new-turn.jsonl");
assert.equal(claudeNewTurn?.progress.todoTotal, 0, "Claude starts each user Turn with an empty Todo state");
assert.equal(claudeNewTurn?.progress.currentTodo, undefined);

const sidechain = parseClaudeTranscript([{ type: "assistant", sessionId: "sub", cwd, isSidechain: true }], "/tmp/sub.jsonl");
assert.equal(sidechain, null);
const subagent = parseClaudeTranscript([{ type: "assistant", sessionId: "sub", cwd }], "/tmp/subagents/sub.jsonl");
assert.equal(subagent, null);
assert.equal(parseClaudeHookEvent({ session_id: "hook-sub", cwd, hook_event_name: "UserPromptSubmit", agent_type: "subagent" }), null);
assert.equal(parseClaudeHookEvent({ session_id: "hook-side", cwd, hook_event_name: "UserPromptSubmit", isSidechain: true }), null);

const effortDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-effort-"));
const codexDirectory = path.join(effortDirectory, ".codex");
fs.mkdirSync(codexDirectory);
fs.writeFileSync(path.join(codexDirectory, "config.toml"), 'model_reasoning_effort = "high"\n');
assert.equal(readCodexDefaultReasoningEffort(codexDirectory), "high");

const databasePath = path.join(effortDirectory, "state.sqlite");
const database = new DatabaseSync(databasePath);
database.exec(`CREATE TABLE threads (
	id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
	created_at_ms INTEGER, updated_at_ms INTEGER, source TEXT, thread_source TEXT,
	agent_role TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT,
	name TEXT, has_user_event INTEGER, archived INTEGER, recency_at_ms INTEGER
)`);
database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	.run("thread-no-effort", "/tmp/rollout.jsonl", 1, 1, 1, 1, "desktop", null, null, cwd, "Thread", "", "", null, 1, 0, 1);
database.close();
assert.equal(readThreads(databasePath)[0]?.reasoning_effort, null, "Older Codex databases without reasoning_effort stay readable");

const claudeSettings = path.join(effortDirectory, "settings.json");
fs.writeFileSync(claudeSettings, JSON.stringify({ effortLevel: "medium" }));
assert.equal(readClaudeDefaultReasoningEffort(claudeSettings), "medium");
const sessionRoot = path.join(effortDirectory, "claude-code-sessions", "account", "workspace");
fs.mkdirSync(sessionRoot, { recursive: true });
fs.writeFileSync(path.join(sessionRoot, "local_old.json"), JSON.stringify({ cliSessionId: "transcript-session", effort: "low", lastFocusedAt: 10 }));
fs.writeFileSync(path.join(sessionRoot, "local_current.json"), JSON.stringify({ cliSessionId: "transcript-session", effort: "max", lastFocusedAt: 20 }));
fs.writeFileSync(path.join(sessionRoot, "local_broken.json"), "{");
assert.equal((await readClaudeDesktopSessionEfforts(path.join(effortDirectory, "claude-code-sessions"))).get("transcript-session"), "max");
fs.rmSync(effortDirectory, { recursive: true });

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
const rollout = path.join(directory, "rollout.jsonl");
fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: "2026-08-07T04:00:00.000Z", type: "event_msg", payload: { type: "task_started" } })}\n${JSON.stringify({ timestamp: "2026-08-07T04:01:00.000Z", type: "event_msg", payload: { type: "task_complete" } })}\n`);
assert.equal(lifecycleFromRollout(rollout).status, "DONE_UNREAD");

const progressRollout = path.join(directory, "progress-rollout.jsonl");
const progressRecords = [
	{ timestamp: "2026-08-07T04:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-old" } },
	{ timestamp: "2026-08-07T04:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-old" } },
	{ timestamp: "2026-08-07T05:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-progress" } },
	{ timestamp: "2026-08-07T05:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "plan-1", input: JSON.stringify({ plan: [
		{ step: "Inspect events", status: "completed" }, { step: "Build installer", status: "in_progress" },
	] }) } },
	{ timestamp: "2026-08-07T05:00:02.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "plan-1", output: "ok" } },
	{ timestamp: "2026-08-07T05:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "agent-progress", input: "{}" } },
	{ timestamp: "2026-08-07T05:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "agent-progress", output: "done" } },
	{ timestamp: "2026-08-07T05:00:05.000Z", type: "event_msg", payload: { type: "agent_message", turn_id: "turn-progress", message: "Built the process view." } },
	{ timestamp: "2026-08-07T05:00:06.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-progress" } },
];
fs.writeFileSync(progressRollout, `${progressRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
const processLifecycle = lifecycleFromRollout(progressRollout);
assert.equal(processLifecycle.status, "DONE_UNREAD");
assert.equal(processLifecycle.executionId, "turn-progress");
assert.equal(processLifecycle.progress.todoCompleted, 1, "A cold/mid-turn scan rebuilds Todo from the newest complete turn");
assert.equal(processLifecycle.progress.todoTotal, 2);
assert.equal(processLifecycle.progress.currentTodo, "Build installer");
assert.equal(processLifecycle.progress.activeSubagents, 0);
assert.equal(processLifecycle.progress.totalSubagents, 0, "A spawn tool result alone is not evidence that a child thread completed");
assert.equal(processLifecycle.progress.durationMs, 6_000);
assert.equal(processLifecycle.progress.recap, "Built the process view.");
assert.deepEqual(processLifecycle.progress.latestActivity, {
	category: "agent", label: "Working with agent", state: "done", at: Date.parse("2026-08-07T05:00:04.000Z"),
}, "Legacy direct tools use the same stable semantic labels");

const programmaticPlanRollout = path.join(directory, "programmatic-plan-rollout.jsonl");
const programmaticPlanRecords = [
	{ timestamp: "2026-08-07T05:15:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-programmatic-plan" } },
	{ timestamp: "2026-08-07T05:15:01.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "programmatic-plan", input: `
		const first = await tools.update_plan({ plan: [
			{ step: "Inspect real rollout", status: "in_progress" },
			{ step: "Build fix", status: "pending" },
		] });
		const second = await tools["update_plan"]({ plan: [
			{ step: "Inspect real rollout", status: "completed" },
			{ step: "Build fix", status: "inProgress" },
		] });
		text(first); text(second);
	` } },
];
fs.writeFileSync(programmaticPlanRollout, `${programmaticPlanRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
const programmaticPlan = lifecycleFromRollout(programmaticPlanRollout);
assert.equal(programmaticPlan.progress.todoCompleted, 1, "Programmatic Tool Calling plan updates are extracted without executing their JavaScript");
assert.equal(programmaticPlan.progress.todoTotal, 2);
assert.equal(programmaticPlan.progress.currentTodo, "Build fix");
assert.deepEqual(programmaticPlan.progress.latestActivity, {
	category: "plan", label: "Updating plan", state: "running", at: Date.parse("2026-08-07T05:15:01.000Z"),
}, "Multiple programmatic tools in the same category retain a stable semantic Activity");

const programmaticPlanClear = { timestamp: "2026-08-07T05:15:02.000Z", type: "response_item", payload: {
	type: "custom_tool_call", name: "exec", call_id: "programmatic-plan-clear", input: "await tools.update_plan({ plan: [] });",
} };
fs.appendFileSync(programmaticPlanRollout, `${JSON.stringify(programmaticPlanClear)}\n`);
assert.equal(lifecycleFromRollout(programmaticPlanRollout).progress.todoTotal, 0, "An explicit programmatic empty plan clears Todo");

const semanticExecLifecycle = (name, input, withOutput = false) => {
	const file = path.join(directory, `semantic-${name}.jsonl`);
	const turnId = `turn-${name}`;
	const callId = `call-${name}`;
	const records = [
		{ timestamp: "2026-08-07T05:20:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
		{ timestamp: "2026-08-07T05:20:01.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: callId, input } },
	];
	if (withOutput) records.push({
		timestamp: "2026-08-07T05:20:02.000Z", type: "response_item",
		payload: { type: "custom_tool_call_output", call_id: callId, output: "ok" },
	});
	fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return lifecycleFromRollout(file).progress.latestActivity;
};

assert.deepEqual(semanticExecLifecycle("command", 'await tools.exec_command({cmd:"npm test --token sk-secret"});', true), {
	category: "shell", label: "Running command", state: "done", at: Date.parse("2026-08-07T05:20:02.000Z"),
}, "The outer exec output preserves the safe semantic label and completion state");
assert.equal(semanticExecLifecycle("web", 'await tools["web__run"]({search_query:[{q:"secret"}]});')?.label, "Searching web");
assert.equal(semanticExecLifecycle("patch", 'await tools.apply_patch("sensitive patch content");')?.label, "Editing files");
assert.equal(semanticExecLifecycle("image", 'await tools.view_image({path:"/private/secret.png"});')?.label, "Reading secret.png");
assert.deepEqual(semanticExecLifecycle("same-category", 'await Promise.all([tools.web__run({}), tools["web__run"]({})]);'), {
	category: "search", label: "Searching web", state: "running", at: Date.parse("2026-08-07T05:20:01.000Z"),
});
assert.deepEqual(semanticExecLifecycle("mixed", 'await Promise.all([tools.exec_command({cmd:"secret"}), tools.web__run({})]);'), {
	category: "other", label: "Using multiple tools", state: "running", at: Date.parse("2026-08-07T05:20:01.000Z"),
});
assert.equal(semanticExecLifecycle("false-positive", 'const mention="tools.web__run({secret:true})"; // tools.exec_command({cmd:"secret"})\nawait helper();')?.label, "Working");
assert.equal(semanticExecLifecycle("dynamic", 'const method="exec_command"; await tools[method]({cmd:"secret"});')?.label, "Working");
assert.equal(semanticExecLifecycle("malformed", 'await tools.web__run({')?.label, "Working");
assert.equal(semanticExecLifecycle("oversized", `${" ".repeat(300_000)}await tools.web__run({});`)?.label, "Working");

const ignoredProgrammaticPlanRollout = path.join(directory, "ignored-programmatic-plan-rollout.jsonl");
const ignoredProgrammaticPlanRecords = [
	{ timestamp: "2026-08-07T05:16:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-ignored-programmatic-plan" } },
	{ timestamp: "2026-08-07T05:16:01.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "programmatic-plan-string", input: `
		const mention = "tools.update_plan({ plan: [{ step: 'false positive', status: 'in_progress' }] })";
		// tools.update_plan({ plan: [] });
		text(mention);
	` } },
	{ timestamp: "2026-08-07T05:16:02.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "programmatic-plan-dynamic", input: "const input = { plan: [] }; await tools.update_plan(input);" } },
	{ timestamp: "2026-08-07T05:16:03.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "programmatic-plan-malformed", input: "await tools.update_plan({ plan: [" } },
];
fs.writeFileSync(ignoredProgrammaticPlanRollout, `${ignoredProgrammaticPlanRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.equal(lifecycleFromRollout(ignoredProgrammaticPlanRollout).progress.todoTotal, 0, "Strings, comments, dynamic arguments and malformed JavaScript never fabricate Todo state");

const clearedProgressRollout = path.join(directory, "cleared-progress-rollout.jsonl");
const clearedProgressRecords = [
	{ timestamp: "2026-08-07T05:30:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-clear" } },
	{ timestamp: "2026-08-07T05:30:01.000Z", type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "plan-set", input: JSON.stringify({ plan: [{ step: "Temporary", status: "in_progress" }] }) } },
	{ timestamp: "2026-08-07T05:30:02.000Z", type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "plan-clear", input: JSON.stringify({ plan: [] }) } },
	{ timestamp: "2026-08-07T05:30:03.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-clear" } },
];
fs.writeFileSync(clearedProgressRollout, `${clearedProgressRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
const clearedProcess = lifecycleFromRollout(clearedProgressRollout);
assert.equal(clearedProcess.progress.todoTotal, 0, "Codex update_plan with an explicit empty plan clears the current Turn Todo");
assert.equal(clearedProcess.progress.currentTodo, undefined);

const started = { timestamp: "2026-08-07T05:00:00.000Z", type: "event_msg", payload: { type: "task_started" } };
const question = {
	timestamp: "2026-08-07T05:01:00.000Z",
	type: "response_item",
	payload: {
		type: "function_call",
		name: "request_user_input",
		call_id: "call-plan-question",
		arguments: JSON.stringify({ questions: [{ id: "scope", question: "Which scope?", options: [{ label: "focused", description: "Keep it focused" }] }] }),
	},
};
const answer = {
	timestamp: "2026-08-07T05:02:00.000Z",
	type: "response_item",
	payload: {
		type: "function_call_output",
		call_id: "call-plan-question",
		output: JSON.stringify({ answers: { scope: { answers: ["focused"] } } }),
	},
};
fs.writeFileSync(rollout, `${[started, question].map((record) => JSON.stringify(record)).join("\n")}\n`);
const pendingQuestion = lifecycleFromRollout(rollout);
assert.equal(pendingQuestion.status, "NEEDS_INPUT", "A persisted Plan question must alert without an app-server subscription");
assert.equal(pendingQuestion.lastEventAt, Date.parse(question.timestamp));
assert.equal(pendingQuestion.progress.latestActivity?.label, "Waiting for answer");

fs.writeFileSync(rollout, `${[started, question, answer].map((record) => JSON.stringify(record)).join("\n")}\n`);
const answeredQuestion = lifecycleFromRollout(rollout);
assert.equal(answeredQuestion.status, "RUNNING", "The matching answer output must clear the question reminder");
assert.equal(answeredQuestion.lastEventAt, Date.parse(answer.timestamp), "The answer time prevents the resumed turn from becoming stale immediately");

const secondQuestion = {
	...question,
	timestamp: "2026-08-07T05:03:00.000Z",
	payload: { ...question.payload, call_id: "call-plan-question-2" },
};
fs.writeFileSync(rollout, `${[started, question, answer, secondQuestion].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.equal(lifecycleFromRollout(rollout).status, "NEEDS_INPUT", "A later Plan question must create a new reminder");

const elevatedExec = {
	timestamp: "2026-08-07T05:04:00.000Z",
	type: "response_item",
	payload: {
		type: "custom_tool_call",
		name: "exec",
		call_id: "call-elevated-exec",
		input: 'await tools.exec_command({"cmd":"npm test","sandbox_permissions":"require_escalated","justification":"Allow the full local test suite?"})',
	},
};
fs.writeFileSync(rollout, `${[started, elevatedExec].map((record) => JSON.stringify(record)).join("\n")}\n`);
const pendingApproval = lifecycleFromRollout(rollout);
assert.equal(pendingApproval.status, "RUNNING", "Elevated exec does not prove human intervention");
assert.equal(pendingApproval.approval, undefined);

const elevatedOutput = {
	timestamp: "2026-08-07T05:05:00.000Z",
	type: "response_item",
	payload: { type: "custom_tool_call_output", call_id: "call-elevated-exec", output: "approved" },
};
fs.writeFileSync(rollout, `${[started, elevatedExec, elevatedOutput].map((record) => JSON.stringify(record)).join("\n")}\n`);
const resolvedApproval = lifecycleFromRollout(rollout);
assert.equal(resolvedApproval.status, "RUNNING", "Matching custom_tool_call_output clears the Codex approval");
assert.equal(resolvedApproval.approval, undefined);

const ordinaryExec = {
	...elevatedExec,
	timestamp: "2026-08-07T05:06:00.000Z",
	payload: { ...elevatedExec.payload, call_id: "call-ordinary-exec", input: 'await tools.exec_command({ cmd: "npm test" })' },
};
fs.writeFileSync(rollout, `${[started, ordinaryExec].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.notEqual(lifecycleFromRollout(rollout).status, "APPROVAL", "Ordinary exec calls must never light the Codex decision keys");

const computerUseCode = 'globalThis.sky = (await import("@oai/sky")).sky;\nvar finderState = await sky.get_app_state({ app: "Finder", disableDiff: true });';
const computerUseCall = {
	timestamp: "2026-08-07T05:08:00.000Z",
	type: "response_item",
	payload: {
		type: "custom_tool_call",
		name: "exec",
		call_id: "call-computer-use",
		input: `const r = await tools.mcp__node_repl__js({title:"Inspect Finder",code:${JSON.stringify(computerUseCode)}});`,
	},
};
fs.writeFileSync(rollout, `${[started, computerUseCall].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.equal(lifecycleFromRollout(rollout).approval, undefined, "Computer use latency is not an approval signal");

const yieldedComputerUse = {
	timestamp: "2026-08-07T05:08:30.000Z",
	type: "response_item",
	payload: { type: "custom_tool_call_output", call_id: "call-computer-use", output: "Script running with cell ID 47\nWall time 30.6 seconds\nOutput:\n" },
};
fs.writeFileSync(rollout, `${[started, computerUseCall, yieldedComputerUse].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.equal(lifecycleFromRollout(rollout).status, "RUNNING", "Yielded tools continue running without a permission warning");

const computerUseEnd = {
	timestamp: "2026-08-07T05:08:35.000Z",
	type: "event_msg",
	payload: {
		type: "mcp_tool_call_end",
		call_id: "exec-computer-use",
		invocation: { server: "node_repl", tool: "js", arguments: { title: "Inspect Finder", code: computerUseCode } },
		result: { Ok: { content: [] } },
	},
};
fs.writeFileSync(rollout, `${[started, computerUseCall, yieldedComputerUse, computerUseEnd].map((record) => JSON.stringify(record)).join("\n")}\n`);
const completedComputerUse = lifecycleFromRollout(rollout);
assert.equal(completedComputerUse.status, "RUNNING", "The matching node_repl completion clears the Computer Use approval");
assert.equal(completedComputerUse.approval, undefined);
assert.ok(completedComputerUse.observedComputerUseApps.includes("finder"));

const allowedFollowUp = {
	...computerUseCall,
	timestamp: "2026-08-07T05:09:00.000Z",
	payload: {
		...computerUseCall.payload,
		call_id: "call-computer-use-follow-up",
		input: `const r = await tools.mcp__node_repl__js({title:"Click Finder",code:${JSON.stringify('await sky.click({ app: "Finder", element_index: 2 });')}});`,
	},
};
fs.writeFileSync(rollout, `${[started, computerUseCall, yieldedComputerUse, computerUseEnd, allowedFollowUp].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.notEqual(lifecycleFromRollout(rollout).status, "APPROVAL", "Conversation-approved apps must not create a false approval on every Computer Use call");

const unrelatedNodeRepl = {
	...computerUseCall,
	timestamp: "2026-08-07T05:10:00.000Z",
	payload: {
		...computerUseCall.payload,
		call_id: "call-node-repl-compute",
		input: 'const r = await tools.mcp__node_repl__js({title:"Calculate",code:"nodeRepl.write(2 + 2);"});',
	},
};
fs.writeFileSync(rollout, `${[started, unrelatedNodeRepl].map((record) => JSON.stringify(record)).join("\n")}\n`);
assert.notEqual(lifecycleFromRollout(rollout).status, "APPROVAL", "node_repl work without a Computer Use app must never light decision keys");

const riskyExec = {
	...elevatedExec,
	timestamp: "2026-08-07T05:11:00.000Z",
	payload: { ...elevatedExec.payload, call_id: "call-risky-exec", input: 'await tools.exec_command({ cmd: "rm -rf /tmp/neo-test", sandbox_permissions: "require_escalated" })' },
};
fs.writeFileSync(rollout, `${JSON.stringify(started)}\n{partial\n${JSON.stringify(riskyExec)}\n`);
assert.equal(lifecycleFromRollout(rollout).approval, undefined);

const longRollout = path.join(directory, "long-rollout.jsonl");
const longStarted = { timestamp: "2026-08-07T06:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-long-running" } };
const padding = Array.from({ length: 900 }, (_, index) => JSON.stringify({
	timestamp: "2026-08-07T06:00:01.000Z",
	type: "response_item",
	payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${index}:${"x".repeat(900)}` }] },
})).join("\n");
fs.writeFileSync(longRollout, `${JSON.stringify(longStarted)}\n${padding}\n`);
const old = new Date(Date.now() - 2 * 60 * 60_000);
fs.utimesSync(longRollout, old, old);
const longLifecycle = lifecycleFromRollout(longRollout);
assert.equal(longLifecycle.status, "RUNNING", "A task_started event beyond the 512 KiB hot tail must remain RUNNING");
assert.equal(longLifecycle.executionId, "turn-long-running");
const longComplete = { timestamp: "2026-08-07T08:00:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-long-running" } };
fs.appendFileSync(longRollout, `${JSON.stringify(longComplete)}\n`);
assert.equal(lifecycleFromRollout(longRollout).status, "DONE_UNREAD", "A terminal event appended to a large rollout must stop the running count immediately");

const longApprovalRollout = path.join(directory, "long-approval-rollout.jsonl");
const longApprovalCall = {
	...elevatedExec,
	timestamp: "2026-08-07T09:00:01.000Z",
	payload: { ...elevatedExec.payload, call_id: "call-long-approval" },
};
const longApprovalPadding = Array.from({ length: 1_400 }, (_, index) => JSON.stringify({
	timestamp: "2026-08-07T09:00:02.000Z",
	type: "event_msg",
	payload: { type: "token_count", index, padding: "x".repeat(900) },
})).join("\n");
fs.writeFileSync(longApprovalRollout, `${JSON.stringify(longStarted)}\n${JSON.stringify(longApprovalCall)}\n${longApprovalPadding}\n`);
assert.ok(fs.statSync(longApprovalRollout).size > 512 * 1024);
assert.equal(lifecycleFromRollout(longApprovalRollout).approval, undefined);
const longApprovalOutput = JSON.stringify({
	timestamp: "2026-08-07T09:10:00.000Z",
	type: "response_item",
	payload: { type: "custom_tool_call_output", call_id: "call-long-approval", output: "approved" },
});
const splitAt = Math.floor(longApprovalOutput.length / 2);
fs.appendFileSync(longApprovalRollout, longApprovalOutput.slice(0, splitAt));
assert.equal(lifecycleFromRollout(longApprovalRollout).status, "RUNNING", "A partial line does not create inferred approval");
fs.appendFileSync(longApprovalRollout, `${longApprovalOutput.slice(splitAt)}\n`);
assert.equal(lifecycleFromRollout(longApprovalRollout).status, "RUNNING", "The completed matching output clears the incrementally tracked approval");

const longQuestionRollout = path.join(directory, "long-question-rollout.jsonl");
const longQuestion = { ...question, timestamp: "2026-08-07T09:20:01.000Z", payload: { ...question.payload, call_id: "call-long-question" } };
fs.writeFileSync(longQuestionRollout, `${JSON.stringify(longStarted)}\n${JSON.stringify(longQuestion)}\n${longApprovalPadding}\n`);
assert.ok(fs.statSync(longQuestionRollout).size > 512 * 1024);
assert.equal(lifecycleFromRollout(longQuestionRollout).status, "NEEDS_INPUT", "A question remains visible after more than 512 KiB of later log records");
const longQuestionAnswer = { ...answer, timestamp: "2026-08-07T09:21:00.000Z", payload: { ...answer.payload, call_id: "call-long-question" } };
fs.appendFileSync(longQuestionRollout, `${JSON.stringify(longQuestionAnswer)}\n`);
assert.equal(lifecycleFromRollout(longQuestionRollout).status, "RUNNING", "The matching appended answer clears a long-log question reminder");

const rewrittenQuestion = { ...question, timestamp: "2026-08-07T10:00:01.000Z", payload: { ...question.payload, call_id: "call-after-rewrite" } };
fs.writeFileSync(longApprovalRollout, `${JSON.stringify({ ...started, timestamp: "2026-08-07T10:00:00.000Z" })}\n${JSON.stringify(rewrittenQuestion)}\n`);
assert.equal(lifecycleFromRollout(longApprovalRollout).status, "NEEDS_INPUT", "Truncating and rewriting a rollout invalidates the incremental cursor and rebuilds pending state");
const rewrittenAnswer = { ...answer, timestamp: "2026-08-07T10:00:02.000Z", payload: { ...answer.payload, call_id: "call-after-rewrite" } };
fs.appendFileSync(longApprovalRollout, `${JSON.stringify(rewrittenAnswer)}\n`);
assert.equal(lifecycleFromRollout(longApprovalRollout).status, "RUNNING");

const observerStateDirectory = path.join(directory, "observer-state");
fs.mkdirSync(observerStateDirectory);
const observerDatabasePath = path.join(observerStateDirectory, "state_5.sqlite");
const observerDatabase = new DatabaseSync(observerDatabasePath);
observerDatabase.exec(`CREATE TABLE threads (
	id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
	created_at_ms INTEGER, updated_at_ms INTEGER, source TEXT, thread_source TEXT,
	agent_role TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT,
	name TEXT, has_user_event INTEGER, archived INTEGER, recency_at_ms INTEGER
)`);
const insertObserverThread = observerDatabase.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const observerRootRollout = path.join(directory, "observer-root.jsonl");
const observerChildRollouts = [1, 2, 3].map((index) => path.join(directory, `observer-child-${index}.jsonl`));
const rootStartAt = Date.parse("2026-08-07T11:00:00.000Z");
fs.writeFileSync(observerRootRollout, `${JSON.stringify({ timestamp: "2026-08-07T11:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "observer-turn-1" } })}\n`);
observerChildRollouts.forEach((rolloutPath, index) => {
	const startedAt = `2026-08-07T11:00:0${index + 1}.000Z`;
	const records = [{ timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: `child-turn-${index + 1}` } }];
	fs.writeFileSync(rolloutPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
});
insertObserverThread.run("observer-root", observerRootRollout, rootStartAt / 1_000, rootStartAt / 1_000, rootStartAt, rootStartAt, "vscode", "vscode", null, cwd, "Observer root", "Observer root", "Observer root", null, 1, 0, rootStartAt);
observerChildRollouts.forEach((rolloutPath, index) => {
	const createdAt = rootStartAt + (index + 1) * 1_000;
	const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "observer-root", depth: 1 } } });
	insertObserverThread.run(`observer-child-${index + 1}`, rolloutPath, createdAt / 1_000, createdAt / 1_000, createdAt, createdAt, source, "subagent", null, cwd, `Observer child ${index + 1}`, "", "", null, 1, 0, createdAt);
});
observerDatabase.close();

const observedTasks = new Map();
const observerContext = {
	registry: { getTask: (taskId) => observedTasks.get(taskId) },
	upsertTask: (task) => observedTasks.set(task.taskId, task),
	removeTask: (taskId) => observedTasks.delete(taskId),
	setStatus: () => undefined,
};
const observerAdapter = new CodexCatalogAdapter(observerContext, observerStateDirectory);
const pollObserver = async () => { await observerAdapter.start(); await observerAdapter.stop(); return observedTasks.get("codex:observer-root"); };
let observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 3);
assert.equal(observedRoot.progress.totalSubagents, 3, "Observer aggregates unique direct child threads from the parent turn");

fs.appendFileSync(observerChildRollouts[0], `${JSON.stringify({ timestamp: "2026-08-07T11:00:06.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn-1" } })}\n`);
observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 2);
assert.equal(observedRoot.progress.totalSubagents, 3);
fs.appendFileSync(observerChildRollouts[1], `${JSON.stringify({ timestamp: "2026-08-07T11:00:06.500Z", type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn-2" } })}\n`);
observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 1);
assert.equal(observedRoot.progress.totalSubagents, 3);
fs.appendFileSync(observerChildRollouts[2], `${JSON.stringify({ timestamp: "2026-08-07T11:00:07.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn-3" } })}\n`);
observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 0);
assert.equal(observedRoot.progress.totalSubagents, 3, "Child completion comes from each child rollout lifecycle, not the spawn result");

fs.appendFileSync(observerRootRollout, `${JSON.stringify({ timestamp: "2026-08-07T11:01:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "observer-turn-2" } })}\n`);
observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 0);
assert.equal(observedRoot.progress.totalSubagents, 0, "A new parent turn resets direct-child counts");
fs.appendFileSync(observerChildRollouts[0], `${JSON.stringify({ timestamp: "2026-08-07T11:01:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "child-turn-1-resumed" } })}\n`);
observedRoot = await pollObserver();
assert.equal(observedRoot.progress.activeSubagents, 1);
assert.equal(observedRoot.progress.totalSubagents, 1, "Resuming an old child in the new parent turn counts it once for that turn");
fs.rmSync(directory, { recursive: true });

console.log("[replay] bound Claude Hook allow/deny, resilient effort data and Codex exec/Computer Use approval lifecycles: ok");

const modelRollout = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "neo-model-")), "rollout.jsonl");
fs.writeFileSync(modelRollout, [
 { type: "event_msg", payload: { type: "task_started", turn_id: "model-turn" } },
 { type: "turn_context", payload: { model: "gpt-6-astra", effort: "xhigh", turn_id: "model-turn" } },
].map(row => JSON.stringify(row)).join("\n") + "\n");
assert.equal(lifecycleFromRollout(modelRollout).model, "gpt-6-astra");
assert.equal(lifecycleFromRollout(modelRollout).reasoningEffort, "xhigh");
fs.rmSync(path.dirname(modelRollout), { recursive: true });
