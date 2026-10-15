import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "assets", "app-icon.png");
const destination = path.join(root, "assets", "app-icon.icns");
const entries = [
	["icp4", 16], ["icp5", 32], ["icp6", 64],
	["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
	["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
];

const chunks = [];
for (const [type, size] of entries) {
	const png = await sharp(source).resize(size, size).png().toBuffer();
	const header = Buffer.alloc(8);
	header.write(type, 0, 4, "ascii");
	header.writeUInt32BE(png.length + 8, 4);
	chunks.push(header, png);
}
const length = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(length, 4);
fs.writeFileSync(destination, Buffer.concat([header, ...chunks]));
console.log(destination);
