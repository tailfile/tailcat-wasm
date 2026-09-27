import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";
import {
  goVersion,
  source,
  tags,
  xcryptoVersion,
} from "../scripts/build-inputs.ts";
import { prepareForks } from "../scripts/prepare-forks.ts";

type CryptoSample = {
  operation: string;
  bytes: number;
  ns: number;
  MBps: number;
  bytesAllocated: number;
  allocations: number;
};

// This is an isolated, single-thread AEAD control. Network/bridge benchmarks
// must not run concurrently with it (compilation and samples both consume CPU).
test("crypto benchmark", () => {
  const go = process.env.GO || "go";
  const nativeOSMap: Partial<Record<NodeJS.Platform, string>> = {
    linux: "linux",
    darwin: "darwin",
    win32: "windows",
  };
  const nativeArchMap: Partial<Record<NodeJS.Architecture, string>> = {
    x64: "amd64",
    arm64: "arm64",
    arm: "arm",
    ia32: "386",
  };
  const nativeOS = nativeOSMap[platform()];
  const nativeArch = nativeArchMap[arch()];
  assert(nativeOS && nativeArch, "Unsupported crypto benchmark host");
  const env = {
    ...process.env,
    GOTOOLCHAIN: goVersion,
    GOWORK: "off",
    CGO_ENABLED: "0",
    GOFLAGS: "",
    GOMAXPROCS: "1",
  };
  assert.equal(
    execFileSync(go, ["env", "GOVERSION"], { env, encoding: "utf8" }).trim(),
    goVersion,
  );
  prepareForks(go);
  const goroot = execFileSync(go, ["env", "GOROOT"], {
    env,
    encoding: "utf8",
  }).trim();
  const runs = Number(process.env.BENCH_CRYPTO_RUNS || 3);
  assert(Number.isInteger(runs) && runs > 0);
  const benchtime = process.env.BENCH_CRYPTO_TIME || "1s";
  const results: { kind: string; samples: CryptoSample[] }[] = [];
  const report = {
    timestamp: new Date().toISOString(),
    go: goVersion,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpuModel: cpus()[0]?.model,
    gomaxprocs: 1,
    runs,
    benchtime,
    crypto: xcryptoVersion,
    results,
  };
  mkdirSync("test-results", { recursive: true });
  for (const kind of ["native", "native-purego", "wasm"] as const) {
    console.log(`START crypto ${kind}`);
    const output: string = execFileSync(
      go,
      [
        "test",
        "-mod=readonly",
        "-trimpath",
        "-buildvcs=false",
        "-tags",
        tags + (kind === "native-purego" ? ",purego" : ""),
        "-run=^$",
        "-bench=^BenchmarkChaCha20Poly1305$",
        `-benchtime=${benchtime}`,
        `-count=${runs}`,
        "-json",
        ...(kind === "wasm"
          ? ["-exec", resolve(goroot, "lib/wasm/go_js_wasm_exec")]
          : []),
        ".",
      ],
      {
        cwd: source,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...env,
          GOOS: kind === "wasm" ? "js" : nativeOS,
          GOARCH: kind === "wasm" ? "wasm" : nativeArch,
        },
      },
    );
    writeFileSync(`test-results/crypto-${kind}.jsonl`, output);
    const log = output
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line).Output || "")
      .join("");
    const samples: CryptoSample[] = [
      ...log.matchAll(
        /BenchmarkChaCha20Poly1305\/(Seal|Open|ChaCha20|Poly1305|Donna32)\/(\d+)(?:-\d+)?\s+\d+\s+([\d.]+) ns\/op\s+([\d.]+) MB\/s\s+(\d+) B\/op\s+(\d+) allocs\/op/g,
      ),
    ].map((match) => ({
      operation: match[1],
      bytes: Number(match[2]),
      ns: Number(match[3]),
      MBps: Number(match[4]),
      bytesAllocated: Number(match[5]),
      allocations: Number(match[6]),
    }));
    assert.equal(
      samples.length,
      runs * 15,
      `Incomplete ${kind} benchmark output: ${log}`,
    );
    report.results.push({ kind, samples });
    writeFileSync(
      "test-results/crypto.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.table(samples);
  }
  console.log("Saved test-results/crypto.json and raw Go benchmark logs.");
}, 3600000);
