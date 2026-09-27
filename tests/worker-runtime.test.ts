import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { startWorker, type RuntimeScope } from "../src/worker-runtime.ts";
import { deferred, Inbox, tick } from "./helpers.ts";

type Request = Parameters<RuntimeScope["onmessage"]>[0]["data"];
type Connection = Awaited<ReturnType<RuntimeScope["tailcatDial"]>>;
type Listener = Awaited<ReturnType<RuntimeScope["tailcatListen"]>>;
interface Response {
  id?: number;
  event?: string;
  error?: string;
  result?: unknown;
  connection?: number;
  kind?: string;
  value?: unknown;
}
const listener: Listener = {
  addr: "address",
  nodeKey: "receive-key",
  sendNodeKey: "send-key",
  privateKeyJSON: "private-test-keys",
  async close() {},
};
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    port: 80,
    peerNodeKey: "peer",
    transportStats: () => ({
      derpTxBytes: 100,
      derpRxBytes: 200,
      pathDrops: 0,
    }),
    async read() {
      return new Uint8Array([1, 2]);
    },
    async write() {},
    async closeWrite() {},
    async close() {},
    ...overrides,
  };
}
async function fixture(
  options: {
    load?: () => Promise<globalThis.Response>;
    start?: boolean;
    constructorFailure?: boolean;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const inbox = new Inbox<Response>();
  const stopped = deferred<void>();
  const env: Record<string, string> = {};
  const transferred: Transferable[][] = [];
  let memory: WebAssembly.Memory;
  const listen = vi.fn(
    async (_options: Parameters<RuntimeScope["tailcatListen"]>[0]) => listener,
  );
  const dial = vi.fn(
    async (_options: Parameters<RuntimeScope["tailcatDial"]>[0]) =>
      connection(),
  );
  const tailcatRTC = vi.fn((): unknown => undefined);
  const scope: RuntimeScope = {
    Go: class {
      constructor() {
        if (options.constructorFailure)
          throw new Error("Go initialization failed");
      }
      env = env;
      importObject = {};
      run(instance: WebAssembly.Instance) {
        memory = instance.exports.mem as WebAssembly.Memory;
        scope.onTailcatReady();
        return stopped.promise;
      }
    },
    onTailcatReady() {},
    onTailcatRTC() {},
    onTailcatRTCPacket: () => false,
    tailcatRTC,
    async tailcatCreateIdentity() {
      return listener;
    },
    async tailcatDescribeAddress() {
      return { ServerPublic: "peer" };
    },
    tailcatListen: listen,
    tailcatDial: dial,
    postMessage(message, transfer = []) {
      transferred.push(transfer);
      // Detach buffers as a real Worker would; detect reuse in read tests.
      inbox.push(structuredClone(message, { transfer }) as Response);
    },
    onmessage() {},
  };
  // A real minimal WASM module exercises loading/compilation, while the Go
  // boundary stays controllable so failures and races are deterministic.
  startWorker(
    scope,
    options.load ??
      (async () =>
        new globalThis.Response(
          new Uint8Array([
            0,
            97,
            115,
            109,
            1,
            0,
            0,
            0,
            5,
            3,
            1,
            0,
            1, // One 64 KiB memory, exported as Go's "mem".
            7,
            7,
            1,
            3,
            109,
            101,
            109,
            2,
            0,
          ]),
        )),
  );
  function send(data: Request) {
    scope.onmessage(new MessageEvent("message", { data }));
  }
  function rpc(data: Extract<Request, { id: number }>) {
    send(data);
    return inbox.wait((message) => message.id === data.id);
  }
  send({ method: "configure", args: { tunnelMTU: 1280, webRTC: true } });
  if (options.start !== false)
    await inbox.wait((message) => message.event === "ready");
  return {
    scope,
    inbox,
    stopped,
    env,
    transferred,
    send,
    rpc,
    listen,
    dial,
    tailcatRTC,
    get memory() {
      return memory;
    },
  };
}
const listenRequest = (id = 1) => ({
  id,
  method: "listen" as const,
  args: { derpMapURL: "map" },
});
const dialRequest = (id = 2) => ({
  id,
  method: "dial" as const,
  args: { address: "remote", derpMapURL: "map", port: 80 },
});
function resultID(response: Response) {
  assert.equal(response.error, undefined);
  return (response.result as { id: number }).id;
}

test("worker configures WASM MTU, keeps both identity keys and updates listener WebRTC mode", async () => {
  const f = await fixture();
  assert.equal(f.env.TS_DEBUG_MTU, "1280");
  assert.deepEqual((await f.rpc(listenRequest())).result, {
    address: listener.addr,
    nodeKey: listener.nodeKey,
    sendNodeKey: listener.sendNodeKey,
    privateKeyJSON: listener.privateKeyJSON,
  });
  const options = f.listen.mock.calls[0][0];
  assert.equal(options.webRTC, true);
  f.send({ method: "webRTCEnabled", args: { enabled: false } });
  assert.equal(options.webRTC, false);
  await f.rpc(dialRequest());
  assert.equal(
    f.dial.mock.calls[0][0].privateKey,
    listener.privateKeyJSON,
  );
  assert.equal(f.dial.mock.calls[0][0].webRTC, false);
});

test("a WASM load failure reports fatal and rejects waiting RPCs", async () => {
  const f = await fixture({
    load: async () => {
      throw new Error("asset unavailable");
    },
    start: false,
  });
  const response = await f.rpc({ id: 1, method: "createIdentity", args: {} });
  assert.match(response.error!, /asset unavailable/);
  assert.match(
    (await f.inbox.wait((message) => message.event === "fatal")).error!,
    /asset unavailable/,
  );
  assert(!f.inbox.messages.some((message) => message.event === "ready"));
});

test("Go constructor failure reports fatal instead of leaving startup waiting for its timeout", async () => {
  const f = await fixture({ constructorFailure: true, start: false });
  const response = await f.rpc({ id: 1, method: "createIdentity", args: {} });
  assert.match(response.error!, /Go initialization failed/);
  assert.match(
    (await f.inbox.wait((message) => message.event === "fatal")).error!,
    /Go initialization failed/,
  );
});

for (const failure of [false, true]) {
  test(`Go ${failure ? "panic" : "exit"} after ready reports fatal and rejects new work`, async () => {
    const f = await fixture();
    if (failure) f.stopped.reject(new Error("Go panic"));
    else f.stopped.resolve();
    const fatal = await f.inbox.wait((message) => message.event === "fatal");
    assert.match(fatal.error!, failure ? /Go panic/ : /Tailcat stopped/);
    assert.match(
      (await f.rpc({ id: 1, method: "createIdentity", args: {} })).error!,
      /Go panic|Tailcat stopped/,
    );
  });
}

test("concurrent listen requests cannot start two native listeners; a failed start can retry", async () => {
  const f = await fixture();
  const pending = deferred<Listener>();
  f.listen.mockImplementationOnce(() => pending.promise);
  const first = f.rpc(listenRequest(1));
  await tick();
  const second = f.rpc(listenRequest(2));
  await tick();
  pending.reject(new Error("relay unavailable"));
  assert.match((await first).error!, /relay unavailable/);
  assert.match((await second).error!, /Already listening/);
  assert.equal(f.listen.mock.calls.length, 1);
  assert.equal((await f.rpc(listenRequest(3))).error, undefined);
  assert.equal(f.listen.mock.calls.length, 2);
});

test("invalid identity/region overrides fail before starting a listener and permit retry", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    serverKey: { Public: { RegionID: 1, Region: [{ Name: "old" }] } },
    clientKey: "unchanged",
  });
  assert.match(
    (
      await f.rpc({
        ...listenRequest(1),
        args: { derpMapURL: "map", privateKeyJSON: saved, regionID: 0 },
      })
    ).error!,
    /Invalid relay/,
  );
  assert.equal(f.listen.mock.calls.length, 0);
  await f.rpc({
    ...listenRequest(2),
    args: { derpMapURL: "map", privateKeyJSON: saved, regionID: 900 },
  });
  assert.deepEqual(
    JSON.parse(f.listen.mock.calls[0][0].privateKey!),
    {
      serverKey: { Public: { RegionID: 900, Region: null } },
      clientKey: "unchanged",
    },
  );
});

