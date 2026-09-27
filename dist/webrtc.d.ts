/** Browser transport for encrypted WireGuard datagrams. Signaling arrives over
 * an authenticated Tailcat stream; MQTT is never part of this trust boundary. */
export interface WebRTCOptions {
    iceServers?: {
        urls: string | string[];
        username?: string;
        credential?: string;
    }[];
}
export interface TransportStats {
    session: number;
    peerNodeKey: string;
    state: "connecting" | "direct" | "webrtc-relay" | "derp";
    txBytes: number;
    rxBytes: number;
    droppedPackets: number;
    bufferedBytes: number;
    acknowledgedBytes: number;
    deliveryRTTMS?: number;
    fallbackReason?: string;
    rttMS?: number;
    candidateProtocol?: string;
    localCandidateType?: string;
    remoteCandidateType?: string;
}
export interface PacketStats {
    derpTxBytes: number;
    derpRxBytes: number;
    pathDrops: number;
}
export type PeerTransport = Pick<TransportStats, "peerNodeKey" | "state"> & Partial<Omit<TransportStats, "session" | "peerNodeKey" | "state"> & PacketStats>;
export declare function createWebRTC(options: WebRTCOptions, send: (message: Record<string, unknown>, transfer?: ArrayBuffer[]) => void, initiallyEnabled?: boolean, tunnelMTU?: number): {
    onChange(callback: () => void): void;
    snapshot(): PeerTransport[];
    handle({ session: id, kind, value, }: {
        session: number;
        kind: string;
        value: any;
    }): void;
    stats(): Promise<TransportStats[]>;
    setEnabled(value: boolean): void;
    close(): void;
};
export type WebRTCManager = ReturnType<typeof createWebRTC>;
