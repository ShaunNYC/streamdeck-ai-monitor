import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { emptyTaskProgress,taskCapabilities,type Task } from '@streamdeck-supervisor/shared';
import { COLORS,layoutText,renderMainTile,renderTaskColumnKey,renderPressedTile,type MainTileModel } from '../packages/device/src/render.js';

async function main() {
 const dir=path.resolve('artifacts/calendar-layout/device');fs.mkdirSync(dir,{recursive:true});
 const fixtures:Array<{name:string;svg:string}>=[];
 const add=(name:string,svg:string)=>fixtures.push({name,svg});
 for(const agent of ['codex','claude'] as const) for(const emphasis of ['active','quiet'] as const) {
  const base={accent:COLORS[agent],emphasis,actionable:false};
  const models:MainTileModel[]=[
   {...base,label:'XHIGH',detail:'GPT-6-ASTRA-LONG-MODEL-NAME',icon:'circle-gauge'},
   {...base,label:'CODEX',agent:'codex'}, {...base,label:'CLAUDE',agent:'claude'},
   {...base,label:'HIGH',detail:'CLAUDE-OPUS-4-6',icon:'circle-gauge'},
   {...base,label:'NEW CHAT',icon:'message-square-plus',actionable:true},
   {...base,label:'ACTIVITY',process:{kind:'activity',value:'Updating device layout'}},
   {...base,label:'PROGRESS',process:{kind:'progress',completed:0,total:0,liveTaskCount:1,unknownCount:1}},
   {...base,label:'TODAY',detail:'999H59M',icon:'clock'},
  ];
  models.forEach((model,i)=>add(`${agent}-${emphasis}-${i}`,renderMainTile(model)));
  const keys=models.map(renderMainTile);
  await sharp({create:{width:424,height:216,channels:4,background:'#000'}}).composite(keys.map((svg,i)=>({input:Buffer.from(svg),left:8+i%4*104,top:8+Math.floor(i/4)*104}))).png().toFile(path.join(dir,`${agent}-${emphasis}.png`));
  add(`${agent}-${emphasis}-pressed`,renderPressedTile(keys[4]!,.65));
  for(const progress of [{completed:999,total:999,liveTaskCount:1},{completed:23,total:999,liveTaskCount:1,estimatedRemainingMs:9999999999},{completed:99,total:123,liveTaskCount:99,unknownCount:98}]) add(`${agent}-${emphasis}-progress-${progress.total}`,renderMainTile({...base,label:'PROGRESS',process:{kind:'progress',...progress}}));
 }
 for(const agent of ['codex','claude'] as const) for(const status of ['RUNNING','PAUSED','APPROVAL','DONE','ERROR'] as const) {
  const task:Task={taskId:'layout',externalId:'layout',agent,status,ownership:'observer',projectId:'demo',projectLabel:'Demo',titleShort:'测试超长项目名称 VERY LONG DESCRIPTION',attentionCount:0,capabilities:taskCapabilities(),progress:emptyTaskProgress(),openRef:{kind:'url',value:''},source:'mock',lastEventAt:0,startedAt:0};
  for(const lower of [false,true]) add(`${agent}-${status}-${lower}`,renderTaskColumnKey(task,lower,9999999999,1200));
 }
 const working=layoutText('WORKING',{maxWidth:68,maxLines:1,sizes:[22,20,18,16,14,12]});
 assert.equal(working.lines[0],'WORKING');assert.equal(working.truncated,false);
 assert.ok(working.size>=8);
 const quiet=fixtures.find(f=>f.name==='codex-quiet-4')!.svg, active=fixtures.find(f=>f.name==='codex-active-4')!.svg;
 assert.equal(/translate\(37 24\)/.test(quiet),true);assert.equal(/translate\(37 24\)/.test(active),true);
 assert.ok(quiet.includes('y="66"') && active.includes('y="66"'));
 fs.writeFileSync(path.join(dir,'fixtures.json'),JSON.stringify(fixtures));
 console.log(`[device-layout] ${fixtures.length} main/task/pressed fixtures and full-word fitting: ok`);
}
void main();
