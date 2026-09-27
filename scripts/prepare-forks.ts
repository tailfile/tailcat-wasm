// go.mod pins each patch baseline; go.sum locks the downloaded module contents.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forks = {
  tailcat: "github.com/tailscale/tailcat",
  tailscale: "tailscale.com",
  xcrypto: "golang.org/x/crypto",
} as const;
export function prepareForks(
  go: string,
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const module = readFileSync(resolve(root, "wasm/go.mod"), "utf8");
  const pins = JSON.parse(readFileSync(resolve(root, "wasm/forks.json"), "utf8")) as
    Record<string, { version: string; commit: string }>;
  const sums = new Set(
    readFileSync(resolve(root, "wasm/go.sum"), "utf8").trim().split(/\r?\n/),
  );
  for (const [name, path] of Object.entries(forks)) {
    const version = module
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[0] === path)?.[1];
    // Go requires a canonical tag when that tag names the selected commit.
    // Lock the full revision separately: a moved tag must still fail closed.
    const pin = pins[path];
    if (
      !version ||
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) ||
      pin?.version !== version ||
      !/^[0-9a-f]{40}$/.test(pin?.commit)
    )
      throw new Error(
        `Pin ${path} to an exact version and full commit in wasm/forks.json matching wasm/go.mod`,
      );
    const info = JSON.parse(
      execFileSync(go, ["mod", "download", "-json", `${path}@${version}`], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { ...process.env, GOWORK: "off" },
      }),
    );
    if (!info.Dir) throw new Error(info.Error ?? `Missing sources for ${path}`);
    if (info.Path !== path || info.Version !== version)
      throw new Error(`Downloaded module does not match ${path}@${version}`);
    if (info.Origin?.Hash !== pin.commit)
      throw new Error(`Commit mismatch for ${path}@${version}; expected ${pin.commit}`);
    for (const [suffix, checksum] of [
      ["", info.Sum],
      ["/go.mod", info.GoModSum],
    ])
      if (!sums.has(`${path} ${version}${suffix} ${checksum}`))
        throw new Error(
          `Checksum mismatch for ${path}@${version}${suffix}; check wasm/go.sum`,
        );
    const target = resolve(root, ".forks", name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(info.Dir, target, { recursive: true });
    makeWritable(target);
    execFileSync(
      "git",
      ["apply", "--unsafe-paths", resolve(root, "patches", `${name}.patch`)],
      { cwd: target },
    );
  }
}

// Module-cache copies retain read-only modes. Do not depend on a Unix chmod
// executable when preparing native benchmark tools on Windows.
function makeWritable(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o200);
  if (stat.isDirectory())
    for (const name of readdirSync(path)) makeWritable(resolve(path, name));
}
