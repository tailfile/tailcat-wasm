import test, { type TestContext } from "node:test";
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
  t: TestContext,
  options: {
    load?: () => Promise<globalThis.Response>;
    start?: boolean;
    constructorFailure?: boolean;
  } = {},
) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const inbox = new Inbox<Response>();
  const stopped = deferred<void>();
  const env: Record<string, string> = {};
  const transferred: Transferable[][] = [];
  const listen = t.mock.fn(
    async (_options: Parameters<RuntimeScope["tailcatListen"]>[0]) => listener,
  );
  const dial = t.mock.fn(
    async (_options: Parameters<RuntimeScope["tailcatDial"]>[0]) =>
      connection(),
  );
  const scope: RuntimeScope = {
    Go: class {
      constructor() {
        if (options.constructorFailure)
          throw new Error("Go initialization failed");
      }
      env = env;
      importObject = {};
      run() {
        scope.onTailcatReady();
        return stopped.promise;
      }
    },
    onTailcatReady() {},
    onTailcatRTC() {},
    onTailcatRTCPacket: () => false,
    tailcatRTC: t.mock.fn(),
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
        new globalThis.Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
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
  return { scope, inbox, stopped, env, transferred, send, rpc, listen, dial };
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

test("worker configures WASM MTU, keeps both identity keys and updates listener WebRTC mode", async (t) => {
  const f = await fixture(t);
  assert.equal(f.env.TS_DEBUG_MTU, "1280");
  assert.deepEqual((await f.rpc(listenRequest())).result, {
    address: listener.addr,
    nodeKey: listener.nodeKey,
    sendNodeKey: listener.sendNodeKey,
    privateKeyJSON: listener.privateKeyJSON,
  });
  const options = f.listen.mock.calls[0].arguments[0];
  assert.equal(options.webRTC, true);
  f.send({ method: "webRTCEnabled", args: { enabled: false } });
  assert.equal(options.webRTC, false);
  await f.rpc(dialRequest());
  assert.equal(
    f.dial.mock.calls[0].arguments[0].privateKey,
    listener.privateKeyJSON,
  );
  assert.equal(f.dial.mock.calls[0].arguments[0].webRTC, false);
});

test("a WASM load failure reports fatal and rejects waiting RPCs", async (t) => {
  const f = await fixture(t, {
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

test("Go constructor failure reports fatal instead of leaving startup waiting for its timeout", async (t) => {
  const f = await fixture(t, { constructorFailure: true, start: false });
  const response = await f.rpc({ id: 1, method: "createIdentity", args: {} });
  assert.match(response.error!, /Go initialization failed/);
  assert.match(
    (await f.inbox.wait((message) => message.event === "fatal")).error!,
    /Go initialization failed/,
  );
});

for (const failure of [false, true]) {
  test(`Go ${failure ? "panic" : "exit"} after ready reports fatal and rejects new work`, async (t) => {
    const f = await fixture(t);
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

test("concurrent listen requests cannot start two native listeners; a failed start can retry", async (t) => {
  const f = await fixture(t);
  const pending = deferred<Listener>();
  f.listen.mock.mockImplementationOnce(() => pending.promise);
  const first = f.rpc(listenRequest(1));
  await tick();
  const second = f.rpc(listenRequest(2));
  await tick();
  pending.reject(new Error("relay unavailable"));
  assert.match((await first).error!, /relay unavailable/);
  assert.match((await second).error!, /Already listening/);
  assert.equal(f.listen.mock.callCount(), 1);
  assert.equal((await f.rpc(listenRequest(3))).error, undefined);
  assert.equal(f.listen.mock.callCount(), 2);
});

test("invalid identity/region overrides fail before starting a listener and permit retry", async (t) => {
  const f = await fixture(t);
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
  assert.equal(f.listen.mock.callCount(), 0);
  await f.rpc({
    ...listenRequest(2),
    args: { derpMapURL: "map", privateKeyJSON: saved, regionID: 900 },
  });
  assert.deepEqual(
    JSON.parse(f.listen.mock.calls[0].arguments[0].privateKey!),
    {
      serverKey: { Public: { RegionID: 900, Region: null } },
      clientKey: "unchanged",
    },
  );
});

test("outgoing streams serialize while incoming streams remain available", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  const next = f.rpc(dialRequest(3));
  await tick();
  assert.equal(f.dial.mock.callCount(), 1);
  f.listen.mock.calls[0].arguments[0].onConnection(
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
  assert.equal(f.dial.mock.callCount(), 1);
  await f.rpc({ id: 5, method: "close", args: { connection: first } });
  assert.notEqual(resultID(await next), first);
  assert.equal(f.dial.mock.callCount(), 2);
});

test("a canceled queued dial never enters Go and does not block its successor", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  const canceled = f.rpc(dialRequest(3));
  f.send({ method: "cancel", args: { request: 3 } });
  const next = f.rpc(dialRequest(4));
  await f.rpc({ id: 5, method: "close", args: { connection: first } });
  assert.match((await canceled).error!, /canceled/);
  assert(resultID(await next));
  assert.equal(f.dial.mock.callCount(), 2);
});

test("canceling queued dials releases their worker requests before the active stream closes", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const first = resultID(await f.rpc(dialRequest(2)));
  for (let id = 3; id < 103; id++) {
    const canceled = f.rpc(dialRequest(id));
    await tick();
    f.send({ method: "cancel", args: { request: id } });
    assert.match((await canceled).error!, /canceled/);
    assert.equal(f.dial.mock.callCount(), 1);
  }
  const next = f.rpc(dialRequest(103));
  await f.rpc({ id: 104, method: "close", args: { connection: first } });
  assert(resultID(await next));
  assert.equal(f.dial.mock.callCount(), 2);
});

test("queued dials are bounded, keep FIFO order, and canceled slots can be reused", async (t) => {
  const f = await fixture(t);
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
  assert.equal(f.dial.mock.callCount(), 2);
  for (let id = 5; id <= 66; id++)
    f.send({ method: "cancel", args: { request: id } });
  for (const response of await Promise.all(waiting.slice(2)))
    assert.match(response.error!, /canceled/);
  await f.rpc({ id: 70, method: "close", args: { connection: second } });
  assert(resultID(await replacement));
  assert.equal(f.dial.mock.callCount(), 3);
});

test("canceling a waiter during native teardown cannot let the next dial reuse a busy sending key", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const teardown = deferred<void>();
  f.dial.mock.mockImplementationOnce(async () =>
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
  assert.equal(f.dial.mock.callCount(), 1);
  teardown.resolve();
  await closing;
  assert(resultID(await next));
  assert.equal(f.dial.mock.callCount(), 2);
});

test("an in-flight dial canceled before native completion closes its late stream and releases the queue", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const pending = deferred<Connection>();
  f.dial.mock.mockImplementationOnce(() => pending.promise);
  const dialing = f.rpc(dialRequest(2));
  await tick();
  f.send({ method: "cancel", args: { request: 2 } });
  assert.equal(f.dial.mock.calls[0].arguments[0].signal.aborted, true);
  const close = t.mock.fn(async () => {});
  pending.resolve(connection({ close }));
  assert.match((await dialing).error!, /canceled/);
  assert.equal(close.mock.callCount(), 1);
  assert(resultID(await f.rpc(dialRequest(3))));
});

for (const failure of ["close", "transportStats"] as const) {
  test(`${failure} failure cannot leak a connection or stall the outgoing queue`, async (t) => {
    const f = await fixture(t);
    await f.rpc(listenRequest());
    const close = t.mock.fn(async () => {
      if (failure === "close") throw new Error("close failed");
    });
    f.dial.mock.mockImplementationOnce(async () =>
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
    assert.equal(close.mock.callCount(), 1);
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

test("overlapping reads cannot concurrently reuse the Go receive buffer; closing interrupts a pending read", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const pending = deferred<Uint8Array<ArrayBuffer> | null>();
  const read = t.mock.fn(() => pending.promise);
  const close = t.mock.fn(async () => {
    pending.resolve(null);
  });
  f.dial.mock.mockImplementationOnce(async () => connection({ read, close }));
  const id = resultID(await f.rpc(dialRequest(2)));
  const first = f.rpc({ id: 3, method: "read", args: { connection: id } });
  const second = f.rpc({ id: 4, method: "read", args: { connection: id } });
  await tick();
  await f.rpc({ id: 5, method: "close", args: { connection: id } });
  assert.equal((await first).result, null);
  assert.match((await second).error!, /read.*progress/i);
  assert.equal(read.mock.callCount(), 1);
});

test("binary reads transfer ownership and failed reads leave the connection readable", async (t) => {
  const f = await fixture(t);
  await f.rpc(listenRequest());
  const read = t.mock.fn(async () => new Uint8Array([7, 8]));
  read.mock.mockImplementationOnce(async () => {
    throw new Error("read failed");
  });
  f.dial.mock.mockImplementationOnce(async () => connection({ read }));
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

test("WebRTC admits at most 1 MiB until credits return and stops admitting after path closure", async (t) => {
  const f = await fixture(t);
  const packet = () => new Uint8Array(32768);
  f.scope.onTailcatRTC(1, "start", { peerNodeKey: "peer", initiator: true });
  assert.equal(f.scope.onTailcatRTCPacket(1, packet()), false);
  f.send({ method: "rtc", args: { session: 1, kind: "ready", value: true } });
  for (let n = 0; n < 32; n++)
    assert.equal(f.scope.onTailcatRTCPacket(1, packet()), true);
  assert.equal(f.scope.onTailcatRTCPacket(1, packet()), false);
  f.send({ method: "rtc", args: { session: 1, kind: "credit", value: 32768 } });
  assert.equal(f.scope.onTailcatRTCPacket(1, packet()), true);
  f.send({
    method: "rtc",
    args: { session: 1, kind: "packet", value: new Uint8Array([1, 2]) },
  });
  assert.equal(f.inbox.messages.at(-1)?.kind, "received");
  assert.equal(f.inbox.messages.at(-1)?.value, 2);
  f.scope.onTailcatRTC(1, "closed", null);
  assert.equal(f.scope.onTailcatRTCPacket(1, packet()), false);
});
