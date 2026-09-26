import type { PacketStats } from "./webrtc.js";
import type { AddressDescription, TransportIdentity, ListenerIdentity, ListenOptions } from "./index.js";
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
type Request = {
    method: "webRTCEnabled";
    args: {
        enabled: boolean;
    };
} | {
    method: "rtc";
    args: {
        session: number;
        kind: string;
        value?: any;
    };
} | {
    method: "configure";
    args: Configuration;
} | {
    method: "cancel";
    args: {
        request: number;
    };
} | {
    id: number;
    method: "createIdentity";
    args: Record<string, never>;
} | {
    id: number;
    method: "describeAddress";
    args: {
        address: string;
    };
} | {
    id: number;
    method: "listen";
    args: ListenOptions & {
        derpMapURL: string;
    };
} | {
    id: number;
    method: "dial";
    args: {
        address: string;
        derpMapURL: string;
        port: number;
    };
} | {
    id: number;
    method: "read" | "close" | "closeWrite";
    args: {
        connection: number;
    };
} | {
    id: number;
    method: "write";
    args: {
        connection: number;
        bytes: Uint8Array;
    };
};
export interface RuntimeScope {
    Go: new () => {
        env: Record<string, string>;
        importObject: WebAssembly.Imports;
        run(instance: WebAssembly.Instance): Promise<void>;
    };
    onTailcatReady(): void;
    onTailcatRTC(session: number, kind: string, value: unknown): void;
    onTailcatRTCPacket(session: number, bytes: Uint8Array<ArrayBuffer>): boolean;
    tailcatRTC(session: number, kind: string, value: unknown): void;
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
export declare function startWorker(scope: RuntimeScope, loadWasm: () => Promise<Response>): void;
export {};
