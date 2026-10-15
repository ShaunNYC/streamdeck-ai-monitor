import assert from "node:assert/strict";
import { emptyTaskProgress, taskCapabilities, type AgentKind, type Task } from "@streamdeck-supervisor/shared";
import { AuditLogger } from "../packages/daemon/src/audit-log.js";
import { MacCodexApprovalControl } from "../packages/daemon/src/codex-approval-control.js";
import { ClaudeExecutionTracker } from "../packages/daemon/src/adapters/claude-hook-adapter.js";
import { parseClaudeHookEvent } from "../packages/daemon/src/adapters/claude-events.js";
import { TaskActionService } from "../packages/daemon/src/task-action-service.js";
import { TaskRegistry } from "../packages/daemon/src/task-registry.js";

function task(agent: AgentKind, externalId: string, lastEventAt: number): Task {
	return {
		taskId: `${agent}:${externalId}`,
		agent,
		ownership: "observer",
		externalId,
		projectId: "project",
		projectLabel: "PROJECT",
		titleShort: "Current conversation",
		status: "RUNNING",
		attentionCount: 0,
		capabilities: taskCapabilities({ review: true, verify: true }),
		progress: emptyTaskProgress(),
		openRef: { kind: "url", value: agent === "codex" ? `codex://threads/${externalId}` : `claude://resume?session=${externalId}` },
		source: "mock",
		lastEventAt,
		startedAt: lastEventAt,
	};
}

