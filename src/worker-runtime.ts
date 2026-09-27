import { wasmResponse } from "./wasm-response.js";
import { RTC_HEADER, RTC_WORKER_LIMIT } from "./rtc-protocol.js";
import type { PacketStats } from "./webrtc.js";
import type {
  AddressDescription,
  TransportIdentity,
  ListenerIdentity,
  ListenOptions,
} from "./index.js";

interface WASMConnection {
  port: number;
  peerNodeKey: string;
  transportStats(): PacketStats;
  read(): Promise<Uint8Array<ArrayBuffer> | null>;
  write(bytes: Uint8Array): Promise<void>;
  closeWrite(): Promise<void>;
  close(): Promise<void>;
}
interface WASMListener extends Omit<ListenerIdentity, "address"> {
  addr: string;
  close(): Promise<void>;
}
interface Configuration {
  tunnelMTU: number;
  webRTC: boolean;
}
type Request =
  | { method: "webRTCEnabled"; args: { enabled: boolean } }
  | {
      method: "rtc";
      args: { session: number; kind: string; value?: any; sequence?: number };
    }
  | { method: "configure"; args: Configuration }
  | { method: "cancel"; args: { request: number } }
  | { id: number; method: "createIdentity"; args: Record<string, never> }
  | { id: number; method: "describeAddress"; args: { address: string } }
  | {
      id: number;
      method: "listen";
      args: ListenOptions & { derpMapURL: string };
    }
  | {
      id: number;
      method: "dial";
      args: { address: string; derpMapURL: string; port: number };
    }
  | {
      id: number;
      method: "read" | "close" | "closeWrite";
      args: { connection: number };
    }
  | {
      id: number;
      method: "write";
      args: { connection: number; bytes: Uint8Array };
    };

// wasm_exec.js installs Go; main_js.go installs the Tailcat exports at startup.
// Keep this Worker scope separate from the DOM globals used by the public API.
export interface RuntimeScope {
  Go: new () => {
    env: Record<string, string>;
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  };
  onTailcatReady(): void;
  onTailcatRTC(session: number, kind: string, value: unknown): void;
  onTailcatRTCPacket(session: number, address: number, length: number): boolean;
  tailcatRTC(session: number, kind: string, value: unknown): unknown;
  tailcatWebRTCEnabled?: boolean;
  tailcatCreateIdentity(): Promise<TransportIdentity>;
  tailcatDescribeAddress(address: string): Promise<AddressDescription>;
  tailcatListen(options: {
    webRTC: boolean;
    derpMapURL: string;
    privateKey?: string;
    onConnection(connection: WASMConnection): void;
  }): Promise<WASMListener>;
  tailcatDial(options: {
    webRTC: boolean;
    addr: string;
    derpMapURL: string;
    port: number;
    privateKey: string;
    signal: AbortSignal;
  }): Promise<WASMConnection>;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage(event: MessageEvent<Request>): void;
}

