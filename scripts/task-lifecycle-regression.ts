import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, taskExecutionKey, type AgentKind, type Task, type TaskStatus } from "@streamdeck-supervisor/shared";
import { TaskRegistry, TERMINAL_REMINDER_MS, RUNNING_STALE_MS } from "../packages/daemon/src/task-registry.js";
import { RegistryStore } from "../packages/daemon/src/registry-store.js";
import { MonitorStore } from "../packages/daemon/src/monitor-store.js";
import { RolloutReader } from "../packages/daemon/src/adapters/codex-catalog-adapter.js";
import { parseClaudeTranscript } from "../packages/daemon/src/adapters/claude-transcript.js";
import { IpcServer } from "../packages/daemon/src/ipc-server.js";
import { DaemonClient } from "../packages/device/src/daemon-client.js";
import { deviceState } from "../packages/device/src/state.js";
import { DeviceController, buildTouchPointColors, nextContentPage } from "../packages/device/src/device-controller.js";
import { daemonClient } from "../packages/device/src/daemon-client.js";

const now = Date.now();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "task-lifecycle-"));
const healthy = { codex: true, claude: true };
function task(id: string, agent: AgentKind, status: TaskStatus, overrides: Partial<Task> = {}): Task {
	return {
		taskId: `${agent}:${id}`, externalId: id, agent, status, ownership: "observer", executionId: "turn-1",
		projectId: temporary, projectLabel: "TEST", cwd: temporary, titleShort: id,
		attentionCount: status === "ERROR" || status === "DONE_UNREAD" ? 1 : 0,
		progress: { ...emptyTaskProgress(), turnStartedAt: now - 1_000 }, capabilities: taskCapabilities(),
		openRef: { kind: "url", value: `${agent}://test` }, source: agent === "codex" ? "catalog-sqlite" : "transcript-tail",
		lastEventAt: now, lastExecutionActivityAt: now, lastObservedAt: now, startedAt: now - 1_000,
		...overrides,
	};
}
function restored(registry: TaskRegistry): TaskRegistry {
	const store = new RegistryStore(path.join(temporary, "state.json"));
	store.flush({ version: 8, ...registry.getPersistedState(), savedAt: now });
	const state = store.load()!;
	assert.equal(state.version, 8);
	return new TaskRegistry(state.tasks, state.focus, state.terminalAcknowledgements, state.observationBaselineAt, state.clearedExecutions);
}