test("outgoing streams serialize while incoming streams remain available", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  const next = f.rpc(dialRequest(3));
  await tick();
  assert.equal(f.dial.mock.calls.length, 1);
  f.listen.mock.calls[0][0].onConnection(
    connection({ peerNodeKey: "incoming" }),
  );
  const accepted = await f.inbox.wait(
    (message) => message.event === "connection",
  );
  assert(accepted.connection);
  await f.rpc({
    id: 4,
    method: "close",
    args: { connection: accepted.connection },
  });
  assert.equal(f.dial.mock.calls.length, 1);
  await f.rpc({ id: 5, method: "close", args: { connection: first } });
  assert.notEqual(resultID(await next), first);
  assert.equal(f.dial.mock.calls.length, 2);
});

test("a canceled queued dial never enters Go and does not block its successor", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  const canceled = f.rpc(dialRequest(3));
  f.send({ method: "cancel", args: { request: 3 } });
  const next = f.rpc(dialRequest(4));
  await f.rpc({ id: 5, method: "close", args: { connection: first } });
  assert.match((await canceled).error!, /canceled/);
  assert(resultID(await next));
  assert.equal(f.dial.mock.calls.length, 2);
});

test("canceling queued dials releases their worker requests before the active stream closes", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  for (let id = 3; id < 103; id++) {
    const canceled = f.rpc(dialRequest(id));
    await tick();
    f.send({ method: "cancel", args: { request: id } });
    assert.match((await canceled).error!, /canceled/);
    assert.equal(f.dial.mock.calls.length, 1);
  }
  const next = f.rpc(dialRequest(103));
  await f.rpc({ id: 104, method: "close", args: { connection: first } });
  assert(resultID(await next));
  assert.equal(f.dial.mock.calls.length, 2);
});

