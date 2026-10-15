export interface HoldClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

const SYSTEM_CLOCK: HoldClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (callback, delayMs) => setInterval(callback, delayMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface HoldCallbacks<T> {
	onProgress(progress: number, target: T): void;
	onTrigger(target: T): void;
	onCancel?(target: T): void;
}

/** A press-driven deadline: trigger occurs at the deadline, never on key-up. */
export class HoldGesture<T> {
	private target: T | undefined;
	private startedAt = 0;
	private triggered = false;
	private timeoutHandle: unknown;
	private intervalHandle: unknown;
	private callbacks: HoldCallbacks<T> | undefined;

	constructor(
		private readonly durationMs = 1_000,
		private readonly tickMs = 50,
		private readonly clock: HoldClock = SYSTEM_CLOCK,
	) {}

	start(target: T, callbacks: HoldCallbacks<T>): void {
		this.cancel(false);
		this.target = target;
		this.callbacks = callbacks;
		this.startedAt = this.clock.now();
		this.triggered = false;
		callbacks.onProgress(0, target);
		this.intervalHandle = this.clock.setInterval(() => this.emitProgress(), this.tickMs);
		this.timeoutHandle = this.clock.setTimeout(() => this.trigger(), this.durationMs);
	}

	release(): { wasHeld: boolean; triggered: boolean } {
		if (!this.target) return { wasHeld: false, triggered: false };
		const target = this.target;
		const triggered = this.triggered;
		const callbacks = this.callbacks;
		this.clearTimers();
		this.target = undefined;
		this.callbacks = undefined;
		if (!triggered) callbacks?.onCancel?.(target);
		return { wasHeld: true, triggered };
	}

	cancel(notify = true): void {
		if (!this.target) return;
		const target = this.target;
		const callbacks = this.callbacks;
		this.clearTimers();
		this.target = undefined;
		this.callbacks = undefined;
		this.triggered = false;
		if (notify) callbacks?.onCancel?.(target);
	}

	isHeld(): boolean { return this.target !== undefined; }
	hasTriggered(): boolean { return this.triggered; }
	getTarget(): T | undefined { return this.target; }

	private emitProgress(): void {
		if (!this.target || !this.callbacks || this.triggered) return;
		const progress = Math.min(1, Math.max(0, (this.clock.now() - this.startedAt) / this.durationMs));
		this.callbacks.onProgress(progress, this.target);
	}

	private trigger(): void {
		if (!this.target || !this.callbacks || this.triggered) return;
		this.triggered = true;
		this.callbacks.onProgress(1, this.target);
		this.callbacks.onTrigger(this.target);
		if (this.intervalHandle !== undefined) this.clock.clearInterval(this.intervalHandle);
		this.intervalHandle = undefined;
		this.timeoutHandle = undefined;
	}

	private clearTimers(): void {
		if (this.timeoutHandle !== undefined) this.clock.clearTimeout(this.timeoutHandle);
		if (this.intervalHandle !== undefined) this.clock.clearInterval(this.intervalHandle);
		this.timeoutHandle = undefined;
		this.intervalHandle = undefined;
	}
}
