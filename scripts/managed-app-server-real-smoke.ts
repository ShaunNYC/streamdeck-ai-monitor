import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexManagedController } from "../packages/daemon/src/codex-managed-controller.js";
import { TaskRegistry } from "../packages/daemon/src/task-registry.js";

async function main(): Promise<void> {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "neo-managed-real-"));
	const controller = new CodexManagedController({
		registry: new TaskRegistry([]),
		filePath: path.join(temporary, "managed-codex.json"),
		onPlanInput: () => undefined,
		onPlanInputCleared: () => undefined,
		onStatus: () => undefined,
	});
	try {
		const models = await controller.listModels();
		assert.ok(models.length > 0, "The installed Codex app-server returned no models");
		assert.equal(controller.getStatus().status, "OK");
		console.log(`[managed-app-server-real] stdio initialize/initialized and model/list: ok (${models.length} models)`);
	} finally {
		await controller.stop();
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
