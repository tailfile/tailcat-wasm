import { test, vi, type TestContext } from "vitest";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  connectWorker,
  validateOptions,
  type TailcatConnection,
  type TailcatOptions,
  type WorkerPort,
} from "../src/client.ts";
import type { PeerTransport, WebRTCManager } from "../src/webrtc.ts";
import { tick } from "./helpers.ts";

interface Request {
  id?: number;
  method: string;
  args: Record<string, unknown>;
}
class Worker implements WorkerPort {
  requests: Request[] = [];
  transfers: ArrayBuffer[][] = [];
  terminations = 0;
  failure?: Error;
  receive: (message: unknown) => void = () => {};
  error: (error: Error) => void = () => {};
  postMessage(message: Request, transfers: ArrayBuffer[] = []) {
    if (this.failure) throw this.failure;
    this.requests.push(message);
    // Model the real ownership transfer, not just an ordinary function call.
    this.transfers.push(transfers);
    structuredClone(message, { transfer: transfers });
  }
  terminate() {
    this.terminations++;
  }
  onMessage(handler: (message: unknown) => void) {
    this.receive = handler;
  }
  onError(handler: (error: Error) => void) {
    this.error = handler;
  }
  last(method: string) {
    const request = this.requests.findLast(
      (request) => request.method === method,
    );
    assert(request, `Missing ${method} request`);
    return request;
  }
  reply(method: string, result?: unknown, error?: string) {
    this.receive({ id: this.last(method).id, result, error });
  }
}
async function fixture(
  t: TestContext,
  overrides: Partial<TailcatOptions> = {},
  rtc?: WebRTCManager,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const worker = new Worker();
  const accepted: TailcatConnection[] = [];
  const changes: PeerTransport[][] = [];
  const errors: Error[] = [];
  const opening = connectWorker(
    worker,
    {
      onConnection: (connection) => accepted.push(connection),
      onTransportChange: (peers) => changes.push(peers),
      onError: (error) => errors.push(error),
      ...overrides,
    },
    32768,
    rtc,
  );
  worker.receive({ event: "ready" });
  const client = await opening;
  t.onTestFinished(() => client.close());
  function accept(id = 10, peer = "peer") {
    worker.receive({
      event: "connection",
      connection: id,
      peerNodeKey: peer,
      port: 80,
    });
    return accepted.at(-1)!;
  }
  return { worker, client, accepted, changes, errors, accept };
}

test("MTU bounds and pre-aborted startup reject before worker creation", () => {
  const options = { onConnection() {} };
  for (const tunnelMTU of [1279, 32769, 1500.5, NaN, Infinity])
    assert.throws(
      () => validateOptions({ ...options, tunnelMTU }),
      /tunnelMTU/,
    );
  for (const tunnelMTU of [1280, 32768])
    assert.equal(validateOptions({ ...options, tunnelMTU }), tunnelMTU);
  assert.throws(
    () =>
      validateOptions({
        ...options,
        signal: AbortSignal.abort(new Error("stop")),
      }),
    /stop/,
  );
});

test("startup timeout terminates once and detaches abort listener", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const worker = new Worker();
  const controller = new AbortController();
  const opening = connectWorker(
    worker,
    { onConnection() {}, signal: controller.signal },
    1280,
  );
  const rejected = assert.rejects(opening, /loading timed out/);
  vi.advanceTimersByTime(60_000);
  await rejected;
  assert.equal(worker.terminations, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a failed configure post cleans up startup immediately", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const worker = new Worker();
  worker.failure = new Error("worker unavailable");
  await assert.rejects(
    connectWorker(worker, { onConnection() {} }, 1280),
    /worker unavailable/,
  );
  assert.equal(worker.terminations, 1);
});

test("worker failure rejects all pending requests and ignores subsequent events", async (t) => {
  const { worker, client, accept, accepted } = await fixture(t);
  const connection = accept();
  const read = assert.rejects(connection.read(), /crashed/);
  const identity = assert.rejects(client.createIdentity(), /crashed/);
  worker.error(new Error("crashed"));
  await Promise.all([read, identity]);
  worker.receive({ event: "connection", connection: 99, peerNodeKey: "late" });
  assert.equal(accepted.length, 1);
  await assert.rejects(client.createIdentity(), /closed/);
  client.close();
  assert.equal(worker.terminations, 1);
});

