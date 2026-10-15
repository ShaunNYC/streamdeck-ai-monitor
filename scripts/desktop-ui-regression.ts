import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, type Task, type TaskStatus } from "@streamdeck-supervisor/shared";
import { DesktopTaskStateStore, validateDesktopTaskIds } from "../packages/app/src/desktop-task-state.js";
import { groupDesktopTasks, taskDurationMs } from "../packages/app/src/task-order.js";

const root = process.cwd();
const now = Date.now();

function task(id: string, status: TaskStatus, lastEventAt: number, overrides: Partial<Task> = {}): Task {
	const attention = status === "APPROVAL" || status === "NEEDS_INPUT" || status === "ERROR" || status === "DONE_UNREAD";
	return {
		taskId: id,
		agent: id.includes("claude") ? "claude" : "codex",
		ownership: "observer",
		externalId: id,
		projectId: "test",
		projectLabel: "TEST",
		titleShort: id,
		status,
		attentionCount: attention ? 1 : 0,
		attentionVersion: attention ? 1 : 0,
		acknowledgedAttentionVersion: 0,
		capabilities: taskCapabilities(),
		progress: emptyTaskProgress(),
		openRef: { kind: "url", value: `codex://threads/${id}` },
		source: "mock",
		lastEventAt,
		startedAt: lastEventAt,
		...overrides,
	};
}