test("queued dials are bounded, keep FIFO order, and canceled slots can be reused", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  const waiting = Array.from({ length: 64 }, (_, index) =>
    f.rpc(dialRequest(index + 3)),
  );
  // Keep a failing assertion from producing unrelated unhandled timeouts.
  void Promise.all(waiting).catch(() => {});
  assert.match((await f.rpc(dialRequest(67))).error!, /Too many queued dials/);
  f.send({ method: "cancel", args: { request: 3 } });
  assert.match((await waiting[0]).error!, /canceled/);
  const replacement = f.rpc(dialRequest(68));
  await f.rpc({ id: 69, method: "close", args: { connection: first } });
  const second = resultID(await waiting[1]);
  assert.equal(f.dial.mock.calls.length, 2);
  for (let id = 5; id <= 66; id++)
    f.send({ method: "cancel", args: { request: id } });
  for (const response of await Promise.all(waiting.slice(2)))
    assert.match(response.error!, /canceled/);
  await f.rpc({ id: 70, method: "close", args: { connection: second } });
  assert(resultID(await replacement));
  assert.equal(f.dial.mock.calls.length, 3);
});

test("canceling a waiter during native teardown cannot let the next dial reuse a busy sending key", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const teardown = deferred<void>();
  f.dial.mockImplementationOnce(async () =>
    connection({ close: () => teardown.promise }),
  );
  const first = resultID(await f.rpc(dialRequest(2)));
  const canceled = f.rpc(dialRequest(3));
  const next = f.rpc(dialRequest(4));
  const closing = f.rpc({
    id: 5,
    method: "close",
    args: { connection: first },
  });
  f.send({ method: "cancel", args: { request: 3 } });
  assert.match((await canceled).error!, /canceled/);
  assert.equal(f.dial.mock.calls.length, 1);
  teardown.resolve();
  await closing;
  assert(resultID(await next));
  assert.equal(f.dial.mock.calls.length, 2);
});

test("an in-flight dial canceled before native completion closes its late stream and releases the queue", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const pending = deferred<Connection>();
  f.dial.mockImplementationOnce(() => pending.promise);
  const dialing = f.rpc(dialRequest(2));
  await tick();
  f.send({ method: "cancel", args: { request: 2 } });
  assert.equal(f.dial.mock.calls[0][0].signal.aborted, true);
  const close = vi.fn(async () => {});
  pending.resolve(connection({ close }));
  assert.match((await dialing).error!, /canceled/);
  assert.equal(close.mock.calls.length, 1);
  assert(resultID(await f.rpc(dialRequest(3))));
});

for (const failure of ["close", "transportStats"] as const) {
  test(`${failure} failure cannot leak a connection or stall the outgoing queue`, async () => {
    const f = await fixture();
    await f.rpc(listenRequest());
    const close = vi.fn(async () => {
      if (failure === "close") throw new Error("close failed");
    });
    f.dial.mockImplementationOnce(async () =>
      connection({
        close,
        transportStats() {
          if (failure === "transportStats")
            throw new Error("stats unavailable");
          return { derpTxBytes: 0, derpRxBytes: 0, pathDrops: 0 };
        },
      }),
    );
    const first = resultID(await f.rpc(dialRequest(2)));
    const next = f.rpc(dialRequest(3));
    const closed = await f.rpc({
      id: 4,
      method: "close",
      args: { connection: first },
    });
    if (failure === "close") assert.match(closed.error!, /close failed/);
    assert.equal(close.mock.calls.length, 1);
    assert(resultID(await next));
    assert.equal(
      (await f.rpc({ id: 5, method: "close", args: { connection: first } }))
        .error,
      undefined,
    );
    assert.match(
      (await f.rpc({ id: 6, method: "read", args: { connection: first } }))
        .error!,
      /closed/,
    );
  });
}

