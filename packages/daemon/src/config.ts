import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IPC_HOST = "127.0.0.1";
export const IPC_PORT = Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10);
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const ADAPTER_MODE = process.env.AI_CONTROL_SUPERVISOR_ADAPTER_MODE === "real" ? "real" : "mock";
/**
 * Experimental only: a relay can own sessions created by its app-server, but
 * it cannot subscribe to a thread that Codex Desktop already owns. Keep it off
 * for the normal Desktop-monitoring installation to avoid active-writer fights.
 */
export const CODEX_PLAN_RELAY_ENABLED = process.env.AI_CONTROL_SUPERVISOR_EXPERIMENTAL_PLAN_RELAY === "1";

export function getCodexAppServerSocket(): string {
	return process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET
		?? path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

export function getCodexBinary(): string {
	return process.env.AI_CONTROL_SUPERVISOR_CODEX_BIN
		?? (fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/codex")
			? "/Applications/ChatGPT.app/Contents/Resources/codex"
			: "codex");
}

/** Tests can point the daemon at a temporary directory without touching the user's real config. */
export function getDataDirectory(): string {
	return process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
}

export function getTokenPath(): string {
	return path.join(getDataDirectory(), "token");
}

export function getConfiguredProjectCount(): number {
	const configured = process.env.AI_CONTROL_SUPERVISOR_PROJECTS?.split(",").map((value) => value.trim()).filter(Boolean);
	return configured?.length ?? 0;
}

export function createSessionToken(): string {
	const directory = getDataDirectory();
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const token = crypto.randomBytes(32).toString("hex");
	fs.writeFileSync(getTokenPath(), `${token}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		fs.chmodSync(directory, 0o700);
		fs.chmodSync(getTokenPath(), 0o600);
	} catch {
		// Best effort on platforms/filesystems that do not expose POSIX mode bits.
	}
	hardenDataPermissions();
	return token;
}

/** Repairs permissions left by legacy LaunchAgent redirection or older builds. */
export function hardenDataPermissions(): void {
	const directory = getDataDirectory();
	const logs = path.join(directory, "logs");
	for (const candidate of [directory, logs]) {
		try {
			fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
			fs.chmodSync(candidate, 0o700);
		} catch { /* Best effort on non-POSIX filesystems. */ }
	}
	for (const candidate of ["token", "config.json", "config.json.bak", "state.json", "mode.json", "managed-codex.json"].map((name) => path.join(directory, name))) {
		chmodRegularFile(candidate);
	}
	try {
		for (const name of fs.readdirSync(logs)) chmodRegularFile(path.join(logs, name));
	} catch { /* No legacy logs. */ }
}

function chmodRegularFile(filePath: string): void {
	try {
		if (fs.lstatSync(filePath).isFile()) fs.chmodSync(filePath, 0o600);
	} catch { /* Missing or unsupported. */ }
}
