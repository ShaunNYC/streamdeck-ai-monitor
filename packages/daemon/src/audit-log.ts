import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "@streamdeck-supervisor/shared";
import { getDataDirectory } from "./config.js";

export interface AuditRecord {
	action: string;
	agent?: "codex" | "claude";
	taskId?: string;
	requestId?: string;
	clientRequestId?: string;
	outcome: "ok" | "error" | "started" | "pass" | "fail";
	detail?: string;
}

/** Append-only, prompt-free action history for safety and troubleshooting. */
export class AuditLogger {
	readonly filePath = path.join(getDataDirectory(), "logs", "audit.jsonl");

	record(record: AuditRecord): void {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const safeRecord = record.detail ? { ...record, detail: redactSensitiveText(record.detail) } : record;
		fs.appendFileSync(this.filePath, `${JSON.stringify({ timestamp: Date.now(), ...safeRecord })}\n`, { encoding: "utf8", mode: 0o600 });
		try { fs.chmodSync(this.filePath, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
	}
}
