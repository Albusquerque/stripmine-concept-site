/** Smoke-test all three published views and the shared optical profile control. */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const baseUrl = process.env.STRIPMINE_SITE_URL || "http://127.0.0.1:8772/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  assert.equal(await page.locator(".view-tab").count(), 3);
  assert.match(await page.title(), /StripMine/);
  await page.frameLocator("#game-frame").locator("body").waitFor();

  await page.locator('[data-view="decky"]').click();
  await page.frameLocator("#decky-frame").locator("body").waitFor();
  await page.locator(".decky-view.is-active").waitFor();

  await page.locator('[data-view="physical"]').click();
  await page.locator(".physical-view.is-active").waitFor();
  await page.locator("#optical-lab").waitFor();
  await page.locator('[data-style="contrasted"]').click();
  assert.equal(await page.locator('[data-style="contrasted"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-style="luminous"]').click();
  assert.equal(await page.locator('[data-style="luminous"]').getAttribute("aria-pressed"), "true");

  assert.deepEqual(errors, []);
  console.log("StripMine concept site: all three views and both light profiles passed.");
} finally {
  await browser.close();
}
