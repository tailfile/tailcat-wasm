import { type TailcatOptions } from "./client.js";
export type { WebRTCOptions, TransportStats, PeerTransport } from "./webrtc.js";
export type { AddressDescription, TailcatConnection, TransportIdentity, ListenerIdentity, ListenOptions, TailcatOptions, } from "./client.js";
/** The shared WASM hosted by a Node.js Worker; this entry uses DERP only. */
export declare function createTailcat(options: TailcatOptions): Promise<{
    getTransportStats: () => Promise<never[] | import("./webrtc.js").TransportStats[]>;
    setWebRTCEnabled: (enabled: boolean) => void;
    createIdentity: () => Promise<import("./client.js").TransportIdentity>;
    describeAddress: (address: string) => Promise<import("./client.js").AddressDescription>;
    listen: (derpMapURL: string) => Promise<string>;
    listenWithIdentity: (derpMapURL: string, options?: import("./client.js").ListenOptions) => Promise<import("./client.js").ListenerIdentity>;
    dial: (address: string, derpMapURL: string, options?: {
        port?: number;
        signal?: AbortSignal;
    }) => Promise<import("./client.js").TailcatConnection>;
    close: () => void;
}>;
