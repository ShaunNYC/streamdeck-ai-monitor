import assert from "node:assert/strict";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, type Task } from "@streamdeck-supervisor/shared";
import { TaskRegistry } from "../packages/daemon/src/task-registry.ts";
import { enrichTaskWithProject, normalizeSupervisorConfig } from "../packages/daemon/src/supervisor-config.ts";

const now = Date.now();

function task(id: string, cwd: string, status: Task["status"] = "RUNNING"): Task {
	return {
		taskId: `codex:${id}`,
		...(status === "RUNNING" ? { executionId: `turn:${id}` } : {}),
		agent: "codex",
		externalId: id,
		projectId: cwd,
		projectLabel: path.basename(cwd).toUpperCase().slice(0, 9),
		cwd,
		titleShort: id,
		status,
		attentionCount: 0,
		ownership: "observer",
		progress: emptyTaskProgress(),
		capabilities: taskCapabilities("observer", status),
		openRef: { kind: "url", value: `codex://threads/${id}` },
		source: "catalog-sqlite",
		lastEventAt: now,
		lastObservedAt: now,
		startedAt: now,
	};
}

const streamDeck = "/Users/test/Documents/stream deck";
const pillfill = "/Users/test/Documents/pillfill";
const other = "/Users/test/Documents/private/other";
const configured = normalizeSupervisorConfig({
	version: 2,
	projects: [{
		id: "stream-deck",
		label: "STREAM",
		cwd: streamDeck,
		verify: { command: "npm test", cwd: streamDeck, timeoutMs: 120_000 },
	}],
	agents: { codex: { enabled: true }, claude: { enabled: true } },
	device: { mode: "ai", startAtLogin: true, showInMenuBar: true },
});

const registry = new TaskRegistry([]);
registry.upsertTask(enrichTaskWithProject(task("stream-deck-running", streamDeck), configured));
registry.upsertTask(enrichTaskWithProject(task("pillfill-running", pillfill), configured));
assert.equal(registry.getTasks().filter((candidate) => candidate.status === "RUNNING").length, 2,
	"A configured stream deck task and an unconfigured pillfill task must display 2 TASKS RUNNING");
assert.equal(registry.getTask("codex:pillfill-running")?.projectId, pillfill,
	"An unconfigured project keeps its real identity instead of being dropped");
assert.equal(registry.getTask("codex:stream-deck-running")?.projectLabel, "STREAM");
assert.equal(registry.getTask("codex:stream-deck-running")?.verifyProfile?.command, "npm test");

registry.upsertTask(enrichTaskWithProject(task("approval", other, "APPROVAL"), configured));
registry.upsertTask(enrichTaskWithProject(task("done", other, "DONE_UNREAD"), configured));
assert.equal(registry.getTasks().filter((candidate) => candidate.status === "RUNNING").length, 2,
	"Approval, input, and terminal states must not inflate the strict RUNNING count");

const zeroProjectConfig = normalizeSupervisorConfig({
	version: 2,
	projects: [],
	agents: { codex: { enabled: true }, claude: { enabled: true } },
	device: { mode: "ai" },
});
const zeroProjectRegistry = new TaskRegistry([]);
zeroProjectRegistry.upsertTask(enrichTaskWithProject(task("any-directory", other), zeroProjectConfig));
assert.equal(zeroProjectRegistry.getTasks().filter((candidate) => candidate.status === "RUNNING").length, 1,
	"Zero configured projects must still monitor all top-level tasks");
assert.equal(zeroProjectConfig.device.startAtLogin, false, "Monitoring does not imply login-startup consent");
assert.equal(zeroProjectConfig.device.showInMenuBar, true);

console.log("[task-monitoring] all-project collection, exact concurrent count, optional metadata and zero-project monitoring: ok");
