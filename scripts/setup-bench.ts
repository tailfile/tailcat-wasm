import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchToolsDirectory } from "./bench-binaries.ts";
import {
  fingerprint,
  goVersion,
  tailcatVersion,
  tailscaleVersion,
} from "./build-inputs.ts";
import { prepareForks } from "./prepare-forks.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const go = process.env.GO || "go";
const nativeOS = (
  { linux: "linux", darwin: "darwin", win32: "windows" } as Record<
    string,
    string
  >
)[process.platform];
const nativeArch = (
  { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" } as Record<
    string,
    string
  >
)[process.arch];
if (!nativeOS || !nativeArch)
  throw new Error(
    `Unsupported build host: ${process.platform}/${process.arch}`,
  );
const suffix = process.platform === "win32" ? ".exe" : "";
const inputHash = createHash("sha256")
  .update(fingerprint())
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(resolve(root, "scripts/prepare-forks.ts")))
  .update(`${nativeOS}/${nativeArch}`)
  .digest("hex");
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const manifestPath = resolve(benchToolsDirectory, "build.json");
let cached = false;
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  cached =
    manifest.fingerprint === inputHash &&
    ["derper", "tailcat", "tailcat-ws"].every(
      (name) =>
        manifest.binaries[name].sha256 ===
        hash(resolve(benchToolsDirectory, name + suffix)),
    );
} catch {
  /* Missing or stale tools are rebuilt below. */
}

if (!cached) {
  // Go 1.21+ can download the exact compiler requested by this repository.
  process.env.GOTOOLCHAIN = goVersion;
  process.env.GOFLAGS = "";
  const env = {
    ...process.env,
    GOWORK: "off",
    GOOS: nativeOS,
    GOARCH: nativeArch,
    CGO_ENABLED: "0",
  };
  try {
    const actual = execFileSync(go, ["env", "GOVERSION"], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
    }).trim();
    if (actual !== goVersion)
      throw new Error(`Expected ${goVersion}, got ${actual}`);
  } catch (error) {
    throw new Error(
      `Native benchmark tools require Go 1.21+ on PATH (the pinned ${goVersion} toolchain is selected automatically), or GO=/path/to/go. ${String(error)}`,
    );
  }
  prepareForks(go, root);
  mkdirSync(benchToolsDirectory, { recursive: true });
  const temporary = mkdtempSync(resolve(benchToolsDirectory, "build-"));
  try {
    const tailcat = resolve(root, ".forks/tailcat");
    const tailscale = resolve(root, ".forks/tailscale");
    // Use the CLI's pinned native dependency graph and release tags. Keep the
    // project's patched Tailscale baseline without modifying either go.mod.
    const modfile = resolve(temporary, "tailcat.mod");
    copyFileSync(resolve(tailcat, "go.mod"), modfile);
    copyFileSync(resolve(tailcat, "go.sum"), resolve(temporary, "tailcat.sum"));
    execFileSync(
      go,
      [
        "mod",
        "edit",
        `-modfile=${modfile}`,
        `-replace=tailscale.com=${tailscale}`,
      ],
      { cwd: tailcat, env, stdio: "inherit" },
    );
    const nativeTags = readFileSync(
      resolve(tailcat, "build-tags.txt"),
      "utf8",
    ).trim();
    const binaries: Record<string, { sha256: string; tags: string }> = {};
    for (const [name, cwd, extra] of [
      ["derper", tailscale, []],
      ["tailcat", tailcat, [`-modfile=${modfile}`, "-tags", nativeTags]],
      [
        "tailcat-ws",
        tailcat,
        [`-modfile=${modfile}`, "-tags", nativeTags + ",ts_debug_websockets"],
      ],
    ] as const) {
      console.log(`Building native ${name} (${nativeOS}/${nativeArch})…`);
      const output = resolve(temporary, name + suffix);
      execFileSync(
        go,
        [
          "build",
          "-mod=readonly",
          "-trimpath",
          "-buildvcs=false",
          "-ldflags=-s -w",
          ...extra,
          "-o",
          output,
          `./cmd/${name === "tailcat-ws" ? "tailcat" : name}`,
        ],
        { cwd, env, stdio: "inherit" },
      );
      binaries[name] = {
        sha256: hash(output),
        tags:
          name === "tailcat-ws"
            ? nativeTags + ",ts_debug_websockets"
            : name === "tailcat"
              ? nativeTags
              : "",
      };
    }
    for (const name of ["derper", "tailcat", "tailcat-ws"]) {
      const destination = resolve(benchToolsDirectory, name + suffix);
      // Windows cannot rename over an existing executable.
      if (existsSync(destination)) rmSync(destination);
      renameSync(resolve(temporary, name + suffix), destination);
    }
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          fingerprint: inputHash,
          go: goVersion,
          tailcat: tailcatVersion,
          tailscale: tailscaleVersion,
          platform: process.platform,
          arch: process.arch,
          binaries,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else console.log("Verified cached native benchmark tools.");

execFileSync(
  process.execPath,
  [resolve(root, "node_modules/playwright/cli.js"), "install", "chromium"],
  { stdio: "inherit" },
);
console.log(
  `Ready: ${benchToolsDirectory}\nRun npm run bench:transport; no binary path parameters are needed.`,
);
