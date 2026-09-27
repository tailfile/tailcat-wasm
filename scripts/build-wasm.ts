import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { prepareForks } from "./prepare-forks.ts";
import {
  source,
  goVersion,
  tailcatVersion,
  tailscaleVersion,
  xcryptoVersion,
  flags,
  fingerprint,
} from "./build-inputs.ts";

const output = fileURLToPath(new URL("../dist/", import.meta.url));
const go = process.env.GO || "go";
prepareForks(go);
const run = (
  args: string[],
  options: Partial<ExecFileSyncOptionsWithStringEncoding> = {},
) =>
  execFileSync(go, args, {
    encoding: "utf8",
    cwd: source,
    env: {
      ...process.env,
      GOOS: "js",
      GOARCH: "wasm",
      CGO_ENABLED: "0",
      GOWORK: "off",
    },
    ...options,
  });
const actualGo = run(["env", "GOVERSION"]).trim();
if (actualGo !== goVersion)
  throw new Error(
    `Expected ${goVersion}; set GO to that executable (got ${actualGo}).`,
  );
mkdirSync(output, { recursive: true });
const manifestPath = resolve(output, "build.json");
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {};
const hashFile = (name: string) =>
  createHash("sha256")
    .update(readFileSync(resolve(output, name)))
    .digest("hex");
const inputHash = fingerprint();
let wasm;
if (previous.fingerprint === inputHash) {
  try {
    const cached = gunzipSync(readFileSync(resolve(output, "tailcat.wasm.gz")));
    if (
      createHash("sha256").update(cached).digest("hex") === previous.wasmSHA256
    )
      wasm = cached;
  } catch {
    // Rebuild missing or damaged compressed assets from the pinned sources.
  }
}
if (!wasm) {
  console.log(
    `Building the browser adapter with local packet-path forks of Tailcat ${tailcatVersion}, Tailscale ${tailscaleVersion} and x/crypto ${xcryptoVersion}…`,
  );
  const temporary = mkdtempSync(join(tmpdir(), "tailcat-wasm-build-"));
  try {
    const binary = resolve(temporary, "tailcat.wasm");
    run(["build", ...flags, "-o", binary, "."], { stdio: "inherit" });
    wasm = readFileSync(binary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
// Always copy the runtime from the exact compiler used for this binary.
const goroot = run(["env", "GOROOT"]).trim();
copyFileSync(
  resolve(goroot, "lib/wasm/wasm_exec.js"),
  resolve(output, "wasm_exec.js"),
);
const notices = [
  "Third-party notices for @tailfile/tailcat-wasm\n" +
    "Generated from the Go runtime and the modules used by the WASM build.\n" +
    "Original license and notice texts are reproduced below without changes.\n",
];
function appendNotice(component: string, directory: string, filename: string) {
  notices.push(
    `${"=".repeat(80)}\n${component} — ${filename}\n${"=".repeat(80)}\n\n` +
      readFileSync(resolve(directory, filename), "utf8"),
  );
}
appendNotice(`Go ${goVersion}`, goroot, "LICENSE");
const deps = run([
  "list",
  ...flags.slice(0, -1),
  "-deps",
  "-f",
  "{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}",
  ".",
]);
for (const dependency of [
  ...new Set(deps.trim().split("\n").filter(Boolean)),
].sort()) {
  const [name, version, directory] = dependency.split("|");
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  ))
    if (
      entry.isFile() &&
      /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(entry.name)
    )
      appendNotice(`${name} ${version}`.trim(), directory, entry.name);
}
writeFileSync(resolve(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"));
// Remove the previous layout only after the replacement has been generated.
rmSync(resolve(output, "licenses"), { recursive: true, force: true });
writeFileSync(resolve(output, "tailcat.wasm.gz"), gzipSync(wasm));
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      tailcat: tailcatVersion,
      tailscale: tailscaleVersion,
      xcrypto: xcryptoVersion,
      go: goVersion,
      entrypoint: "wasm/main_js.go",
      fingerprint: inputHash,
      wasmSHA256: createHash("sha256").update(wasm).digest("hex"),
      runtimeSHA256: hashFile("wasm_exec.js"),
    },
    null,
    2,
  ) + "\n",
);
await import("./build.ts");
