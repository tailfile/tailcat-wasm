import assert from "node:assert/strict";
import { vi, type TestContext } from "vitest";
import { createWebRTC } from "../src/webrtc.ts";
import { RTC_ACK, RTC_PROBE, rtcFrame } from "../src/rtc-protocol.ts";
import { deferred, tick } from "./helpers.ts";
export class Channel {
  label = "wireguard-v2";
  ordered = false;
  maxRetransmits = 2;
  readyState = "open";
  bufferedAmount = 0;
  sent: unknown[] = [];
  failure?: Error;
  onmessage?: (event: { data: unknown }) => void;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onbufferedamountlow?: () => void;
  send(value: unknown) {
    if (this.failure) throw this.failure;
    this.sent.push(value);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}
interface RTCMessage {
  session: number;
  kind: string;
  value?: unknown;
}
export function rtcFixture(
  t: TestContext,
  options: {
    failChannel?: boolean;
    delayedOffer?: boolean;
    enabled?: boolean;
  } = {},
) {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    now: 100_000,
  });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const offer = deferred<RTCSessionDescriptionInit>();
  const messages: RTCMessage[] = [];
  const peers: Peer[] = [];
  class Peer {
    channel = new Channel();
    closed = false;
    connectionState = "new";
    sctp = { maxMessageSize: 65536 };
    localDescription?: RTCSessionDescriptionInit;
    remoteDescription?: RTCSessionDescriptionInit;
    addedCandidates: RTCIceCandidateInit[] = [];
    report = new Map<string, Record<string, unknown>>();
    onicecandidate?: (event: {
      candidate: { toJSON(): RTCIceCandidateInit } | null;
    }) => void;
    ondatachannel?: (event: { channel: Channel }) => void;
    onconnectionstatechange?: () => void;
    constructor() {
      peers.push(this);
    }
    createDataChannel() {
      if (options.failChannel) throw new Error("SCTP unavailable");
      return this.channel;
    }
    async createOffer() {
      return options.delayedOffer
        ? offer.promise
        : { type: "offer" as const, sdp: "offer" };
    }
    async createAnswer() {
      return { type: "answer" as const, sdp: "answer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.remoteDescription = description;
    }
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      this.addedCandidates.push(candidate);
    }
    async getStats() {
      return this.report;
    }
    close() {
      this.closed = true;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "RTCPeerConnection",
  );
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: Peer,
  });
  const rtc = createWebRTC(
    {},
    (message) => messages.push(message.args as RTCMessage),
    options.enabled ?? true,
  );
  t.onTestFinished(() => {
    rtc.close();
    if (descriptor)
      Object.defineProperty(globalThis, "RTCPeerConnection", descriptor);
    else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  });
  function handle(kind: string, value?: unknown, session = 1) {
    rtc.handle({ session, kind, value });
  }
  function start(initiator = true, session = 1) {
    handle("start", { initiator, peerNodeKey: `peer-${session}` }, session);
    return peers.at(-1)!;
  }
  async function negotiate() {
    handle(
      "signal",
      JSON.stringify({
        version: 2,
        description: { type: "answer", sdp: "answer" },
      }),
    );
    await tick();
  }
  function confirmProbe(pc: Peer) {
    const probe = pc.channel.sent.findLast(
      (v): v is Uint8Array<ArrayBuffer> =>
        v instanceof Uint8Array &&
        new DataView(v.buffer).getUint32(0) === RTC_PROBE,
    );
    assert(probe);
    pc.channel.receive(
      rtcFrame(RTC_ACK, new DataView(probe.buffer).getUint32(4)).buffer,
    );
  }
  async function activate(pc: Peer) {
    await negotiate();
    pc.channel.onopen?.();
    confirmProbe(pc);
    vi.advanceTimersByTime(250);
    confirmProbe(pc);
  }
  return {
    rtc,
    peers,
    messages,
    offer,
    handle,
    start,
    negotiate,
    confirmProbe,
    activate,
  };
}
