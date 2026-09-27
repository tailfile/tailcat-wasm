import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { arch, cpus, platform } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { browserCPU } from "./browser-cpu.ts";
import { browserFixture } from "./browser-fixture.ts";
import { throughputProfiler } from "./throughput-profile.ts";
import { setupThroughput } from "./throughput-browser.ts";
import { nativeThroughput } from "./throughput-native.ts";
import { nodeThroughput } from "./throughput-node.ts";
import { benchBinary, benchBinaryInfo } from "../scripts/bench-binaries.ts";

type Case = {
  name: string;
  kind: "raw" | "wrapped" | "bridge" | "tailcat" | "native" | "node";
  mtu: number;
  chunk?: number;
  reliable?: boolean;
  baseline?: boolean;
  queue?: number;
  noReceipts?: boolean;
  rawBuffer?: number;
  verify?: boolean;
  audit?: boolean;
  derp?: boolean;
  gomaxprocs?: number;
  websocket?: boolean;
};
const cases: Case[] = [
  { name: "raw-8k", kind: "raw", mtu: 8192 },
  { name: "raw-reliable-8k", kind: "raw", mtu: 8192, reliable: true },
  { name: "raw-32k", kind: "raw", mtu: 32768 },
  { name: "raw-reliable-32k", kind: "raw", mtu: 32768, reliable: true },
  { name: "wrapped-8k", kind: "wrapped", mtu: 8192 },
  { name: "wrapped-32k", kind: "wrapped", mtu: 32768 },
  { name: "bridge-8k", kind: "bridge", mtu: 8192 },
  { name: "bridge-32k", kind: "bridge", mtu: 32768 },
  { name: "tailcat-8k", kind: "tailcat", mtu: 8192 },
  { name: "tailcat-32k", kind: "tailcat", mtu: 32768 },
  { name: "tailcat-derp-8k", kind: "tailcat", mtu: 8192, derp: true },
  { name: "native-derp-8k", kind: "native", mtu: 8192, derp: true },
  { name: "native-direct-1280", kind: "native", mtu: 1280 },
  {
    name: "tailcat-8k-no-receipts",
    kind: "tailcat",
    mtu: 8192,
    noReceipts: true,
  },
  {
    name: "tailcat-8k-write1m",
    kind: "tailcat",
    mtu: 8192,
    chunk: 1024 * 1024,
  },
  {
    name: "tailcat-8k-queue4m",
    kind: "tailcat",
    mtu: 8192,
    queue: 4 * 1024 * 1024,
  },
  { name: "baseline-8k", kind: "tailcat", mtu: 8192, baseline: true },
  { name: "baseline-32k", kind: "tailcat", mtu: 32768, baseline: true },
];
cases.push(
  {
    name: "raw-audit-reference",
    kind: "raw",
    mtu: 32768,
    reliable: true,
    audit: true,
  },
  {
    name: "raw-audit-count",
    kind: "raw",
    mtu: 32768,
    reliable: true,
    verify: false,
    audit: true,
  },
  {
    name: "raw-audit-buffer1m",
    kind: "raw",
    mtu: 32768,
    reliable: true,
    rawBuffer: 1024 * 1024,
    audit: true,
  },
  {
    name: "raw-audit-buffer4m",
    kind: "raw",
    mtu: 32768,
    reliable: true,
    rawBuffer: 4 * 1024 * 1024,
    audit: true,
  },
  {
    name: "raw-audit-chunk64k",
    kind: "raw",
    mtu: 65536,
    reliable: true,
    rawBuffer: 4 * 1024 * 1024,
    audit: true,
  },
  {
    name: "raw-audit-chunk256k",
    kind: "raw",
    mtu: 262144,
    reliable: true,
    rawBuffer: 4 * 1024 * 1024,
    audit: true,
  },
  {
    name: "raw-audit-fast",
    kind: "raw",
    mtu: 262144,
    reliable: true,
    rawBuffer: 4 * 1024 * 1024,
    verify: false,
    audit: true,
  },
);
const baseline = process.env.BENCH_BASELINE;
// Match runtime/transport pairs at each inner MTU. Raw cases use that size as
// their application message size; they do not contain Tailcat's inner headers.
const matrix: string[] = [];
for (const mtu of [1280, 4096, 8192, 16384, 32768]) {
  const label = mtu === 1280 ? "1280" : `${mtu / 1024}k`;
  for (const test of [
    { name: `raw-reliable-${label}`, kind: "raw", reliable: true },
    { name: `tailcat-${label}`, kind: "tailcat" },
    { name: `tailcat-derp-${label}`, kind: "tailcat", derp: true },
    { name: `node-derp-${label}`, kind: "node", derp: true },
    { name: `native-derp-${label}`, kind: "native", derp: true },
    { name: `native-ws-${label}`, kind: "native", derp: true, websocket: true },
    ...(baseline
      ? [{ name: `baseline-${label}`, kind: "tailcat", baseline: true }]
      : []),
  ] as Omit<Case, "mtu">[]) {
    if (!cases.some((c) => c.name === test.name)) cases.push({ ...test, mtu });
    matrix.push(test.name);
  }
  if (baseline)
    cases.push(
      {
        name: `baseline-derp-${label}`,
        kind: "tailcat",
        mtu,
        derp: true,
        baseline: true,
      },
      {
        name: `baseline-node-derp-${label}`,
        kind: "node",
        mtu,
        derp: true,
        baseline: true,
      },
    );
}
cases.push(
  {
    name: "native-derp-8k-p1",
    kind: "native",
    mtu: 8192,
    derp: true,
    gomaxprocs: 1,
  },
  {
    name: "native-ws-8k-p1",
    kind: "native",
    mtu: 8192,
    derp: true,
    gomaxprocs: 1,
    websocket: true,
  },
);
matrix.push("native-derp-8k-p1", "native-ws-8k-p1", "native-direct-1280");
const requested =
  process.env.BENCH_CASES ??
  (process.env.BENCH_MATRIX === "1" ? "matrix" : undefined);
