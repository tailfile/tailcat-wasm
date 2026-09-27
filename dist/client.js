import { DEFAULT_TUNNEL_MTU } from "./rtc-protocol.js";
export function validateOptions(options) {
    options.signal?.throwIfAborted();
    const mtu = options.tunnelMTU ?? DEFAULT_TUNNEL_MTU;
    if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 32768)
        throw new Error("tunnelMTU must be between 1280 and 32768");
    return mtu;
}
export async function connectWorker(worker, options, tunnelMTU, rtc) {
    let nextID = 0;
    let closed = false;
    const activeConnections = new Map();
    const packetStats = new Map();
    let lastTransportState = "";
    function notifyTransports() {
        if (!options.onTransportChange)
            return;
        const paths = new Map(rtc?.snapshot().map((path) => [path.peerNodeKey, path]));
        const peers = Array.from(new Set(activeConnections.values()), (peerNodeKey) => ({
            ...packetStats.get(peerNodeKey),
            ...paths.get(peerNodeKey),
            peerNodeKey,
            state: paths.get(peerNodeKey)?.state ?? "derp",
        }));
        const state = JSON.stringify(peers);
        if (state === lastTransportState)
            return;
        lastTransportState = state;
        options.onTransportChange(peers);
    }
    rtc?.onChange(notifyTransports);
    const pending = new Map();
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    const timer = setTimeout(() => fail(new Error("Transport loading timed out. Refresh and try again.")), 60_000);
    function fail(error) {
        if (closed)
            return;
        closed = true;
        activeConnections.clear();
        packetStats.clear();
        clearTimeout(timer);
        worker.terminate();
        options.signal?.removeEventListener("abort", aborted);
        readyReject(error);
        for (const request of pending.values())
            request.reject(error);
        pending.clear();
        // Settle work before notifying consumers: their callbacks may throw.
        // Closing RTC paths also emits change events; defer the consumer callback
        // until every path has released its channel and heartbeat.
        rtc?.onChange(() => { });
        try {
            rtc?.close();
            notifyTransports();
        }
        finally {
            options.onError?.(error);
        }
    }
    const aborted = () => fail(new Error("Transport canceled"));
    function post(message, transfer = []) {
        try {
            worker.postMessage(message, transfer);
        }
        catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    function call(method, args = {}, transfer = [], signal) {
        if (closed)
            return Promise.reject(new Error("Transport closed"));
        if (signal?.aborted)
            return Promise.reject(signal.reason);
        const id = ++nextID;
        return new Promise((resolve, reject) => {
            const abort = () => {
                const request = pending.get(id);
                if (!request)
                    return;
                pending.delete(id);
                request.reject(signal.reason);
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
    function connection(id, peerNodeKey, port = 1) {
        activeConnections.set(id, peerNodeKey);
        let closing;
        let writeTail = Promise.resolve();
        let pendingWriteBytes = 0;
        let pendingWrites = 0;
        let writeError;
        let halfClosing;
        function close() {
            return (closing ??= call("close", { connection: id }).finally(() => {
                activeConnections.delete(id);
                if (!Array.from(activeConnections.values()).includes(peerNodeKey))
                    packetStats.delete(peerNodeKey);
                notifyTransports();
            }));
        }
        try {
            notifyTransports();
        }
        catch (error) {
            // The caller never received this stream, so it cannot release the dial slot.
            void close().catch(() => { });
            throw error;
        }
        function streamCall(method, args = {}, transfer = []) {
            if (closing)
                return Promise.reject(new Error("Connection is closed"));
            return call(method, { connection: id, ...args }, transfer);
        }
        return {
            port,
            peerNodeKey,
            read: () => streamCall("read"),
            write: (bytes) => {
                if (closing || halfClosing || closed)
                    return Promise.reject(new Error("Connection is closed for writing"));
                if (writeError)
                    return Promise.reject(writeError);
                if (pendingWrites >= 64 ||
                    pendingWriteBytes + bytes.byteLength > 4 * 1024 * 1024)
                    return Promise.reject(new Error("Write queue full (4 MiB / 64 writes); use smaller chunks and await previous writes"));
                // Structured clone copies a view's entire backing ArrayBuffer. Copy
                // only this write, then transfer it without detaching the caller's data.
                // Buffer.slice() is a view, unlike Uint8Array.slice(). Always allocate
                // a plain Uint8Array so Node buffers retain ownership of their memory.
                const owned = new Uint8Array(bytes);
                const size = owned.byteLength;
                pendingWriteBytes += size;
                const first = pendingWrites++ === 0;
                const submit = () => {
                    if (writeError)
                        return Promise.reject(writeError);
                    return streamCall("write", { bytes: owned }, [owned.buffer]);
                };
                const result = (first ? submit() : writeTail.then(submit))
                    .catch((error) => {
                    writeError = error;
                    throw error;
                })
                    .finally(() => {
                    pendingWriteBytes -= size;
                    pendingWrites--;
                });
                // Retain the original rejection for the caller, while the queue has a
                // handled tail even if no later write or half-close is submitted.
                writeTail = result.catch(() => { });
                return result;
            },
            closeWrite: () => (halfClosing ??= writeTail.then(() => {
                if (writeError)
                    throw writeError;
                return streamCall("closeWrite");
            })),
            close,
        };
    }
    worker.onError(fail);
    worker.onMessage((data) => {
        if (closed)
            return;
        if (data.event === "ready") {
            clearTimeout(timer);
            readyResolve();
        }
        else if (data.event === "transportStats") {
            const activePeers = new Set(activeConnections.values());
            for (const peer of data.peers)
                if (activePeers.has(peer.peerNodeKey))
                    packetStats.set(peer.peerNodeKey, peer);
            notifyTransports();
        }
        else if (data.event === "rtc")
            rtc?.handle(data);
        else if (data.event === "fatal")
            fail(new Error(data.error));
        else if (data.event === "connection") {
            const stream = connection(data.connection, data.peerNodeKey, data.port);
            try {
                // A transport observer may have synchronously closed the runtime.
                if (!closed)
                    options.onConnection(stream);
            }
            catch (error) {
                void stream.close().catch(() => { });
                throw error;
            }
        }
        else {
            const request = pending.get(data.id);
            pending.delete(data.id);
            if (request)
                data.error
                    ? request.reject(new Error(data.error))
                    : request.resolve(data.result);
            else if (data.result?.peerNodeKey && Number.isInteger(data.result.id))
                void call("close", { connection: data.result.id }).catch(() => { });
        }
    });
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted)
        aborted();
    if (!closed)
        post({
            method: "configure",
            args: { tunnelMTU, webRTC: !!rtc && options.webRTC !== false },
        });
    await ready;
    if (closed)
        throw new Error("Transport closed");
    return {
        getTransportStats: async () => (rtc ? rtc.stats() : []),
        /** Disabling restores DERP; re-enabling resumes existing upgrade loops and enables future connections. */
        setWebRTCEnabled: (enabled) => {
            if (closed || !rtc)
                return;
            try {
                rtc.setEnabled(enabled);
            }
            finally {
                post({ method: "webRTCEnabled", args: { enabled } });
            }
        },
        /** Generate native keys locally, without a listener, DERP map or network connection. */
        createIdentity: () => call("createIdentity"),
        /** Parse with upstream Tailcat inside WASM; no connection or map fetch is needed. */
        describeAddress: (address) => call("describeAddress", { address }),
        listen: async (derpMapURL) => (await call("listen", { derpMapURL })).address,
        listenWithIdentity: (derpMapURL, options = {}) => call("listen", { derpMapURL, ...options }),
        dial: async (address, derpMapURL, options = {}) => {
            const port = options.port ?? 80;
            if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 65534)
                throw new Error("port must be between 1 and 65535; 65534 is reserved for WebRTC signaling");
            const result = await call("dial", {
                address,
                derpMapURL,
                port,
            }, [], options.signal);
            // Abort/close can happen after the RPC resolves but before this continuation.
            if (options.signal?.aborted || closed) {
                if (!closed)
                    void call("close", { connection: result.id }).catch(() => { });
                options.signal?.throwIfAborted();
                throw new Error("Transport closed");
            }
            const stream = connection(result.id, result.peerNodeKey, result.port);
            // Consumers may cancel or close the runtime from onTransportChange.
            if (options.signal?.aborted || closed) {
                void stream.close().catch(() => { });
                options.signal?.throwIfAborted();
                throw new Error("Transport closed");
            }
            return stream;
        },
        close: () => fail(new Error("Transport closed")),
    };
}
