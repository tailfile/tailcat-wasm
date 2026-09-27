// One independent Node process per endpoint, mirroring independent Chromium
// instances. The SDK still owns its normal worker_threads/Go WASM runtime.
import type {
  createTailcat,
  TailcatConnection,
  PeerTransport,
} from "../dist/node.js";

let runtime: Awaited<ReturnType<typeof createTailcat>> | undefined;
let connection: TailcatConnection | undefined;
let peers: PeerTransport[] = [];
let target = 0,
  received = 0,
  corrupt = 0,
  ended = 0;
let cpuStart = process.cpuUsage();
let completed: Promise<void>;
let complete: () => void;
let failure: Error | undefined;
function fail(error: unknown) {
  failure = error instanceof Error ? error : new Error(String(error));
  process.send?.({ event: "fatal", error: failure.message });
}
function accept(conn: TailcatConnection) {
  connection = conn;
  void (async () => {
    for (;;) {
      const bytes = await conn.read();
      if (!bytes) return;
      if (!target) throw new Error("Node receiver produced unexpected bytes");
      for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 37) corrupt++;
      received += bytes.length;
      if (received > target) throw new Error("Node receiver exceeded target");
      if (received === target) {
        ended = performance.timeOrigin + performance.now();
        complete();
      }
    }
  })().catch(fail);
}
process.on(
  "message",
  async (request: {
    id: number;
    method: string;
    mtu: number;
    map: string;
    address: string;
    bytes: number;
    moduleURL?: string;
  }) => {
    const { id, method } = request;
    try {
      if (failure) throw failure;
      let result: unknown;
      if (method === "listen") {
        const sdk: typeof import("../dist/node.js") = await import(
          request.moduleURL ?? new URL("../dist/node.js", import.meta.url).href
        );
        runtime = await sdk.createTailcat({
          tunnelMTU: request.mtu,
          onConnection: accept,
          onTransportChange: (value) => {
            peers = value;
          },
          onError: fail,
        });
        result = await runtime.listen(request.map);
      } else if (method === "dial") {
        accept(await runtime!.dial(request.address, request.map));
      } else if (method === "prepare") {
        target = request.bytes;
        received = corrupt = ended = 0;
        cpuStart = process.cpuUsage();
        completed = new Promise<void>((resolve) => {
          complete = resolve;
        });
      } else if (method === "run") {
        const block = new Uint8Array(256 * 1024).fill(37);
        const cpu = process.cpuUsage();
        const started = performance.timeOrigin + performance.now();
        for (let offset = 0; offset < request.bytes; offset += block.length)
          await connection!.write(
            block.subarray(0, Math.min(block.length, request.bytes - offset)),
          );
        result = { started, cpu: process.cpuUsage(cpu) };
      } else if (method === "result") {
        await completed!;
        result = { received, corrupt, ended, cpu: process.cpuUsage(cpuStart) };
      } else if (method === "stats") {
        result = peers;
      } else throw new Error(`Unknown Node benchmark request: ${method}`);
      process.send?.({ id, result });
    } catch (error) {
      process.send?.({ id, error: String(error) });
    }
  },
);
process.on("disconnect", () => {
  runtime?.close();
  process.exit(0);
});
