import { fingerprint } from "./build-inputs.ts";
import { accessSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
const dist = new URL("../dist/", import.meta.url);
for (const name of [
  "index.js",
  "index.d.ts",
  "worker.js",
  "client.js",
  "worker-runtime.js",
  "node.js",
  "node-worker.js",
  "wasm-response.js",
  "wasm_exec.js",
  "tailcat.wasm.gz",
  "build.json",
  "THIRD_PARTY_NOTICES.txt",
]) {
  try {
    accessSync(new URL(name, dist));
  } catch {
    throw new Error(
      `Missing ${name}; restore the committed dist/ or run npm run build:wasm before packing.`,
    );
  }
}
const build = JSON.parse(readFileSync(new URL("build.json", dist), "utf8"));
if (build.fingerprint !== fingerprint())
  throw new Error(
    "WASM sources changed; run npm run build:wasm and commit the matching dist/ assets",
  );
if (
  createHash("sha256")
    .update(readFileSync(new URL("wasm_exec.js", dist)))
    .digest("hex") !== build.runtimeSHA256
)
  throw new Error("Go JavaScript runtime does not match its build manifest");
if (
  createHash("sha256")
    .update(gunzipSync(readFileSync(new URL("tailcat.wasm.gz", dist))))
    .digest("hex") !== build.wasmSHA256
)
  throw new Error("Compressed WASM does not match its build manifest");
console.error(
  `Verified self-contained package assets at ${fileURLToPath(dist)}`,
);