test("failed RPC post detaches the dial abort listener", async (t) => {
  const { worker, client } = await fixture(t);
  const controller = new AbortController();
  worker.failure = new Error("could not post");
  await assert.rejects(
    client.dial("address", "map", { signal: controller.signal }),
    /could not post/,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborted dial sends cancellation and closes a late native connection", async (t) => {
  const { worker, client, changes } = await fixture(t);
  const controller = new AbortController();
  const dial = client.dial("address", "map", { signal: controller.signal });
  const rejected = assert.rejects(dial, /user canceled/);
  const request = worker.last("dial");
  controller.abort(new Error("user canceled"));
  await rejected;
  assert.equal(worker.last("cancel").args.request, request.id);
  worker.reply("dial", { id: 20, port: 80, peerNodeKey: "late" });
  assert.equal(worker.last("close").args.connection, 20);
  worker.reply("close");
  assert(!changes.some((peers) => peers.length));
});

test("cancellation between a dial reply and its continuation still closes the connection", async (t) => {
  const { worker, client, changes } = await fixture(t);
  const controller = new AbortController();
  const dial = client.dial("address", "map", { signal: controller.signal });
  worker.reply("dial", { id: 21, port: 80, peerNodeKey: "late" });
  controller.abort(new Error("user canceled"));
  await assert.rejects(dial, /user canceled/);
  assert.equal(worker.last("close").args.connection, 21);
  worker.reply("close");
  assert(!changes.some((peers) => peers.length));
});

test("closing the runtime immediately after a dial reply cannot publish a connection", async (t) => {
  const { worker, client, changes } = await fixture(t);
  const dial = client.dial("address", "map");
  worker.reply("dial", { id: 22, port: 80, peerNodeKey: "late" });
  client.close();
  await assert.rejects(dial, /closed/);
  assert.deepEqual(changes.at(-1), []);
});

test("writes transfer only the requested view without detaching caller memory", async (t) => {
  const { worker, accept } = await fixture(t);
  const connection = accept();
  const backing = new Uint8Array([9, 1, 2, 9]);
  let sent: Uint8Array | undefined;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message, transfer) => {
    if (message.method === "write")
      sent = (message.args.bytes as Uint8Array).slice();
    post(message, transfer);
  };
  const write = connection.write(backing.subarray(1, 3));
  worker.reply("write");
  await write;
  assert.deepEqual(sent, new Uint8Array([1, 2]));
  assert.deepEqual(backing, new Uint8Array([9, 1, 2, 9]));
  assert.equal(worker.transfers.at(-1)![0].byteLength, 0);
  const read = connection.read();
  worker.reply("read", null);
  assert.equal(await read, null);
  const halfClose = connection.closeWrite();
  await tick();
  worker.reply("closeWrite", undefined, "remote closed");
  await assert.rejects(halfClose, /remote closed/);
});

for (const pooled of [true, false]) {
  test(`writing a ${pooled ? "pooled" : "dedicated"} Node Buffer preserves the caller's bytes`, async (t) => {
    const { worker, accept } = await fixture(t);
    const connection = accept();
    const backing = pooled
      ? Buffer.from([9, 1, 2, 9])
      : Buffer.allocUnsafeSlow(4);
    backing.set([9, 1, 2, 9]);
    const write = connection.write(backing.subarray(1, 3));
    worker.reply("write");
    await write;
    assert.deepEqual([...backing], [9, 1, 2, 9]);
  });
}

test("disabling RTC still updates the worker when an observer throws", async (t) => {
  const failure = new Error("observer failed");
  const rtc: WebRTCManager = {
    onChange() {},
    snapshot: () => [],
    async stats() { return []; },
    handle() {},
    setEnabled() { throw failure; },
    close() {},
  };
  const { worker, client } = await fixture(t, {}, rtc);
  assert.throws(() => client.setWebRTCEnabled(false), (error) => error === failure);
  assert.equal(worker.last("webRTCEnabled").args.enabled, false);
});

test("a throwing transport observer cannot prevent fatal cleanup or strand pending requests", async (t) => {
  let throwOnChange = false;
  let changed = () => {};
  let rtcClosed = false;
  const rtc: WebRTCManager = {
    onChange(callback) {
      changed = callback;
    },
    snapshot: () => [],
    async stats() {
      return [];
    },
    handle() {},
    setEnabled() {},
    close() {
      changed();
      rtcClosed = true;
    },
  };
  const { worker, client, accept } = await fixture(
    t,
    {
      onTransportChange() {
        if (throwOnChange) throw new Error("observer failed");
      },
    },
    rtc,
  );
  accept();
  const pending = assert.rejects(client.createIdentity(), /crashed/);
  throwOnChange = true;
  assert.throws(() => worker.error(new Error("crashed")), /observer failed/);
  await pending;
  assert.equal(worker.terminations, 1);
  assert.equal(rtcClosed, true);
});

