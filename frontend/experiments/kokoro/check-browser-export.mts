import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { exposeNativeDurations } from "../../src/audio/duration-export";
const path = process.argv[2];
if (!path) throw new Error("Provide the original pinned model path");
const bytes = Uint8Array.from(readFileSync(path));
const output = exposeNativeDurations(bytes.buffer);
console.log(createHash("sha256").update(new Uint8Array(output)).digest("hex"));
writeFileSync(path + ".browser.onnx", new Uint8Array(output));
