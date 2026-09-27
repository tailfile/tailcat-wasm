import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const benchToolsDirectory = resolve(
  root,
  `.cache/bench/${process.platform}-${process.arch}`,
);

type BenchBinary = "derper" | "tailcat" | "tailcat-ws";
export function benchBinary(name: BenchBinary) {
  const override =
    process.env[
      name === "derper"
        ? "DERPER_BIN"
        : name === "tailcat-ws"
          ? "TAILCAT_WS_BIN"
          : "TAILCAT_BIN"
    ];
  if (override) return resolve(override);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const installed = resolve(benchToolsDirectory, name + suffix);
  if (existsSync(installed)) return installed;
  // Keep manually prepared binaries from earlier checkouts usable.
  const legacy = resolve(root, `.cache/${name}-${process.arch}${suffix}`);
  if (existsSync(legacy)) return legacy;
  throw new Error(
    `Missing ${name}; run npm run bench:setup, or set ${name.toUpperCase().replaceAll("-", "_")}_BIN to its executable.`,
  );
}

export async function benchBinaryInfo(name: BenchBinary) {
  const path = benchBinary(name);
  const sha256 = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  let pinnedBuild;
  try {
    const manifest = JSON.parse(
      await readFile(resolve(benchToolsDirectory, "build.json"), "utf8"),
    );
    if (manifest.binaries[name].sha256 === sha256)
      pinnedBuild = {
        go: manifest.go,
        tailcat: manifest.tailcat,
        tailscale: manifest.tailscale,
        tags: manifest.binaries[name].tags,
      };
  } catch {
    /* User-provided binaries can have no matching build manifest. */
  }
  return { path, sha256, pinnedBuild };
}
