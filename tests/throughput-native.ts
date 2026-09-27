import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { benchBinaryInfo } from "../scripts/bench-binaries.ts";
import { relayFixture } from "./browser-fixture.ts";

export async function nativeThroughput(config: {
  name: string;
  mtu: number;
  derp?: boolean;
  bytes: number;
  runs: number;
  warmupBytes: number;
  gomaxprocs?: number;
  websocket?: boolean;
}) {
  const binaryInfo = await benchBinaryInfo(
    config.websocket ? "tailcat-ws" : "tailcat",
  );
  const binary = binaryInfo.path;
  const fixture = await relayFixture();
  const temporary = await mkdtemp(join(tmpdir(), "tailcat-native-bench-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const logs: string[] = [];
  const direct = [false, false];
  const forcedDERP = [false, false];
  const websockets = [false, false];
  let failure: Error | undefined;
  let pending:
    | {
        target: number;
        received: number;
        corrupt: number;
        resolve(value: {
          received: number;
          corrupt: number;
          ended: number;
        }): void;
        reject(error: Error): void;
      }
    | undefined;
  function fail(error: Error) {
    failure ??= error;
    pending?.reject(error);
  }
  function launch(args: string[], server = false) {
    const i = children.length;
    logs[i] = "";
    const child = spawn(
      binary,
      [
        "--key=new",
        "--verbose",
        `--derpmap-url=${fixture.base}/derpmap-test.json`,
        ...args,
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          XDG_CACHE_HOME: temporary,
          XDG_CONFIG_HOME: temporary,
          TS_DEBUG_MTU: String(config.mtu),
          TS_DEBUG_ALWAYS_USE_DERP: config.derp ? "true" : "false",
          TS_DEBUG_TAILCAT_LOCAL_DERP: "false",
          TS_DEBUG_USE_DERP_ADDR: "",
          TS_DEBUG_USE_DERP_HTTP: "false",
          GOMAXPROCS: config.gomaxprocs ? String(config.gomaxprocs) : "",
          TS_DEBUG_DERP_WS_CLIENT: config.websocket ? "true" : "false",
          SSL_CERT_FILE: fixture.caFile,
          TS_DEBUG_NEVER_DIRECT_UDP: "false",
          TS_DEBUG_OMIT_LOCAL_ADDRS: "false",
          ...(server ? { TAILCAT_ADDR_FILE: join(temporary, "address") } : {}),
        },
      },
    );
    children.push(child);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.on("exit", (code, signal) =>
      fail(
        new Error(
          `Native ${server ? "receiver" : "sender"} exited (${code ?? signal})`,
        ),
      ),
    );
    child.stderr.on("data", (bytes: Buffer) => {
      logs[i] = (logs[i] + bytes.toString()).slice(-65536);
      direct[i] ||= /magicsock: disco: node .* now using .* mtu=/.test(logs[i]);
      forcedDERP[i] ||= /disabled udp\d per TS_DEBUG_ALWAYS_USE_DERP/.test(
        logs[i],
      );
      websockets[i] ||= /websocket: connected to/.test(logs[i]);
    });
    return child;
  }
  async function until(check: () => Promise<boolean> | boolean, what: string) {
    const deadline = performance.now() + 45000;
    while (!(await check())) {
      if (failure) throw failure;
      if (performance.now() > deadline)
        throw new Error(`Timed out waiting for ${what}`);
      await delay(50);
    }
  }
  try {
    const receiver = launch([], true);
    receiver.stdout.on("data", (bytes: Buffer) => {
      if (!pending) {
        fail(new Error("Native receiver produced unexpected bytes"));
        return;
      }
      for (let n = 0; n < bytes.length; n++)
        if (bytes[n] !== 37) pending.corrupt++;
      pending.received += bytes.length;
      if (pending.received > pending.target)
        fail(new Error("Native receiver exceeded requested byte count"));
      else if (pending.received === pending.target) {
        pending.resolve({
          received: pending.received,
          corrupt: pending.corrupt,
          ended: performance.now(),
        });
        pending = undefined;
      }
    });
    let address = "";
    await until(async () => {
      try {
        address = (await readFile(join(temporary, "address"), "utf8")).trim();
        return !!address;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    }, "native listener address");
    const sender = launch([address]);
    sender.stdout.resume();
    async function transfer(total: number) {
      if (failure) throw failure;
      const block = Buffer.alloc(256 * 1024, 37);
      const started = performance.now();
      const controller = new AbortController();
      const receipt = new Promise<{
        received: number;
        corrupt: number;
        ended: number;
      }>((resolve, reject) => {
        pending = { target: total, received: 0, corrupt: 0, resolve, reject };
      });
      const timer = setTimeout(() => {
        const error = new Error(`${config.name} transfer stalled`);
        fail(error);
        controller.abort(error);
      }, 120000);
      try {
        const [result] = await Promise.all([
          receipt,
          (async () => {
            for (let n = 0; n < total; n += block.length) {
              if (failure) throw failure;
              if (
                !sender.stdin.write(
                  block.subarray(0, Math.min(block.length, total - n)),
                )
              )
                await once(sender.stdin, "drain", {
                  signal: controller.signal,
                });
            }
          })(),
        ]);
        assert.equal(result.received, total);
        assert.equal(result.corrupt, 0);
        const elapsedMS = result.ended - started;
        return {
          received: result.received,
          corrupt: result.corrupt,
          lostBytes: 0,
          elapsedMS,
          MBps: result.received / elapsedMS / 1000,
        };
      } finally {
        clearTimeout(timer);
        pending = undefined;
        controller.abort();
      }
    }
    const warmup = await transfer(config.warmupBytes);
    assert.deepEqual(
      websockets,
      [!!config.websocket, !!config.websocket],
      "Native WebSocket transport must match the requested control",
    );
    if (config.derp) {
      assert(
        forcedDERP.every(Boolean),
        "Both native endpoints must confirm UDP is disabled",
      );
      assert(
        !direct.some(Boolean),
        "A native DERP control selected a direct endpoint",
      );
    } else {
      await until(() => direct.every(Boolean), "both native UDP paths");
      // A successful transfer with this private relay stopped cannot silently
      // measure DERP instead of native UDP. No separate ping connection is used.
      await fixture.stopRelay();
    }
    const samples = [];
    for (let n = 0; n < config.runs; n++) {
      const sample = await transfer(config.bytes);
      samples.push(sample);
      console.log(
        `${config.name} ${n + 1}/${config.runs}: ${sample.MBps.toFixed(2)} MB/s, lost 0 B`,
      );
    }
    const rates = samples.map((s) => s.MBps).sort((a, b) => a - b);
    return {
      name: config.name,
      kind: "native",
      mtu: config.mtu,
      transport: config.derp ? "derp" : "udp-direct",
      relayStopped: !config.derp,
      directQualified: direct,
      udpDisabled: forcedDERP,
      websockets,
      binary,
      binarySHA256: binaryInfo.sha256,
      build: binaryInfo.pinnedBuild,
      gomaxprocs: config.gomaxprocs ?? "Go default",
      measurement:
        "CLI stdin to receiver stdout, verified in Node; includes pipe and CLI copy overhead",
      warmup,
      samples,
      medianMBps:
        (rates[Math.floor((rates.length - 1) / 2)] +
          rates[Math.floor(rates.length / 2)]) /
        2,
    };
  } catch (error) {
    throw new Error(
      `${String(error)}\nNative diagnostics:\n${logs.join("\n")}`,
    );
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, "close").catch(() => {});
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    }
    await fixture.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
