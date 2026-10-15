import fs from "node:fs";
import path from "node:path";
import { isClearableTask, isLiveTask, taskExecutionKey, type AgentKind, type Task, type MonitorSummary, type DismissCompletedDeviceTasksPayload } from "@streamdeck-supervisor/shared";

export function localDay(at: number): string {
 const d = new Date(at);
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
export const executionKey = taskExecutionKey;
/** Independent of task history. Downtime is never reconstructed from persisted timestamps. */
export class MonitorStore {
 private data: MonitorSummary = { days: {}, slots: { codex: [], claude: [] } };
 private durations: Record<string, { executionId: string; durationMs: number }> = {};
 private dismissed: Record<string, string> = {};
 private lastAt?: number;
 private running = new Map<string, { agent: AgentKind; executionId: string }>();
 private savedAt = 0;
 private slotsDirty = false;
 constructor(private file?: string) {
  if (file) try {
   const raw = JSON.parse(fs.readFileSync(file,"utf8"));
   if (raw.version === 1 && raw.data?.days && Array.isArray(raw.data.slots?.codex) && Array.isArray(raw.data.slots?.claude)) {
    this.data = raw.data; this.dismissed = raw.dismissed ?? {}; this.durations = raw.durations ?? {};
   }
  } catch { /* New installation or damaged data: do not invent history. */ }
 }
 update(tasks: Task[], healthy: Record<AgentKind, boolean>, now = Date.now()): MonitorSummary {
  // A delayed timer after sleep or process suspension must not count that gap.
  if (this.lastAt !== undefined && now >= this.lastAt && now-this.lastAt <= 5_000) {
   const elapsed = now-this.lastAt;
   for (const agent of ["codex","claude"] as const) {
    if (!healthy[agent] || ![...this.running.values()].some(t => t.agent === agent)) continue;
    let at = this.lastAt;
    while (at < now) {
     const midnight = new Date(at); midnight.setHours(24,0,0,0);
     const end = Math.min(now,midnight.getTime());
     const day = this.data.days[localDay(at)] ??= { codex: 0, claude: 0 };
     day[agent] += end-at; at=end;
    }
    for (const [id, running] of this.running) {
     if (running.agent !== agent) continue;
     const duration = this.durations[id] ??= {executionId: running.executionId, durationMs: 0};
     if (duration.executionId === running.executionId) duration.durationMs += elapsed;
    }
   }
  }
  this.lastAt = now;
  for (const task of tasks) if (this.durations[task.taskId]?.executionId !== executionKey(task)) this.durations[task.taskId] = {executionId: executionKey(task), durationMs: 0};
  this.running = new Map(tasks.filter(t => t.status === "RUNNING" && healthy[t.agent]).map(t => [t.taskId,{agent:t.agent,executionId:executionKey(t)}]));
  let changed = this.slotsDirty;
  for (const agent of ["codex","claude"] as const) {
   // Registry retention can remove old tasks; absent identities must not leave holes.
   const present = new Set(tasks.filter(t => t.agent === agent).map(t => t.taskId));
   const before = this.data.slots[agent].length;
   this.data.slots[agent] = this.data.slots[agent].filter(s => present.has(s.taskId));
   changed = this.compact(agent) || before !== this.data.slots[agent].length || changed;
   const slots=this.data.slots[agent];
   for (const slot of slots) {
    const task=tasks.find(t=>t.taskId===slot.taskId);
    slot.durationMs = this.durations[slot.taskId]?.durationMs ?? slot.durationMs;
    if (task && executionKey(task)!==slot.executionId) { slot.executionId=executionKey(task); slot.durationMs=0; changed=true; }
   }
   const candidates=tasks.filter(t=>t.agent===agent && isLiveTask(t)).sort((a,b)=>a.startedAt-b.startedAt || a.taskId.localeCompare(b.taskId));
   for (const task of candidates) {
    if (slots.length>=12) break;
    if (slots.some(s=>s.taskId===task.taskId) || this.dismissed[task.taskId]===executionKey(task)) continue;
    let slot=0; while(slots.some(s=>s.slot===slot)) slot++;
    slots.push({taskId:task.taskId,executionId:executionKey(task),slot,durationMs:this.durations[task.taskId]?.durationMs ?? 0}); changed=true;
   }
  }
  if (changed || now-this.savedAt>=1_000) { this.flush(); this.savedAt=now; this.slotsDirty=false; }
  return structuredClone(this.data);
 }
 resetClock(): void { this.lastAt = undefined; this.running.clear(); }
 getDismissedExecutions(): Array<{ taskId: string; executionId: string }> {
  return Object.entries(this.dismissed).filter(([,id]) => typeof id === "string").map(([taskId,executionId]) => ({taskId,executionId}));
 }
 selectAgent(agent: AgentKind): void { this.data.selectedAgent = agent; this.flush(); }
 dismiss(task: Task, executionId: string): boolean {
  if (!isClearableTask(task) || executionKey(task)!==executionId) return false;
  const slots=this.data.slots[task.agent];
  if (!slots.some(s=>s.taskId===task.taskId && s.executionId===executionId)) return false;
  this.data.slots[task.agent]=slots.filter(s=>s.taskId!==task.taskId);
  this.compact(task.agent);
  this.dismissed[task.taskId]=executionId; this.flush(); return true;
 }
 dismissCompleted(tasks: Task[], request: DismissCompletedDeviceTasksPayload): void {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const requested = new Map(request.executions.map(item => [item.taskId, item.executionId]));
  this.data.slots[request.agent] = this.data.slots[request.agent].filter(slot => {
   const task = byId.get(slot.taskId);
   if (!task || task.agent !== request.agent || !isClearableTask(task)
    || requested.get(task.taskId) !== slot.executionId || executionKey(task) !== slot.executionId) return true;
   this.dismissed[task.taskId] = slot.executionId;
   return false;
  });
  this.compact(request.agent);
  this.slotsDirty = true;
 }
 private compact(agent: AgentKind): boolean {
  let changed = false;
  this.data.slots[agent].sort((a,b) => a.slot-b.slot).forEach((item, index) => {
   if (item.slot !== index) { item.slot = index; changed = true; }
  });
  return changed;
 }
 flush(): void {
  if (!this.file) return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
  const temporary=this.file+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({version:1,data:this.data,dismissed:this.dismissed,durations:this.durations}),{mode:0o600});
  fs.renameSync(temporary,this.file);
 }
}
