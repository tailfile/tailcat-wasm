import type { PeerTransport, WebRTCManager, WebRTCOptions } from "./webrtc.js";

/** Upstream ParseAddrRaw JSON output, with PresharedKey redacted. */
export interface AddressDescription {
  ServerPublic: string;
  ServerDiscoPublic?: string;
  PresharedKey?: string;
  RegionID?: number;
  Region?: Record<string, unknown>[];
}

export interface TailcatConnection {
  readonly port?: number;
  /** Supplied by the established Tailcat tunnel, never by application messages. */
  readonly peerNodeKey: string;
  /** Only one read may be pending per stream; overlapping reads reject. */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  closeWrite(): Promise<void>;
  close(): Promise<void>;
}
export interface TransportIdentity {
  nodeKey: string;
  sendNodeKey: string;
  /** Secret native Tailcat keys for receiving and sending. Persist securely; never publish or log it. */
  privateKeyJSON: string;
}
export interface ListenerIdentity extends TransportIdentity {
  address: string;
}
export interface ListenOptions {
  privateKeyJSON?: string;
  /** Move the existing identity to a selected relay region without rotating its keys. */
  regionID?: number;
}

export interface TailcatOptions {
  /** Experimental browser direct transport; false retains DERP only. */
  webRTC?: false | WebRTCOptions;
  signal?: AbortSignal;
  assetsURL?: string;
  /** Inner tunnel MTU, from 1280 to 32768; also carried as WebRTC messages. */
  tunnelMTU?: number;
  onConnection(connection: TailcatConnection): void;
  /** Active authenticated peers only; closing the last stream removes a peer. */
  onTransportChange?(peers: PeerTransport[]): void;
  onError?(error: Error): void;
}
export interface WorkerPort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
  onMessage(handler: (data: any) => void): void;
  onError(handler: (error: Error) => void): void;
}
export function validateOptions(options: TailcatOptions) {
  options.signal?.throwIfAborted();
  const mtu = options.tunnelMTU ?? 32768;
  if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 32768)
    throw new Error("tunnelMTU must be between 1280 and 32768");
  return mtu;
}
export async function connectWorker(
  worker: WorkerPort,
  options: TailcatOptions,
  tunnelMTU: number,
  rtc?: WebRTCManager,
) {
  let nextID = 0;
  let closed = false;
  const activeConnections = new Map<number, string>();
  const packetStats = new Map<string, Partial<PeerTransport>>();
  let lastTransportState = "";
  function notifyTransports() {
    if (!options.onTransportChange) return;
    const paths = new Map(
      rtc?.snapshot().map((path) => [path.peerNodeKey, path]),
    );
    const peers: PeerTransport[] = Array.from(
      new Set(activeConnections.values()),
      (peerNodeKey) => ({
        ...packetStats.get(peerNodeKey),
        ...paths.get(peerNodeKey),
        peerNodeKey,
        state: paths.get(peerNodeKey)?.state ?? "derp",
      }),
    );
    const state = JSON.stringify(peers);
    if (state === lastTransportState) return;
    lastTransportState = state;
    options.onTransportChange(peers);
  }
  rtc?.onChange(notifyTransports);
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(
    () =>
      fail(new Error("Transport loading timed out. Refresh and try again.")),
    60_000,
  );
  function fail(error: Error) {
    if (closed) return;
    closed = true;
    activeConnections.clear();
    packetStats.clear();
    clearTimeout(timer);
    worker.terminate();
    options.signal?.removeEventListener("abort", aborted);
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    // Settle work before notifying consumers: their callbacks may throw.
    // Closing RTC paths also emits change events; defer the consumer callback
    // until every path has released its channel and heartbeat.
    rtc?.onChange(() => {});
    try {
      rtc?.close();
      notifyTransports();
    } finally {
      options.onError?.(error);
    }
  }
  const aborted = () => fail(new Error("Transport canceled"));
  function post(message: unknown, transfer: ArrayBuffer[] = []) {
    try {
      worker.postMessage(message, transfer);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  function call<T>(
    method: string,
    args: Record<string, unknown> = {},
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed) return Promise.reject(new Error("Transport closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++nextID;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        request.reject(signal!.reason);
        post({ method: "cancel", args: { request: id } });
      };
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      post({ id, method, args }, transfer);
    });
  }
  function connection(
    id: number,
    peerNodeKey: string,
    port = 1,
  ): TailcatConnection {
    activeConnections.set(id, peerNodeKey);
    let closing: Promise<void> | undefined;
    function close() {
      return (closing ??= call<void>("close", { connection: id }).finally(
        () => {
          activeConnections.delete(id);
          if (!Array.from(activeConnections.values()).includes(peerNodeKey))
            packetStats.delete(peerNodeKey);
          notifyTransports();
        },
      ));
    }
    try {
      notifyTransports();
    } catch (error) {
      // The caller never received this stream, so it cannot release the dial slot.
      void close().catch(() => {});
      throw error;
    }
    function streamCall<T>(
      method: string,
      args: Record<string, unknown> = {},
      transfer: ArrayBuffer[] = [],
    ) {
      if (closing) return Promise.reject<T>(new Error("Connection is closed"));
      return call<T>(method, { connection: id, ...args }, transfer);
    }
    return {
      port,
      peerNodeKey,
      read: () => streamCall("read"),
      write: (bytes) => {
        // Structured clone copies a view's entire backing ArrayBuffer. Copy
        // only this write, then transfer it without detaching the caller's data.
        // Buffer.slice() is a view, unlike Uint8Array.slice(). Always allocate
        // a plain Uint8Array so Node buffers retain ownership of their memory.
        const owned = new Uint8Array(bytes);
        return streamCall("write", { bytes: owned }, [owned.buffer]);
      },
      closeWrite: () => streamCall("closeWrite"),
      close,
    };
  }
  worker.onError(fail);
  worker.onMessage((data) => {
    if (closed) return;
    if (data.event === "ready") {
      clearTimeout(timer);
      readyResolve();
    } else if (data.event === "transportStats") {
      const activePeers = new Set(activeConnections.values());
      for (const peer of data.peers)
        if (activePeers.has(peer.peerNodeKey))
          packetStats.set(peer.peerNodeKey, peer);
      notifyTransports();
    } else if (data.event === "rtc") rtc?.handle(data);
    else if (data.event === "fatal") fail(new Error(data.error));
    else if (data.event === "connection") {
      const stream = connection(data.connection, data.peerNodeKey, data.port);
      try {
        // A transport observer may have synchronously closed the runtime.
        if (!closed) options.onConnection(stream);
      } catch (error) {
        void stream.close().catch(() => {});
        throw error;
      }
    } else {
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (request)
        data.error
          ? request.reject(new Error(data.error))
          : request.resolve(data.result);
      else if (data.result?.peerNodeKey && Number.isInteger(data.result.id))
        void call("close", { connection: data.result.id }).catch(() => {});
    }
  });
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  if (!closed)
    post({
      method: "configure",
      args: { tunnelMTU, webRTC: !!rtc && options.webRTC !== false },
    });
  await ready;
  if (closed) throw new Error("Transport closed");
  return {
    getTransportStats: async () => (rtc ? rtc.stats() : []),
    /** Disabling restores DERP; re-enabling applies to subsequent connections. */
    setWebRTCEnabled: (enabled: boolean) => {
      if (closed || !rtc) return;
      rtc.setEnabled(enabled);
      post({ method: "webRTCEnabled", args: { enabled } });
    },
    /** Generate native keys locally, without a listener, DERP map or network connection. */
    createIdentity: () => call<TransportIdentity>("createIdentity"),
    /** Parse with upstream Tailcat inside WASM; no connection or map fetch is needed. */
    describeAddress: (address: string) =>
      call<AddressDescription>("describeAddress", { address }),
    listen: async (derpMapURL: string) =>
      (await call<ListenerIdentity>("listen", { derpMapURL })).address,
    listenWithIdentity: (derpMapURL: string, options: ListenOptions = {}) =>
      call<ListenerIdentity>("listen", { derpMapURL, ...options }),
    dial: async (
      address: string,
      derpMapURL: string,
      options: { port?: number; signal?: AbortSignal } = {},
    ) => {
      const port = options.port ?? 80;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 65534)
        throw new Error(
          "port must be between 1 and 65535; 65534 is reserved for WebRTC signaling",
        );
      const result = await call<{
        id: number;
        port: number;
        peerNodeKey: string;
      }>(
        "dial",
        {
          address,
          derpMapURL,
          port,
        },
        [],
        options.signal,
      );
      // Abort/close can happen after the RPC resolves but before this continuation.
      if (options.signal?.aborted || closed) {
        if (!closed)
          void call("close", { connection: result.id }).catch(() => {});
        options.signal?.throwIfAborted();
        throw new Error("Transport closed");
      }
      const stream = connection(result.id, result.peerNodeKey, result.port);
      // Consumers may cancel or close the runtime from onTransportChange.
      if (options.signal?.aborted || closed) {
        void stream.close().catch(() => {});
        options.signal?.throwIfAborted();
        throw new Error("Transport closed");
      }
      return stream;
    },
    close: () => fail(new Error("Transport closed")),
  };
}
