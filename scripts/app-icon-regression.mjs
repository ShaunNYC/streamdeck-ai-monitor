#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const assets = path.resolve("packages/app/assets");
const source = path.join(assets, "app-icon.png");
const output = path.resolve("artifacts/agent-pulse-branding");
fs.mkdirSync(output, { recursive: true });
const metadata = await sharp(source).metadata();
assert.equal(metadata.width, metadata.height, "App icon source must be square");
assert.ok(metadata.width >= 1024 && metadata.hasAlpha, "Icon requires a high-resolution source with transparency");
const icns = fs.readFileSync(path.join(assets, "app-icon.icns"));
assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
assert.equal(icns.readUInt32BE(4), icns.length);
const exported = [];
for (let offset = 8; offset < icns.length;) {
 const length = icns.readUInt32BE(offset + 4);
 assert.ok(length > 8 && offset + length <= icns.length, "Valid ICNS entry bounds");
 const entry = await sharp(icns.subarray(offset + 8, offset + length)).metadata();
 assert.equal(entry.width, entry.height);
 exported.push(entry.width); offset += length;
}
for (const size of [16, 32, 64, 128, 256, 512, 1024]) assert.ok(exported.includes(size), `ICNS includes ${size}px`);
const previews = [];
for (const size of [1024, 128, 32, 16]) {
 const png = await sharp(source).resize(size, size).png().toBuffer();
 const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
 assert.equal(data[3], 0, `${size}px icon has transparent outer corners`);
 let orange = 0, ivory = 0;
 for (let i = 0; i < data.length; i += 4) {
  const [r,g,b,a] = data.subarray(i,i+4);
  if (a > 240 && r > 140 && r > g*1.4 && g > b*1.3) orange++;
  if (a > 240 && r > 210 && g > 200 && b > 170) ivory++;
 }
 assert.ok(orange > size*size*.2 && ivory > size*size*.12, `${size}px orange field and cards remain distinct`);
 fs.writeFileSync(path.join(output, `app-icon-${size}.png`), png);
 previews.push(await sharp(png).resize(160,160,{kernel:size <= 32 ? "nearest" : "lanczos3"}).png().toBuffer());
}
const menuPreviews=[];
for (const [name,size] of [["menu-bar-Template.png",16],["menu-bar-Template@2x.png",32]]) {
 const file=path.join(assets,name);
 const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,size); assert.equal(info.height,size); assert.equal(data[3],0);
 let opaque=0,transparent=0;
 for(let i=0;i<data.length;i+=4){
  assert.ok(data[i]===0 && data[i+1]===0 && data[i+2]===0,"Template glyph must be black plus alpha, with no painted-white cutouts");
  if(data[i+3]>200)opaque++; if(data[i+3]===0)transparent++;
 }
 assert.ok(opaque>size*size*.2 && transparent>size*size*.25,"Menu glyph retains silhouette and clear cutouts");
 for(const dark of [false,true]) {
  let glyph=await sharp(file).resize(80,80,{kernel:"nearest"}).png().toBuffer();
  if(dark)glyph=await sharp(glyph).negate({alpha:false}).png().toBuffer();
  menuPreviews.push(await sharp({create:{width:160,height:120,channels:4,background:dark?"#22252b":"#f5f5f4"}}).composite([{input:glyph,left:40,top:20}]).png().toBuffer());
 }
}
await sharp({create:{width:640,height:280,channels:4,background:"#f5f5f4"}})
 .composite([...previews.map((input,i)=>({input,left:i*160,top:0})),...menuPreviews.map((input,i)=>({input,left:i*160,top:160}))])
 .png().toFile(path.join(output,"icon-size-and-menu-themes.png"));
console.log("[app-icon] complete ICNS sizes, orange cards at 16px, transparent monochrome menu glyph in both themes: ok");
