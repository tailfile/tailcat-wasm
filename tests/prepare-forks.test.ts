import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareForks } from "../scripts/prepare-forks.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "tailcat-forks-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pins = [
    ["tailcat", "github.com/tailscale/tailcat", "v1.2.3"],
    ["tailscale", "tailscale.com", "v2.3.4-pre.0.20260102030405-abcdef123456"],
  ];
  const downloads: Record<string, Record<string, string>> = {};
  const sums: string[] = [];
  for (const name of ["wasm", "patches"])
    mkdirSync(join(root, name), { recursive: true });
  for (const [name, path, version] of pins) {
    const source = join(root, "upstream", name);
    const fork = join(root, ".forks", name);
    mkdirSync(source, { recursive: true });
    mkdirSync(fork, { recursive: true });
    writeFileSync(join(source, "original.txt"), "upstream\n");
    writeFileSync(join(fork, "stale.txt"), "old local edit\n");
    writeFileSync(
      join(root, "patches", `${name}.patch`),
      `--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+${name}\n`,
    );
    downloads[`${path}@${version}`] = {
      Path: path,
      Version: version,
      Dir: source,
      Sum: "h1:module-checksum",
      GoModSum: "h1:go-mod-checksum",
    };
    sums.push(`${path} ${version} h1:module-checksum`);
    sums.push(`${path} ${version}/go.mod h1:go-mod-checksum`);
  }
  const module = `module test\n\nrequire (\n${pins.map(([, path, version]) => `\t${path} ${version}`).join("\n")}\n)\n`;
  writeFileSync(join(root, "wasm/go.mod"), module);
  writeFileSync(join(root, "wasm/go.sum"), sums.join("\n") + "\n");
  const go = join(root, "fake-go");
  // Exercise the real subprocess boundary without Go, a registry or a network.
  writeFileSync(
    go,
    `#!${process.execPath}
const { readFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const downloads = JSON.parse(readFileSync(join(__dirname, 'downloads.json'), 'utf8'));
if (args.length !== 4 || args.slice(0, 3).join(' ') !== 'mod download -json' || !downloads[args[3]])
  throw new Error('Unexpected download command');
console.log(JSON.stringify(downloads[args[3]]));
`,
    { mode: 0o755 },
  );
  const saveDownloads = () =>
    writeFileSync(join(root, "downloads.json"), JSON.stringify(downloads));
  saveDownloads();
  return { root, go, pins, downloads, saveDownloads, module, sums };
}

test("fork preparation uses exact tags and pseudo-versions, replaces old edits, and applies patches", (t) => {
  const { root, go, pins } = fixture(t);
  prepareForks(go, root);
  for (const [name] of pins) {
    const fork = join(root, ".forks", name);
    assert.equal(
      readFileSync(join(fork, "original.txt"), "utf8"),
      "upstream\n",
    );
    assert.equal(readFileSync(join(fork, "patched.txt"), "utf8"), `${name}\n`);
    assert(!existsSync(join(fork, "stale.txt")));
    assert(!existsSync(join(root, "upstream", name, "patched.txt")));
  }
  const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls,
    pins.map(([, path, version]) => [
      "mod",
      "download",
      "-json",
      `${path}@${version}`,
    ]),
  );
});

test("floating refs and partial versions fail before invoking Go or replacing a fork", (t) => {
  const { root, go, module } = fixture(t);
  for (const version of [
    "latest",
    "main",
    "master",
    "v1",
    "v1.2",
    "abcdef123456",
  ]) {
    writeFileSync(join(root, "wasm/go.mod"), module.replace("v1.2.3", version));
    assert.throws(
      () => prepareForks(go, root),
      /exact tag or Go pseudo-version/,
    );
  }
  assert(!existsSync(join(root, "calls.jsonl")));
  assert(existsSync(join(root, ".forks/tailcat/stale.txt")));
});

test("a different downloaded module, version or checksum never replaces the locked fork", (t) => {
  const { root, go, downloads, saveDownloads, sums } = fixture(t);
  const info = downloads["github.com/tailscale/tailcat@v1.2.3"];
  for (const field of ["Path", "Version", "Sum", "GoModSum"]) {
    const original = info[field];
    info[field] = "unexpected";
    saveDownloads();
    assert.throws(
      () => prepareForks(go, root),
      /does not match|Checksum mismatch/,
    );
    assert(existsSync(join(root, ".forks/tailcat/stale.txt")));
    info[field] = original;
  }
  saveDownloads();
  writeFileSync(join(root, "wasm/go.sum"), sums.slice(1).join("\n") + "\n");
  assert.throws(() => prepareForks(go, root), /Checksum mismatch/);
  assert(existsSync(join(root, ".forks/tailcat/stale.txt")));
});