async function main(): Promise<void> {
const selectedId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const newerId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const now = Date.now();
const selected = task("codex", selectedId, now - 1);
const newer = task("codex", newerId, now);
const registry = new TaskRegistry([selected, newer], {
	selectedTaskId: { codex: selected.taskId, claude: null },
	activeAgent: "claude",
	newChatAgent: "codex",
});
const commands: Array<{ command: string; args: string[] }> = [];
const service = new TaskActionService(registry, new AuditLogger(), async (command, args) => { commands.push({ command, args }); });

await service.openAgent("codex");
assert.equal(registry.getFocus().activeAgent, "codex");
assert.equal(registry.getFocus().newChatAgent, "codex");
assert.equal(registry.getFocus().selectedTaskId.codex, selected.taskId, "Logo open preserves the explicitly selected conversation");
assert.deepEqual(commands.at(-1), {
	command: "/usr/bin/open",
	args: ["-b", "com.openai.codex", `codex://threads/${selectedId}`],
});

await service.activateAgentApp("codex");
await service.activateAgentApp("claude");
assert.deepEqual(commands.slice(-2), [
	{ command: "/usr/bin/open", args: ["-b", "com.openai.codex"] },
	{ command: "/usr/bin/open", args: ["-b", "com.anthropic.claudefordesktop"] },
]);

await service.newChat("codex");
await service.newChat("claude");
assert.deepEqual(commands.slice(-2), [{
	command: "/usr/bin/open",
	args: ["-b", "com.openai.codex", "codex://threads/new"],
}, {
	command: "/usr/bin/open",
	args: ["-b", "com.anthropic.claudefordesktop", "claude://claude.ai/new"],
}]);
await service.newCodexChat();
assert.ok(!commands.at(-1)?.args.some((argument) => argument.includes("path=")), "New chat must not bind a workspace path");

const emptyCommands: Array<{ command: string; args: string[] }> = [];
const emptyRegistry = new TaskRegistry([]);
const emptyService = new TaskActionService(emptyRegistry, new AuditLogger(), async (command, args) => { emptyCommands.push({ command, args }); });
await emptyService.openAgent("claude");
assert.deepEqual(emptyCommands, [{ command: "/usr/bin/open", args: ["-b", "com.anthropic.claudefordesktop"] }], "Logo opens the app when no task exists");
assert.equal(emptyRegistry.getFocus().newChatAgent, "claude", "A successful idle Logo open changes the persistent New Chat target");

const failingRegistry = new TaskRegistry([]);
const failingService = new TaskActionService(failingRegistry, new AuditLogger(), async () => { throw new Error("app missing"); });
await assert.rejects(() => failingService.openAgent("claude"), /app missing/);
assert.equal(failingRegistry.getFocus().newChatAgent, "codex", "A failed Logo open cannot retarget New Chat");

const codexStop = task("codex", "cccccccc-cccc-cccc-cccc-cccccccccccc", now + 1);
codexStop.executionId = "turn-codex-1";
codexStop.capabilities.desktop.interrupt = true;
const codexStopRegistry = new TaskRegistry([codexStop], {
	selectedTaskId: { codex: codexStop.taskId, claude: null },
	activeAgent: "codex",
	newChatAgent: "codex",
});
const codexInterrupts: Array<[string, string]> = [];
const codexStopService = new TaskActionService(codexStopRegistry, new AuditLogger(), undefined, {
	interruptCodex: async (threadId, turnId) => { codexInterrupts.push([threadId, turnId]); },
});
assert.equal(await codexStopService.stop(codexStop, "stale-turn"), false, "A stale Codex turn is rejected before control I/O");
assert.deepEqual(codexInterrupts, []);
assert.equal(await codexStopService.stop(codexStop, codexStop.executionId), true);
assert.deepEqual(codexInterrupts, [[codexStop.externalId, "turn-codex-1"]]);
assert.equal(codexStopRegistry.getTask(codexStop.taskId)?.status, "PAUSED");
assert.equal(codexStopRegistry.getTask(codexStop.taskId)?.capabilities.desktop.interrupt, false);

const claudeStop = task("claude", "same-pid-session", now + 2);
claudeStop.executionId = "claude:prompt-1";
claudeStop.processId = 4242;
claudeStop.capabilities.desktop.interrupt = true;
const claudeStopRegistry = new TaskRegistry([claudeStop]);
let signalledPid: number | undefined;
const wrongPidService = new TaskActionService(claudeStopRegistry, new AuditLogger(), undefined, {
	isClaudeProcess: () => false,
	interruptClaude: (pid) => { signalledPid = pid; },
});
assert.equal(await wrongPidService.stop(claudeStop, claudeStop.executionId), false, "A non-Claude PID is rejected immediately before SIGINT");
assert.equal(signalledPid, undefined);
assert.equal(claudeStopRegistry.getTask(claudeStop.taskId)?.status, "RUNNING");

claudeStopRegistry.upsertTask({ ...claudeStop, executionId: "claude:prompt-2", lastEventAt: now + 3 });
const claudeStopService = new TaskActionService(claudeStopRegistry, new AuditLogger(), undefined, {
	isClaudeProcess: (pid) => pid === 4242,
	interruptClaude: (pid) => { signalledPid = pid; },
});
assert.equal(await claudeStopService.stop(claudeStop, "claude:prompt-1"), false, "A reused PID cannot make the previous prompt stoppable");
assert.equal(await claudeStopService.stop(claudeStopRegistry.getTask(claudeStop.taskId)!, "claude:prompt-2"), true);
assert.equal(signalledPid, 4242);
assert.equal(claudeStopRegistry.getTask(claudeStop.taskId)?.status, "PAUSED");

const tracker = new ClaudeExecutionTracker();
const promptOne = parseClaudeHookEvent({ session_id: "same-session", hook_event_name: "UserPromptSubmit", process_id: 4242 })!;
const toolOne = parseClaudeHookEvent({ session_id: "same-session", hook_event_name: "PreToolUse", process_id: 4242 })!;
const promptTwo = parseClaudeHookEvent({ session_id: "same-session", hook_event_name: "UserPromptSubmit", process_id: 4242 })!;
const promptOneId = tracker.assign(promptOne, 1_000)!;
assert.equal(tracker.assign(toolOne, 1_001), promptOneId, "Lifecycle events within one Claude prompt share an execution identity");
const promptTwoId = tracker.assign(promptTwo, 1_002)!;
assert.notEqual(promptTwoId, promptOneId, "A new Claude prompt gets a new execution identity even when the CLI PID is reused");

const approvalTask: Task = {
	...selected,
	titleShort: 'Malicious text $(touch /tmp/never) `open /tmp/never`',
	status: "APPROVAL",
	request: {
		requestId: "codex:approval",
		type: "permission",
		target: 'npm test; osascript -e "display dialog"',
		riskTier: 1,
		createdAt: now,
		expiresAt: now + 30_000,
		decisionPath: "codex-shortcut",
	},
	capabilities: { ...selected.capabilities, desktop: { ...selected.capabilities.desktop, approve: true, reject: true } },
};
const nativeCalls: string[] = [];
const approvalControl = new MacCodexApprovalControl({
	getStatus: () => ({ status: "READY", lastCheckedAt: Date.now() }),
	bridge: {
		activateThread: (url) => { nativeCalls.push(`activate:${url}`); return true; },
		frontmostBundleId: () => "com.openai.codex",
		postDecision: (decision) => { nativeCalls.push(`post:${decision}`); return true; },
	},
	delay: async () => undefined,
});
await approvalControl.submit(approvalTask, "approve", () => true);
assert.deepEqual(nativeCalls, [`activate:codex://threads/${selectedId}`, "post:approve"]);
assert.ok(!JSON.stringify(nativeCalls).includes("Malicious text") && !JSON.stringify(nativeCalls).includes("npm test;"), "Task text never reaches native input control");

nativeCalls.length = 0;
await approvalControl.submit(approvalTask, "reject", () => true);
assert.deepEqual(nativeCalls.at(-1), "post:reject", "Codex REJECT uses the fixed native Escape decision");

nativeCalls.length = 0;
await assert.rejects(() => approvalControl.submit(approvalTask, "approve", () => false), /no longer active/);
assert.equal(nativeCalls.length, 0, "A stale Codex request cannot open the app or send a shortcut");

let wrongBundlePosted = false;
const wrongBundleControl = new MacCodexApprovalControl({
	getStatus: () => ({ status: "READY", lastCheckedAt: Date.now() }),
	bridge: {
		activateThread: () => true,
		frontmostBundleId: () => "com.apple.Terminal",
		postDecision: () => { wrongBundlePosted = true; return true; },
	},
	delay: async () => undefined,
	frontmostTimeoutMs: 0,
});
await assert.rejects(() => wrongBundleControl.submit(approvalTask, "approve", () => true), /frontmost/);
assert.equal(wrongBundlePosted, false, "No Return is sent to the wrong foreground app");

let statusChecks = 0;
let revokedPosted = false;
const revokedControl = new MacCodexApprovalControl({
	getStatus: () => ({ status: statusChecks++ === 0 ? "READY" : "PERMISSION_REQUIRED", lastCheckedAt: Date.now() }),
	bridge: {
		activateThread: () => true,
		frontmostBundleId: () => "com.openai.codex",
		postDecision: () => { revokedPosted = true; return true; },
	},
	delay: async () => undefined,
});
await assert.rejects(() => revokedControl.submit(approvalTask, "approve", () => true), /permission/);
assert.equal(revokedPosted, false, "PostEvent permission is rechecked immediately before Return/Escape");

console.log("[action-service-regression] dual New Chat, transactional Logo focus, execution-bound Stop and guarded Codex decisions: ok");
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
