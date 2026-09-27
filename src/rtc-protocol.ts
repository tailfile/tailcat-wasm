// Version 2 adds packet receipts and sized path probes. These frames are only
// used inside the authenticated DataChannel, never sent to WireGuard or DERP.
export const RTC_VERSION = 2;
export const RTC_HEADER = 8;
export const RTC_DATA = 0x54434432;
export const RTC_PROBE = 0x54435032;
export const RTC_ACK = 0x54434132;
export const RTC_QUEUE_LIMIT = 256 * 1024;
// Worker scheduling can deliver a burst before either side returns credits.
// A byte bound absorbs that burst; the main-thread queue also has an age bound.
export const RTC_WORKER_LIMIT = 1024 * 1024;
export const DEFAULT_TUNNEL_MTU = 8192;

export function rtcFrame(kind: number, sequence: number, size = RTC_HEADER) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, kind);
  view.setUint32(4, sequence);
  return bytes;
}
