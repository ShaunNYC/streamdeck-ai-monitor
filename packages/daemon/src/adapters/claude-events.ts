import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeReasoningEffort, redactSensitiveText, type Task, type TaskRequest, type TaskStatus } from "@streamdeck-supervisor/shared";
import { baseTask, projectLabelFromCwd, safeTaskTitle } from "./types.js";
import { activityCategoryForTool } from "../progress-reducer.js";

export interface ClaudeHookEvent {
	eventName: string;
	task: Task;
	request?: TaskRequest;
	terminal: boolean;
}

/**
 * Claude fires SessionStart/SessionEnd when an existing conversation is merely
 * opened and closed. Those are application lifecycle signals, not proof that an
 * Agent task ran. Keep a small in-memory gate so only sessions with observed
 * work can publish a completion/error event.
 */
export class ClaudeHookActivityGate {
	private readonly activeSessions = new Set<string>();

	accept(event: ClaudeHookEvent): boolean {
		const sessionId = event.task.externalId;
		switch (event.eventName) {
			case "SessionStart":
			case "CwdChanged":
				return false;
			case "Stop":
			case "StopFailure":
			case "SessionEnd": {
				const wasActive = this.activeSessions.delete(sessionId);
				return wasActive;
			}
			case "UserPromptSubmit":
			case "PreToolUse":
			case "PostToolUse":
			case "PostToolUseFailure":
			case "PermissionRequest":
				this.activeSessions.add(sessionId);
				return true;
			case "Notification":
				if (event.task.status === "NEEDS_INPUT") this.activeSessions.add(sessionId);
				return this.activeSessions.has(sessionId);
			default:
				return false;
		}
	}
}

type JsonRecord = Record<string, unknown>;

function stringField(input: JsonRecord, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function objectField(input: JsonRecord, ...names: string[]): JsonRecord | undefined {
	for (const name of names) {
		const value = input[name];
		if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
	}
	return undefined;
}

function numberField(input: JsonRecord, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "number" && Number.isSafeInteger(value)) return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
	}
	return undefined;
}

function uniqueRequestId(sessionId: string): string {
	return `permission:${sessionId}:${crypto.randomUUID()}`;
}

function summarizeTarget(toolName: string, toolInput: JsonRecord | undefined): string {
	if (!toolInput) return toolName || "permission request";
	const target = stringField(toolInput, "command", "file_path", "path", "url", "query");
	return redactSensitiveText(target ? `${toolName}: ${target}` : toolName || "permission request");
}

function riskTier(toolName: string, toolInput: JsonRecord | undefined, cwd: string | undefined): 1 | 2 {
	if (!cwd || !canonicalWorkspaceRoot(cwd)) return 2;
	const target = summarizeTarget(toolName, toolInput);
	const dangerous = /(^|\s)(sudo|rm\s+-rf|dd\s+if=|chmod\s+777)(\s|$)|git\s+push\s+--force|\|\s*(sh|bash|zsh)\b/i;
	const network = /^(WebFetch|WebSearch|Network|mcp__)/i.test(toolName)
		|| /\b(curl|wget|ssh|scp|rsync)\b|https?:\/\//i.test(target);
	if (dangerous.test(target) || network) return 2;
	const paths = explicitPaths(toolInput);
	if (paths.some((candidate) => !isPathInsideWorkspace(candidate, cwd))) return 2;
	return /^(Bash|Read|Edit|Write|NotebookEdit|MultiEdit|Glob|Grep)$/i.test(toolName) ? 1 : 2;
}