const selected =
  requested === "matrix"
    ? matrix
    : requested === "all"
      ? cases
          .filter((c) => (!c.baseline || baseline) && !c.audit)
          .map((c) => c.name)
      : (requested?.split(",") ?? [
          "raw-audit-reference",
          "tailcat-8k",
          "tailcat-32k",
          "tailcat-derp-8k",
          "native-derp-8k",
          "native-direct-1280",
          ...(baseline ? ["baseline-8k", "baseline-32k"] : []),
        ]);
assert(
  selected.every((name) => cases.some((c) => c.name === name)),
  "Unknown BENCH_CASES entry",
);
const stopRelay = process.env.BENCH_STOP_RELAY === "1";
assert(
  !stopRelay ||
    (selected.length === 1 &&
      cases.find((c) => c.name === selected[0])?.kind === "tailcat" &&
      !cases.find((c) => c.name === selected[0])?.derp),
  "BENCH_STOP_RELAY=1 requires exactly one WebRTC Tailcat case",
);
assert(
  !selected.some((name) => name.startsWith("baseline-")) || baseline,
  "Historical cases require BENCH_BASELINE",
);
const bytes = Number(process.env.BENCH_BYTES || 1024 * 1024 * 1024);
const runs = Number(process.env.BENCH_RUNS || 3);
const warmupBytes = Number(process.env.BENCH_WARMUP_BYTES || 128 * 1024 * 1024);
assert(
  Number.isSafeInteger(warmupBytes) &&
    warmupBytes > 0 &&
    warmupBytes % 32768 === 0,
);
assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes % 32768 === 0);
assert(Number.isSafeInteger(runs) && runs > 0);
const activeCases = selected.map((name) => cases.find((c) => c.name === name)!);
for (const c of activeCases.filter((c) => c.kind === "native"))
  benchBinary(c.websocket ? "tailcat-ws" : "tailcat");
