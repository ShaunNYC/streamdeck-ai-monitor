import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoundedJsonlReader } from "../packages/daemon/src/adapters/bounded-jsonl.js";
import { RolloutReader } from "../packages/daemon/src/adapters/codex-catalog-adapter.js";

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"codex-memory-regression-"));
const file=path.join(directory,"rollout.jsonl");
const row=(type:string,payload:unknown,at=1)=>JSON.stringify({timestamp:new Date(1700000000000+at).toISOString(),type,payload});
try {
 // Arbitrary chunk boundaries, unicode and escaped quotes/backslashes.
 for (const width of [1,2,3,7,65536]) {
  const values=[{text:'测试🙂 "quoted" \\ \\uABCD\n',nested:{type:"task_complete"}},{text:"x".repeat(262159)+'\\u1234"tail',after:"still readable"}];
  const parsed:unknown[]=[];const decoder=new BoundedJsonlReader(line=>parsed.push(JSON.parse(line)));
  const bytes=Buffer.from(values.map(value=>JSON.stringify(value)).join("\n")+"\n");
  for(let at=0;at<bytes.length;at+=width)decoder.write(bytes.subarray(at,at+width));
  assert.deepEqual(parsed[0],values[0]);
  assert.equal((parsed[1] as any).after,"still readable");
  assert.ok((parsed[1] as any).text.length<262190);
 }
 const started=row("event_msg",{type:"task_started",turn_id:"one"});
 const title=row("event_msg",{type:"user_message",message:"Implement the streaming memory regression"});
 const image=row("response_item",{type:"message",role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,"+"X".repeat(8*1024*1024)},{type:"input_text",text:"Keep this latest task title after the giant image"}]});
 fs.writeFileSync(file,[started,title,image,row("turn_context",{model:"gpt-test",effort:"high"})].join("\n")+"\n");
 const reader=new RolloutReader();
 const first=reader.read(file);
 assert.equal(first.status,"RUNNING");assert.equal(first.executionId,"one");assert.equal(first.model,"gpt-test");assert.equal(first.reasoningEffort,"high");
 assert.match(first.latestUserText!,/^Keep this latest/);
 const original=fs.readSync;let reads=0;
 fs.readSync=function(...args:any[]){const n=Reflect.apply(original,fs,args);reads+=n;return n;} as typeof fs.readSync;
 try {assert.equal(reader.read(file).status,"RUNNING");assert.equal(reads,0,"Unchanged logs perform no content reads");}
 finally {fs.readSync=original;}
 const completed=row("event_msg",{type:"task_complete",turn_id:"one"},2);
 fs.appendFileSync(file,completed.slice(0,-3));assert.equal(reader.read(file).status,"RUNNING","Partial records do not advance lifecycle");
 fs.appendFileSync(file,completed.slice(-3)+"\n");assert.equal(reader.read(file).status,"DONE_UNREAD");
 const events=Array.from({length:2000},(_,i)=>row("response_item",{type:"message",role:"assistant",content:[{type:"output_text",text:`Recap ${i}`}]},3+i));
 fs.appendFileSync(file,events.join("\n")+"\n");
 assert.equal(reader.read(file).progress.recap,"Recap 1999");
 assert.ok(reader.states.get(file)!.progressEvents.length<=8,"Retain reduced progress, not every historical event");
 fs.writeFileSync(file,started+"\n");assert.equal(reader.read(file).status,"RUNNING","Truncation resets terminal state");
 const sameTime = [
  row("response_item",{type:"function_call",name:"request_user_input",call_id:"input",arguments:"{}"},10),
  row("response_item",{type:"function_call",name:"exec_command",call_id:"exec",arguments:"{}"},10),
 ];
 fs.appendFileSync(file,sameTime[0]+"\n");reader.read(file);
 fs.appendFileSync(file,sameTime[1]+"\n");assert.equal(reader.read(file).progress.latestActivity?.category,"shell","Equal-time events retain transport order across polls");
 fs.writeFileSync(file,started+"\n");reader.read(file);
 const stat=fs.statSync(file);
 const replacement=row("event_msg",{type:"turn_aborted",turn_id:"two"});
 fs.writeFileSync(file,replacement+" ".repeat(Math.max(0,stat.size-replacement.length-1))+"\n");fs.utimesSync(file,stat.atime,stat.mtime);
 assert.equal(reader.read(file).status,"PAUSED","Same-size rewrite invalidates cache even with restored mtime");
 const other=path.join(directory,"other.jsonl");fs.writeFileSync(other,started+"\n");reader.read(other);
 reader.retain(new Set([other]));assert.equal(reader.states.size,1);reader.clear();assert.equal(reader.states.size,0);
 console.log("[codex-memory] bounded JSON strings, unicode/escapes, giant image metadata, zero-read idle polls, partial/rewritten files and bounded cache: ok");
} finally {fs.rmSync(directory,{recursive:true,force:true});}