export function startWorker(
  scope: RuntimeScope,
  loadWasm: () => Promise<Response>,
) {
  const connections = new Map<number, WASMConnection>();
  let nextConnection = 0;
  let identity: ListenerIdentity | undefined;
  let listening = false;
  const reading = new Set<number>();
  let fatalError: Error | undefined;
  const canceled = new Map<number, AbortController>();
  let outgoing: { id: number; release(): void } | undefined;
  let dialBusy = false;
  const waitingDials = new Set<() => void>();
  let webRTC = false;
  let listenerOptions: Parameters<RuntimeScope["tailcatListen"]>[0] | undefined;
  let wasmMemory: WebAssembly.Memory;
  const RECEIVED_BATCH = 16;
  const paths = new Map<
    number,
    {
      ready: boolean;
      pending: number;
      dropped: number;
      recvAddress?: number;
      recvCapacity?: number;
      received: { sequence: number | undefined; accepted: boolean }[];
      receivedBytes: number;
      receivedTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  function flushReceived(session: number, path: ReturnType<typeof paths.get>) {
    if (!path || !path.received.length) return;
    clearTimeout(path.receivedTimer);
    path.receivedTimer = undefined;
    const value = { bytes: path.receivedBytes, items: path.received };
    path.received = [];
    path.receivedBytes = 0;
    scope.postMessage({ event: "rtc", session, kind: "received", value });
  }
  function noteReceived(
    session: number,
    path: NonNullable<ReturnType<typeof paths.get>>,
    sequence: number | undefined,
    accepted: boolean,
    bytes: number,
  ) {
    path.received.push({ sequence, accepted });
    path.receivedBytes += bytes;
    if (path.received.length >= RECEIVED_BATCH) {
      flushReceived(session, path);
      return;
    }
    // Batch a packet trickle without delaying delivery health for long.
    path.receivedTimer ??= setTimeout(
      () => flushReceived(session, paths.get(session)),
      2,
    );
  }
  scope.onTailcatRTC = (session, kind, value) => {
    if (kind === "start") {
      const start = value as
        | { recvBuffer?: number; recvCapacity?: number }
        | null
        | undefined;
      paths.set(session, {
        ready: false,
        pending: 0,
        dropped: 0,
        recvAddress:
          typeof start?.recvBuffer === "number" ? start.recvBuffer : undefined,
        recvCapacity:
          typeof start?.recvCapacity === "number" ? start.recvCapacity : undefined,
        received: [],
        receivedBytes: 0,
      });
    }
    if (kind === "closed") {
      const path = paths.get(session);
      if (path?.dropped)
        scope.postMessage({
          event: "rtc",
          session,
          kind: "dropped",
          value: path.dropped,
        });
      flushReceived(session, path);
      paths.delete(session);
    }
    scope.postMessage({ event: "rtc", session, kind, value });
  };
  scope.onTailcatRTCPacket = (session, address, length) => {
    const path = paths.get(session);
    if (!path?.ready) return false;
    if (path.pending + length > RTC_WORKER_LIMIT) {
      // Absorb short scheduling bursts like a bounded UDP socket: a local
      // drop lets inner TCP apply backpressure without mixing paths. Queue age
      // and delivery receipts, not one full buffer, trigger a path switch.
      path.dropped++;
      return true;
    }
    // Copy synchronously while Go owns the borrowed packet. Always obtain the
    // current buffer: memory.grow detaches the previous ArrayBuffer. Headroom
    // lets the main thread add RTC framing without copying the ciphertext again.
    const frame = new Uint8Array(RTC_HEADER + length);
    frame.set(new Uint8Array(wasmMemory.buffer, address, length), RTC_HEADER);
    const bytes = frame.subarray(RTC_HEADER);
    path.pending += length;
    scope.postMessage({ event: "rtc", session, kind: "packet", value: bytes }, [
      bytes.buffer,
    ]);
    return true;
  };

  function accept(connection: WASMConnection) {
    const id = remember(connection);
    scope.postMessage({
      event: "connection",
      connection: id,
      port: connection.port,
      peerNodeKey: connection.peerNodeKey,
    });
  }
  function reportTransports() {
    const peers = new Map<string, PacketStats>();
    for (const connection of connections.values()) {
      try {
        peers.set(connection.peerNodeKey, connection.transportStats());
      } catch {
        // Diagnostics must not interrupt closing a stream or releasing its queue.
      }
    }
    scope.postMessage({
      event: "transportStats",
      peers: Array.from(peers, ([peerNodeKey, stats]) => ({
        peerNodeKey,
        ...stats,
      })),
    });
  }
  // The worker is terminated with the runtime. Poll only while streams exist.
  const statsTimer = setInterval(() => {
    for (const [session, path] of paths) {
      if (path.dropped) {
        scope.postMessage({
          event: "rtc",
          session,
          kind: "dropped",
          value: path.dropped,
        });
        path.dropped = 0;
      }
    }
    if (connections.size) reportTransports();
  }, 1000);
  function releaseDial() {
    const next = waitingDials.values().next().value;
    if (next) next();
    else dialBusy = false;
  }
  async function acquireDial(signal: AbortSignal) {
    signal.throwIfAborted();
    if (waitingDials.size >= 64)
      throw new Error("Too many queued dials (limit 64)");
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        waitingDials.delete(grant);
        signal.removeEventListener("abort", abort);
        dialBusy = true;
        resolve();
      };
      const abort = () => {
        waitingDials.delete(grant);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      if (!dialBusy) grant();
      else {
        waitingDials.add(grant);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
  async function dial(
    args: { address: string; derpMapURL: string; port: number },
    signal: AbortSignal,
  ) {
    if (!identity) throw new Error("Start the Tailcat listener before dialing");
    // Sending uses a distinct key, so the listener stays up. Only Clients queue.
    // Canceled waiters leave immediately, even if an open stream holds the key.
    await acquireDial(signal);
    let connection: WASMConnection | undefined;
    try {
      signal.throwIfAborted();
      connection = await scope.tailcatDial({
        webRTC,
        addr: args.address,
        derpMapURL: args.derpMapURL,
        port: args.port,
        privateKey: identity.privateKeyJSON,
        signal,
      });
      signal.throwIfAborted();
      const id = remember(connection);
      outgoing = { id, release: releaseDial };
      return { id, port: connection.port, peerNodeKey: connection.peerNodeKey };
    } catch (error) {
      try {
        await connection?.close();
      } finally {
        releaseDial();
      }
      throw error;
    }
  }
  let configure: (options: Configuration) => void;
  const configuration = new Promise<Configuration>((resolve) => {
    configure = resolve;
  });
  const ready = new Promise<void>((resolve, reject) => {
    scope.onTailcatReady = resolve;
    function failed(reason: unknown) {
      if (fatalError) return;
      fatalError = reason instanceof Error ? reason : new Error(String(reason));
      clearInterval(statsTimer);
      reject(fatalError);
      // A settled ready promise cannot carry failures from the running Go VM.
      scope.postMessage({ event: "fatal", error: fatalError.message });
    }
    configuration
      .then(async (config) => {
        const go = new scope.Go();
        const { tunnelMTU } = config;
        webRTC = config.webRTC;
        scope.tailcatWebRTCEnabled = webRTC;
        // DERP/WSS and WebRTC/SCTP carry complete encrypted tunnel packets.
        // This does not change a host UDP interface MTU.
        // TCP MSS negotiation retains compatibility with peers using MTU 1280.
        go.env.TS_DEBUG_MTU = String(tunnelMTU);
        const { instance } = await WebAssembly.instantiateStreaming(
          loadWasm().then(wasmResponse),
          go.importObject,
        );
        if (!(instance.exports.mem instanceof WebAssembly.Memory))
          throw new Error("Go WASM does not export its linear memory");
        wasmMemory = instance.exports.mem;
        return go.run(instance);
      })
      .then(() => failed(new Error("Tailcat stopped")), failed);
  });
  ready.then(
    () => scope.postMessage({ event: "ready" }),
    () => {}, // Startup failures were reported by failed().
  );
  function remember(connection: WASMConnection) {
    const id = ++nextConnection;
    connections.set(id, connection);
    return id;
  }
  scope.onmessage = async ({ data }) => {
    if (data.method === "webRTCEnabled") {
      webRTC = data.args.enabled;
      scope.tailcatWebRTCEnabled = webRTC;
      if (listenerOptions) listenerOptions.webRTC = webRTC;
      return;
    }
    if (data.method === "rtc") {
      const { session, kind, value, sequence } = data.args;
      const path = paths.get(session);
      if (!path) return;
      if (kind === "ready") path.ready = !!value;
      else if (kind === "credit")
        path.pending = Math.max(0, path.pending - value);
      else {
        if (kind === "closed") path.ready = false;
        if (kind === "packet" && value instanceof Uint8Array) {
          const bytes = value;
          let accepted: unknown = false;
          if (
            path.recvAddress !== undefined &&
            path.recvCapacity !== undefined &&
            bytes.byteLength <= path.recvCapacity
          ) {
            // Copy directly into the Go-owned receive buffer: one memcpy instead
            // of a per-packet js.Value, Go allocation and CopyBytesToGo dispatch.
            // Go takes ownership and returns the next buffer's address; 0 rejects.
            new Uint8Array(
              wasmMemory.buffer,
              path.recvAddress,
              path.recvCapacity,
            ).set(bytes);
            const nextAddress = scope.tailcatRTC(
              session,
              "packet",
              bytes.byteLength,
            );
            if (typeof nextAddress === "number" && nextAddress !== 0) {
              path.recvAddress = nextAddress;
              accepted = true;
            }
          } else {
            // Legacy Worker/WASM pair without buffer addresses.
            accepted = scope.tailcatRTC(session, "packet", value);
          }
          noteReceived(session, path, sequence, accepted === true, bytes.byteLength);
        } else {
          scope.tailcatRTC(session, kind, value ?? null);
        }
      }
      return;
    }
    if (data.method === "configure") {
      configure(data.args);
      return;
    }
    if (data.method === "cancel") {
      canceled.get(data.args.request)?.abort(new Error("Transport canceled"));
      return;
    }
    const { id, method, args } = data;
    const controller = new AbortController();
    if (method === "dial") canceled.set(id, controller);
    try {
      await ready;
      if (fatalError) throw fatalError;
      let result:
        | AddressDescription
        | TransportIdentity
        | ListenerIdentity
        | { id: number; port: number; peerNodeKey: string }
        | Uint8Array<ArrayBuffer>
        | null
        | undefined;
      if (method === "createIdentity") {
        result = await scope.tailcatCreateIdentity();
      } else if (method === "describeAddress") {
        result = await scope.tailcatDescribeAddress(args.address);
      } else if (method === "listen") {
        if (identity || listening) throw new Error("Already listening");
        listening = true;
        try {
          let privateKey = args.privateKeyJSON;
          if (args.regionID !== undefined) {
            if (!Number.isInteger(args.regionID) || args.regionID <= 0)
              throw new Error("Invalid relay region");
            privateKey ??= (await scope.tailcatCreateIdentity()).privateKeyJSON;
            const saved = JSON.parse(privateKey);
            saved.serverKey.Public.RegionID = args.regionID;
            saved.serverKey.Public.Region = null;
            privateKey = JSON.stringify(saved);
          }
          listenerOptions = {
            webRTC,
            derpMapURL: args.derpMapURL,
            privateKey,
            onConnection: accept,
          };
          const listener = await scope.tailcatListen(listenerOptions);
          result = identity = {
            address: listener.addr,
            nodeKey: listener.nodeKey,
            sendNodeKey: listener.sendNodeKey,
            privateKeyJSON: listener.privateKeyJSON,
          };
        } finally {
          listening = false;
        }
      } else if (method === "dial") {
        result = await dial(args, controller.signal);
      } else {
        const connection = connections.get(args.connection);
        if (!connection) {
          if (method !== "close") throw new Error("Connection is closed");
        } else if (method === "close") {
          reportTransports();
          connections.delete(args.connection);
          try {
            await connection.close();
          } finally {
            if (outgoing?.id === args.connection) {
              outgoing.release();
              outgoing = undefined;
            }
          }
        } else if (method === "read") {
          // Go uses one receive buffer per stream. Do not let two goroutines
          // read into it concurrently; close must remain free to interrupt IO.
          if (reading.has(args.connection))
            throw new Error("A read is already in progress");
          reading.add(args.connection);
          try {
            result = await connection.read();
          } finally {
            reading.delete(args.connection);
          }
        } else if (method === "write") await connection.write(args.bytes);
        else if (method === "closeWrite") await connection.closeWrite();
        else throw new Error("Unknown operation");
      }
      scope.postMessage(
        { id, result },
        result instanceof Uint8Array ? [result.buffer] : [],
      );
    } catch (error) {
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      canceled.delete(id);
    }
  };
}
