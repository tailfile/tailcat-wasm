import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { relayFixture } from "./browser-fixture.ts";

export async function nodeThroughput(config: {
  name: string;
  mtu: number;
  bytes: number;
  runs: number;
  warmupBytes: number;
  moduleURL?: string;
}) {
  const fixture = await relayFixture();
  const endpoints: ReturnType<typeof endpoint>[] = [];
  function endpoint() {
    const child = fork(
      new URL("./throughput-node-peer.ts", import.meta.url),
      [],
      {
        execArgv: [],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: fixture.caFile },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let id = 0,
      closing = false;
    let stderr = "";
    let failure: Error | undefined;
    const pending = new Map<
      number,
      { resolve(value: any): void; reject(error: Error): void }
    >();
    function fail(error: Error) {
      failure ??= error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    }
    child.stderr!.on("data", (bytes) => {
      stderr = (stderr + bytes).slice(-65536);
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!closing)
        fail(new Error(`Node benchmark peer exited (${code}): ${stderr}`));
    });
    child.on("message", (message: any) => {
      if (message.event === "fatal") return fail(new Error(message.error));
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    });
    return {
      call(method: string, args: Record<string, unknown> = {}): Promise<any> {
        if (failure) return Promise.reject(failure);
        const requestID = ++id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestID);
            reject(new Error(`Node ${method} stalled: ${stderr}`));
          }, 120000);
          pending.set(requestID, {
            resolve(value) {
              clearTimeout(timer);
              resolve(value);
            },
            reject(error) {
              clearTimeout(timer);
              reject(error);
            },
          });
          child.send({ id: requestID, method, ...args }, (error) => {
            if (error) fail(error);
          });
        });
      },
      async close() {
        closing = true;
        fail(new Error("Node benchmark closed"));
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "exit").catch(() => {});
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  try {
    const sender = endpoint(),
      receiver = endpoint();
    endpoints.push(sender, receiver);
    const map = fixture.base + "/derpmap-test.json";
    const addresses = await Promise.all(
      endpoints.map((p) =>
        p.call("listen", {
          map,
          mtu: config.mtu,
          moduleURL: config.moduleURL,
        }),
      ),
    );
    await sender.call("dial", { address: addresses[1], map });
    async function transfer(bytes: number) {
      await receiver.call("prepare", { bytes });
      const [sent, received] = await Promise.all([
        sender.call("run", { bytes }),
        receiver.call("result"),
      ]);
      assert.equal(received.received, bytes);
      assert.equal(received.corrupt, 0);
      const elapsedMS = received.ended - sent.started;
      assert(elapsedMS > 0);
      return {
        received: received.received,
        corrupt: received.corrupt,
        lostBytes: 0,
        elapsedMS,
        MBps: bytes / elapsedMS / 1000,
        // process.cpuUsage includes the SDK's WASM Worker as well as app work.
        endpointCPU: [sent.cpu, received.cpu],
      };
    }
    const warmup = await transfer(config.warmupBytes);
    const samples = [];
    for (let i = 0; i < config.runs; i++) {
      const sample = await transfer(config.bytes);
      samples.push(sample);
      console.log(
        `${config.name} ${i + 1}/${config.runs}: ${sample.MBps.toFixed(2)} MB/s, lost 0 B`,
      );
    }
    await delay(1100); // Allow SDK transport counters to refresh outside timing.
    const stats = await Promise.all(endpoints.map((p) => p.call("stats")));
    assert(
      stats.every((peers) => peers.length === 1 && peers[0].state === "derp"),
    );
    assert(stats[0][0].derpTxBytes >= config.bytes * config.runs);
    const rates = samples.map((s) => s.MBps).sort((a, b) => a - b);
    return {
      name: config.name,
      kind: "node",
      transport: "derp",
      mtu: config.mtu,
      node: process.version,
      separateProcesses: true,
      measurement:
        "Node WASM SDK; independent endpoint processes; receiver-verified bytes",
      warmup,
      samples,
      stats,
      medianMBps:
        (rates[Math.floor((rates.length - 1) / 2)] +
          rates[Math.floor(rates.length / 2)]) /
        2,
    };
  } finally {
    await Promise.all(endpoints.map((p) => p.close()));
    await fixture.close();
  }
}