function explicitPaths(toolInput: JsonRecord | undefined): string[] {
	if (!toolInput) return [];
	const direct = ["file_path", "path", "notebook_path"]
		.flatMap((name) => typeof toolInput[name] === "string" ? [toolInput[name] as string] : []);
	const command = typeof toolInput.command === "string" ? toolInput.command : "";
	const shellPaths = [...command.matchAll(/(?:^|[\s"'=])((?:\/|~\/|\.\.?\/)[^\s"'|;&]*)/g)]
		.map((match) => match[1])
		.filter((candidate): candidate is string => !!candidate)
		.map((candidate) => candidate.replace(/[),\]}]+$/, ""));
	return [...direct, ...shellPaths];
}

function isPathInsideWorkspace(candidate: string, cwd: string): boolean {
	const root = canonicalWorkspaceRoot(cwd);
	const expanded = candidate === "~" || candidate.startsWith("~/")
		? path.resolve(os.homedir(), candidate.slice(2))
		: path.resolve(cwd, candidate);
	const target = canonicalPotentialPath(expanded);
	if (!root || !target) return false;
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** A filesystem root, missing directory, or unreadable cwd cannot prove a project boundary. */
function canonicalWorkspaceRoot(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolved = path.resolve(cwd);
	if (resolved === path.parse(resolved).root) return undefined;
	try {
		if (!fs.statSync(resolved).isDirectory()) return undefined;
		const real = fs.realpathSync.native(resolved);
		return real === path.parse(real).root ? undefined : real;
	} catch {
		return undefined;
	}
}

/** Resolve symlinks even for a not-yet-created file by canonicalizing its nearest existing ancestor. */
function canonicalPotentialPath(candidate: string): string | undefined {
	let current = path.resolve(candidate);
	const missing: string[] = [];
	try {
		while (!fs.existsSync(current)) {
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			missing.unshift(path.basename(current));
			current = parent;
		}
		return path.resolve(fs.realpathSync.native(current), ...missing);
	} catch {
		return undefined;
	}
}

function statusFor(eventName: string, notificationType: string | undefined): TaskStatus {
	switch (eventName) {
		case "PermissionRequest":
			return "APPROVAL";
		case "Notification":
			return notificationType === "permission_prompt" || notificationType === "elicitation_dialog" || notificationType === "idle_prompt"
				? "NEEDS_INPUT"
				: "RUNNING";
		case "StopFailure":
			return "ERROR";
		case "Stop":
		case "SessionEnd":
			return "DONE_UNREAD";
		case "SessionStart":
		case "UserPromptSubmit":
		case "PreToolUse":
		case "PostToolUse":
		case "CwdChanged":
		default:
			return "RUNNING";
	}
}

/** Converts the documented Claude hook envelope into the shared Task model. */
export function parseClaudeHookEvent(input: unknown, hookMode: "observe" | "blocking" = "observe"): ClaudeHookEvent | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as JsonRecord;
	const transcriptPath = stringField(raw, "transcript_path", "transcriptPath");
	const agentType = stringField(raw, "agent_type", "agentType");
	if (raw.isSidechain === true || /(?:^|[\\/])subagents?(?:[\\/]|$)/i.test(transcriptPath ?? "") || /subagent|sidechain|guardian/i.test(agentType ?? "")) return null;
	const sessionId = stringField(raw, "session_id", "sessionId");
	if (!sessionId) return null;
	const eventName = stringField(raw, "hook_event_name", "hookEventName", "event") ?? "Notification";
	const hookCwd = stringField(raw, "cwd");
	const cwd = hookCwd ?? process.cwd();
	const toolName = stringField(raw, "tool_name", "toolName") ?? "";
	const toolInput = objectField(raw, "tool_input", "toolInput");
	const notificationType = stringField(raw, "notification_type", "notificationType");
	const now = Date.now();
	const status = eventName === "PermissionRequest" && hookMode === "observe" ? "RUNNING" : statusFor(eventName, notificationType);
	const taskId = `claude:${sessionId}`;
	const request = eventName === "PermissionRequest" && hookMode === "blocking"
		? {
			requestId: uniqueRequestId(sessionId),
			humanRequired: true,
			type: "permission",
			target: summarizeTarget(toolName, toolInput),
			riskTier: riskTier(toolName, toolInput, hookCwd),
			createdAt: now,
			expiresAt: now + 10 * 60_000,
			decisionPath: hookMode === "blocking" ? "claude-hook" : null,
		} satisfies TaskRequest
		: undefined;
	const title = request?.target ?? (eventName === "SessionEnd" ? "Session ended" : eventName.replace(/([a-z])([A-Z])/g, "$1 $2"));
	const task = baseTask(
		"claude",
		{
			taskId,
			externalId: sessionId,
			projectId: cwd,
			projectLabel: projectLabelFromCwd(cwd, "CLAUDE"),
			cwd,
			titleShort: safeTaskTitle(title, "Claude session"),
			reasoningEffort: normalizeReasoningEffort(stringField(raw, "effort", "effortLevel")),
			model: stringField(raw, "model"),
			status,
			lastEventAt: now,
			startedAt: now,
			source: "hook-event",
			openRef: { kind: "url", value: `claude://resume?session=${encodeURIComponent(sessionId)}` },
		},
		{
			approve: status === "APPROVAL" && hookMode === "blocking",
			reject: status === "APPROVAL" && hookMode === "blocking",
			// ClaudeHookAdapter enables desktop interrupt only after assigning a per-prompt
			// execution identity to this event.
			interrupt: false,
			review: true,
			verify: true,
		},
	);
	if (request) task.request = request;
	if (eventName === "UserPromptSubmit") task.progress.turnStartedAt = now;
	if (toolName && ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(eventName)) {
		task.progress.latestActivity = {
			category: activityCategoryForTool(toolName), label: safeTaskTitle(toolName, "Tool"), at: now,
			state: eventName === "PreToolUse" ? "running" : eventName === "PostToolUseFailure" ? "error" : "done",
		};
	}
	const processId = numberField(raw, "process_id", "processId", "pid");
	if (processId && processId > 1) task.processId = processId;
	if (status === "DONE_UNREAD" || status === "ERROR") task.reviewRef = { kind: "log", value: transcriptPath ?? path.join(cwd, ".claude") };
	return { eventName, task, request, terminal: eventName === "Stop" || eventName === "StopFailure" || eventName === "SessionEnd" };
}

export function claudeDecisionResponse(eventName: "PermissionRequest", decision: "allow" | "deny", message: string): JsonRecord {
	return {
		hookSpecificOutput: {
			hookEventName: eventName,
			decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message },
		},
	};
}