function withTaskStore(run: (store: DesktopTaskStateStore, file: string) => void, initialContents?: string): void {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-task-state-"));
	const file = path.join(directory, "state.json");
	try {
		if (initialContents !== undefined) fs.writeFileSync(file, initialContents);
		run(new DesktopTaskStateStore(file), file);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

{
	const acknowledgedClaudeError = task("claude-old-error", "ERROR", now - 7_000, {
		attentionCount: 0,
		attentionVersion: 4,
		acknowledgedAttentionVersion: 4,
	});
	const groups = groupDesktopTasks([
		task("codex-running", "RUNNING", now - 1_000),
		task("codex-queued", "QUEUED", now),
		task("codex-input", "NEEDS_INPUT", now - 3_000),
		task("codex-approval", "APPROVAL", now - 4_000),
		task("codex-source-done", "DONE_UNREAD", now - 500),
		task("claude-error", "ERROR", now - 750),
		acknowledgedClaudeError,
		task("codex-recent-done", "DONE", now - 2_000),
		task("codex-paused", "PAUSED", now - 9_000),
	]);

	assert.deepEqual(groups.active.map(({ taskId }) => taskId), [
		"codex-approval", "codex-input", "codex-running", "codex-queued",
	], "Active work is stable by status priority, then event time");
	assert.deepEqual(groups.history.map(({ taskId }) => taskId), [
		"codex-source-done", "claude-error", "codex-recent-done", "claude-old-error", "codex-paused",
	], "Every terminal task is ordinary history regardless of attention metadata");
	assert.ok(!("unread" in groups), "Desktop grouping must not expose a read/unread layer");
}

{
	const running = task("managed-running-duration", "RUNNING", now, {
		ownership: "managed",
		progress: { ...emptyTaskProgress(), turnStartedAt: now - 65_000, durationMs: 1_000 },
	});
	const terminal = task("managed-done-duration", "DONE", now, {
		ownership: "managed",
		progress: { ...emptyTaskProgress(), turnStartedAt: now - 600_000, durationMs: 65_000 },
	});
	assert.equal(taskDurationMs(running, now), 65_000, "A quiet live Managed Turn must use wall time instead of stale reduced duration");
	assert.equal(taskDurationMs(terminal, now), 65_000, "A terminal Managed Turn must keep its final reduced duration");
}

withTaskStore((store) => {
	const oldDone = Array.from({ length: 62 }, (_, index) => task(`old-done-${index}`, "DONE", now - 3 * 60 * 60_000 - index));
	const oldSourceDone = task("old-source-done", "DONE_UNREAD", now - 3 * 60 * 60_000);
	const current = [
		task("running", "RUNNING", now, { executionId: "turn-running" }),
		task("source-done", "DONE_UNREAD", now - 1_000),
		task("error", "ERROR", now - 2_000),
	];
	const refilled = [...oldDone, oldSourceDone, ...current];
	assert.equal(refilled.length, 66);
	assert.equal(store.project(refilled, now).length, 3, "An adapter refill must expire both source completion variants and retain only desktop-relevant tasks");
	assert.equal(store.project(current, now).length, 3, "A swept registry snapshot must keep the same desktop count");
	assert.equal(store.project(refilled, now).length, 3, "The next adapter refill must not restore expired DONE history");
});

withTaskStore((store) => {
	const thinking = { category: "thinking" as const, label: "Thinking", state: "running" as const, at: now - 500 };
	const projected = store.project([
		task("live-thinking", "RUNNING", now, { progress: { ...emptyTaskProgress(), latestActivity: thinking } }),
		task("done-thinking", "DONE", now, { progress: { ...emptyTaskProgress(), latestActivity: thinking } }),
		task("error-thinking", "ERROR", now, { progress: { ...emptyTaskProgress(), latestActivity: thinking } }),
		task("paused-thinking", "PAUSED", now, { progress: { ...emptyTaskProgress(), latestActivity: thinking } }),
		task("stale-thinking", "STALE", now, { progress: { ...emptyTaskProgress(), latestActivity: thinking } }),
	], now);
	assert.equal(projected.find(({ taskId }) => taskId === "live-thinking")?.progress.latestActivity?.label, "Thinking", "Live reasoning remains a real Activity");
	assert.deepEqual(projected.filter(({ taskId }) => taskId !== "live-thinking").map(({ progress }) => progress.latestActivity?.label), ["Completed", "Error", "Paused", "Expired"], "Terminal tasks must never remain Thinking/running");
});

withTaskStore((store) => {
	const tasks = [
		task("source-done", "DONE_UNREAD", now),
		task("error", "ERROR", now - 1),
		task("approval", "APPROVAL", now - 2),
		task("needs-input", "NEEDS_INPUT", now - 3),
	];
	const projected = store.project(tasks, now);
	assert.equal(projected.find(({ taskId }) => taskId === "source-done")?.status, "DONE", "Desktop projection collapses the source-only completion variant into DONE");
	assert.equal(projected.find(({ taskId }) => taskId === "error")?.status, "ERROR");
	assert.equal(projected.find(({ taskId }) => taskId === "approval")?.status, "APPROVAL");
	assert.equal(projected.find(({ taskId }) => taskId === "needs-input")?.status, "NEEDS_INPUT");
});

withTaskStore((store) => {
	const firstTurn = task("hidden-conversation", "RUNNING", now, { executionId: "turn-1" });
	assert.equal(store.hideTasks([firstTurn.taskId, "missing-task"], [firstTurn], now), 1);
	assert.equal(store.hideTasks([firstTurn.taskId], [firstTurn], now), 0, "Deleting the same desktop task twice is idempotent");
	assert.equal(store.project([firstTurn], now).length, 0);
	assert.equal(store.project([{ ...firstTurn, status: "APPROVAL", lastEventAt: now + 1_000 }], now + 1_000).length, 0, "Poll and status changes in the same Turn stay hidden");
	assert.equal(store.project([{ ...firstTurn, executionId: "turn-2", lastEventAt: now + 2_000 }], now + 2_000).length, 1, "A new Turn restores a locally deleted conversation");
});

withTaskStore((store) => {
	const tasks = (["IDLE", "DONE", "DONE_UNREAD", "ERROR", "PAUSED", "STALE", "RUNNING", "QUEUED", "APPROVAL", "NEEDS_INPUT"] as TaskStatus[])
		.map((status, index) => task(`clear-${status}`, status, now - index, { ...(status === "RUNNING" ? { executionId: "turn-live" } : {}) }));
	assert.equal(store.clearHistory(tasks, now), 6);
	assert.deepEqual(store.project(tasks, now).map(({ status }) => status), ["RUNNING", "QUEUED", "APPROVAL", "NEEDS_INPUT"], "Clear history preserves every active or pending status");
});

withTaskStore((store, file) => {
	const running = task("corrupt-state-fallback", "RUNNING", now, { executionId: "turn-safe" });
	assert.equal(store.project([running], now).length, 1, "A corrupt desktop state file fails open to visible monitoring");
	assert.equal(store.hideTasks([running.taskId], [running], now), 1);
	assert.equal(fs.statSync(file).mode & 0o077, 0, "Desktop task state is private to the current user");
	const savedState = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(savedState.version, 1);
	assert.ok(!Object.hasOwn(savedState, "readTasks"), "Desktop state must not persist read watermarks");
}, "{broken json");

assert.deepEqual(validateDesktopTaskIds(["one", "one", "two"]), ["one", "two"], "Desktop task IPC de-duplicates valid task IDs");
assert.throws(() => validateDesktopTaskIds([]), /1–128/);
assert.throws(() => validateDesktopTaskIds(Array.from({ length: 129 }, (_, index) => `task-${index}`)), /1–128/);
assert.throws(() => validateDesktopTaskIds(["valid", 42]), /Invalid desktop task ID/);

const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");
const html = read("packages/app/src/renderer/index.html");
const renderer = read("packages/app/src/renderer/renderer.ts");
const css = read("packages/app/src/renderer/styles.css");
const main = read("packages/app/src/main.ts");
const appTypes = read("packages/app/src/app-types.ts");
const preload = read("packages/app/src/preload.ts");
const runtime = read("packages/app/src/runtime.ts");
const desktopState = read("packages/app/src/desktop-task-state.ts");
const daemonIpc = read("packages/daemon/src/ipc-server.ts");

assert.ok(!html.includes('data-view="new-task"') && !html.includes("view-new-task") && !html.includes("New Task"), "Desktop New Task UI must be absent");

assert.ok(!html.includes('data-view="tasks"') && !html.includes('id="view-tasks"'));
assert.ok(!html.includes('id="request-sheet"') && !html.includes('id="task-manager-sheet"'));
assert.ok(html.indexOf('id="usage-cards"') < html.indexOf('id="takeover-toggle"'));
assert.ok(html.includes('role="switch"') && html.includes('Control Neo'));
for (const id of ['usage-period','usage-prev','usage-next','usage-calendar','usage-today']) assert.ok(html.includes(`id="${id}"`));
for (const source of [appTypes,preload,main,renderer]) {
 for (const removed of ['deleteDesktopTasks','sendManagedMessage','decideRequest','answerRequest']) assert.ok(!source.includes(removed));
}
assert.ok(renderer.includes('refreshInFlight') && renderer.includes('fullRefreshPending'));
assert.ok(css.includes('prefers-reduced-motion: reduce') && css.includes(':focus-visible'));
assert.ok(main.includes('nativeTheme.themeSource = "light"'));
assert.ok(renderer.includes('Save settings · Unsaved changes'));
console.log('[desktop-ui-regression] settings-only desktop, summary priority, takeover switch and reduced bridge: ok');
