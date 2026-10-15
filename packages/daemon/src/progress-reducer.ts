import { emptyTaskProgress, redactSensitiveText, type ActivityCategory, type TaskProgress } from "@streamdeck-supervisor/shared";

export type ProgressTerminalState = "completed" | "error" | "interrupted";

export type ProgressEvent =
	| { id: string; at: number; turnId: string; type: "turn.started" }
	| { id: string; at: number; turnId: string; type: "turn.terminal"; terminal: ProgressTerminalState }
	| { id: string; at: number; turnId: string; type: "activity"; category: ActivityCategory; label: string; state: "running" | "done" | "error" | "waiting" }
	| { id: string; at: number; turnId: string; type: "todo"; items: Array<{ text: string; completed: boolean; active?: boolean }> }
	| { id: string; at: number; turnId: string; type: "subagent"; childId: string; state: "started" | "completed" | "error" }
	| { id: string; at: number; turnId: string; type: "input"; label?: string }
	| { id: string; at: number; turnId: string; type: "queue"; length: number; failed: number }
	| { id: string; at: number; turnId: string; type: "recap"; text: string };

export interface ProgressReduction {
	progress: TaskProgress;
	terminal?: ProgressTerminalState;
	waitingInput: boolean;
}

/**
 * Rebuilds progress from a replayable event stream. Event ids are deduplicated,
 * and only the latest terminal event for a turn can affect the result.
 */
export function reduceProgressEvents(events: readonly ProgressEvent[], now = Date.now()): ProgressReduction {
	const unique = new Map<string, ProgressEvent>();
	for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event);
	// Array#sort is stable: retain transport/replay order when events share the
	// same millisecond instead of letting arbitrary ids invert start/completion.
	const ordered = [...unique.values()].sort((a, b) => a.at - b.at);
	const terminalByTurn = new Map<string, Extract<ProgressEvent, { type: "turn.terminal" }>>();
	for (const event of ordered) {
		if (event.type !== "turn.terminal") continue;
		const previous = terminalByTurn.get(event.turnId);
		if (!previous || event.at >= previous.at) terminalByTurn.set(event.turnId, event);
	}

	let progress = emptyTaskProgress();
	const activeSubagents = new Set<string>();
	const allSubagents = new Set<string>();
	let activeTurnId: string | undefined;
	let terminal: ProgressTerminalState | undefined;
	let waitingInput = false;
	for (const event of ordered) {
		if (event.type === "turn.started") {
			progress = emptyTaskProgress();
			activeSubagents.clear();
			allSubagents.clear();
			activeTurnId = event.turnId;
			terminal = undefined;
			waitingInput = false;
			progress.turnStartedAt = event.at;
			progress.durationMs = Math.max(0, now - event.at);
			continue;
		}
		if (event.type === "turn.terminal") {
			if (terminalByTurn.get(event.turnId)?.id !== event.id) continue;
			if (event.turnId === activeTurnId || !activeTurnId) {
				terminal = event.terminal;
				waitingInput = false;
				progress.durationMs = progress.turnStartedAt ? Math.max(0, event.at - progress.turnStartedAt) : progress.durationMs;
			}
			continue;
		}
		// Once a newer turn has started, process data from any older turn is
		// historical and must not repopulate Todo/activity/agent state.
		if (activeTurnId && event.turnId !== activeTurnId) continue;
		if (event.type === "activity") {
			progress.latestActivity = {
				category: event.category,
				label: safeProgressText(event.label, 52) || activityLabel(event.category),
				state: event.state,
				at: event.at,
			};
			continue;
		}
		if (event.type === "todo") {
			progress.todoTotal = event.items.length;
			progress.todoCompleted = event.items.filter((item) => item.completed).length;
			const current = event.items.find((item) => item.active) ?? event.items.find((item) => !item.completed);
			progress.currentTodo = current ? safeProgressText(current.text, 64) : undefined;
			continue;
		}
		if (event.type === "subagent") {
			allSubagents.add(event.childId);
			if (event.state === "started") activeSubagents.add(event.childId);
			else activeSubagents.delete(event.childId);
			progress.activeSubagents = activeSubagents.size;
			progress.totalSubagents = allSubagents.size;
			continue;
		}
		if (event.type === "input") {
			waitingInput = true;
			progress.latestActivity = {
				category: "input",
				label: safeProgressText(event.label ?? "Waiting for input", 52),
				state: "waiting",
				at: event.at,
			};
			continue;
		}
		if (event.type === "queue") {
			progress.queueLength = Math.max(0, event.length);
			progress.queueFailed = Math.max(0, event.failed);
			continue;
		}
		if (event.type === "recap") progress.recap = safeProgressText(event.text, 220) || progress.recap;
	}
	return { progress, terminal, waitingInput };
}

export function activityCategoryForTool(toolName: string): ActivityCategory {
	const name = toolName.toLowerCase();
	if (/imagegen|image_gen|generate_image/.test(name)) return "image";
	if (/shell|bash|exec|terminal|command/.test(name)) return "shell";
	if (/read|write|edit|patch|file|glob/.test(name)) return "file";
	if (/search|grep|find|web/.test(name)) return "search";
	if (/browser|computer|chrome|playwright/.test(name)) return "browser";
	if (/plan|todo|taskcreate|taskupdate/.test(name)) return "plan";
	if (/agent|collab|spawn|task$/.test(name)) return "agent";
	if (/question|input/.test(name)) return "input";
	return "other";
}

export function safeProgressText(value: string, maxLength: number): string {
	const normalized = redactSensitiveText(value)
		.replace(/<image[^>]*>/gi, " ")
		.replace(/[#*_`>]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function activityLabel(category: ActivityCategory): string {
	return ({
		image: "Generating image",
		thinking: "Thinking",
		shell: "Running command",
		file: "Editing files",
		search: "Searching",
		browser: "Using browser",
		plan: "Updating plan",
		agent: "Working with agent",
		input: "Waiting for input",
		terminal: "Finishing turn",
		other: "Working",
	})[category];
}
