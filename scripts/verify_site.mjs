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

  // The real Decky route sits inside Steam's own chrome. Prove that the game
  // follows every available 16:9 route box instead of adding another 100vh.
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    const fitPage = await browser.newPage({ viewport });
    await fitPage.goto(new URL("demo/plugin.html?v=layout-fit", baseUrl).href, { waitUntil: "networkidle" });
    await fitPage.locator(".sm-app").waitFor();
    const fit = await fitPage.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null;
      };
      return {
        innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight,
        app: bounds(".sm-app"),
        shell: bounds(".sm-shell"),
        world: bounds(".sm-world-stage"),
        command: bounds(".sm-command"),
      };
    });
    const label = `${viewport.width}x${viewport.height}`;
    assert.ok(fit.app && fit.shell && fit.world && fit.command, `${label}: missing game region`);
    assert.ok(fit.documentHeight <= fit.innerHeight, `${label}: document scrolls (${fit.documentHeight} > ${fit.innerHeight})`);
    assert.ok(fit.bodyHeight <= fit.innerHeight, `${label}: body scrolls (${fit.bodyHeight} > ${fit.innerHeight})`);
    assert.ok(fit.app.bottom <= fit.innerHeight + 0.5, `${label}: app exceeds viewport`);
    assert.ok(fit.shell.bottom <= fit.app.bottom + 0.5, `${label}: shell exceeds app`);
    assert.ok(fit.command.bottom <= fit.shell.bottom + 0.5, `${label}: controls are cropped`);
    assert.ok(Math.abs(fit.world.height + fit.command.height - fit.shell.height) <= 1, `${label}: stage and controls do not share the shell exactly`);
    await fitPage.close();
  }

  // The concept preview owns a small JavaScript simulation rather than the
  // Python game engine. Keep the fixed Signal Strike completion invariant in
  // both places: neither an exact 100% state nor rapid input may strand a vein.
  const strikePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await strikePage.goto(new URL("demo/plugin.html?diagnostics=1&v=strike-regression", baseUrl).href, { waitUntil: "networkidle" });
  await strikePage.locator(".sm-app").waitFor();
  await strikePage.locator(".sm-intro").waitFor();
  const strikeRegression = await strikePage.evaluate(async () => {
    const diagnostics = window.__stripminePreviewDiagnostics;
    const connect = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit.connect();
    const strike = connect.callable("strike");
    const status = connect.callable("get_status");
    const initial = await status();
    const initialSnapshot = {
      introSeen: initial.intro_seen,
      progress: initial.progress,
      deposit: initial.deposit,
      completedVeins: initial.completed_veins,
      workerCount: initial.worker_count,
      ore: initial.ore,
      cityValue: initial.city_value,
      cityEmpty: initial.city.every((plot) => plot === null),
    };

    diagnostics.setProgress(0.999);
    const burst = await Promise.all(Array.from({ length: 64 }, () => strike()));
    const afterBurst = await status();

    diagnostics.setProgress(1);
    const repaired = await status();
    return {
      initial: initialSnapshot,
      burstResults: burst.map((entry) => entry.result),
      afterBurst: { progress: afterBurst.progress, rewardPending: afterBurst.reward_pending },
      repaired: { progress: repaired.progress, rewardPending: repaired.reward_pending },
    };
  });
  assert.deepEqual(strikeRegression.initial, {
    introSeen: false,
    progress: 0,
    deposit: 0,
    completedVeins: 0,
    workerCount: 1,
    ore: 0,
    cityValue: 0,
    cityEmpty: true,
  });
  assert.equal(strikeRegression.afterBurst.progress, 1);
  assert.equal(strikeRegression.afterBurst.rewardPending, true);
  assert.equal(strikeRegression.repaired.progress, 1);
  assert.equal(strikeRegression.repaired.rewardPending, true);
  assert.ok(strikeRegression.burstResults.includes("critical") || strikeRegression.burstResults.includes("strike") || strikeRegression.burstResults.includes("miss"));
  assert.ok(strikeRegression.burstResults.every((result) => ["critical", "strike", "miss", "cooldown", "unavailable"].includes(result)));
  await strikePage.close();

  await page.frameLocator("#game-frame").locator("body").waitFor();
  await page.frameLocator("#game-frame").getByRole("button", { name: /OST 80% · ON/ }).waitFor();
  await page.frameLocator("#game-frame").getByRole("button", { name: /SFX 65% · ON/ }).waitFor();
  await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 1);

  await page.locator('[data-view="decky"]').click();
  await page.frameLocator("#game-frame").locator(".sm-app").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 0);
  await page.frameLocator("#decky-frame").locator("body").waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: /OST 80% · ON/ }).waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: /SFX 65% · ON/ }).waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: "RESET GAME" }).waitFor();
  await page.frameLocator("#decky-frame").getByRole("button", { name: "OPEN FULL GAME" }).waitFor();
  const deckyFit = await page.evaluate(() => {
    const frame = document.querySelector("#decky-frame");
    const panel = frame?.contentDocument?.querySelector(".sm-qam");
    return {
      viewport: frame?.contentWindow?.innerHeight ?? 0,
      panelBottom: panel?.getBoundingClientRect().bottom ?? Infinity,
    };
  });
  assert.ok(deckyFit.panelBottom <= deckyFit.viewport, `Decky panel is cropped: ${deckyFit.panelBottom}px > ${deckyFit.viewport}px`);
  await page.locator(".decky-view.is-active").waitFor();

  await page.locator('[data-view="game"]').click();
  await page.frameLocator("#game-frame").locator(".sm-app").waitFor();
  await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 1);

  // Repeated comparisons must never accumulate orchestras in the hidden
  // iframe: zero contexts outside the game, exactly one after every return.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.locator('[data-view="decky"]').click();
    await page.frameLocator("#game-frame").locator(".sm-app").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 0);
    await page.locator('[data-view="game"]').click();
    await page.frameLocator("#game-frame").locator(".sm-app").waitFor();
    await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 1);
  }

  await page.locator('[data-view="physical"]').click();
  await page.frameLocator("#game-frame").locator(".sm-app").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#game-frame")?.contentWindow?.__stripminePreviewAudioCount === 0);
  await page.locator(".physical-view.is-active").waitFor();
  await page.locator("#optical-lab").waitFor();
  await page.locator('[data-style="contrasted"]').click();
  assert.equal(await page.locator('[data-style="contrasted"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-style="luminous"]').click();
  assert.equal(await page.locator('[data-style="luminous"]').getAttribute("aria-pressed"), "true");

  assert.deepEqual(errors, []);
  console.log("StripMine concept site: Signal Strike, three views, audio lifecycle, Decky fit and both light profiles passed.");
} finally {
  await browser.close();
}
