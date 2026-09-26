// go.mod pins each patch baseline; go.sum locks the downloaded module contents.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function prepareForks(
  go: string,
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const module = readFileSync(resolve(root, "wasm/go.mod"), "utf8");
  const sums = new Set(
    readFileSync(resolve(root, "wasm/go.sum"), "utf8").trim().split(/\r?\n/),
  );
  for (const [name, path] of [
    ["tailcat", "github.com/tailscale/tailcat"],
    ["tailscale", "tailscale.com"],
  ]) {
    const version = module
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[0] === path)?.[1];
    if (
      !version ||
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+incompatible)?$/.test(version)
    )
      throw new Error(
        `Pin ${path} to an exact tag or Go pseudo-version in wasm/go.mod`,
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
    execFileSync("chmod", ["-R", "u+w", target]);
    execFileSync(
      "git",
      ["apply", "--unsafe-paths", resolve(root, "patches", `${name}.patch`)],
      { cwd: target },
    );
  }
}
