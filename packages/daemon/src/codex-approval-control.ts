import type { CodexApprovalControlStatus, Task } from "@streamdeck-supervisor/shared";

const CODEX_BUNDLE_ID = "com.openai.codex";

export type CodexDecision = "approve" | "reject";
export type ApprovalDelay = (milliseconds: number) => Promise<void>;

export interface CodexApprovalControl {
	getStatus(): CodexApprovalControlStatus;
	submit(task: Task, decision: CodexDecision, isCurrent: () => boolean): Promise<void>;
}

export interface NativeCodexDecisionBridge {
	activateThread(url: string): boolean;
	frontmostBundleId(): string;
	postDecision(decision: CodexDecision): boolean;
}

export interface MacCodexApprovalControlOptions {
	getStatus: (force?: boolean) => CodexApprovalControlStatus;
	bridge: NativeCodexDecisionBridge;
	delay?: ApprovalDelay;
	frontmostTimeoutMs?: number;
}

/**
 * Sends one fixed Return/Escape event from the packaged main process. The task
 * title, command and request text never cross into the native bridge.
 */
export class MacCodexApprovalControl implements CodexApprovalControl {
	private readonly delay: ApprovalDelay;
	private readonly frontmostTimeoutMs: number;
	private lastError: string | undefined;

	constructor(private readonly options: MacCodexApprovalControlOptions) {
		this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		this.frontmostTimeoutMs = options.frontmostTimeoutMs ?? 5_000;
	}

	getStatus(): CodexApprovalControlStatus {
		const status = this.options.getStatus();
		return this.lastError && status.status === "READY" ? { ...status, lastError: this.lastError } : status;
	}

	async submit(task: Task, decision: CodexDecision, isCurrent: () => boolean): Promise<void> {
		this.lastError = undefined;
		try {
			if (this.options.getStatus(true).status !== "READY") throw new Error("Codex approval control is not ready");
			if (task.agent !== "codex" || !/^codex:\/\/threads\/[0-9a-f-]+$/i.test(task.openRef.value)) throw new Error("Codex approval target is invalid");
			if (!isCurrent()) throw new Error("Codex approval request is no longer active");
			if (!this.options.bridge.activateThread(task.openRef.value)) throw new Error("Codex could not be opened");
			const deadline = Date.now() + this.frontmostTimeoutMs;
			while (Date.now() < deadline && this.options.bridge.frontmostBundleId() !== CODEX_BUNDLE_ID) {
				if (!isCurrent()) throw new Error("Codex approval request changed while opening the chat");
				await this.delay(100);
			}
			if (this.options.bridge.frontmostBundleId() !== CODEX_BUNDLE_ID) throw new Error("Codex did not become the frontmost application");
			await this.delay(180);
			if (!isCurrent()) throw new Error("Codex approval request changed before the shortcut was sent");
			if (this.options.getStatus(true).status !== "READY") throw new Error("Codex keyboard-control permission is no longer available");
			if (!this.options.bridge.postDecision(decision)) throw new Error("The native Codex shortcut could not be posted");
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}
}

export class UnavailableCodexApprovalControl implements CodexApprovalControl {
	getStatus(): CodexApprovalControlStatus {
		return { status: "UNAVAILABLE", lastCheckedAt: Date.now() };
	}
	async submit(): Promise<void> { throw new Error("Codex approval control is unavailable outside the desktop app"); }
}

/** Standalone daemons cannot own macOS input permission; use the packaged App. */
export function createDefaultCodexApprovalControl(): CodexApprovalControl {
	return new UnavailableCodexApprovalControl();
}