test("overlapping reads cannot concurrently reuse the Go receive buffer; closing interrupts a pending read", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const pending = deferred<Uint8Array<ArrayBuffer> | null>();
  const read = vi.fn(() => pending.promise);
  const close = vi.fn(async () => {
    pending.resolve(null);
  });
  f.dial.mockImplementationOnce(async () => connection({ read, close }));
  const id = resultID(await f.rpc(dialRequest(2)));
  const first = f.rpc({ id: 3, method: "read", args: { connection: id } });
  const second = f.rpc({ id: 4, method: "read", args: { connection: id } });
  await tick();
  await f.rpc({ id: 5, method: "close", args: { connection: id } });
  assert.equal((await first).result, null);
  assert.match((await second).error!, /read.*progress/i);
  assert.equal(read.mock.calls.length, 1);
});

test("binary reads transfer ownership and failed reads leave the connection readable", async () => {
  const f = await fixture();
  await f.rpc(listenRequest());
  const read = vi.fn(async () => new Uint8Array([7, 8]));
  read.mockImplementationOnce(async () => {
    throw new Error("read failed");
  });
  f.dial.mockImplementationOnce(async () => connection({ read }));
  const id = resultID(await f.rpc(dialRequest(2)));
  assert.match(
    (await f.rpc({ id: 3, method: "read", args: { connection: id } })).error!,
    /read failed/,
  );
  assert.deepEqual(
    (await f.rpc({ id: 4, method: "read", args: { connection: id } })).result,
    new Uint8Array([7, 8]),
  );
  assert.equal((f.transferred.at(-1)![0] as ArrayBuffer).byteLength, 0);
});

test("WebRTC bounds scheduling bursts without sending individual overflow packets to DERP", async () => {
  const f = await fixture();
  const packet = () => f.scope.onTailcatRTCPacket(1, 0, 32768);
  f.scope.onTailcatRTC(1, "start", { peerNodeKey: "peer", initiator: true });
  assert.equal(packet(), false);
  f.send({ method: "rtc", args: { session: 1, kind: "ready", value: true } });
  for (let n = 0; n < 33; n++) assert.equal(packet(), true);
  assert.equal(f.inbox.messages.filter((m) => m.kind === "packet").length, 32);
  vi.advanceTimersByTime(1000);
  assert.equal(f.inbox.messages.find((m) => m.kind === "dropped")?.value, 1);
  f.send({ method: "rtc", args: { session: 1, kind: "credit", value: 32768 } });
  assert.equal(packet(), true);
  f.send({
    method: "rtc",
    args: {
      session: 1,
      kind: "packet",
      sequence: 7,
      value: new Uint8Array([1, 2]),
    },
  });
  const received = await f.inbox.wait((m) => m.kind === "received");
  assert.deepEqual(received.value, {
    bytes: 2,
    items: [{ sequence: 7, accepted: false }],
  });
  f.send({ method: "rtc", args: { session: 1, kind: "ready", value: false } });
  assert.equal(packet(), false);
  f.scope.onTailcatRTC(1, "closed", null);
  assert.equal(packet(), false);
});

test("RTC receive copies into the Go-owned buffer and tracks returned addresses", async () => {
  const f = await fixture();
  const receivedValue = (m: { kind?: string; value?: unknown }) =>
    m.value as { bytes: number; items: { sequence: number; accepted: boolean }[] };
  f.scope.onTailcatRTC(1, "start", {
    peerNodeKey: "peer",
    initiator: true,
    recvBuffer: 128,
    recvCapacity: 16,
  });
  f.tailcatRTC.mockImplementationOnce(() => 4096); // Next buffer address.
  f.send({
    method: "rtc",
    args: {
      session: 1,
      kind: "packet",
      sequence: 5,
      value: new Uint8Array([9, 9, 9]),
    },
  });
  assert.deepEqual(f.tailcatRTC.mock.calls[0], [1, "packet", 3]);
  assert.deepEqual([...new Uint8Array(f.memory.buffer, 128, 3)], [9, 9, 9]);
  const received = await f.inbox.wait((m) => m.kind === "received");
  assert.deepEqual(receivedValue(received), {
    bytes: 3,
    items: [{ sequence: 5, accepted: true }],
  });
  // The next packet uses the address Go returned; rejection (0) keeps it.
  f.tailcatRTC.mockImplementationOnce(() => 0);
  f.send({
    method: "rtc",
    args: {
      session: 1,
      kind: "packet",
      sequence: 6,
      value: new Uint8Array([7]),
    },
  });
  assert.deepEqual(f.tailcatRTC.mock.calls[1], [1, "packet", 1]);
  assert.deepEqual([...new Uint8Array(f.memory.buffer, 4096, 1)], [7]);
  const rejected = await f.inbox.wait(
    (m) =>
      m.kind === "received" && receivedValue(m).items[0].sequence === 6,
  );
  assert.deepEqual(receivedValue(rejected), {
    bytes: 1,
    items: [{ sequence: 6, accepted: false }],
  });
  f.tailcatRTC.mockImplementationOnce(() => 8192);
  f.send({
    method: "rtc",
    args: {
      session: 1,
      kind: "packet",
      sequence: 7,
      value: new Uint8Array([8]),
    },
  });
  assert.deepEqual([...new Uint8Array(f.memory.buffer, 4096, 1)], [8]);
  const accepted = await f.inbox.wait(
    (m) =>
      m.kind === "received" && receivedValue(m).items[0].sequence === 7,
  );
  assert.deepEqual(receivedValue(accepted).items, [
    { sequence: 7, accepted: true },
  ]);
});

