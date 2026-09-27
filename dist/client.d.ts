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
    /** Writes are ordered. At most 4 MiB / 64 writes may be pending; await writes for backpressure. */
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
    /** Select a relay region for a new or existing identity without rotating saved keys. */
    regionID?: number;
}
export interface TailcatOptions {
    /** Experimental browser direct transport; false retains DERP only. */
    webRTC?: false | WebRTCOptions;
    signal?: AbortSignal;
    assetsURL?: string;
    /** Inner tunnel MTU, default 8192, from 1280 to 32768; also carried as WebRTC messages. */
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
export declare function validateOptions(options: TailcatOptions): number;
export declare function connectWorker(worker: WorkerPort, options: TailcatOptions, tunnelMTU: number, rtc?: WebRTCManager): Promise<{
    getTransportStats: () => Promise<never[] | import("./webrtc.js").TransportStats[]>;
    /** Disabling restores DERP; re-enabling resumes existing upgrade loops and enables future connections. */
    setWebRTCEnabled: (enabled: boolean) => void;
    /** Generate native keys locally, without a listener, DERP map or network connection. */
    createIdentity: () => Promise<TransportIdentity>;
    /** Parse with upstream Tailcat inside WASM; no connection or map fetch is needed. */
    describeAddress: (address: string) => Promise<AddressDescription>;
    listen: (derpMapURL: string) => Promise<string>;
    listenWithIdentity: (derpMapURL: string, options?: ListenOptions) => Promise<ListenerIdentity>;
    dial: (address: string, derpMapURL: string, options?: {
        port?: number;
        signal?: AbortSignal;
    }) => Promise<TailcatConnection>;
    close: () => void;
}>;
