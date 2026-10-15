import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const DEFAULT_SOCKET = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");

export function getCodexBinary() {
	return process.env.AI_CONTROL_SUPERVISOR_CODEX_BIN
		?? (fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/codex")
			? "/Applications/ChatGPT.app/Contents/Resources/codex"
			: "codex");
}

export function getCodexSocket() {
	return process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET ?? DEFAULT_SOCKET;
}

export function codexCommand(binary, args, timeoutMs = 15_000) {
	const result = childProcess.spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs });
	if (result.error) return { ok: false, detail: result.error.message };
	if (result.status !== 0) {
		return {
			ok: false,
			detail: String(result.stderr || result.stdout || `${args.join(" ")} exited ${result.status}`).trim(),
		};
	}
	return { ok: true, detail: String(result.stdout || result.stderr || "ok").trim() };
}

/**
 * Verify the exact transport used by the Supervisor: WebSocket over the
 * managed Unix socket, complete initialize, then disconnect without a thread.
 */
export function probeCodexAppServer({ socket = getCodexSocket(), timeoutMs = 5_000 } = {}) {
	return new Promise((resolve) => {
		if (!fs.existsSync(socket)) {
			resolve({ ok: false, detail: `control socket missing: ${socket}` });
			return;
		}

		const connection = new WebSocket("ws://localhost/", {
			perMessageDeflate: false,
			createConnection: () => net.createConnection({ path: socket }),
		});
		let settled = false;
		const finish = (ok, detail) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			connection.close();
			resolve({ ok, detail });
		};
		const timer = setTimeout(() => finish(false, `initialize timed out after ${timeoutMs}ms`), timeoutMs);

		connection.once("open", () => {
			connection.send(JSON.stringify({
				id: "neo-health",
				method: "initialize",
				params: {
					clientInfo: { name: "streamdeck_supervisor_health", title: "Stream Deck Neo Health Check", version: "3.1.0" },
					capabilities: { experimentalApi: true },
				},
			}));
		});
		connection.on("message", (raw) => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.id !== "neo-health") return;
				if (message.error) finish(false, message.error.message ?? "initialize rejected");
				else {
					connection.send(JSON.stringify({ method: "initialized", params: {} }));
					finish(true, "initialize handshake ok");
				}
			} catch (error) {
				finish(false, `invalid app-server response: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		connection.once("error", (error) => finish(false, error.message));
		connection.once("close", (code, reason) => finish(false, reason.toString() || `socket closed (${code})`));
	});
}

/** Start and enable the shared managed daemon without taking ownership of it. */
export async function ensureCodexAppServer({ binary = getCodexBinary(), socket = getCodexSocket(), waitMs = 15_000 } = {}) {
	const started = codexCommand(binary, ["app-server", "daemon", "start"]);
	if (!started.ok) return { ok: false, stage: "start", detail: started.detail, binary, socket };

	const enabled = codexCommand(binary, ["app-server", "daemon", "enable-remote-control"]);
	if (!enabled.ok) return { ok: false, stage: "enable-remote-control", detail: enabled.detail, binary, socket };

	const deadline = Date.now() + waitMs;
	let last = { ok: false, detail: `control socket missing: ${socket}` };
	do {
		if (fs.existsSync(socket)) {
			last = await probeCodexAppServer({ socket, timeoutMs: Math.min(5_000, Math.max(500, deadline - Date.now())) });
			if (last.ok) return { ok: true, stage: "ready", detail: last.detail, binary, socket };
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (Date.now() < deadline);

	return { ok: false, stage: "handshake", detail: last.detail, binary, socket };
}
