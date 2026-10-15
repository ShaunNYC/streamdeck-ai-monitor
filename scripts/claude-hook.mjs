#!/usr/bin/env node

import fs from "node:fs/promises";
import childProcess from "node:child_process";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? `${process.env.HOME}/Library/Application Support/streamdeck-supervisor`;
const tokenPath = process.env.AI_CONTROL_SUPERVISOR_TOKEN_PATH ?? `${dataDirectory}/token`;
const endpoint = process.env.AI_CONTROL_SUPERVISOR_HOOK_URL ?? "http://127.0.0.1:17743/hook/claude";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let payload = input || "{}";
let permissionRequest = false;
try {
	const parsed = JSON.parse(payload);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		permissionRequest = parsed.hook_event_name === "PermissionRequest" || parsed.hookEventName === "PermissionRequest";
		const tty = childProcess.execFileSync("ps", ["-o", "tty=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 1000 }).trim();
		if (tty && tty !== "??") parsed.tty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
		parsed.process_id = process.ppid;
		payload = JSON.stringify(parsed);
	}
} catch {
	// The original documented hook payload remains authoritative if enrichment fails.
}

try {
	const token = (await fs.readFile(tokenPath, "utf8")).trim();
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", "x-ai-control-token": token },
		body: payload,
		signal: AbortSignal.timeout(Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_HOOK_TIMEOUT_MS ?? "620000", 10)),
	});
	if (!response.ok) throw new Error(`Neo Claude Hook returned HTTP ${response.status}`);
	const body = await response.text();
	process.stdout.write(body || "{}");
} catch {
	// Non-permission lifecycle notifications fail open. PermissionRequest is the
	// safety boundary and must fail closed if Neo disappears or times out.
	process.stdout.write(permissionRequest ? JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: { behavior: "deny", message: "Neo approval service was unavailable or timed out." },
		},
	}) : "{}");
}
