/** Isolated read-only observer benchmark. Use a frozen catalog/log copy for A/B. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Task } from "@streamdeck-supervisor/shared";

async function main() {
 const option = (name:string) => { const i=process.argv.indexOf(name); return i<0 ? undefined : process.argv[i+1]; };
 const directory=option("--directory");
 if (!directory) throw new Error("Pass --directory with a read-only catalog/log fixture directory");
 const modulePath=path.resolve(option("--module") ?? "packages/daemon/src/adapters/codex-catalog-adapter.ts");
 const {CodexCatalogAdapter}=await import(pathToFileURL(modulePath).href);
 const tasks=new Map<string,Task>();
 const adapter=new CodexCatalogAdapter({registry:{getTask:(id:string)=>tasks.get(id)},upsertTask:(task:Task)=>tasks.set(task.taskId,task),removeTask:(id:string)=>tasks.delete(id),setStatus:(_name:string,status:string,error?:string)=>{if(status!=="OK")throw new Error(error??status);}},path.resolve(directory));
 let readBytes=0;
 const originalRead=fs.readSync;
 fs.readSync=function(...args:any[]){const count=Reflect.apply(originalRead,fs,args);readBytes+=count;return count;} as typeof fs.readSync;
 const seconds=Number(option("--seconds")??0), interval=Number(option("--interval-ms")??2000);
 const records:any[]=[];
 const started=Date.now(), cpu=process.cpuUsage();
 let lastLog=0;
 try {
  do {
   const start=performance.now();readBytes=0;
   await adapter.poll();
   const memory=process.memoryUsage();
   const row={elapsedMs:Date.now()-started,pollMs:Math.round(performance.now()-start),readBytes,...memory};
   records.push(row);
   if (!lastLog || row.elapsedMs-lastLog>=30000 || records.length<=3) {console.log(JSON.stringify(row));lastLog=row.elapsedMs;}
   if (records.length>=4 && row.elapsedMs>=seconds*1000) break;
   await new Promise(resolve=>setTimeout(resolve,interval));
  } while(true);
  const usage=process.cpuUsage(cpu);
  const states=[...tasks.values()].sort((a,b)=>a.taskId.localeCompare(b.taskId)).map(t=>({id:t.taskId,status:t.status,model:t.model,effort:t.reasoningEffort,title:t.titleShort,execution:t.executionId,progress:{...t.progress,durationMs:0}}));
  const result={modulePath,elapsedMs:Date.now()-started,taskCount:tasks.size,stateDigest:createHash("sha256").update(JSON.stringify(states, (_key,value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value)).digest("hex"),cpuMs:(usage.user+usage.system)/1000,maxRssKiB:process.resourceUsage().maxRSS,records};
  const output=option("--output");if(output)fs.writeFileSync(output,JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify({...result,records:undefined,first:records[0],last:records.at(-1)}));
 } finally {await adapter.stop();fs.readSync=originalRead;}
}
void main();
