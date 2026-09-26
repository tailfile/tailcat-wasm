import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { createStaticServer, serverPort } from "./static-server.ts";

const binary =
  process.env.DERPER_BIN || resolve(`.cache/derper-${process.arch}`);
if (!existsSync(binary))
  throw new Error(
    "Set DERPER_BIN to a local Tailscale derper binary to run the real demo test.",
  );
const temporary = await mkdtemp(join(tmpdir(), "tailcat-demo-"));
const site = join(temporary, "site");
const demo = join(site, "tailcat-wasm");
const mapFile = join(demo, "derpmap-test.json");
let relay: ReturnType<typeof spawn> | undefined;
let browser: Browser | undefined;
let host: ReturnType<typeof createStaticServer> | undefined;
const errors: string[] = [];
try {
  // A project-page subdirectory catches accidental root-relative asset paths.
  await mkdir(demo, { recursive: true });
  for (const name of ["index.html", ".nojekyll", "dist"])
    await cp(new URL(`../${name}`, import.meta.url), join(demo, name), {
      recursive: true,
    });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const certs = join(temporary, "certs");
  relay = spawn(
    binary,
    [
      "-a",
      `127.0.0.1:${port}`,
      "-http-port",
      "-1",
      "-stun=false",
      "-hostname",
      "127.0.0.1",
      "-certmode",
      "manual",
      "-certdir",
      certs,
      "-c",
      join(temporary, "derper.json"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let relayLog = "";
  relay.stderr!.on("data", (bytes) => {
    relayLog += bytes;
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await access(join(certs, "127.0.0.1.crt"));
      break;
    } catch {}
    if (Date.now() > deadline || relay.exitCode !== null)
      throw new Error(relayLog || "DERP fixture did not start");
    await delay(100);
  }
  await writeFile(
    mapFile,
    JSON.stringify({
      Regions: {
        900: {
          RegionID: 900,
          RegionCode: "local",
          RegionName: "Local test relay",
          Nodes: [
            {
              Name: "local",
              RegionID: 900,
              HostName: "127.0.0.1",
              IPv4: "127.0.0.1",
              IPv6: "none",
              DERPPort: port,
              STUNPort: -1,
            },
          ],
        },
      },
    }),
  );
  host = createStaticServer({ staticDir: site });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const base = `http://127.0.0.1:${serverPort(host.server)}/tailcat-wasm`;
  const response = await fetch(base);
  assert.equal(response.url, base + "/");
  assert.equal(
    await response.text(),
    await readFile(new URL("../index.html", import.meta.url), "utf8"),
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ["--no-sandbox", "--ignore-certificate-errors"],
  });
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${base}/?map=${encodeURIComponent(`${base}/derpmap-test.json`)}`,
    );
    await expect(page).toHaveTitle("Tailcat WASM · Browser demo");
    await expect(page.locator("#address")).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("#start")).toBeHidden();
    await expect(page.locator("#connect")).toBeEnabled();
  }
  const [a, b] = pages;
  await a.locator("#stop").click();
  await expect(a.locator("#start")).toBeVisible();
  await expect(a.locator("#address")).toBeHidden();
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
  await expect.poll(() => confirmed(a), { timeout: 30_000 }).toBeGreaterThan(0);
  await a.locator("#cancel-probe").click();
  await expect(a.locator("#send-meter")).toHaveAttribute("data-state", "error");
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
        .then((bytes) =>
          console.log(
            `1 GB test: ${((bytes / TEST_BYTES) * 100).toFixed(1)}% receiver-confirmed`,
          ),
        )
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
    await expect(from.locator("#probe-status")).toContainText("Verified 1 GB");
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
    for (const page of pages) await expect(page.locator("#error")).toBeHidden();
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
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  console.log(
    "PASS: auto-started addresses, debug-page shortcut, safe messages, cancellation and a real 1 GB test crossing from WebRTC to DERP",
  );

  await a.locator("#disconnect").click();
  for (const page of pages)
    await expect(page.locator("#route")).toHaveAttribute("data-state", "idle");
  await a.locator("#webrtc").check();
  await connect(b, addressA);
  relay.kill("SIGTERM");
  await once(relay, "exit");
  relay = undefined;
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
  await browser?.close();
  await host?.close();
  if (relay && relay.exitCode === null) {
    relay.kill("SIGTERM");
    await once(relay, "exit");
  }
  await rm(temporary, { recursive: true, force: true });
}
