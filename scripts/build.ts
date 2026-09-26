import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
copyFileSync(
  resolve(root, "src/wasm_exec.d.ts"),
  resolve(output, "wasm_exec.d.ts"),
);
const require = createRequire(import.meta.url);
const tsPackage = require.resolve("typescript/package.json");
const tsBin = resolve(
  dirname(tsPackage),
  JSON.parse(readFileSync(tsPackage, "utf8")).bin.tsc,
);
execFileSync(process.execPath, [tsBin, "-p", resolve(root, "tsconfig.json")], {
  stdio: "inherit",
});
await import("./verify-dist.ts");
for (const name of ["tailcat.wasm", "tailcat.wasm.br"])
  rmSync(resolve(output, name), { force: true });
// Keep npm pack --json machine-readable when this build runs in prepack.
console.error(
  "Browser and Node SDK ready from prebuilt WASM; no Go toolchain required.",
);
