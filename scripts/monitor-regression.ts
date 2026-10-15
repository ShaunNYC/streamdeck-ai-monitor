import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, type Task, type SystemStatus } from "@streamdeck-supervisor/shared";
import { MonitorStore, localDay } from "../packages/daemon/src/monitor-store.js";
import { DeviceState, deviceState } from "../packages/device/src/state.js";
import { DeviceController, buildMainTileModels } from "../packages/device/src/device-controller.js";
import { renderTaskColumnKey, renderMainTile } from "../packages/device/src/render.js";
import { daemonClient } from "../packages/device/src/daemon-client.js";
async function main() {
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"neo-monitor-test-"));
const make=(id:string, agent:Task['agent']='codex'):Task=>({ taskId:id,agent,executionId:'turn1',externalId:id,projectId:'p',projectLabel:'Project',titleShort:'Build interface',status:'RUNNING',ownership:'observer',attentionCount:0,capabilities:taskCapabilities(),progress:emptyTaskProgress(),openRef:{kind:'url',value:'codex://threads/'+id},source:'mock',lastEventAt:1,startedAt:1 });
const healthy={codex:true,claude:true};
const a=make('a'),b=make('b'),c=make('c','claude');
const start=new Date(2026,11,31,23,59,59).getTime();
const file=path.join(temp,'monitor.json'); const store=new MonitorStore(file);
try {
 store.update([a,b,c],healthy,start);
 let data=store.update([a,b,c],healthy,start+2000);
 assert.deepEqual(data.days[localDay(start)],{codex:1000,claude:1000});
 assert.deepEqual(data.days[localDay(start+2000)],{codex:1000,claude:1000});
 a.status='NEEDS_INPUT'; b.status='PAUSED';
 store.update([a,b,c],healthy,start+3000);
 data=store.update([a,b,c],healthy,start+4000);
 assert.equal(data.days[localDay(start+4000)]?.codex,2000);
 assert.equal(data.days[localDay(start+4000)]?.claude,3000);
 data=store.update([a,b,c],healthy,start+64000);
 assert.equal(data.days[localDay(start+4000)]?.claude,3000,'sleep gap excluded');
 data=store.update([a,b,c],{codex:true,claude:false},start+65000);
 assert.equal(data.days[localDay(start+4000)]?.claude,3000,'offline excluded');
 const reopened=new MonitorStore(file); data=reopened.update([a,b,c],healthy,start+80000);
 assert.equal(data.days[localDay(start+4000)]?.claude,3000,'restart gap excluded');
 const many=Array.from({length:13},(_,i)=>({...make('slot'+i),startedAt:i+1}));
 const slots=new MonitorStore(); let state=slots.update(many,healthy,start);
 assert.equal(state.slots.codex.length,12);
 many[0]!.status='ERROR'; state=slots.update(many,healthy,start+1000);
 assert.equal(state.slots.codex[0]?.taskId,'slot0','stopped position retained');
 assert.equal(slots.dismiss(many[1]!,'turn1'),false,'cannot clear running task');
 assert.equal(slots.dismiss(many[0]!,'wrong'),false,'execution identity checked');
 assert.equal(slots.dismiss(many[0]!,'turn1'),true);
 state=slots.update(many,healthy,start+2000);
 assert.equal(state.slots.codex.find(s=>s.slot===11)?.taskId,'slot12');
 assert.equal(state.slots.codex.find(s=>s.slot===11)?.durationMs,2000,'overflow also accumulates duration');
 many[12]!.status='DONE'; assert.ok(slots.dismiss(many[12]!,'turn1'));
 many[0]!.status='RUNNING'; many[0]!.executionId='turn2'; state=slots.update(many,healthy,start+3000);
 assert.equal(state.slots.codex.find(s=>s.slot===11)?.taskId,'slot0','new execution reappears');
 const status: SystemStatus={daemonUptimeMs:0,daemonPid:1,adapters:{codex:{status:'OK',lastPollAt:start},claude:{status:'OK',lastPollAt:start},workflow:{status:'OK',lastPollAt:start}},configuredProjectCount:1,runningTaskCount:3,monitor:state};
 const focus={selectedTaskId:{codex:'a',claude:'c'},activeAgent:'codex' as const,newChatAgent:'codex' as const};
 a.status='RUNNING';a.progress={...emptyTaskProgress(),todoTotal:4,todoCompleted:2,latestActivity:{at:1,category:'shell',label:'Testing',state:'running'}};
 c.progress={...emptyTaskProgress(),latestActivity:{at:2,category:'image',label:'Generating image',state:'running'}};
 const view=new DeviceState();view.setSnapshot([a,b,c],focus,status);
 const models=buildMainTileModels(view);
 assert.equal(models[5]?.detail,'Generating image','latest activity across agents');
 assert.deepEqual(models[6]?.process,{kind:'progress',completed:2,total:4,liveTaskCount:2,unknownCount:1});
 assert.equal(models[7]?.accent, '#7A9DFF', 'timer color follows explicit selection');
 assert.equal(models[7]?.detail, '0S', 'timer shows only today duration');
 assert.match(renderMainTile(models[6]!),/1 NO PLAN/);
 assert.match(renderTaskColumnKey(a,true,120000,start),/data-ratio="0.5000"/);
 assert.notEqual(renderTaskColumnKey(c,true,1000,start),renderTaskColumnKey(c,true,1000,start+1000),'unknown progress animates');
 c.status='PAUSED';assert.equal(renderTaskColumnKey(c,true,1000,start),renderTaskColumnKey(c,true,1000,start+1000),'paused does not animate');
 deviceState.setSnapshot(many,focus,status);
 const controller=new DeviceController() as any;
 controller.movePage(-1); assert.equal(controller.page,-1);
 controller.handleStateChange();assert.equal(controller.page,-1);
 for(let i=0;i<9;i++)controller.movePage(-1);assert.equal(controller.page,-3);
 for(let i=0;i<9;i++)controller.movePage(1);assert.equal(controller.page,0,'Empty Claude pages cannot be entered');
 controller.page=-1;
 const calls:unknown[]=[];const original=daemonClient.sendTaskAction;
 daemonClient.sendTaskAction=async(type,payload)=>{calls.push({type,payload});return true;};
 try {
  many.find(t=>t.taskId===state.slots.codex.find(s=>s.slot===0)!.taskId)!.status='PAUSED';deviceState.setSnapshot(many,focus,status);
  controller.handleDown({index:4});await new Promise(r=>setTimeout(r,1050));await controller.handleUp({index:4});
  assert.equal((calls[0] as any).type,'action.dismissDeviceTask'); assert.equal(calls.length,1,'hold does not also open');
 } finally { daemonClient.sendTaskAction=original;controller.clearPhysicalPress(); }

 // Returning home clears every stopped execution from the side just visited.
 for (const agent of ["codex", "claude"] as const) {
  const other = agent === "codex" ? "claude" : "codex";
  const items = Array.from({length:13}, (_,i) => ({...make(`home-${agent}-${i}`,agent),startedAt:i+1}));
  const opposite = make(`home-${other}`,other);
  const homeFile = path.join(temp,`home-${agent}.json`);
  const home = new MonitorStore(homeFile);
  home.update([...items,opposite],healthy,start);
  items[0]!.status="DONE"; items[4]!.status="DONE_UNREAD"; items[8]!.status="ERROR";
  opposite.status="DONE";
  let homeState = home.update([...items,opposite],healthy,start+1000);
  assert.equal(homeState.slots[agent][0]?.taskId,items[0]!.taskId,"Completion stays in its original column");
  const publish = () => deviceState.setSnapshot([...items,opposite],focus,{...status,monitor:homeState});
  publish();
  const navigation = new DeviceController() as any;
  const requests:any[]=[];
  const send=daemonClient.sendDismissCompleted;
  daemonClient.sendDismissCompleted=async request=>{ requests.push(request); return true; };
  try {
   navigation.page=agent === "codex" ? -2 : 2;
   navigation.movePage(agent === "codex" ? 1 : -1);
   assert.equal(requests.length,0,"Moving between detail pages does not clear");
   navigation.movePage(agent === "codex" ? 1 : -1);
   assert.equal(navigation.page,0);
   assert.equal(requests.length,1);
   assert.equal(requests[0].agent,agent);
   assert.deepEqual(requests[0].executions.map((x:any)=>x.taskId),[items[0]!.taskId,items[4]!.taskId,items[8]!.taskId]);
   // A newer execution and a completion after navigation must survive the request.
   items[0]!.status="RUNNING"; items[0]!.executionId="turn2";
   items[2]!.status="DONE";
   home.dismissCompleted([...items,opposite],requests[0]);
   homeState=home.update([...items,opposite],healthy,start+2000); publish();
   assert.ok(homeState.slots[agent].some(s=>s.taskId===items[0]!.taskId));
   assert.ok(homeState.slots[agent].some(s=>s.taskId===items[2]!.taskId));
   assert.ok(!homeState.slots[agent].some(s=>s.taskId===items[4]!.taskId));
   assert.equal(homeState.slots[other][0]?.taskId,opposite.taskId);
   assert.deepEqual(homeState.slots[agent].map(s=>s.slot),Array.from({length:11},(_,i)=>i));
   assert.ok(homeState.slots[agent].some(s=>s.taskId===items[12]!.taskId),"Overflow appends after retained tasks");
   home.dismissCompleted([...items,opposite],requests[0]);
   homeState=home.update([...items,opposite],healthy,start+3000);
   const restored=new MonitorStore(homeFile).update([...items,opposite],healthy,start+4000);
   assert.ok(!restored.slots[agent].some(s=>s.taskId===items[4]!.taskId),"Dismissal survives restart");
   items[4]!.status="RUNNING"; items[4]!.executionId="turn2";
   assert.equal(home.dismiss(items[8]!,"turn1"),false,"The error was already cleared on return home");
   homeState=home.update([...items,opposite],healthy,start+5000);
   assert.equal(homeState.slots[agent][11]?.taskId,items[4]!.taskId,"New execution becomes eligible again");
   publish();
   // Failure does not mutate the authoritative slots or pretend the clear succeeded.
   daemonClient.sendDismissCompleted=async()=>false;
   navigation.page=agent === "codex" ? -1 : 1;
   navigation.stopped=false;
   navigation.movePage(agent === "codex" ? 1 : -1);
   await Promise.resolve();
   assert.equal(navigation.feedback?.message,"CLEAR FAILED");
   navigation.clearFeedback();
   for (const item of items) item.status="DONE";
   homeState=home.update([...items,opposite],healthy,start+6000);
   home.dismissCompleted([...items,opposite],{agent,executions:homeState.slots[agent].map(({taskId,executionId})=>({taskId,executionId}))});
   homeState=home.update([...items,opposite],healthy,start+7000);publish();
   assert.equal(homeState.slots[agent].length,0);
   navigation.page=0;navigation.movePage(agent === "codex" ? -1 : 1);
   assert.equal(navigation.page,0,"Empty side cannot be entered");
  } finally { daemonClient.sendDismissCompleted=send;navigation.clearPhysicalPress();navigation.clearFeedback(); }
 }
 console.log('[monitor-regression] union timing, midnight/year, downtime, stable slots, overflow, identity, mixed progress, activity and sticky pages: ok');
} finally {fs.rmSync(temp,{recursive:true,force:true});}

}
void main();
