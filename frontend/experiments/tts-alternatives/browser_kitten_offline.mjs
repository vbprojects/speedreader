// UI-only smoke for a production preview, including full network-offline reload.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url = "http://localhost:5251", executablePath] = process.argv.slice(2);
const root = fileURLToPath(new URL("./assets/kitten-int8/", import.meta.url));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("https://**/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (["kitten_tts_nano_v0_8.onnx", "voices.npz", "en-us.txt"].includes(name)) {
      await route.fulfill({ body: await readFile(root + name), contentType: "application/octet-stream" });
    } else await route.continue();
  });
  await page.goto(url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Speech model", { exact: true }).selectOption("kitten");
  await page.getByRole("button", { name: "Install voice", exact: true }).click();
  await page.getByText("English voice is installed for offline use.", { exact: true }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Preview voice", exact: true }).click();
  await page.getByText("Playing voice preview.", { exact: true }).waitFor({ timeout: 120_000 });
  // Routing disables HTTP cache, so a successful reload comes from the PWA cache.
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  assert.equal(await page.getByLabel("Speech model", { exact: true }).inputValue(), "kitten");
  assert.equal(await page.getByLabel("KittenTTS voice", { exact: true }).inputValue(), "Bella");
  await page.getByRole("button", { name: "Repair voice", exact: true }).waitFor();
  await page.getByRole("button", { name: "Preview voice", exact: true }).click();
  await page.getByText("Playing voice preview.", { exact: true }).waitFor({ timeout: 120_000 });
  console.log(`PASS: ${url} production installation, persisted selection, fully offline reload and fresh synthesis`);
} finally { await browser.close(); }