async function main(): Promise<void> {
try {
	for (const agent of ["codex", "claude"] as const) {
		const stopped = ["DONE", "DONE_UNREAD", "ERROR", "PAUSED", "STALE", "IDLE"].map(status => task(status, agent, status as TaskStatus));
		const live = ["RUNNING", "QUEUED", "APPROVAL", "NEEDS_INPUT"].map(status => task(status, agent, status as TaskStatus));
		const opposite = task("opposite", agent === "codex" ? "claude" : "codex", "ERROR");
		const registry = new TaskRegistry([...stopped, ...live, opposite]);
		const navigationMonitor = new MonitorStore();
		// Allocate slots while live; overflow and never-slotted terminal tasks still clear.
		navigationMonitor.update([...stopped.map(t => ({ ...t, status: "RUNNING" as const })), ...live, opposite], healthy, now);
		const focus = registry.getFocus();
		const status = {
			daemonUptimeMs: 0, daemonPid: 1, configuredProjectCount: 1, runningTaskCount: 1,
			adapters: { codex: { status: "OK" as const, lastPollAt: now }, claude: { status: "OK" as const, lastPollAt: now }, workflow: { status: "OK" as const, lastPollAt: now } },
			monitor: navigationMonitor.update([...stopped, ...live, opposite], healthy, now),
		};
		const overflow = task("never-slotted", agent, "ERROR");
		registry.upsertTask(overflow);
		deviceState.setSnapshot(registry.getTasks(), focus, status);
		const navigation = new DeviceController() as unknown as {
			page: number; movePage(direction: -1 | 1): void; clearPhysicalPress(): void; clearFeedback(): void;
		};
		const send = daemonClient.sendDismissCompleted;
		let requested: Array<{ taskId: string; executionId: string }> = [];
		daemonClient.sendDismissCompleted = async request => { requested = request.executions; return true; };
		try {
			navigation.page = agent === "codex" ? -1 : 1;
			navigation.movePage(agent === "codex" ? 1 : -1);
			assert.equal(navigation.page, 0);
			assert.deepEqual(requested.map(t => t.taskId).sort(), [...stopped, overflow].map(t => t.taskId).sort(), "Navigation includes every stopped status and unslotted tasks");
		} finally { daemonClient.sendDismissCompleted = send; navigation.clearPhysicalPress(); navigation.clearFeedback(); }
		assert.equal(registry.dismissExecutions(agent, [{ taskId: overflow.taskId, executionId: taskExecutionKey(overflow) }]), 1);
		registry.selectTask(agent, stopped[2]!.taskId);
		assert.equal(registry.dismissExecutions(agent, [...stopped, ...live, opposite].map(t => ({ taskId: t.taskId, executionId: taskExecutionKey(t) }))), stopped.length);
		assert.deepEqual(registry.getTasksForAgent(agent).map(t => t.taskId).sort(), live.map(t => t.taskId).sort());
		assert.ok(registry.getTask(opposite.taskId), "The other Agent is untouched");
		assert.notEqual(registry.getFocus().selectedTaskId[agent], stopped[2]!.taskId, "Cleared focus is retired");
		const emptyMonitor = navigationMonitor.update([], healthy, now + 1_000);
		deviceState.setSnapshot([], registry.getFocus(), { ...status, monitor: emptyMonitor, runningTaskCount: 0 });
		assert.equal(nextContentPage(deviceState, 0, agent === "codex" ? -1 : 1), undefined, "An empty side is unreachable");
		assert.deepEqual(buildTouchPointColors(deviceState, 0)[agent], [0, 0, 0], "Touch lights use the same navigation boundary");
		const restart = restored(registry);
		for (const t of stopped) {
			restart.upsertTask({ ...t, titleShort: "Opened old chat", lastObservedAt: now + 60_000 });
			assert.equal(restart.getTask(t.taskId), undefined, "Old execution never returns after restart or metadata changes");
		}
		const next = { ...stopped[2]!, status: "RUNNING" as const, executionId: "turn-2", lastEventAt: now + 1_000, lastExecutionActivityAt: now + 1_000,
			progress: { ...stopped[2]!.progress, turnStartedAt: now + 1_000 } };
		restart.upsertTask(next);
		assert.equal(restart.getTask(next.taskId)?.executionId, "turn-2");
		restart.upsertTask(stopped[2]!);
		assert.equal(restart.getTask(next.taskId)?.executionId, "turn-2", "A delayed old turn cannot replace the new turn");
		assert.equal(restart.dismissExecutions(agent, [{ taskId: next.taskId, executionId: "turn-1" }]), 0, "Navigation races cannot clear a newer execution");

		const oldError = task("expired", agent, "ERROR", { lastEventAt: now - TERMINAL_REMINDER_MS - 60_000, attentionExpiresAt: now - 60_000 });
		const cold = new TaskRegistry([oldError]);
		assert.equal(cold.getTask(oldError.taskId), undefined);
		cold.upsertTask(oldError);
		assert.equal(cold.getTask(oldError.taskId), undefined, "Cold-start expired errors stay removed");
		const fresh = task("delayed-sweep", agent, "ERROR", { attentionExpiresAt: now + TERMINAL_REMINDER_MS });
		const expiry = new TaskRegistry([fresh]);
		expiry.sweep(now + TERMINAL_REMINDER_MS + 60_000);
		assert.equal(expiry.getTask(fresh.taskId), undefined, "Missing the exact expiration millisecond still clears an error");
		assert.equal(expiry.getPersistedState().terminalAcknowledgements[fresh.taskId], now);
	}

	// No execution ID in transcript mode: the real prompt timestamp identifies a new turn.
	const transcriptTask = task("no-id", "claude", "ERROR", { executionId: undefined });
	const transcriptRegistry = new TaskRegistry([transcriptTask]);
	transcriptRegistry.dismissExecutions("claude", [{ taskId: transcriptTask.taskId, executionId: taskExecutionKey(transcriptTask) }]);
	transcriptRegistry.upsertTask({ ...transcriptTask, status: "RUNNING", lastObservedAt: now + 1_000 });
	assert.equal(transcriptRegistry.getTask(transcriptTask.taskId), undefined);
	transcriptRegistry.upsertTask({ ...transcriptTask, status: "RUNNING", lastEventAt: now + 1_000, lastExecutionActivityAt: now + 1_000,
		progress: { ...transcriptTask.progress, turnStartedAt: now + 1_000 } });
	assert.equal(transcriptRegistry.getTask(transcriptTask.taskId)?.status, "RUNNING");
	const hook = task("new-hook", "claude", "RUNNING", { source: "hook-event", progress: emptyTaskProgress() });
	const hookRegistry = new TaskRegistry([hook]);
	hookRegistry.upsertTask({ ...hook, source: "transcript-tail", status: "ERROR", lastEventAt: now - 24 * 60 * 60_000,
		lastExecutionActivityAt: now - 24 * 60 * 60_000, progress: { ...emptyTaskProgress(), turnStartedAt: now - 24 * 60 * 60_000 } });
	assert.equal(hookRegistry.getTask(hook.taskId)?.status, "RUNNING", "An old transcript cannot expire a fresh Hook execution");
	assert.equal(hookRegistry.getTask(hook.taskId)?.lastExecutionActivityAt, now);

	// Reproduce the September 24 rollout plus a recent settings record, using a new file mtime.
	const oldAt = now - 5 * 24 * 60 * 60_000;
	const file = path.join(temporary, "rollout.jsonl");
	const record = (at: number, type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";
	fs.writeFileSync(file, record(oldAt, "event_msg", { type: "task_started", turn_id: "lost-turn" })
		+ record(oldAt + 1_000, "response_item", { type: "reasoning" })
		+ record(now, "event_msg", { type: "thread_settings_applied" }));
	const reader = new RolloutReader();
	const lifecycle = reader.read(file);
	assert.equal(lifecycle.lastExecutionActivityAt, oldAt + 1_000);
	assert.equal(reader.read(file).lastExecutionActivityAt, oldAt + 1_000, "Repeated polling is not execution activity");
	const lost = task("lost", "codex", "RUNNING", { executionId: lifecycle.executionId, lastEventAt: lifecycle.lastEventAt,
		lastExecutionActivityAt: lifecycle.lastExecutionActivityAt, progress: lifecycle.progress });
	const registry = new TaskRegistry([lost]);
	assert.equal(registry.getTask(lost.taskId), undefined);
	const monitor = new MonitorStore();
	monitor.update(registry.getTasks(), healthy, now);
	assert.deepEqual(monitor.update(registry.getTasks(), healthy, now + 1_000).days, {},
		"An old lost task does not increment TODAY");
	const afterRestart = restored(registry);
	afterRestart.upsertTask({ ...lost, lastObservedAt: now + 1_000 });
	assert.equal(afterRestart.getTask(lost.taskId), undefined);
	// Genuine output from a long tool can recover a timeout, even within the same execution.
	afterRestart.upsertTask({ ...lost, lastExecutionActivityAt: now });
	assert.equal(afterRestart.getTask(lost.taskId)?.status, "RUNNING");
	afterRestart.sweep(now + RUNNING_STALE_MS);
	assert.equal(afterRestart.getTask(lost.taskId), undefined);
	fs.appendFileSync(file, record(now + 1_000, "response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Finished" }] }));
	assert.equal(reader.read(file).status, "DONE_UNREAD", "A final answer settles the turn without task_complete");
	const final = reader.read(file);
	afterRestart.upsertTask({ ...lost, status: final.status, lastEventAt: final.lastEventAt, lastExecutionActivityAt: final.lastExecutionActivityAt, progress: final.progress });
	assert.equal(afterRestart.getTask(lost.taskId)?.status, "DONE_UNREAD", "An actual completion recovers a lost long-running tool");
	fs.writeFileSync(file, record(now, "event_msg", { type: "task_started", turn_id: "new-turn" })
		+ record(now + 1_000, "event_msg", { type: "turn_completed", turn_id: "new-turn" }));
	assert.equal(reader.read(file).status, "DONE_UNREAD");

	const claudeFile = path.join(temporary, "claude.jsonl");
	const claudeRecords = [
		{ type: "user", timestamp: new Date(oldAt).toISOString(), sessionId: "no-id", cwd: temporary, message: { content: "Start" } },
		{ type: "assistant", timestamp: new Date(oldAt + 1_000).toISOString(), isApiErrorMessage: true, message: { content: [], stop_reason: "end_turn" } },
		{ type: "custom-title", timestamp: new Date(now).toISOString(), customTitle: "Opened old conversation" },
	];
	const claude = parseClaudeTranscript(claudeRecords, claudeFile, now)!;
	assert.equal(claude.status, "ERROR");
	assert.equal(claude.lastExecutionActivityAt, oldAt + 1_000);
	assert.equal(new TaskRegistry([claude]).getTasks().length, 0);

	// Real in-process IPC must clear the daemon/desktop source and publish compact slots.
	process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = path.join(temporary, "ipc-data");
	const transcriptRoot = path.join(temporary, "transcripts");
	fs.mkdirSync(transcriptRoot);
	const server = new IpcServer({ adapterMode: "real", observerOnly: true, config: {
		version: 2, projects: [], agents: { codex: { enabled: false }, claude: { enabled: true, transcriptDirectory: transcriptRoot } },
		device: { mode: "official", startAtLogin: false, showInMenuBar: false },
	} });
	const client = new DaemonClient();
	try {
		await server.start();
		for (const agent of ["codex", "claude"] as const) {
			const running = task("ipc-running", agent, "RUNNING");
			server.registry.upsertTask(running);
			const monitorTasks = Array.from({ length: 14 }, (_, i) => task(`ipc-${i}`, agent, "RUNNING"));
			for (const t of monitorTasks) server.registry.upsertTask(t);
			for (const t of monitorTasks) server.registry.upsertTask({ ...t, status: "ERROR" });
			const snapshot = server.getTasks();
			assert.ok(snapshot.some(t => t.taskId === monitorTasks[13]!.taskId), "Overflow history exists before dismissal");
			client.start(() => server.connectInProcess());
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => { unsubscribe(); reject(new Error("IPC snapshot timeout")); }, 2_000);
				const unsubscribe = deviceState.subscribe(() => {
					if (!deviceState.getTask(running.taskId)) return;
					clearTimeout(timeout); unsubscribe(); resolve();
				});
			});
			assert.equal(await client.sendDismissCompleted({ agent, executions: monitorTasks.map(t => ({ taskId: t.taskId, executionId: taskExecutionKey(t) })) }), true);
			assert.deepEqual(server.getTasks().filter(t => t.agent === agent).map(t => t.taskId), [running.taskId], "Desktop source removes even unslotted errors");
			assert.equal(deviceState.getTasks(agent).length, 1);
			assert.equal(server.status.monitor?.slots[agent].length, 1);
			client.stop();
		}
	} finally { client.stop(); await server.stop(); }
	console.log("[task-lifecycle] execution freshness, synchronized cleanup, restart watermarks, navigation races and lost-log recovery: ok");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
