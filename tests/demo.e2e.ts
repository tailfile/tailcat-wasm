import { test } from "vitest";
import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
import { browserFixture } from "./browser-fixture.ts";

test("demo lifecycle and two 1 GB transfers", async () => {
  const fixture = await browserFixture();
  const { browser, base } = fixture;
  const errors: string[] = [];
  try {
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
    ]);
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    for (const page of pages) {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${base}/?map=${encodeURIComponent(`${base}/derpmap-test.json`)}`,
      );
      await expect(page).toHaveTitle("TailWASM Demo · WebRTC direct, DERP fallback");
      await expect(page.locator("#address")).toBeVisible({ timeout: 45_000 });
      await expect(page.locator("#start")).toBeHidden();
      await expect(page.locator("#connect")).toBeEnabled();
    }
    const [a, b] = pages;
    await a.locator("#stop").click();
    await expect(a.locator("#start")).toBeVisible();
    await expect(a.locator("#address")).toBeHidden();
    // The map dropdown switches between the two default maps and a custom URL.
    await a.locator("#settings summary").click();
    await expect(a.locator("#map-preset")).toHaveValue("custom");
    await expect(a.locator("#map")).toHaveValue(`${base}/derpmap-test.json`);
    await a.locator("#map-preset").selectOption("tailscale");
    await expect(a.locator("#map")).toHaveValue(
      "https://controlplane.tailscale.com/derpmap/default",
    );
    await expect(a.locator("#map")).not.toBeEditable();
    await a.locator("#map-preset").selectOption("tailcat");
    await expect(a.locator("#map")).toHaveValue(
      "https://tailcat.dev/derpmap.json",
    );
    await a.locator("#map-preset").selectOption("custom");
    await expect(a.locator("#map")).toBeEditable();
    await a.locator("#map").fill(`${base}/derpmap-test.json`);
    await a.locator("#start").click();
    await expect(a.locator("#address")).toBeVisible({ timeout: 45_000 });
    const [addressA, addressB] = await Promise.all(
      pages.map((page) => page.locator("#address").inputValue()),
    );
    assert(addressA && addressB && addressA !== addressB);
    async function connect(from: Page, address: string) {
      await from.locator("#peer-address").fill(address);
      await from.locator("#connect").click();
      for (const page of pages)
        await expect(page.locator("#route")).toHaveAttribute(
          "data-state",
          "direct",
          { timeout: 30_000 },
        );
    }
    await connect(a, addressB);
    for (const [from, to, text] of [
      [a, b, "Hello from A · 你好"],
      [b, a, "<img src=x onerror=alert(1)> from B"],
    ] as const) {
      await from.locator("#message").fill(text);
      await from.locator("#send").click();
      await expect(to.locator("#messages")).toContainText(text);
      assert.equal(await to.locator("#messages img").count(), 0);
    }
    await a.locator("#webrtc-debug summary").click();
    await a.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await a.locator("#copy-debug").click();
    assert.equal(
      await a.evaluate(() => navigator.clipboard.readText()),
      "chrome://webrtc-internals",
    );
    await a.locator("#webrtc-debug summary").click();

    const TEST_BYTES = 1_000_000_000;
    const confirmed = (page: Page) =>
      page.locator("#send-meter").getAttribute("data-bytes").then(Number);
    // Cancellation keeps the listener address available; reconnect requires no restart.
    await a.locator("#probe").click();
    await expect
      .poll(() => confirmed(a), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await a.locator("#cancel-probe").click();
    await expect(a.locator("#send-meter")).toHaveAttribute(
      "data-state",
      "error",
    );
    await expect(b.locator("#route")).toHaveAttribute("data-state", "idle", {
      timeout: 15_000,
    });
    await expect(a.locator("#address")).toHaveValue(addressA);
    await connect(a, addressB);

    async function testBytes(from: Page, to: Page, fallback = false) {
      const began = Date.now();
      await from.locator("#probe").click();
      await expect
        .poll(() => confirmed(from), { timeout: 30_000 })
        .toBeGreaterThan(5_000_000);
      await expect(from.locator("#send-rate")).not.toHaveText("—");
      await expect(to.locator("#receive-rate")).not.toHaveText("—");
      if (fallback) {
        await from.locator("#webrtc").uncheck();
        for (const page of pages)
          await expect(page.locator("#route")).toHaveAttribute(
            "data-state",
            "derp",
            { timeout: 15_000 },
          );
      }
      const report = setInterval(() => {
        void confirmed(from)
          .then(async (bytes) => {
            const paths = await Promise.all(
              pages.map((page) =>
                page.evaluate(() => ({
                  state: document
                    .querySelector("#route")
                    ?.getAttribute("data-state"),
                  detail: document.querySelector("#route-detail")?.textContent,
                  rtc: document.querySelector("#rtc-traffic")?.textContent,
                  derp: document.querySelector("#derp-traffic")?.textContent,
                })),
              ),
            );
            console.log(
              `1 GB test: ${((bytes / TEST_BYTES) * 100).toFixed(1)}% receiver-confirmed`,
              paths,
            );
          })
          .catch(() => {});
      }, 15_000);
      try {
        await expect(from.locator("#send-meter")).toHaveAttribute(
          "data-state",
          "done",
          { timeout: 600_000 },
        );
      } finally {
        clearInterval(report);
      }
      await expect(from.locator("#probe-status")).toContainText(
        "Verified 1 GB",
      );
      await expect(to.locator("#receive-meter")).toHaveAttribute(
        "data-state",
        "done",
      );
      assert.equal(await confirmed(from), TEST_BYTES);
      assert.equal(
        Number(await to.locator("#receive-meter").getAttribute("data-bytes")),
        TEST_BYTES,
      );
      const elapsed = Number(
        await from.locator("#send-meter").getAttribute("data-elapsed-ms"),
      );
      const average = Number(
        await from.locator("#send-meter").getAttribute("data-average-bps"),
      );
      assert.equal(average, (TEST_BYTES * 1000) / elapsed);
      assert(elapsed > 0 && elapsed <= Date.now() - began + 1000);
      for (const page of pages)
        await expect(page.locator("#error")).toBeHidden();
      console.log(
        `PASS: verified exactly 1,000,000,000 bytes in ${(elapsed / 1000).toFixed(2)} s (${(average / 1e6).toFixed(2)} MB/s including receipt)`,
      );
    }
    await testBytes(a, b, true);
    assert(
      Number(await a.locator("#derp-traffic").getAttribute("data-tx-bytes")) >
        100_000_000,
    );
    await a.screenshot({
      path: "test-results/sdk-demo-desktop.png",
      fullPage: true,
    });
    await b.setViewportSize({ width: 390, height: 844 });
    await b.screenshot({
      path: "test-results/sdk-demo-mobile.png",
      fullPage: true,
    });
    assert(
      await b.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    console.log(
      "PASS: auto-started addresses, debug-page shortcut, safe messages, cancellation and a real 1 GB test crossing from WebRTC to DERP",
    );

    await a.locator("#disconnect").click();
    for (const page of pages)
      await expect(page.locator("#route")).toHaveAttribute(
        "data-state",
        "idle",
      );
    await a.locator("#webrtc").check();
    await connect(b, addressA);
    await fixture.stopRelay();
    await testBytes(b, a);
    for (const page of pages)
      await expect(page.locator("#route")).toHaveAttribute(
        "data-state",
        "direct",
      );
    await expect
      .poll(async () =>
        Number(await b.locator("#rtc-traffic").getAttribute("data-tx-bytes")),
      )
      .toBeGreaterThan(TEST_BYTES);
    await expect
      .poll(async () =>
        Number(await a.locator("#rtc-traffic").getAttribute("data-rx-bytes")),
      )
      .toBeGreaterThan(TEST_BYTES);
    console.log(
      "PASS: a complete verified 1 GB crosses WebRTC with DERP stopped; traffic counters cover the actual payload",
    );
    for (const page of pages) {
      await page.locator("#setup-panel").evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      await page.locator("#stop").click();
      await expect(page.locator("#start")).toBeVisible();
      await expect(page.locator("#send")).toBeDisabled();
      assert.equal(await page.evaluate(() => localStorage.length), 0);
    }
    assert.deepEqual(errors, []);
  } finally {
    await fixture.close();
  }
}, 1500000);
