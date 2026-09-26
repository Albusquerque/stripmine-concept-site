/** Record the actual v0.1.0 concept views for GitHub and Reddit. */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.STRIPMINE_CAPTURE_URL || "http://127.0.0.1:8772/";
const INTERVAL_MS = 180;
const livingOnly = process.argv.includes("--living-only");
const outputDir = path.resolve(import.meta.dirname, "..", "assets", "readme-gifs");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "stripmine-readme-capture-"));
const browser = await chromium.launch({ headless: true });

async function captureFrames(locator, durationMs, folder, startIndex = 0) {
  await fs.mkdir(folder, { recursive: true });
  const count = Math.ceil(durationMs / INTERVAL_MS);
  const started = Date.now();
  for (let index = 0; index < count; index += 1) {
    const remaining = started + index * INTERVAL_MS - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    await locator.screenshot({ path: path.join(folder, `${String(startIndex + index).padStart(4, "0")}.png`) });
  }
  return count;
}

function encode(name, folder, maxWidth, colors = 96) {
  const output = path.join(outputDir, `${name}.gif`);
  execFileSync("python3", [
    path.join(import.meta.dirname, "encode_readme_gif.py"),
    folder,
    output,
    String(INTERVAL_MS),
    String(maxWidth),
    String(colors),
  ], { stdio: "inherit" });
  console.log(output);
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("#showcase").scrollIntoViewIfNeeded();
  return page;
}

async function captureGame() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(new URL("demo/plugin.html?v=32", BASE_URL).href, { waitUntil: "networkidle" });
  await page.locator(".sm-world-stage").waitFor();
  await page.waitForTimeout(350);
  const folder = path.join(scratch, "full-game");
  await fs.mkdir(folder, { recursive: true });
  const durationMs = 5600;
  const count = Math.ceil(durationMs / INTERVAL_MS);
  const started = Date.now();
  let strikeTriggered = false;
  for (let index = 0; index < count; index += 1) {
    const elapsed = index * INTERVAL_MS;
    const remaining = started + elapsed - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    if (!strikeTriggered && elapsed >= 1620) {
      strikeTriggered = true;
      await page.getByRole("button", { name: /SIGNAL STRIKE/ }).click();
    }
    await page.locator("#root").screenshot({ path: path.join(folder, `${String(index).padStart(4, "0")}.png`) });
  }
  encode("full-game", folder, 1000, 128);
  await page.close();
}

async function captureDecky() {
  const page = await newPage();
  await page.locator('[data-view="decky"]').click();
  await page.frameLocator("#decky-frame").locator("body").waitFor();
  await page.waitForTimeout(900);
  const folder = path.join(scratch, "decky-control-room");
  await captureFrames(page.locator(".steam-screen"), 6500, folder);
  encode("decky-control-room", folder, 760, 96);
  await page.close();
}

async function capturePhysical() {
  const page = await newPage();
  await page.locator('[data-view="physical"]').click();
  await page.waitForTimeout(500);
  const folder = path.join(scratch, "physical-light-bar");
  await captureFrames(page.locator(".physical-stage"), 4700, folder);
  encode("physical-light-bar", folder, 760, 96);
  await page.close();
}

async function captureProfiles() {
  const page = await newPage();
  await page.locator('[data-view="physical"]').click();
  const stage = page.locator(".physical-stage");
  const badge = page.locator("#stage-badge");
  const folder = path.join(scratch, "light-profiles");
  await page.locator('[data-style="luminous"]').click();
  await badge.evaluate((node) => { node.textContent = "LUMINOUS · SOFT GLOW"; });
  let index = await captureFrames(stage, 2700, folder);
  await page.locator('[data-style="contrasted"]').click();
  await badge.evaluate((node) => { node.textContent = "CONTRASTED · DARK GAPS"; });
  await captureFrames(stage, 2700, folder, index);
  encode("light-profiles", folder, 760, 96);
  await page.close();
}

try {
  await fs.mkdir(outputDir, { recursive: true });
  await captureGame();
  if (!livingOnly) {
    await captureDecky();
    await capturePhysical();
    await captureProfiles();
  }
} finally {
  await browser.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
