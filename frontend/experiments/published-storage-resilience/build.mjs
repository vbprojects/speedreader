// Run from frontend: node experiments/published-storage-resilience/build.mjs
import { build } from "vite";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("./", import.meta.url), dist = new URL("./dist/", root);
await build({ configFile: false, root: fileURLToPath(root), build: {
  target: "es2022", outDir: fileURLToPath(dist), emptyOutDir: true, minify: false, sourcemap: true,
  lib: { entry: fileURLToPath(new URL("harness.ts", root)), formats: ["es"], fileName: () => "harness.js" },
} });
for (const file of ["index.html", "sw.js", "manifest.webmanifest"]) await copyFile(new URL(file, root), new URL(file, dist));
