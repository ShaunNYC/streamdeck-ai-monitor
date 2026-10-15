import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskExecutionKey, type SystemStatus, type Task } from "@streamdeck-supervisor/shared";
import { parseClaudeHookEvent } from "../packages/daemon/src/adapters/claude-events.js";
import { ClaudeExecutionTracker } from "../packages/daemon/src/adapters/claude-hook-adapter.js";
import { ClaudeTranscriptWatcher, parseClaudeTranscript, readClaudeDesktopSessions } from "../packages/daemon/src/adapters/claude-transcript.js";
import { MonitorStore } from "../packages/daemon/src/monitor-store.js";
import { TaskRegistry } from "../packages/daemon/src/task-registry.js";
import { DeviceState } from "../packages/device/src/state.js";
import { buildMainTileModels } from "../packages/device/src/device-controller.js";

async function main(): Promise<void> {
	const now = Date.now();
	const start = now - 65_000;
	const sessionId = "claude-monitoring";
	const file = `/tmp/${sessionId}.jsonl`;
	const cwd = process.cwd();
	const row = (at: number, type: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		...extra, type, timestamp: new Date(at).toISOString(), sessionId, cwd, message,
	});
	const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
	const result = (id: string, content: unknown, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
	const records = [
		row(start, "user", { content: "Build and check" }),
		row(start + 1_000, "assistant", { model: "claude-opus-5-5", stop_reason: "tool_use", content: [
			call("create-a", "TaskCreate", { subject: "Build" }), call("create-b", "TaskCreate", { subject: "Check" }),
		] }, { effort: "high" }),
		row(start + 2_000, "user", { content: [result("create-a", "Created")] }, { toolUseResult: { task: { id: "1", subject: "Build" } } }),
		row(start + 2_100, "user", { content: [result("create-b", [{ type: "text", text: "Task #2 created successfully: Check" }])] }),
		row(start + 3_000, "assistant", { stop_reason: "tool_use", content: [call("complete-a", "TaskUpdate", { taskId: "1", status: "completed" })] }),
		row(start + 3_100, "user", { content: [result("complete-a", "Updated task #1 status")] }),
		row(start + 4_000, "assistant", { stop_reason: "tool_use", content: [call("active-b", "TaskUpdate", { taskId: "2", status: "in_progress" })] }),
		row(start + 4_100, "user", { content: [result("active-b", "Updated task #2 status")] }),
	];
	const parse = (rows: unknown[] = records, at = now) => parseClaudeTranscript(rows, file, at)!;
	const planned = parse();
	assert.equal(planned.progress.todoTotal, 2, "Created task IDs must match subsequent TaskUpdate IDs without duplicating steps");
	assert.equal(planned.progress.todoCompleted, 1);
	assert.equal(planned.progress.currentTodo, "Check");
	assert.equal(planned.progress.durationMs, 65_000, "Replay uses its supplied clock instead of the process wall clock");
	assert.equal(planned.lastEventAt, start + 4_100, "Tool results are execution activity even during quiet model work");

	const failedUpdate = [
		...records,
		row(start + 5_000, "assistant", { stop_reason: "tool_use", content: [call("fail-b", "TaskUpdate", { taskId: "2", status: "completed" })] }),
		row(start + 5_100, "user", { content: [result("fail-b", "Failed to update", true)] }),
	];
	assert.equal(parse(failedUpdate).progress.todoCompleted, 1, "A failed update cannot inflate structured progress");
	const deleted = [
		...records,
		row(start + 5_000, "assistant", { stop_reason: "tool_use", content: [call("delete-b", "TaskUpdate", { taskId: "2", status: "deleted" })] }),
		row(start + 5_100, "user", { content: [result("delete-b", "Deleted task #2")] }),
	];
	assert.equal(parse(deleted).progress.todoTotal, 1, "Deleted plan steps must leave the denominator");
	assert.equal(parse(deleted).progress.currentTodo, undefined);
	const failedCreate = [
		...records,
		row(start + 5_000, "assistant", { stop_reason: "tool_use", content: [call("create-failed", "TaskCreate", { subject: "Never created" })] }),
		row(start + 5_100, "user", { content: [result("create-failed", "Creation failed", true)] }),
	];
	assert.equal(parse(failedCreate).progress.todoTotal, 2);

	const streaming = parse([...records, row(start + 6_000, "assistant", { stop_reason: null, content: [{ type: "thinking", thinking: "working" }] })]);
	assert.equal(streaming.status, "RUNNING", "A partial streaming message must not terminate the clock");
	assert.equal(streaming.progress.durationMs, 65_000);
	const metadata = parse([...records, row(start + 6_000, "user", { content: "Injected context" }, { isMeta: true })]);
	assert.equal(metadata.progress.turnStartedAt, start, "Injected context is not a new user execution");
	assert.equal(metadata.progress.todoTotal, 2);
	const nextPrompt = row(now, "user", { content: "Use another model for a new task" });
	const nextTurn = parse([...records, nextPrompt], now + 1_000);
	assert.equal(nextTurn.progress.todoTotal, 0);
	assert.equal(nextTurn.progress.currentTodo, undefined);
	assert.equal(nextTurn.model, undefined, "An unanswered new prompt must not claim the previous turn's model");
	assert.equal(nextTurn.reasoningEffort, undefined);
	const imageTurn = parse([...records, row(now, "user", { content: [{ type: "image" }] })], now + 1_000);
	assert.equal(imageTurn.progress.turnStartedAt, now, "An image-only prompt starts a real new execution");
	assert.equal(imageTurn.model, undefined);
	assert.equal(imageTurn.progress.todoTotal, 0);
	assert.equal(parseClaudeTranscript([{ type: "custom-title", sessionId, cwd, customTitle: "Opened conversation" }], file, now), null,
		"Title/mode metadata alone cannot manufacture a completion or execution clock");

	function hook(event: string, at: number, executionId = "hook-turn-1"): Task {
		const parsed = parseClaudeHookEvent({ session_id: sessionId, cwd, hook_event_name: event, tool_name: "Bash" })!;
		return {
			...parsed.task, executionId, startedAt: at, lastEventAt: at, lastExecutionActivityAt: at,
			progress: { ...parsed.task.progress, ...(event === "UserPromptSubmit" ? { turnStartedAt: at } : {}) },
		};
	}
	const registry = new TaskRegistry([]);
	registry.upsertTask(hook("UserPromptSubmit", start + 200));
	registry.upsertTask(planned);
	assert.equal(taskExecutionKey(registry.getTasks()[0]!), "hook-turn-1", "Hook/transcript starts within transport delay share one execution");
	registry.upsertTask(planned);
	assert.equal(taskExecutionKey(registry.getTasks()[0]!), "hook-turn-1", "Repeated transcript polls must not reset the execution clock");
	registry.upsertTask(hook("PostToolUse", now));
	assert.equal(registry.getTasks()[0]!.progress.todoTotal, 2, "A partial Hook must not zero the existing plan");
	assert.equal(registry.getTasks()[0]!.model, "claude-opus-5-5");
	const monitor = new MonitorStore();
	const healthy = { codex: true, claude: true };
	monitor.update(registry.getTasks(), healthy, now);
	registry.upsertTask(hook("PostToolUseFailure", now + 1_000));
	assert.equal(registry.getTasks()[0]!.status, "RUNNING", "A recoverable tool failure is not a failed Claude turn");
	assert.equal(registry.getTasks()[0]!.progress.latestActivity?.state, "error");
	monitor.update(registry.getTasks(), healthy, now + 1_000);
	registry.upsertTask(hook("Stop", now + 2_000));
	const stopped = registry.getTasks()[0]!;
	assert.equal(stopped.progress.todoCompleted, 1);
	assert.equal(stopped.progress.durationMs, 67_000);
	const delayed = { ...planned, lastEventAt: now + 1_500, lastExecutionActivityAt: now + 1_500 };
	registry.upsertTask(delayed);
	assert.equal(registry.getTasks()[0]!.status, "DONE_UNREAD", "A delayed running poll cannot undo a newer Stop Hook within two seconds");
	assert.equal(monitor.update(registry.getTasks(), healthy, now + 2_000).slots.claude[0]!.durationMs, 2_000);
	assert.equal(monitor.update(registry.getTasks(), healthy, now + 3_000).slots.claude[0]!.durationMs, 2_000, "Completed turns stop accruing usage");
	registry.upsertTask(hook("UserPromptSubmit", now + 4_000, "hook-turn-2"));
	const restarted = registry.getTasks()[0]!;
	assert.equal(restarted.progress.todoTotal, 0);
	assert.equal(restarted.progress.currentTodo, undefined);
	assert.equal(restarted.model, undefined);
	assert.equal(restarted.reasoningEffort, undefined);
	assert.equal(monitor.update(registry.getTasks(), healthy, now + 4_000).slots.claude[0]!.durationMs, 0);
	const state = new DeviceState();
	const status: SystemStatus = {
		daemonUptimeMs: 0, daemonPid: 1, configuredProjectCount: 0, runningTaskCount: 1,
		adapters: { codex: { status: "OK", lastPollAt: now }, claude: { status: "OK", lastPollAt: now }, workflow: { status: "OK", lastPollAt: now } },
		reasoningDefaults: { claude: "high" },
	};
	state.setSnapshot([restarted], registry.getFocus(), status);
	assert.equal(state.getReasoningEffort("claude"), undefined, "Unknown current effort must not be replaced with a global default");
	assert.equal(buildMainTileModels(state)[3]!.detail, "MODEL —");
	const recoveredTracker = new ClaudeExecutionTracker();
	const observedHook = parseClaudeHookEvent({ session_id: sessionId, hook_event_name: "PostToolUse", cwd })!;
	assert.equal(recoveredTracker.assign(observedHook, now, planned), taskExecutionKey(planned), "The first Hook after restart must adopt an already observed execution clock");
	assert.equal(new ClaudeExecutionTracker().assign(observedHook, now, { ...planned, status: "NEEDS_INPUT" }), taskExecutionKey(planned),
		"Resuming after an input wait and daemon restart preserves the same execution duration");
	const failedTurn = parseClaudeHookEvent({ session_id: sessionId, hook_event_name: "StopFailure", cwd })!;
	assert.equal(failedTurn.task.status, "ERROR");
	assert.equal(failedTurn.terminal, true, "An API failure is a terminal turn, unlike a recoverable tool failure");

	const userText = (at: number, text: string) => row(at, "user", { content: [{ type: "text", text }] });
	const finished = [...records, row(start + 5_000, "assistant", { stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] })];
	for (const command of [
		"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
		"<local-command-stdout>Set model to Sonnet</local-command-stdout>",
		"<bash-input>ls</bash-input>",
	]) {
		const afterCommand = parse([...finished, row(start + 9_000, "user", { content: command })]);
		assert.equal(afterCommand.status, "DONE_UNREAD", "Local CLI command rows are not prompts and cannot restart the turn");
		assert.equal(afterCommand.progress.turnStartedAt, start);
		assert.equal(afterCommand.model, "claude-opus-5-5");
	}
	const interrupted = parse([...records,
		row(start + 4_500, "user", { content: [result("active-b", "The user doesn't want to proceed", true)] }),
		userText(start + 4_500, "[Request interrupted by user for tool use]")]);
	assert.equal(interrupted.status, "PAUSED", "Esc ends the Claude turn instead of starting a new running one");
	assert.equal(interrupted.progress.turnStartedAt, start);
	assert.equal(interrupted.progress.durationMs, 4_500, "An interrupted turn stops its clock at the interrupt");
	assert.equal(parse([...finished, userText(start + 9_000, "[Request interrupted by user]")]).status, "DONE_UNREAD",
		"A stray interrupt marker cannot reopen a completed turn");
	const pausedRegistry = new TaskRegistry([]);
	pausedRegistry.upsertTask({ ...planned, executionId: "hook-paused" });
	pausedRegistry.pauseExecution(planned.taskId, "hook-paused", start + 4_500);
	pausedRegistry.upsertTask(interrupted);
	assert.equal(pausedRegistry.getTasks()[0]!.status, "PAUSED", "Late rows from the paused turn cannot relight it");
	pausedRegistry.upsertTask(parse([...records, userText(start + 4_500, "[Request interrupted by user]"),
		row(now - 1_000, "user", { content: "Continue" }), row(now - 500, "assistant", { stop_reason: "tool_use", content: [call("next", "Bash", {})] })]));
	assert.equal(pausedRegistry.getTasks()[0]!.status, "RUNNING", "A prompt after the pause is a new execution even before its Hook arrives");
	assert.equal(pausedRegistry.getTasks()[0]!.progress.turnStartedAt, now - 1_000);

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitoring-"));
	const transcriptRoot = path.join(temporary, "projects");
	const projectRoot = path.join(transcriptRoot, "project");
	const desktopRoot = path.join(temporary, "desktop", "account", "workspace");
	fs.mkdirSync(projectRoot, { recursive: true });
	fs.mkdirSync(desktopRoot, { recursive: true });
	const transcriptFile = path.join(projectRoot, `${sessionId}.jsonl`);
	const desktopFile = path.join(desktopRoot, "local_current.json");
	const published: Task[] = [];
	const errors: Error[] = [];
	const watcher = new ClaudeTranscriptWatcher(transcriptRoot, task => published.push(task), error => errors.push(error), path.join(temporary, "desktop"));
	const poll = () => (watcher as unknown as { poll(): Promise<void> }).poll();
	try {
		fs.writeFileSync(transcriptFile, JSON.stringify(nextPrompt) + "\n");
		fs.writeFileSync(desktopFile, JSON.stringify({ cliSessionId: sessionId, model: "claude-sonnet-5", effort: "medium", lastActivityAt: now }));
		fs.writeFileSync(path.join(desktopRoot, "local_stale.json"), JSON.stringify({ cliSessionId: sessionId, model: "claude-opus-5", effort: "low", lastActivityAt: now - 10_000, lastFocusedAt: now + 1_000 }));
		assert.equal((await readClaudeDesktopSessions(path.join(temporary, "desktop"))).get(sessionId)?.model, "claude-sonnet-5", "Opening an older Desktop record cannot replace current execution settings");
		await poll();
		assert.equal(published.at(-1)!.model, "claude-sonnet-5", "Desktop settings fill in a model before its first assistant response");
		assert.equal(published.at(-1)!.reasoningEffort, "medium");
		fs.writeFileSync(desktopFile, JSON.stringify({ cliSessionId: sessionId, model: "claude-haiku-5", lastActivityAt: now + 2_000 }));
		await poll();
		assert.equal(published.at(-1)!.model, "claude-haiku-5");
		assert.equal(published.at(-1)!.reasoningEffort, undefined, "Removing an explicit effort must not preserve its stale value");
		const observedRegistry = new TaskRegistry([]);
		observedRegistry.upsertTask(published[0]!);
		observedRegistry.upsertTask(published.at(-1)!);
		assert.equal(observedRegistry.getTasks()[0]!.reasoningEffort, undefined);
		fs.appendFileSync(transcriptFile, JSON.stringify(row(now + 1_000, "assistant", { model: "claude-opus-5-5", stop_reason: "tool_use", content: [call("shell", "Bash", { command: "true" })] })) + "\n");
		await poll();
		assert.equal(published.at(-1)!.model, "claude-opus-5-5", "The model actually producing the response takes precedence over Desktop selection");
		assert.deepEqual(errors, []);
	} finally {
		watcher.stop();
		fs.rmSync(temporary, { recursive: true, force: true });
	}

	console.log("[claude-monitoring] real plan IDs, confirmed updates, streaming clocks, turn isolation, Hook reconciliation, interrupts, local commands and current model/effort: ok");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
