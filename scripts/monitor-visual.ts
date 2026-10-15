import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { emptyTaskProgress,taskCapabilities,type Task,type SystemStatus } from '@streamdeck-supervisor/shared';
import { DeviceState } from '../packages/device/src/state.js';
import { buildMainTileModels } from '../packages/device/src/device-controller.js';
import { renderTaskColumnKey,renderMainTile,renderInfobar } from '../packages/device/src/render.js';
async function main() {
 const now=Date.now(),d=new Date(now); const day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const tasks:Task[]=['RUNNING','RUNNING','PAUSED','ERROR'].map((status,i)=>({taskId:'demo'+i,executionId:'turn',agent:i===1?'claude':'codex',ownership:'observer',externalId:'demo'+i,projectId:'demo',projectLabel:'PROJECT',titleShort:['更新桌面设置','生成宣传图片','修复登录页面','验证后台连接'][i]!,status:status as Task['status'],attentionCount:0,capabilities:taskCapabilities(),progress:{...emptyTaskProgress(),todoTotal:i===0?8:0,todoCompleted:i===0?3:0,durationMs:1234000,latestActivity:{category:i===1?'image':'file',state:'running',label:i===1?'Generating image':'Reading settings.ts',at:now+i}},openRef:{kind:'url',value:''},source:'mock',lastEventAt:now,startedAt:now-1234000}));
 const state=new DeviceState(); const status:SystemStatus={daemonUptimeMs:0,daemonPid:0,adapters:{codex:{status:'OK',lastPollAt:now},claude:{status:'OK',lastPollAt:now},workflow:{status:'OK',lastPollAt:now}},configuredProjectCount:0,monitoringScope:'all-projects',runningTaskCount:2,monitor:{selectedAgent:'codex',days:{[day]:{codex:12345000,claude:5340000}},slots:{codex:[],claude:[]}}};
 state.setSnapshot(tasks,{selectedTaskId:{codex:tasks[0]!.taskId,claude:tasks[1]!.taskId},activeAgent:'codex',newChatAgent:'codex'},status);
 const dir=path.resolve('artifacts/monitor-redesign/device');fs.mkdirSync(dir,{recursive:true});
 const pages={overview:buildMainTileModels(state).map(renderMainTile),tasks:Array.from({length:8},(_,i)=>renderTaskColumnKey(tasks[i%4]!,i>=4,1234000,now))};
 for(const [name,keys] of Object.entries(pages)) {
  const bar=renderInfobar({runningCount:2,pageLabel:name==='overview'?'OVERVIEW':'CODEX -1',overflowCount:name==='tasks'?1:0});
  await sharp({create:{width:424,height:274,channels:4,background:'#000'}}).composite([...keys.map((svg,i)=>({input:Buffer.from(svg),left:8+(i%4)*104,top:8+Math.floor(i/4)*104})),{input:Buffer.from(bar),left:88,top:218}]).png().toFile(path.join(dir,name+'.png'));
 }
 console.log(dir);
}
void main();
