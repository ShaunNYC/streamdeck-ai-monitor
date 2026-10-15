import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText, sanitizeEnvironment, type AgentKind, type Task } from "@streamdeck-supervisor/shared";
import { getDataDirectory } from "./config.js";
import type { TaskRegistry } from "./task-registry.js";
import type { AuditLogger } from "./audit-log.js";

export type ReadAction = "open" | "review" | "verify";
export type CommandRunner = (command: string, args: string[]) => Promise<void>;

export interface TaskControlOptions {
	interruptCodex?: (threadId: string, turnId: string) => Promise<void>;
	isClaudeProcess?: (pid: number) => boolean;
	interruptClaude?: (pid: number) => void;
}

const APP_BUNDLE_IDS: Record<AgentKind, string> = {
	codex: "com.openai.codex",
	claude: "com.anthropic.claudefordesktop",
};

const NEW_CHAT_URLS: Record<AgentKind, string> = {
	codex: "codex://threads/new",
	claude: "claude://claude.ai/new",
};

export class TaskActionService {
	private readonly runningVerifications = new Set<string>();
	private readonly logDirectory = path.join(getDataDirectory(), "logs");

	constructor(
		private readonly registry: TaskRegistry,
		private readonly audit: AuditLogger,
		private readonly runCommand: CommandRunner = run,
		private readonly controls: TaskControlOptions = {},
	) {}

	async runReadAction(action: ReadAction, task: Task): Promise<void> {
		switch (action) {
			case "open":
				await this.open(task);
				this.registry.acknowledgeReview(task.taskId);
				return;
			case "review":
				await this.review(task);
				this.registry.acknowledgeReview(task.taskId);
				return;
			case "verify":
				this.verify(task);
				return;
		}
	}

	async openAgent(agent: AgentKind): Promise<void> {
		const task = this.registry.getSelectedTask(agent);
		if (task) await this.open(task);
		else await this.activateAgentApp(agent);
		// Opening is the transaction boundary: a failed deep link must not change
		// focus or the persistent New Chat target.
		this.registry.activateAgent(agent);
		if (task) this.registry.acknowledgeReview(task.taskId);
	}

	async activateAgentApp(agent: AgentKind): Promise<void> {
		await this.runCommand("/usr/bin/open", ["-b", APP_BUNDLE_IDS[agent]]);
	}

	async newChat(agent: AgentKind): Promise<void> {
		await this.runCommand("/usr/bin/open", ["-b", APP_BUNDLE_IDS[agent], NEW_CHAT_URLS[agent]]);
	}

	async newCodexChat(): Promise<void> {
		await this.newChat("codex");
	}

	async stop(task: Task, executionId: string): Promise<boolean> {
		const current = this.registry.getTask(task.taskId);
		if (!current?.executionId
			|| current.executionId !== executionId
			|| current.agent !== task.agent
			|| current.status !== "RUNNING"
			|| !current.capabilities.desktop.interrupt) return false;
		try {
			if (current.agent === "codex") {
				if (!this.controls.interruptCodex) return false;
				await this.controls.interruptCodex(current.externalId, executionId);
			} else {
				if (!current.processId || current.processId <= 1) return false;
				const isClaudeProcess = this.controls.isClaudeProcess ?? isExpectedClaudeProcess;
				if (!isClaudeProcess(current.processId)) return false;
				(this.controls.interruptClaude ?? interruptClaudeProcess)(current.processId);
			}
			return this.registry.pauseExecution(current.taskId, executionId);
		} catch {
			return false;
		}
	}

	private async open(task: Task): Promise<void> {
		if (task.agent === "codex" && /^codex:\/\/threads\/[0-9a-f-]+$/i.test(task.openRef.value)) {
			// Target the registered Codex Desktop bundle explicitly. This both
			// activates ChatGPT/Codex and routes the deep link to the exact thread
			// containing the pending request_user_input card.
			await this.runCommand("/usr/bin/open", ["-b", APP_BUNDLE_IDS.codex, task.openRef.value]);
			return;
		}
		await this.runCommand("/usr/bin/open", [task.openRef.value]);
	}

