import childProcess from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function runClaudeHookCli(): Promise<void> {
	const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR
		?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
	const tokenPath = process.env.AI_CONTROL_SUPERVISOR_TOKEN_PATH ?? path.join(dataDirectory, "token");
	const endpoint = process.env.AI_CONTROL_SUPERVISOR_HOOK_URL ?? "http://127.0.0.1:17743/hook/claude";
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;

	let payload = input || "{}";
	let permissionRequest = false;
	try {
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			permissionRequest = parsed.hook_event_name === "PermissionRequest" || parsed.hookEventName === "PermissionRequest";
			const tty = childProcess.execFileSync("/bin/ps", ["-o", "tty=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 1_000 }).trim();
			if (tty && tty !== "??") parsed.tty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
			parsed.process_id = process.ppid;
			payload = JSON.stringify(parsed);
		}
	} catch { /* Preserve the documented payload if enrichment fails. */ }

	try {
		const token = (await fs.readFile(tokenPath, "utf8")).trim();
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-ai-control-token": token },
			body: payload,
			signal: AbortSignal.timeout(Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_HOOK_TIMEOUT_MS ?? "620000", 10)),
		});
		if (!response.ok) throw new Error(`Neo Claude Hook returned HTTP ${response.status}`);
		writeOutput((await response.text()) || "{}");
	} catch {
		writeOutput(claudeHookFailureResponse(permissionRequest));
	}
}

export function claudeHookFailureResponse(permissionRequest: boolean): string {
	return permissionRequest
		? JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "Neo approval service was unavailable or timed out." },
			},
		})
		: "{}";
}

function writeOutput(value: string): void {
	// Electron's stdout stream does not reliably invoke async write callbacks
	// before app readiness. A synchronous fd write makes the short-lived hook
	// deterministic and ensures Claude always receives valid JSON.
	fsSync.writeSync(1, value);
}
