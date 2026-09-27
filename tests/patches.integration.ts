import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { goVersion, source, tags } from "../scripts/build-inputs.ts";
import { prepareForks } from "../scripts/prepare-forks.ts";

test("native and WASM packet paths and dial retries", () => {
  const go = process.env.GO || "go";
  const race = process.env.TEST_RACE === "1";
  const env = {
    ...process.env,
    GOTOOLCHAIN: goVersion,
    GOWORK: "off",
    GOFLAGS: "",
  };
  const goEnv = (name: string) =>
    execFileSync(go, ["env", name], { env, encoding: "utf8" }).trim();
  assert.equal(goEnv("GOVERSION"), goVersion);
  prepareForks(go);
  const nativeOSMap: Partial<Record<NodeJS.Platform, string>> = {
    linux: "linux",
    darwin: "darwin",
    win32: "windows",
  };
  const nativeOS = nativeOSMap[process.platform];
  const nativeArchMap: Partial<Record<NodeJS.Architecture, string>> = {
    x64: "amd64",
    arm64: "arm64",
    arm: "arm",
    ia32: "386",
  };
  const nativeArch = nativeArchMap[process.arch];
  assert(nativeOS && nativeArch, "Unsupported native test host");
  const common = [
    "test",
    "-mod=readonly",
    "-buildvcs=false",
    "-count=1",
    "-timeout=2m",
    "-v",
  ];
  console.log(
    `Testing packet paths (${nativeOS}/${nativeArch}${race ? ", race" : ""})`,
  );
  execFileSync(
    go,
    [
      ...common,
      ...(race ? ["-race"] : []),
      "-run=^TestPacketPath",
      "tailscale.com/wgengine/magicsock",
    ],
    {
      cwd: source,
      stdio: "inherit",
      env: {
        ...env,
        GOOS: nativeOS,
        GOARCH: nativeArch,
        CGO_ENABLED: race ? "1" : "0",
      },
    },
  );
  const wasmEnv = {
    ...env,
    GOOS: "js",
    GOARCH: "wasm",
    CGO_ENABLED: "0",
    GOMAXPROCS: "1",
  };
  const wasmExec = [
    "-exec",
    resolve(goEnv("GOROOT"), "lib/wasm/go_js_wasm_exec"),
  ];
  console.log("Testing packet paths (js/wasm)");
  // Upstream magicsock tests inspect expvar counters omitted by the SDK's
  // size-reduction tags. Run this package with its normal feature set.
  execFileSync(
    go,
    [
      ...common,
      ...wasmExec,
      "-run=^TestPacketPath",
      "tailscale.com/wgengine/magicsock",
    ],
    { cwd: source, stdio: "inherit", env: wasmEnv },
  );
  console.log("Testing dial retries (js/wasm, SDK tags)");
  execFileSync(
    go,
    [...common, ...wasmExec, "-tags", tags, "-run=^TestPingUntil", "."],
    { cwd: source, stdio: "inherit", env: wasmEnv },
  );
}, 900000);