// Raw senders support a short final message, but its sequence needs four bytes.
assert(
  activeCases.every(
    (c) =>
      c.kind !== "raw" ||
      [bytes, warmupBytes].every((n) => n % c.mtu === 0 || n % c.mtu >= 4),
  ),
  "Raw final messages must fit their four-byte sequence",
);
assert(
  process.env.BENCH_CPU !== "1" || platform() === "linux",
  "BENCH_CPU=1 requires Linux /proc thread counters",
);
test("transport throughput benchmark", async () => {
  const fixture = await browserFixture();
  const { browser, base } = fixture;
  const secondBrowser =
    process.env.BENCH_SEPARATE_BROWSERS !== "0"
      ? await chromium.launch({
          executablePath: process.env.CHROMIUM_BIN || undefined,
          args: ["--no-sandbox", "--ignore-certificate-errors"],
        })
      : undefined;
  const cpu =
    process.env.BENCH_CPU === "1"
      ? await browserCPU([browser, ...(secondBrowser ? [secondBrowser] : [])])
      : undefined;
  const ticksPerSecond = cpu
    ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim())
    : undefined;
  const report: any = {
    timestamp: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    build: JSON.parse(await readFile("dist/build.json", "utf8")),
    browser: browser.version(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    derper: await benchBinaryInfo("derper"),
    baseline,
    stopRelay,
    separateBrowsers: !!secondBrowser,
    ticksPerSecond,
    bytes,
    runs,
    warmupBytes,
    instrumentIO: process.env.BENCH_IO === "1",
    results: [],
  };
  await mkdir("test-results", { recursive: true });
  const output = process.env.BENCH_OUTPUT || "test-results/throughput.json";
  try {
    if (baseline) {
      const directory = fixture.siteDirectory + "/baseline";
      await mkdir(directory);
      const archive = execFileSync("git", ["archive", baseline, "dist"], {
        maxBuffer: 32 * 1024 * 1024,
      });
      execFileSync("tar", ["-x", "-C", directory], { input: archive });
      report.baselineBuild = JSON.parse(
        await readFile(directory + "/dist/build.json", "utf8"),
      );
    }
    for (const test of activeCases) {
      console.log(`START ${test.name}`);
      if (test.kind === "native" || test.kind === "node") {
        report.results.push(
          await (test.kind === "native" ? nativeThroughput : nodeThroughput)({
            ...test,
            bytes,
            runs,
            warmupBytes,
            moduleURL: test.baseline
              ? pathToFileURL(fixture.siteDirectory + "/baseline/dist/node.js")
                  .href
              : undefined,
          }),
        );
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        continue;
      }
      const browserKind = test.kind;
      const expectedPath = test.derp ? "derp" : "direct";
      const contexts = await Promise.all([
        browser.newContext(),
        (secondBrowser ?? browser).newContext(),
      ]);
      const pages = await Promise.all(contexts.map((c) => c.newPage()));
      const errors: string[] = [];
      const profilers = [];
      let diagnostic: ReturnType<typeof setInterval> | undefined;
      try {
        if (process.env.BENCH_PROFILE)
          profilers.push(...(await Promise.all(pages.map(throughputProfiler))));
        for (const context of contexts) {
          if (process.env.BENCH_IO === "1")
            await context.route("**/dist/worker.js", async (route) => {
              const original = await route.fetch();
              // Diagnostic only: count actual browser WebSocket messages. Do not
              // mix instrumented measurements into the primary throughput table.
              const instrumentation = `
const io = globalThis.__tailcatBenchIO = { txMessages: 0, rxMessages: 0, txBytes: 0, rxBytes: 0 };
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", ({ data }) => {
      io.rxMessages++;
      io.rxBytes += data.byteLength ?? data.size ?? data.length;
    });
  }
  send(data) {
    super.send(data);
    io.txMessages++;
    io.txBytes += data.byteLength ?? data.size ?? data.length;
  }
};
`;
              await route.fulfill({
                response: original,
                body: instrumentation + (await original.text()),
              });
            });
          if (test.noReceipts)
            await context.route("**/dist/webrtc.js", async (route) => {
              const original = await readFile("dist/webrtc.js", "utf8");
              const body = original
                .replace(
                  /const group = packet.bytes.byteLength > 512[\s\S]*?(?=if \(!transmit)/,
                  "",
                )
                .replace(
                  "acknowledge(id, s, value.sequence);",
                  "void value.sequence;",
                );
              assert.notEqual(body, original);
              assert(!body.includes("s.inflight.set(sequence"));
              await route.fulfill({ body, contentType: "text/javascript" });
            });
          if (test.queue)
            await context.route("**/dist/rtc-protocol.js", async (route) => {
              const body = (await readFile("dist/rtc-protocol.js", "utf8"))
                .replace(
                  "RTC_QUEUE_LIMIT = 256 * 1024",
                  `RTC_QUEUE_LIMIT = ${test.queue}`,
                )
                .replace(
                  "RTC_WORKER_LIMIT = 1024 * 1024",
                  `RTC_WORKER_LIMIT = ${test.queue}`,
                );
              await route.fulfill({ body, contentType: "text/javascript" });
            });
        }
        for (const [i, page] of pages.entries()) {
          page.on("pageerror", (error) => errors.push(error.message));
          if (test.kind === "wrapped" || test.kind === "bridge")
            await page.exposeFunction("signal", (value: string) =>
              pages[1 - i].evaluate((value) => {
                const w = window as any;
                w.manager.handle({ session: 1, kind: "signal", value });
              }, value),
            );
          await page.goto(base + "/transport-test.html");
        }
        const addresses = await Promise.all(
          pages.map((p) =>
            p.evaluate(setupThroughput, {
              base,
              assets: base + (test.baseline ? "/baseline/dist" : "/dist"),
              ...test,
              kind: browserKind,
              chunk: test.chunk || 256 * 1024,
            }),
          ),
        );
        const [a, b] = pages;

        if (test.kind === "tailcat") {
          await a.evaluate(
            async ({ base, address }) => {
              const w = window as any;
              w.accept(
                await w.runtime.dial(address, base + "/derpmap-test.json"),
              );
            },
            { base, address: addresses[1] },
          );
        } else if (test.kind === "raw") {
          await a.evaluate(() => (window as any).open());
          const offer = await a.evaluate(() =>
            (window as any).description(true),
          );
          await b.evaluate(
            (offer) => (window as any).pc.setRemoteDescription(offer),
            offer,
          );
          const answer = await b.evaluate(() =>
            (window as any).description(false),
          );
          await a.evaluate(
            (answer) => (window as any).pc.setRemoteDescription(answer),
            answer,
          );
        } else {
          await b.evaluate(() =>
            (window as any).manager.handle({
              session: 1,
              kind: "start",
              value: { initiator: false, peerNodeKey: "synthetic" },
            }),
          );
          await a.evaluate(() =>
            (window as any).manager.handle({
              session: 1,
              kind: "start",
              value: { initiator: true, peerNodeKey: "synthetic" },
            }),
          );
        }
        for (const p of pages)
          await p.waitForFunction(
            ({ kind, expectedPath }) =>
              kind === "raw"
                ? (window as any).channel?.readyState === "open"
                : (window as any).peers[0]?.state === expectedPath,
            { kind: test.kind, expectedPath },
            { timeout: 45000 },
          );
        if (stopRelay) await fixture.stopRelay();
        diagnostic = setInterval(() => {
          void Promise.all(
            pages.map((p) =>
              p.evaluate(() => ({
                received: (window as any).received,
                target: (window as any).target,
                error: (window as any).error,
              })),
            ),
          )
            .then((data) => console.log("progress", JSON.stringify(data)))
            .catch(() => {});
        }, 30000);
        async function transfer(total: number, warmup = false) {
          if (test.kind !== "raw") {
            for (const p of pages) {
              const state = await p.evaluate(() => ({
                peers: (window as any).peers,
                states: (window as any).states,
              }));
              assert.equal(
                state.peers[0]?.state,
                expectedPath,
                JSON.stringify(state),
              );
            }
          }
          await b.evaluate((total) => (window as any).prepare(total), total);
          let timer: ReturnType<typeof setTimeout>;
          const started = await Promise.race([
            a.evaluate(
              ({ total, warmup }) => (window as any).run(total, warmup),
              { total, warmup },
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${test.name} sender stalled`)),
                120000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          await b.waitForFunction(
            ({ allowLoss, expectedPath }) => {
              const w = window as any;
              return (
                w.received >= w.target ||
                w.error ||
                (w.peers.length && w.peers[0].state !== expectedPath) ||
                (allowLoss &&
                  w.ended &&
                  performance.timeOrigin + performance.now() - w.ended > 1000)
              );
            },
            {
              allowLoss: test.kind !== "tailcat" && !test.reliable,
              expectedPath,
            },
            { timeout: 120000 },
          );
          const result = await b.evaluate(() => {
            const w = window as any;
            return {
              received: w.received,
              corrupt: w.corrupt,
              duplicates: w.duplicates,
              ended: w.ended,
              error: w.error,
            };
          });
          assert.equal(result.error, undefined);
          if (test.kind === "tailcat" || test.reliable)
            assert.equal(result.received, total);
          assert.equal(result.corrupt, 0);
          assert.equal(result.duplicates, 0);
          let receiptElapsedMS: number | undefined;
          if (test.kind === "raw" && test.reliable) {
            await a.waitForFunction(() => (window as any).receiptAt > 0);
            receiptElapsedMS = await a.evaluate(
              () => (window as any).receiptAt - (window as any).started,
            );
          }
          return {
            receiptElapsedMS,
            receiptMBps: receiptElapsedMS
              ? result.received / receiptElapsedMS / 1000
              : undefined,
            elapsedMS: result.ended - started,
            received: result.received,
            corrupt: result.corrupt,
            duplicates: result.duplicates,
            lostBytes: total - result.received,
            MBps: result.received / (result.ended - started) / 1000,
          };
        }

        const warmup = await transfer(report.warmupBytes, true);

        const samples = [];
        const before = await a.evaluate(() => (window as any).peers);
        for (let n = 0; n < runs; n++) {
          const cpuBefore = await cpu?.();
          const sample = await transfer(bytes);
          if (cpuBefore) {
            const cpuAfter = await cpu!();
            const previous = new Map(cpuBefore.rows.map((r) => [r.tid, r]));
            Object.assign(sample, {
              cpu: {
                durationMS: cpuAfter.at - cpuBefore.at,
                threads: cpuAfter.rows
                  .map((r) => ({
                    ...r,
                    cpuMS:
                      (1000 *
                        (r.ticks - (previous.get(r.tid)?.ticks ?? r.ticks))) /
                      ticksPerSecond!,
                  }))
                  .filter((r) => r.cpuMS > 0)
                  .sort((a, b) => b.cpuMS - a.cpuMS),
              },
            });
          }
          samples.push(sample);
          console.log(
            `${test.name} ${n + 1}/${runs}: ${sample.MBps.toFixed(2)} MB/s, lost ${sample.lostBytes} B`,
          );
        }
        if (profilers.length) {
          await Promise.all(profilers.map((p) => p.start()));
          await transfer(bytes);
          const profiles = await Promise.all(profilers.map((p) => p.stop()));
          for (const [i, threads] of profiles.entries())
            for (const { thread, profile } of threads)
              await writeFile(
                `test-results/${test.name}-${i}-${thread}.cpuprofile`,
                JSON.stringify(profile),
              );
        }
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const stats = await Promise.all(
          pages.map((p) =>
            p.evaluate(async () => {
              const w = window as any;
              const ice = [];
              for (const pc of w.pcs) {
                const stats = await pc.getStats();
                for (const s of stats.values())
                  if (s.type === "candidate-pair" && s.nominated) ice.push(s);
              }
              return {
                peers: w.peers,
                states: w.states,
                ice,
                maxMessageSizes: w.pcs.map(
                  (pc: RTCPeerConnection) => pc.sctp?.maxMessageSize,
                ),
                error: w.error,
              };
            }),
          ),
        );
        const workerIO =
          process.env.BENCH_IO === "1"
            ? await Promise.all(
                pages.map((p) =>
                  Promise.all(
                    p
                      .workers()
                      .map((worker) =>
                        worker.evaluate(
                          () => (globalThis as any).__tailcatBenchIO,
                        ),
                      ),
                  ),
                ),
              )
            : undefined;
        assert.deepEqual(errors, []);
        assert(stats.every((s) => !s.error));
        if (test.kind !== "raw") {
          assert(stats.every((s) => s.peers[0].state === expectedPath));
          for (const s of stats) {
            const direct = s.states.findIndex(
              (event: any) => event.state === expectedPath,
            );
            assert(direct >= 0);
            assert(
              s.states
                .slice(direct)
                .every((event: any) => event.state === expectedPath),
              "Path switched during a benchmark",
            );
          }
        }
        if (test.derp) {
          assert(
            stats.every((s) => s.ice.length === 0),
            "DERP control unexpectedly created WebRTC",
          );
          assert(
            stats[0].peers[0].derpTxBytes >= bytes * runs,
            "DERP counters must cover the measured payload",
          );
        }
        if (test.kind === "tailcat" && !test.baseline && !test.derp)
          assert(
            stats[0].peers[0].derpTxBytes < 16384,
            "Bulk payload leaked to DERP",
          );
        clearInterval(diagnostic);
        const rates = samples.map((s) => s.MBps).sort((a, b) => a - b);
        report.results.push({
          ...test,
          workerIO,
          transport: test.derp ? "derp" : "webrtc",
          warmup,
          samples,
          medianMBps:
            (rates[Math.floor((rates.length - 1) / 2)] +
              rates[Math.floor(rates.length / 2)]) /
            2,
          before,
          stats,
        });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
      } finally {
        clearInterval(diagnostic);
        await Promise.all(contexts.map((c) => c.close()));
      }
    }
  } finally {
    await secondBrowser?.close();
    await fixture.close();
  }
  console.table(
    report.results.map(({ name, medianMBps, samples }: any) => ({
      name,
      medianMBps: medianMBps.toFixed(2),
      range: samples.map((s: any) => s.MBps.toFixed(2)).join(" / "),
    })),
  );
  console.log(`Saved ${output}`);
}, 7200000);