	private async review(task: Task): Promise<void> {
		const reference = task.reviewRef;
		if (reference?.kind === "log" && fs.existsSync(reference.value)) {
			await this.runCommand("open", [reference.value]);
			return;
		}
		if (reference?.kind === "pr") {
			await this.runCommand("open", [reference.value]);
			return;
		}
		const cwd = task.cwd ?? task.verifyProfile?.cwd;
		if (!cwd) {
			await this.runCommand("open", [task.verifyProfile?.cwd ?? process.cwd()]);
			return;
		}
		const startedAt = Date.now();
		const summary = await capture("/usr/bin/git", ["diff", "--stat"], cwd);
		const detail = await capture("/usr/bin/git", ["diff"], cwd);
		const output = [summary.output, detail.output].filter(Boolean).join("\n\n");
		const logPath = this.writeLog(task, startedAt, output || "No uncommitted Git changes.");
		this.registry.upsertTask({ ...task, reviewRef: { kind: "log", value: logPath }, lastEventAt: Date.now() });
		await this.runCommand("open", [logPath]);
	}

	private verify(task: Task): void {
		if (!task.verifyProfile || this.runningVerifications.has(task.taskId)) return;
		this.runningVerifications.add(task.taskId);
		const startedAt = Date.now();
		this.audit.record({ action: "verify", agent: task.agent, taskId: task.taskId, outcome: "started" });
		this.registry.upsertTask({
			...task,
			workflow: { kind: "verify", state: "running", lastRunAt: startedAt },
		});

		const child = spawn("/bin/zsh", ["-lc", task.verifyProfile.command], {
			cwd: task.verifyProfile.cwd,
			env: { ...sanitizeEnvironment(process.env), NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const append = (chunk: Buffer) => {
			if (output.length < 64_000) output += chunk.toString("utf8").slice(0, 64_000 - output.length);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timer = setTimeout(() => child.kill("SIGTERM"), task.verifyProfile.timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			this.runningVerifications.delete(task.taskId);
			const completedAt = Date.now();
			const passed = code === 0 && !signal;
			this.audit.record({ action: "verify", agent: task.agent, taskId: task.taskId, outcome: passed ? "pass" : "fail", detail: signal ? `signal:${signal}` : `exit:${code ?? "unknown"}` });
			const logPath = this.writeLog(task, startedAt, output || (signal ? `Verification timed out or was stopped (${signal}).` : `Exited with code ${code ?? "unknown"}.`));
			this.registry.upsertTask({
				...task,
				reviewRef: { kind: "log", value: logPath },
				workflow: { kind: "verify", state: passed ? "pass" : "fail", lastRunAt: completedAt, logPath },
			});
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			this.runningVerifications.delete(task.taskId);
			const completedAt = Date.now();
			this.audit.record({ action: "verify", agent: task.agent, taskId: task.taskId, outcome: "fail", detail: error.name });
			const logPath = this.writeLog(task, startedAt, error.message);
			this.registry.upsertTask({
				...task,
				reviewRef: { kind: "log", value: logPath },
				workflow: { kind: "verify", state: "fail", lastRunAt: completedAt, logPath },
			});
		});
	}

	private writeLog(task: Task, startedAt: number, output: string): string {
		fs.mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 });
		const file = path.join(this.logDirectory, `${task.taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${startedAt}.log`);
		fs.writeFileSync(file, redactSensitiveText(output), { encoding: "utf8", mode: 0o600 });
		try { fs.chmodSync(file, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
		return file;
	}
}

function isExpectedClaudeProcess(pid: number): boolean {
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000 });
	if (result.status !== 0) return false;
	const command = result.stdout.trim();
	const executable = command.split(/\s+/, 1)[0] ?? "";
	if (/(^|\/)claude$/i.test(executable)) return true;
	return /(^|\s)(?:\S*\/)?node(?:\s|$)[\s\S]*(?:@anthropic-ai\/claude-code|\/claude-code\/[^\s]*cli)/i.test(command);
}

function interruptClaudeProcess(pid: number): void {
	process.kill(pid, "SIGINT");
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "unknown"}`)));
	});
}

function capture(command: string, args: string[], cwd: string): Promise<{ output: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const append = (chunk: Buffer) => { if (output.length < 64_000) output += chunk.toString("utf8").slice(0, 64_000 - output.length); };
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", reject);
		child.once("close", (code) => resolve({ output, code }));
	});
}
