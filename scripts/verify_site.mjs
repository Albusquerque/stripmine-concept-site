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
  assert.equal((await page.locator(".brand-wordmark").innerText()).replace(/\s/g, ""), "StripMine");
  assert.match(await page.locator(".brand-logo").getAttribute("src"), /stripmine-logo\.png$/);
  const brandMetrics = await page.locator(".brand").evaluate((brand) => {
    const wordmark = brand.querySelector(".brand-wordmark");
    const bounds = wordmark?.getBoundingClientRect();
    return { width: bounds?.width ?? 0, height: bounds?.height ?? 0, fontSize: parseFloat(getComputedStyle(wordmark).fontSize) };
  });
  assert.ok(brandMetrics.width >= 175, `Header wordmark is too narrow: ${brandMetrics.width}px`);
  assert.ok(brandMetrics.height >= 54, `Header wordmark is too short: ${brandMetrics.height}px`);
  assert.ok(brandMetrics.fontSize >= 54, `Header wordmark is too small: ${brandMetrics.fontSize}px`);
  await page.frameLocator("#game-frame").locator("body").waitFor();
  await page.frameLocator("#game-frame").getByRole("button", { name: /OST 80% · ON/ }).waitFor();
  await page.frameLocator("#game-frame").getByRole("button", { name: /SFX 65% · ON/ }).waitFor();

  await page.locator('[data-view="decky"]').click();
  await page.frameLocator("#decky-frame").locator("body").waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: /OST 80% · ON/ }).waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: /SFX 65% · ON/ }).waitFor();
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
