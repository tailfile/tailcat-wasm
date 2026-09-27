import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  goVersion,
  source,
  tags,
  xcryptoVersion,
} from "../scripts/build-inputs.ts";
import { prepareForks } from "../scripts/prepare-forks.ts";

test("patched WASM crypto vectors and differential oracle", () => {
  const go = process.env.GO || "go";
  const env = {
    ...process.env,
    GOTOOLCHAIN: goVersion,
    GOWORK: "off",
    CGO_ENABLED: "0",
    GOFLAGS: "",
    GOOS: "js",
    GOARCH: "wasm",
    GOMAXPROCS: "1",
  };
  const goEnv = (name: string) =>
    execFileSync(go, ["env", name], { env, encoding: "utf8" }).trim();
  assert.equal(goEnv("GOVERSION"), goVersion);
  prepareForks(go);

  // Run upstream correctness tests against the same patched module replacement
  // used by the SDK. This executes WASM in Node, not the native assembly path.
  console.log(
    `Testing patched x/crypto ${xcryptoVersion} with ${goVersion} (js/wasm)`,
  );
  const fork = resolve(source, "../.forks/xcrypto");
  const poly = resolve(fork, "internal/poly1305");
  const temporary = mkdtempSync(resolve(tmpdir(), "tailcat-crypto-test-"));
  try {
    // Upstream tests also exercise their generic reference and directly seed
    // its private accumulator. Keep every vector, adapting only the test's
    // representation to Donna's 26-bit limbs. The overlay never enters dist.
    const reference = readFileSync(resolve(poly, "sum_generic.go"), "utf8")
      .replace("//go:build !js || purego", "//go:build js && wasm && !purego")
      .replaceAll(/\bmacState\b/g, "genericState")
      .replaceAll(/\binitialize\b/g, "initializeGeneric")
      .replaceAll(/\bfinalize\b/g, "finalizeGeneric");
    let tests = readFileSync(resolve(poly, "poly1305_test.go"), "utf8");
    assert.equal(
      tests.split("h.macState.h = s").length - 1,
      2,
      "Upstream accumulator tests changed; review the WASM test adapter",
    );
    tests = tests.replace("h.macState.h = s", "h.genericState.h = s");
    // Preserve H = s[0] + s[1]*2^64 + s[2]*2^128 by splitting at bits
    // 26, 52, 78 and 104. Do not mask h4: upstream deliberately supplies
    // unreduced states up to 2*(2^130-5)-1 to exercise carry/reduction edges.
    tests = tests.replace(
      "h.macState.h = s",
      `
      h.h0 = uint32(s[0]) & 0x3ffffff
      h.h1 = uint32(s[0] >> 26) & 0x3ffffff
      h.h2 = uint32((s[0] >> 52) | (s[1] << 12)) & 0x3ffffff
      h.h3 = uint32(s[1] >> 14) & 0x3ffffff
      h.h4 = uint32((s[1] >> 40) | (s[2] << 24))`,
    );
    const referencePath = resolve(temporary, "reference_test.go");
    const testPath = resolve(temporary, "poly1305_test.go");
    const overlayPath = resolve(temporary, "overlay.json");
    writeFileSync(referencePath, reference);
    writeFileSync(testPath, tests);
    writeFileSync(
      overlayPath,
      JSON.stringify({
        Replace: {
          [resolve(poly, "reference_wasm_test.go")]: referencePath,
          [resolve(poly, "poly1305_test.go")]: testPath,
          [resolve(poly, "donna_differential_test.go")]: resolve(
            source,
            "../tests/crypto/poly1305_wasm_test.go",
          ),
        },
      }),
    );
    for (const purego of [false, true]) {
      console.log(
        `\nRunning js/wasm ${purego ? "purego (upstream generic)" : "Donna32 + generic reference"}`,
      );
      execFileSync(
        go,
        [
          "test",
          "-mod=readonly",
          "-trimpath",
          "-buildvcs=false",
          "-v",
          "-tags",
          tags + (purego ? ",purego" : ""),
          "-count=1",
          "-timeout=5m",
          ...(purego ? [] : ["-overlay", overlayPath]),
          "-exec",
          resolve(goEnv("GOROOT"), "lib/wasm/go_js_wasm_exec"),
          "./internal/poly1305",
          "./chacha20poly1305",
        ],
        { cwd: fork, env, stdio: "inherit" },
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 900000);