test("RTC receive falls back to the Uint8Array bridge without buffer addresses", async () => {
  const f = await fixture();
  f.scope.onTailcatRTC(1, "start", { peerNodeKey: "peer", initiator: true });
  const bytes = new Uint8Array([3, 4]);
  f.send({
    method: "rtc",
    args: { session: 1, kind: "packet", sequence: 9, value: bytes },
  });
  assert.deepEqual(f.tailcatRTC.mock.calls[0], [
    1,
    "packet",
    bytes,
  ]);
  const received = await f.inbox.wait((m) => m.kind === "received");
  assert.deepEqual(received.value, {
    bytes: 2,
    items: [{ sequence: 9, accepted: false }],
  });
});

test("RTC snapshots borrowed Go memory before return and after memory growth", async () => {
  const f = await fixture();
  f.scope.onTailcatRTC(1, "start", { peerNodeKey: "peer", initiator: true });
  f.send({ method: "rtc", args: { session: 1, kind: "ready", value: true } });
  const before = new Uint8Array(f.memory.buffer, 128, 3);
  before.set([1, 2, 3]);
  assert.equal(f.scope.onTailcatRTCPacket(1, 128, 3), true);
  before.fill(9); // Go may immediately reuse the borrowed bytes.
  const first = f.inbox.messages.find((m) => m.kind === "packet")!
    .value as Uint8Array;
  assert.deepEqual([...first], [1, 2, 3]);
  assert.equal(first.byteOffset, 8);
  assert.equal(first.buffer.byteLength, 11);
  f.memory.grow(1);
  assert.equal(before.byteLength, 0);
  new Uint8Array(f.memory.buffer, 65536, 2).set([4, 5]);
  assert.equal(f.scope.onTailcatRTCPacket(1, 65536, 2), true);
  const last = f.inbox.messages.at(-1)!.value as Uint8Array;
  assert.deepEqual([...last], [4, 5]);
  assert.equal(f.memory.buffer.byteLength, 2 * 65536);
});


test("first listen honors region selection and holds the listener slot during key generation", async () => {
  const f = await fixture();
  for (const regionID of [0, -1, 1.5, NaN]) {
    const response = await f.rpc({
      ...listenRequest(1), args: { derpMapURL: "map", regionID },
    });
    assert.match(response.error!, /Invalid relay region/);
  }
  assert.equal(f.listen.mock.calls.length, 0);
  const generated = deferred<Listener>();
  f.scope.tailcatCreateIdentity = () => generated.promise;
  const first = f.rpc({
    ...listenRequest(2), args: { derpMapURL: "map", regionID: 900 },
  });
  await tick();
  assert.match((await f.rpc(listenRequest(3))).error!, /Already listening/);
  generated.resolve({
    ...listener,
    privateKeyJSON: JSON.stringify({
      serverKey: { Public: { RegionID: -1 } }, clientKey: "preserved",
    }),
  });
  assert.equal((await first).error, undefined);
  assert.deepEqual(JSON.parse(f.listen.mock.calls[0][0].privateKey!), {
    serverKey: { Public: { RegionID: 900, Region: null } }, clientKey: "preserved",
  });
});

test("identity generation failure releases the listener slot for retry", async () => {
  const f = await fixture();
  f.scope.tailcatCreateIdentity = async () => { throw new Error("key generation failed"); };
  assert.match((await f.rpc({
    ...listenRequest(1), args: { derpMapURL: "map", regionID: 900 },
  })).error!, /key generation failed/);
  assert.equal((await f.rpc(listenRequest(2))).error, undefined);
});
