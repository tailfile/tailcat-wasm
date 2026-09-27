import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const source = fileURLToPath(new URL("../wasm/", import.meta.url));
const module = readFileSync(resolve(source, "go.mod"), "utf8");
export const goVersion = "go" + requiredMatch(/^go ([\d.]+)$/m);
export const tailcatVersion = requiredMatch(
  /github\.com\/tailscale\/tailcat (v\S+)/,
);
export const tailscaleVersion = requiredMatch(/tailscale\.com (v\S+)/);
export const xcryptoVersion = requiredMatch(/golang\.org\/x\/crypto (v\S+)/);
export const tags = readFileSync(
  resolve(source, "build-tags.txt"),
  "utf8",
).trim();
export const flags = [
  "-mod=readonly",
  "-trimpath",
  "-buildvcs=false",
  "-tags",
  tags,
  "-ldflags=-s -w",
];
export const sources = readdirSync(source)
  .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
  .sort();
export function fingerprint() {
  const hash = createHash("sha256")
    .update(goVersion)
    .update(JSON.stringify(flags));
  for (const name of ["go.mod", "go.sum", "forks.json", ...sources])
    hash.update(name).update(readFileSync(resolve(source, name)));
  const patches = resolve(source, "../patches");
  for (const name of readdirSync(patches).sort())
    hash.update(name).update(readFileSync(resolve(patches, name)));
  return hash.digest("hex");
}

function requiredMatch(pattern: RegExp): string {
  const value = module.match(pattern)?.[1];
  if (!value) throw new Error(`Missing build input: ${pattern}`);
  return value;
}