test("cancellation still rejects when the cancel message cannot be posted", async (t) => {
  const { worker, client } = await fixture(t);
  const controller = new AbortController();
  const rejected = assert.rejects(
    client.dial("address", "map", { signal: controller.signal }),
    /user canceled/,
  );
  worker.failure = new Error("worker stopped");
  controller.abort(new Error("user canceled"));
  await rejected;
  assert.equal(worker.terminations, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("closing a connection twice shares one RPC and preserves other peers", async (t) => {
  const { worker, accept, changes } = await fixture(t);
  const first = accept(1, "first");
  accept(2, "second");
  const a = first.close();
  const b = first.close();
  assert.equal(
    worker.requests.filter((request) => request.method === "close").length,
    1,
  );
  worker.reply("close");
  await Promise.all([a, b]);
  assert.deepEqual(
    changes.at(-1)?.map((peer) => peer.peerNodeKey),
    ["second"],
  );
  await assert.rejects(first.read(), /closed/);
});

test("a second stream for the same peer preserves cumulative traffic counters", async (t) => {
  const { worker, accept, changes } = await fixture(t);
  const first = accept(1);
  worker.receive({
    event: "transportStats",
    peers: [{ peerNodeKey: "peer", derpTxBytes: 123 }],
  });
  accept(2);
  assert.equal(changes.at(-1)![0].derpTxBytes, 123);
  const close = first.close();
  worker.reply("close");
  await close;
  assert.equal(changes.at(-1)![0].derpTxBytes, 123);
});

test("invalid or signaling-reserved ports never reach the worker", async (t) => {
  const { worker, client } = await fixture(t);
  for (const port of [0, -1, 65536, 65534, 1.5, NaN, Infinity]) {
    // An invalid port must settle locally, without any worker response.
    let settled = false;
    const dial = client.dial("address", "map", { port });
    void dial.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    if (!settled) worker.reply("dial", undefined, "not validated");
    await assert.rejects(dial, /port/i);
  }
  assert.equal(
    worker.requests.filter((request) => request.method === "dial").length,
    0,
  );
});

test("a throwing transport observer closes a dialed stream that could not reach its caller", async (t) => {
  const { worker, client } = await fixture(t, {
    onTransportChange(peers) {
      if (peers.length) throw new Error("observer failed");
    },
  });
  const dial = client.dial("address", "map");
  worker.reply("dial", { id: 31, port: 80, peerNodeKey: "peer" });
  await assert.rejects(dial, /observer failed/);
  assert.equal(worker.last("close").args.connection, 31);
  worker.reply("close");
  await tick();
  assert.equal(
    worker.terminations,
    0,
    "a consumer error does not kill the runtime",
  );
});

test("a throwing incoming handler closes its stream without closing other peers", async (t) => {
  let fail = false;
  const { worker, accept, changes } = await fixture(t, {
    onConnection() {
      if (fail) throw new Error("handler failed");
    },
  });
  accept(1, "first");
  fail = true;
  assert.throws(() => accept(2, "second"), /handler failed/);
  assert.equal(worker.last("close").args.connection, 2);
  worker.reply("close");
  await tick();
  assert.deepEqual(
    changes.at(-1)?.map((peer) => peer.peerNodeKey),
    ["first"],
  );
  assert.equal(worker.terminations, 0);
});

test("a transport observer can close the runtime without publishing an incoming stream", async (t) => {
  const f = await fixture(t, {
    onTransportChange(peers) {
      if (peers.length) f.client.close();
    },
  });
  assert.doesNotThrow(() => f.accept());
  assert.equal(f.worker.terminations, 1);
  assert.equal(f.accepted.length, 0);
});

for (const action of ["close", "abort"] as const) {
  test(`a transport observer can ${action} a dial before its connection is delivered`, async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, {
      onTransportChange(peers) {
        if (!peers.length) return;
        if (action === "close") f.client.close();
        else controller.abort(new Error("Canceled in observer"));
      },
    });
    const dial = f.client.dial("address", "map", { signal: controller.signal });
    f.worker.reply("dial", { id: 41, port: 80, peerNodeKey: "peer" });
    await assert.rejects(
      dial,
      action === "close" ? /closed/ : /Canceled in observer/,
    );
    if (action === "abort") {
      assert.equal(f.worker.last("close").args.connection, 41);
      f.worker.reply("close");
      await tick();
      assert.equal(f.worker.terminations, 0);
    }
  });
}

test("pending writes are bounded before copying and half-close follows the last write", async (t) => {
  const { worker, accept } = await fixture(t);
  const c = accept();
  const payload = new Uint8Array(2 * 1024 * 1024);
  const first = c.write(payload);
  const second = c.write(payload);
  assert.equal(worker.requests.filter((r) => r.method === "write").length, 1);
  await assert.rejects(c.write(new Uint8Array(1)), /queue full/);
  const end = c.closeWrite();
  await assert.rejects(c.write(new Uint8Array(1)), /closed for writing/);
  assert(!worker.requests.some((r) => r.method === "closeWrite"));
  worker.reply("write");
  await first;
  await tick();
  assert.equal(worker.requests.filter((r) => r.method === "write").length, 2);
  assert(!worker.requests.some((r) => r.method === "closeWrite"));
  worker.reply("write");
  await second;
  await tick();
  worker.reply("closeWrite");
  await end;
});

test("closing interrupts the active write and rejects queued writes without sending them", async (t) => {
  const { worker, accept } = await fixture(t);
  const c = accept();
  const first = assert.rejects(c.write(new Uint8Array(10)), /closed/);
  const second = assert.rejects(c.write(new Uint8Array(10)), /closed/);
  const closed = c.close();
  worker.reply("close");
  worker.reply("write", undefined, "closed");
  await Promise.all([first, second, closed]);
  assert.equal(worker.requests.filter((r) => r.method === "write").length, 1);
});
