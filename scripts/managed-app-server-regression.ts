import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PendingPlanInput } from "@streamdeck-supervisor/shared";
import { CodexManagedController } from "../packages/daemon/src/codex-managed-controller.js";
import { TaskRegistry } from "../packages/daemon/src/task-registry.js";

async function main(): Promise<void> {
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "neo-managed-app-server-"));
const binary = path.join(temporary, "fake-codex.mjs");
const logPath = path.join(temporary, "fake-app-server.jsonl");
const statePath = path.join(temporary, "managed-codex.json");
const workspace = path.join(temporary, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const fakeSource = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const logPath = process.env.FAKE_CODEX_LOG;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const writeBatch = (values) => process.stdout.write(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
const log = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\n");
const rpcResponse = (message, result) => ({ jsonrpc: "2.0", id: message.id, result });
const notification = (method, params) => ({ jsonrpc: "2.0", method, params });
const response = (message, result) => write(rpcResponse(message, result));
const notify = (method, params) => write(notification(method, params));
let successfulTurns = 0;
let failedOnce = false;
let delayedStart;
const pending = new Map();
const complete = (turnId, status = "completed") => notify("turn/completed", {
  threadId: "thread-managed-1",
  turn: { id: turnId, status, completedAt: Date.now() / 1000 },
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ direction: "in", method: message.method, id: message.id, params: message.params, result: message.result, error: message.error });
  if (!message.method) {
    const turnId = pending.get(message.id);
    if (turnId) { pending.delete(message.id); setTimeout(() => complete(turnId), 5); }
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "initialize") return response(message, { protocolVersion: 2 });
  if (message.method === "model/list") return response(message, { data: [{
    id: "gpt-test", model: "gpt-test", displayName: "GPT Test", description: "Fixture model",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
    defaultReasoningEffort: "high", isDefault: true,
  }] });
  if (message.method === "thread/start") return response(message, {
    thread: { id: "thread-managed-1", createdAt: Date.now() / 1000 },
    model: message.params.model || "gpt-test", reasoningEffort: "high",
  });
  if (message.method === "thread/read") return response(message, { thread: {
    id: "thread-managed-1",
    turns: [{ id: "turn-6", status: "inProgress", startedAt: Date.now() / 1000, items: [
      { type: "agentMessage", id: "restore-recap", text: "Restored managed task." },
    ] }],
  } });
  if (message.method === "thread/settings/update") return response(message, {});
  if (message.method === "turn/steer") {
    const text = message.params.input[0].text;
    if (text === "CRASH") return setTimeout(() => process.exit(17), 5);
    return response(message, { turnId: message.params.expectedTurnId });
  }
  if (message.method === "turn/interrupt") {
    response(message, {});
    return setTimeout(() => complete(message.params.turnId, "interrupted"), 5);
  }
  if (message.method !== "turn/start") return response(message, {});
  const text = message.params.input[0].text;
  if (text === "fail once" && !failedOnce) {
    failedOnce = true;
    return write({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "fixture start failure" } });
  }
  if (text === "late response") {
    successfulTurns += 1;
    delayedStart = { message, turnId: "turn-" + successfulTurns, startedAt: Date.now() / 1000 };
    return;
  }
  if (text === "newer response") {
    successfulTurns += 1;
    const turnId = "turn-" + successfulTurns;
    const startedAt = Date.now() / 1000;
    writeBatch([
      rpcResponse(message, { turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/started", { threadId: "thread-managed-1", turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/plan/updated", { threadId: "thread-managed-1", turnId, plan: [{ step: "Keep newer progress", status: "inProgress" }] }),
      notification("item/started", { threadId: "thread-managed-1", turnId, item: { id: "agent-newer", type: "collabToolCall", tool: "resumeAgent", receiverThreadId: "child-newer", agentStatus: "running" } }),
    ]);
    if (delayedStart) {
      const stale = delayedStart;
      delayedStart = undefined;
      setTimeout(() => response(stale.message, { turn: { id: stale.turnId, status: "inProgress", startedAt: stale.startedAt } }), 5);
    }
    return;
  }
  successfulTurns += 1;
  const turnId = "turn-" + successfulTurns;
  const startedAt = Date.now() / 1000;
  if (successfulTurns === 1) {
    pending.set("approval-1", turnId);
    writeBatch([
      rpcResponse(message, { turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/started", { threadId: "thread-managed-1", turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/plan/updated", { threadId: "thread-managed-1", turnId, plan: [
        { step: "Inspect fixture", status: "completed" }, { step: "Build release", status: "inProgress" },
      ] }),
      notification("item/started", { threadId: "thread-managed-1", turnId, item: { id: "cmd-1", type: "commandExecution" } }),
      notification("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "cmd-1", type: "commandExecution", status: "completed" } }),
      notification("item/started", { threadId: "thread-managed-1", turnId, item: { id: "agent-1", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child-1", "child-1"], agentsStates: { "child-1": { status: "running", message: null } } } }),
      notification("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "agent-1", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child-1"], status: "completed", agentsStates: { "child-1": { status: "running", message: null } } } }),
      notification("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "message-1", type: "agentMessage", text: "Built the fixture safely." } }),
      { jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-managed-1", turnId, itemId: "cmd-approval" } },
    ]);
    setTimeout(() => notify("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "agent-wait-1", type: "collabToolCall", tool: "wait", receiverThreadId: "child-1", agentsStates: { "child-1": { status: "completed" } } } }), 150);
    return;
  }
  if (successfulTurns >= 4) {
    const completedAt = Date.now() / 1000;
    return writeBatch([
      rpcResponse(message, { turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/started", { threadId: "thread-managed-1", turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("turn/plan/updated", { threadId: "thread-managed-1", turnId, plan: [{ step: "Persist current progress", status: "inProgress" }] }),
      notification("turn/started", { threadId: "thread-managed-1", turn: { id: turnId, status: "inProgress", startedAt } }),
      notification("item/started", { threadId: "thread-managed-1", turnId, item: { id: "agent-persist", type: "collabToolCall", tool: "resumeAgent", receiverThreadId: "child-persist", agentStatus: "running" } }),
      notification("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "agent-activity", type: "subAgentActivity", kind: "interacted", agentThreadId: "child-persist", agentPath: "reviewer" } }),
      notification("item/completed", { threadId: "thread-managed-1", turnId, item: { id: "persist-recap", type: "agentMessage", text: "Persisted without sk-proj-1234567890abcdefghijklmnop." } }),
      notification("turn/completed", { threadId: "thread-managed-1", turn: { id: turnId, status: "completed", completedAt } }),
    ]);
  }
  response(message, { turn: { id: turnId, status: "inProgress", startedAt } });
  notify("turn/started", { threadId: "thread-managed-1", turn: { id: turnId, status: "inProgress", startedAt } });
  if (successfulTurns === 2) {
    pending.set("question-1", turnId);
    return write({ jsonrpc: "2.0", id: "question-1", method: "item/tool/requestUserInput", params: {
      threadId: "thread-managed-1", turnId, itemId: "question-item", isBlocking: true,
      questions: [{ id: "q1", header: "Mode", question: "Choose a mode", isOther: false, isSecret: false,
        options: [{ label: "safe", description: "Use the safe mode" }, { label: "fast", description: "Use the fast mode" }] }],
    } });
  }
});
`;
fs.writeFileSync(binary, fakeSource, { mode: 0o700 });
process.env.FAKE_CODEX_LOG = logPath;

const plans = new Map<string, PendingPlanInput>();
const statuses: string[] = [];
const registry = new TaskRegistry([]);
const makeController = (targetRegistry: TaskRegistry, filePath = statePath) => new CodexManagedController({
	registry: targetRegistry,
	filePath,
	codexBinary: binary,
	onPlanInput: (input) => plans.set(input.requestId, input),
	onPlanInputCleared: (requestId) => plans.delete(requestId),
	onStatus: (status) => statuses.push(status.status),
});

let controller = makeController(registry);
try {
	const models = await controller.listModels();
	assert.deepEqual(models.map((model) => [model.id, model.defaultEffort, model.supportedEfforts]), [["gpt-test", "high", ["high", "xhigh"]]]);

	const created = await controller.createTask({ prompt: "initial prompt", cwd: workspace, model: "gpt-test", effort: "high" });
	const taskId = created.task.taskId;
	assert.equal(created.task.ownership, "managed");
	assert.equal(created.task.status, "APPROVAL", "A same-batch approval notification remains authoritative over the Turn-start RPC response");
	assert.equal(created.task.capabilities.device.answerChoice, false);
	assert.equal(created.task.capabilities.desktop.send, true);

	await controller.sendMessage(taskId, "follow up one");
	const queued = await controller.sendMessage(taskId, "follow up two");
	assert.equal(queued.queue.length, 2, "Messages sent during an active turn stay FIFO queued");
	await assert.rejects(controller.sendMessage(taskId, "x".repeat(8 * 1024 + 1)), /8 KiB/);

	await waitFor(() => controller.getDetail(taskId)?.requests[0]?.kind === "command-approval", "Managed approval request did not arrive");
	let detail = controller.getDetail(taskId)!;
	assert.equal(detail.task.progress.todoCompleted, 1);
	assert.equal(detail.task.progress.todoTotal, 2);
	assert.equal(detail.task.progress.totalSubagents, 1);
	assert.equal(detail.task.progress.activeSubagents, 1, "A completed spawn tool does not complete its receiver thread");
	assert.equal(detail.task.progress.recap, "Built the fixture safely.");
	assert.equal(detail.task.capabilities.device.answerChoice, false, "Approvals are never exposed as a device action");
	await waitFor(() => controller.getDetail(taskId)?.task.progress.activeSubagents === 0, "Managed agentsStates completion was not applied");
	assert.equal(controller.getDetail(taskId)?.task.progress.totalSubagents, 1, "New and old collab item names share receiver identity without duplication");
	await controller.resolveRequest(taskId, detail.requests[0]!.requestId, { decision: "accept" });

	await waitFor(() => controller.getDetail(taskId)?.requests[0]?.kind === "question", "Managed question did not arrive after FIFO drain");
	detail = controller.getDetail(taskId)!;
	const question = detail.requests[0]!;
	assert.equal(detail.task.capabilities.device.answerChoice, true, "A single multiple-choice question remains answerable from Neo");
	assert.ok(plans.has(question.requestId));
	await controller.answerPlanChoice(taskId, question.requestId, "q1", 0);

	await waitFor(() => controller.getDetail(taskId)?.task.executionId === "turn-3", "Second queued turn did not start in FIFO order");
	assert.equal(controller.getDetail(taskId)?.task.progress.todoTotal, 0, "A genuinely new Turn still clears the previous Turn Todo");
	await controller.updateSettings(taskId, { model: "gpt-test", effort: "xhigh" });
	assert.equal(controller.getDetail(taskId)?.task.reasoningEffort, "xhigh");
	await controller.interrupt(taskId);
	await waitFor(() => controller.getDetail(taskId)?.task.status === "PAUSED", "Interrupted turn did not settle as PAUSED");

	detail = await controller.sendMessage(taskId, "fail once");
	assert.equal(detail.queue[0]?.state, "failed", "Failed FIFO items stay available for retry");
	await controller.retryMessage(taskId, detail.queue[0]!.id);
	await waitFor(() => controller.getDetail(taskId)?.task.status === "DONE_UNREAD" && controller.getDetail(taskId)?.queue.length === 0, "Retried FIFO item did not complete");
	assert.equal(controller.getDetail(taskId)?.task.progress.todoTotal, 1);
	assert.equal(controller.getDetail(taskId)?.task.progress.currentTodo, "Persist current progress", "A duplicate Turn start in the same batch must not clear Todo");
	assert.equal(controller.getDetail(taskId)?.task.progress.activeSubagents, 1);
	assert.equal(controller.getDetail(taskId)?.task.status, "DONE_UNREAD", "An immediate terminal event must not be resurrected as RUNNING by the RPC continuation");
	const completedAt = controller.getDetail(taskId)!.task.lastEventAt;
	const completedActivityAt = controller.getDetail(taskId)!.task.lastExecutionActivityAt;
	await controller.updateSettings(taskId, { model: "gpt-test", effort: "xhigh" });
	assert.equal(controller.getDetail(taskId)!.task.lastEventAt, completedAt, "Settings do not renew a completed turn's reminder");
	assert.equal(controller.getDetail(taskId)!.task.lastExecutionActivityAt, completedActivityAt, "Settings do not manufacture execution activity");
	const privateState = fs.readFileSync(statePath, "utf8");
	assert.equal(JSON.parse(privateState).version, 2);
	assert.ok(JSON.parse(privateState).sessions[0].progressEvents.length > 0, "Current-turn progress is persisted for restart recovery");
	assert.ok(!privateState.includes("sk-proj-1234567890abcdefghijklmnop"), "Persisted progress is redacted before it reaches private state");

	const lateResponse = controller.sendMessage(taskId, "late response");
	await waitFor(() => fs.readFileSync(logPath, "utf8").includes("late response"), "The delayed Turn start request was not received");
	const newerResponse = controller.sendMessage(taskId, "newer response");
	await Promise.all([lateResponse, newerResponse]);
	await waitFor(() => controller.getDetail(taskId)?.task.executionId === "turn-6" && controller.getDetail(taskId)?.queue.length === 0, "A newer overlapping Turn did not remain authoritative");
	assert.equal(controller.getDetail(taskId)?.task.status, "RUNNING");
	assert.equal(controller.getDetail(taskId)?.task.progress.todoTotal, 1);
	assert.equal(controller.getDetail(taskId)?.task.progress.currentTodo, "Keep newer progress", "A delayed older RPC response must not replace the newer Turn Todo");
	assert.equal(controller.getDetail(taskId)?.task.progress.activeSubagents, 1);

	await controller.stop();
	const restoredRegistry = new TaskRegistry(registry.getTasks());
	controller = makeController(restoredRegistry);
	await controller.restoreIfNeeded();
	await waitFor(() => controller.getDetail(taskId)?.task.executionId === "turn-6", "Registered thread was not rebuilt with thread/read(includeTurns:true)");
	assert.equal(controller.getDetail(taskId)?.task.progress.todoTotal, 1, "A matching current-turn Todo snapshot survives app restart");
	assert.equal(controller.getDetail(taskId)?.task.progress.currentTodo, "Keep newer progress");
	assert.equal(controller.getDetail(taskId)?.task.progress.activeSubagents, 1, "A matching current-turn agent snapshot survives app restart");
	await assert.rejects(controller.steer(taskId, "CRASH"), /exited|stopped|offline/i);
	await waitFor(() => controller.getStatus().status === "DEGRADED", "App-server crash did not degrade the managed supervisor");
	assert.equal(controller.getDetail(taskId)?.task.status, "ERROR");

	const legacyStatePath = path.join(temporary, "managed-codex-v1.json");
	fs.writeFileSync(legacyStatePath, `${JSON.stringify({ version: 1, sessions: [{
		threadId: "thread-managed-1", cwd: workspace, createdAt: Date.now(), activeTurnId: "turn-6", queue: [],
	}] })}\n`, { mode: 0o600 });
	const legacyController = makeController(new TaskRegistry([]), legacyStatePath);
	await legacyController.restoreIfNeeded();
	assert.equal(legacyController.getDetail(taskId)?.task.executionId, "turn-6", "Version-1 managed state remains restorable");
	await legacyController.stop();

	const log = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const methods = log.map((entry) => entry.method).filter(Boolean);
	assert.ok(methods.indexOf("initialize") < methods.indexOf("initialized"), "initialize must precede initialized");
	assert.ok(methods.includes("thread/read") && log.some((entry) => entry.method === "thread/read" && entry.params?.includeTurns === true));
	assert.ok(methods.includes("thread/settings/update"));
	assert.ok(methods.includes("turn/interrupt"));
	const prompts = log.filter((entry) => entry.method === "turn/start").map((entry) => entry.params.input[0].text);
	assert.deepEqual(prompts.slice(0, 3), ["initial prompt", "follow up one", "follow up two"], "Active-turn messages drain in strict FIFO order");
	assert.deepEqual(prompts.slice(-2), ["late response", "newer response"], "Overlapping Turn starts retain request order while the newest response remains authoritative");
	assert.ok(log.some((entry) => entry.id === "approval-1" && entry.result?.decision === "accept"));
	assert.ok(log.some((entry) => entry.id === "question-1" && entry.result?.answers?.q1?.answers?.[0] === "safe"));
	assert.equal(fs.statSync(statePath).mode & 0o077, 0, "Managed thread registry must remain private");
	console.log("[managed-app-server] stdio handshake, models, process replay, FIFO/retry, exact requests, settings, interrupt, restore and crash recovery: ok");
} finally {
	await controller.stop().catch(() => undefined);
	fs.rmSync(temporary, { recursive: true, force: true });
}
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(10);
	}
	throw new Error(message);
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
