import { StringDecoder } from "node:string_decoder";

// Preserve JSON structure and small metadata while dropping the tail of very
// large string values (typically screenshots/base64 or tool output). Escapes
// are completed before truncation, so a later lifecycle field remains readable.
const MAX_STRING_CHARS = 256 * 1024 + 16;
export class BoundedJsonlReader {
 private decoder = new StringDecoder("utf8");
 private parts: string[] = [];
 private inString = false;
 private escapeChars = 0;
 private stringChars = 0;
 private keepEscape = false;
 private invalidLine = false;
 constructor(private readonly onLine: (line: string) => void) {}
 write(bytes: Buffer): void {
  const text = this.decoder.write(bytes);
  const tokens = /["\\\n]/g;
  let start = 0;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
   this.append(text.slice(start, match.index));
   const char = match[0]!;
   if (char === "\n") {
    if (!this.invalidLine) this.onLine(this.parts.join(""));
    this.parts = []; this.inString = false; this.escapeChars = 0; this.stringChars = 0; this.invalidLine = false;
   } else if (this.escapeChars !== 0) {
    this.append(char);
   } else if (char === '"') {
    this.parts.push(char); this.inString = !this.inString; this.stringChars = 0;
   } else if (this.inString) {
    this.keepEscape = this.stringChars < MAX_STRING_CHARS;
    if (this.keepEscape) this.parts.push(char);
    this.escapeChars = -1;
   } else this.parts.push(char);
   start = match.index + 1;
  }
  this.append(text.slice(start));
 }
 private append(value: string): void {
  if (!value) return;
 
  let offset = 0;
  // -1 means the escape discriminator has not arrived yet.
  if (this.escapeChars === -1) {
   const char = value[0]!;
   if (this.keepEscape) { this.parts.push(char); this.stringChars += 2; }
   if (!'"\\/bfnrtu'.includes(char)) this.invalidLine = true;
   this.escapeChars = char === "u" ? 4 : 0; offset = 1;
  }
  if (this.escapeChars > 0) {
   const count = Math.min(this.escapeChars, value.length-offset);
   if (!/^[a-fA-F0-9]*$/.test(value.slice(offset,offset+count))) this.invalidLine = true;
   if (this.keepEscape) { this.parts.push(value.slice(offset,offset+count)); this.stringChars += count; }
   this.escapeChars -= count; offset += count;
  }
  if (offset === value.length) return;
  const rest = value.slice(offset);
  if (!this.inString) { this.parts.push(rest); return; }
  const count = Math.max(0, Math.min(rest.length, MAX_STRING_CHARS-this.stringChars));
  if (count) { this.parts.push(rest.slice(0,count)); this.stringChars += count; }
 }
}
