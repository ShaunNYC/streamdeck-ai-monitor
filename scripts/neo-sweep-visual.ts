import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { emptyTaskProgress, taskCapabilities, type Task, type SystemStatus } from '@streamdeck-supervisor/shared';
import { DeviceState } from '../packages/device/src/state.js';
import { buildMainTileModels, buildTouchPointColors } from '../packages/device/src/device-controller.js';
import { renderMainTile, renderInfobar } from '../packages/device/src/render.js';

async function main() {
 const dir = path.resolve('artifacts/neo-sweep'); fs.mkdirSync(dir, {recursive:true});
 const actualNow = Date.now;
 const now = actualNow(); const d = new Date(now);
 const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 try {
  for (const agent of ['codex','claude'] as const) {
   const task: Task = {taskId:'demo', agent, ownership:'observer', externalId:'demo', projectId:'demo', projectLabel:'DEMO', titleShort:'Refresh device controls', status:'RUNNING', reasoningEffort:'xhigh', model:agent==='codex'?'gpt-6-astra':'claude-opus-4-6', attentionCount:0, capabilities:taskCapabilities(), progress:{...emptyTaskProgress(),todoCompleted:2,todoTotal:5,durationMs:180000,latestActivity:{category:'file',label:'Updating device UI',state:'running',at:now}},openRef:{kind:'url',value:''},source:'mock',lastEventAt:now,startedAt:now-180000};
   const status: SystemStatus = {daemonUptimeMs:0,daemonPid:0,configuredProjectCount:0,monitoringScope:'all-projects',runningTaskCount:1,adapters:{codex:{status:'OK',lastPollAt:now},claude:{status:'OK',lastPollAt:now},workflow:{status:'OK',lastPollAt:now}},monitor:{selectedAgent:agent,days:{[day]:{codex:12345000,claude:5340000}},slots:{codex:[],claude:[]}}};
   status.monitor!.slots[agent] = [{taskId:task.taskId,executionId:'1',slot:0,durationMs:180000}];
   const state = new DeviceState();state.setSnapshot([task],{selectedTaskId:{codex:agent==='codex'?'demo':null,claude:agent==='claude'?'demo':null},activeAgent:agent,newChatAgent:agent},status);
   const models=buildMainTileModels(state);
   assert.equal(models[5]!.process?.kind,'activity');
   assert.equal(models[7]!.detail!.includes(agent.toUpperCase()),false);
   const frames:Buffer[]=[];
   for(let frame=0;frame<33;frame++) {
    Date.now=()=>frame*80;
    const keys=models.map(renderMainTile);
    assert.ok(!keys[4]!.includes('>CODEX<') && !keys[4]!.includes('>CLAUDE<') && !keys[4]!.includes('>READY<'));
    assert.ok(keys[6]!.includes('>40%<') && keys[6]!.includes('~5M LEFT') && keys[6]!.includes('diagonal-sweep'));
    const leds=buildTouchPointColors(state);
    const ledSvg=`<svg width="424" height="58"><rect x="24" y="20" width="28" height="4" rx="2" fill="rgb(${leds.codex.join(',')})"/><rect x="372" y="20" width="28" height="4" rx="2" fill="rgb(${leds.claude.join(',')})"/></svg>`;
    const buffer=await sharp({create:{width:424,height:274,channels:4,background:'#000'}}).composite([...keys.map((svg,i)=>({input:Buffer.from(svg),left:8+(i%4)*104,top:8+Math.floor(i/4)*104})),{input:Buffer.from(ledSvg),left:0,top:216},{input:Buffer.from(renderInfobar({runningCount:1,pageLabel:'OVERVIEW'})),left:88,top:216}]).png().toBuffer();
    if(frame===16) fs.writeFileSync(path.join(dir,`${agent}.png`),buffer);
    if(agent==='codex') fs.writeFileSync(path.join(dir,`frame-${String(frame).padStart(2,'0')}.png`),buffer);
    frames.push(buffer);
   }
   assert.notDeepEqual(frames[8],frames[16], 'Rasterized sweep frames move');
   const unknown=structuredClone(models[6]!);if(unknown.process?.kind==='progress') { unknown.process.total=0;unknown.process.completed=0;unknown.process.unknownCount=1;delete unknown.process.estimatedRemainingMs; }
   assert.ok(renderMainTile(unknown).includes('>WORKING<') && !renderMainTile(unknown).includes('>%<'));
   const partial=structuredClone(models[6]!);if(partial.process?.kind==='progress') {partial.process.unknownCount=1;delete partial.process.estimatedRemainingMs;}
   assert.ok(renderMainTile(partial).includes('>2 / 5<') && !renderMainTile(partial).includes('>40%<'));
  }
 } finally { Date.now=actualNow; }
 console.log('[neo-sweep] both agents, moving light, clean labels, measured ETA and unknown-plan rendering: ok');
}
void main();
