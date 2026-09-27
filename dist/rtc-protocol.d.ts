export declare const RTC_VERSION = 2;
export declare const RTC_HEADER = 8;
export declare const RTC_DATA = 1413694514;
export declare const RTC_PROBE = 1413697586;
export declare const RTC_ACK = 1413693746;
export declare const RTC_QUEUE_LIMIT: number;
export declare const RTC_WORKER_LIMIT: number;
export declare const DEFAULT_TUNNEL_MTU = 8192;
export declare function rtcFrame(kind: number, sequence: number, size?: number): Uint8Array<ArrayBuffer>;
