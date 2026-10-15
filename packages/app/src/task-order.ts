import { isLiveTask, type Task } from "@streamdeck-supervisor/shared";

const ACTIVE_STATUS_RANK = new Map<Task["status"], number>([
	["APPROVAL", 0],
	["NEEDS_INPUT", 1],
	["RUNNING", 2],
	["QUEUED", 3],
]);

export interface DesktopTaskGroups {
	active: Task[];
	history: Task[];
}

export function groupDesktopTasks(tasks: readonly Task[]): DesktopTaskGroups {
	const active: Task[] = [];
	const history: Task[] = [];
	for (const task of tasks) {
		if (ACTIVE_STATUS_RANK.has(task.status)) active.push(task);
		else history.push(task);
	}
	active.sort((a, b) => activeRank(a) - activeRank(b) || b.lastEventAt - a.lastEventAt);
	history.sort(newestFirst);
	return { active, history };
}

/** Live Turns use wall time; terminal Turns keep their final reduced duration. */
export function taskDurationMs(task: Pick<Task, "status" | "progress">, now = Date.now()): number {
	if (isLiveTask(task) && task.progress.turnStartedAt) return Math.max(0, now - task.progress.turnStartedAt);
	return Math.max(0, task.progress.durationMs ?? 0);
}

function activeRank(task: Task): number {
	return ACTIVE_STATUS_RANK.get(task.status) ?? Number.MAX_SAFE_INTEGER;
}

function newestFirst(a: Task, b: Task): number {
	return b.lastEventAt - a.lastEventAt || a.taskId.localeCompare(b.taskId);
}
