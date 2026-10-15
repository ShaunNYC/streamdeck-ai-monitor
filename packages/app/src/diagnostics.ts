import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { redactSensitiveText } from "@streamdeck-supervisor/shared";
import type { DesktopStatus, OperationResult } from "./app-types.js";

export async function exportDiagnostics(parent: BrowserWindow | null, status: DesktopStatus): Promise<OperationResult> {
	const options = {
		title: "Export Diagnostics",
		defaultPath: path.join(os.homedir(), "Downloads", `Agent-Pulse-Diagnostics-${Date.now()}.zip`),
		filters: [{ name: "ZIP archive", extensions: ["zip"] }],
	};
	const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
	if (result.canceled || !result.filePath) return { ok: false, message: "Export canceled" };

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-control-diagnostics-"));
	try {
		const summary = {
			generatedAt: new Date().toISOString(),
			version: status.version,
			platform: `${process.platform}-${process.arch}`,
			osRelease: os.release(),
			platformSupported: status.platformSupported,
			inApplicationsFolder: status.inApplicationsFolder,
			configured: status.configured,
			runtimeRunning: status.runtimeRunning,
			openAtLogin: status.openAtLogin,
			streamDeckAppRunning: status.elgatoRunning,
			agents: status.agents,
			device: {
				state: status.device.state,
				connectedNeoCount: status.device.scannedDevices.length,
				productName: status.device.productName,
				lastError: status.device.lastError,
			},
			projectCount: status.config.projects.length,
			mode: status.config.device.mode,
			lastError: status.lastError,
		};
		fs.writeFileSync(path.join(temporary, "diagnostics.json"), `${JSON.stringify(redact(summary), null, 2)}\n`, { mode: 0o600 });
		copyRedactedLogs(temporary);
		childProcess.execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", temporary, result.filePath]);
		return { ok: true, message: "Diagnostics exported", path: result.filePath };
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function copyRedactedLogs(destination: string): void {
	const source = path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor", "logs");
	const output = path.join(destination, "logs");
	for (const name of ["daemon.out.log", "daemon.err.log", "device.out.log", "device.err.log", "app.log"]) {
		const file = path.join(source, name);
		if (!fs.existsSync(file)) continue;
		fs.mkdirSync(output, { recursive: true, mode: 0o700 });
		const text = fs.readFileSync(file, "utf8").slice(-64_000);
		fs.writeFileSync(path.join(output, name), redactText(text), { mode: 0o600 });
	}
}

function redact<T>(value: T): T {
	return JSON.parse(redactText(JSON.stringify(value))) as T;
}

function redactText(value: string): string {
	return redactSensitiveText(value.replaceAll(os.homedir(), "~"))
		.replace(/("?(?:prompt|content|message)"?\s*[:=]\s*)[^\n,}]+/gi, "$1[REDACTED]");
}
