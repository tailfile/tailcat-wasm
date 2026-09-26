import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createWebRTC } from "../src/webrtc.ts";
import { deferred, tick } from "./helpers.ts";

class Channel {
  label = "wireguard";
  ordered = false;
  maxRetransmits = 0;
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
function fixture(
  t: TestContext,
  options: {
    failChannel?: boolean;
    delayedOffer?: boolean;
    enabled?: boolean;
  } = {},
) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
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
  t.after(() => {
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
  return { rtc, peers, messages, offer, handle, start };
}

test("partial WebRTC startup failure closes the peer instead of leaking a heartbeat and slot", (t) => {
  const f = fixture(t, { failChannel: true });
  const pc = f.start();
  assert.equal(pc.closed, true);
  assert.equal(f.rtc.snapshot()[0]?.state, "derp");
  assert.equal(
    f.messages.filter((message) => message.kind === "closed").length,
    1,
  );
});

test("closing during offer creation suppresses late SDP and ICE callbacks", async (t) => {
  const f = fixture(t, { delayedOffer: true });
  const pc = f.start();
  f.handle("closed");
  f.offer.resolve({ type: "offer", sdp: "late offer" });
  pc.onicecandidate?.({
    candidate: { toJSON: () => ({ candidate: "late ICE" }) },
  });
  await tick();
  assert.equal(
    f.messages.filter((message) => message.kind === "signal").length,
    0,
  );
  const late = new Channel();
  pc.ondatachannel?.({ channel: late });
  assert.equal(late.readyState, "closed");
});

test("duplicate start cannot replace a live session and orphan its peer", async (t) => {
  const f = fixture(t);
  const first = f.start();
  f.start();
  assert.equal(f.peers.length, 1);
  f.rtc.close();
  assert.equal(first.closed, true);
  await tick();
});

for (const event of ["open", "ping"] as const) {
  test(`a failed ${event} response closes the path and falls back without an uncaught exception`, (t) => {
    const f = fixture(t);
    const pc = f.start();
    pc.channel.failure = new Error("channel closed while sending");
    assert.doesNotThrow(() =>
      event === "open" ? pc.channel.onopen?.() : pc.channel.receive("ping"),
    );
    assert.equal(pc.closed, true);
    assert.equal(f.rtc.snapshot()[0].state, "derp");
  });
}

for (const remote of ["host", "relay"]) {
  test(`${remote} candidate classification requires a live heartbeat and selected ICE pair`, async (t) => {
    const f = fixture(t);
    const pc = f.start();
    pc.channel.receive("pong");
    assert.equal(f.rtc.snapshot()[0].state, "connecting");
    pc.report = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      [
        "pair",
        {
          type: "candidate-pair",
          localCandidateId: "local",
          remoteCandidateId: "remote",
          currentRoundTripTime: 0.012,
        },
      ],
      ["local", { candidateType: "host", protocol: "udp" }],
      ["remote", { candidateType: remote }],
    ]);
    const [stats] = await f.rtc.stats();
    assert.equal(stats.state, remote === "relay" ? "webrtc-relay" : "direct");
    assert.equal(stats.rttMS, 12);
    t.mock.timers.tick(4000);
    assert.equal(f.rtc.snapshot()[0].state, "derp");
    assert(
      f.messages.some(
        (message) => message.kind === "ready" && message.value === false,
      ),
    );
    pc.channel.receive("pong");
    assert.equal(
      f.rtc.snapshot()[0].state,
      remote === "relay" ? "webrtc-relay" : "direct",
    );
  });
}

test("a channel that never opens times out and disabled WebRTC allocates no peers", (t) => {
  const f = fixture(t, { enabled: false });
  f.start();
  assert.equal(f.peers.length, 0);
  f.rtc.setEnabled(true);
  const pc = f.start(false, 2);
  t.mock.timers.tick(16_000);
  assert.equal(pc.closed, true);
});

test("inbound packets are bounded until worker acknowledgments return capacity", (t) => {
  const f = fixture(t);
  const pc = f.start();
  for (let n = 0; n < 33; n++) pc.channel.receive(new ArrayBuffer(32768));
  assert.equal(
    f.messages.filter((message) => message.kind === "packet").length,
    32,
  );
  assert.equal(f.rtc.snapshot()[0].droppedPackets, 1);
  f.handle("received", 32768);
  pc.channel.receive(new ArrayBuffer(32768));
  assert.equal(
    f.messages.filter((message) => message.kind === "packet").length,
    33,
  );
  pc.channel.receive(new ArrayBuffer(65536));
  pc.channel.receive("unrecognized");
  assert.equal(
    f.messages.filter((message) => message.kind === "packet").length,
    33,
  );
});

test("closing a congested channel returns each queued worker credit exactly once", (t) => {
  const f = fixture(t);
  const pc = f.start();
  pc.channel.bufferedAmount = 1024 * 1024;
  f.handle("packet", new Uint8Array(32768));
  f.handle("packet", new Uint8Array(16384));
  f.rtc.setEnabled(false);
  f.handle("closed");
  assert.deepEqual(
    f.messages
      .filter((message) => message.kind === "credit")
      .map((message) => message.value),
    [32768, 16384],
  );
  assert.equal(f.rtc.snapshot()[0].droppedPackets, 2);
  assert.equal(pc.closed, true);
});

test("SCTP size limits fall back and restore credit without sending a truncated datagram", (t) => {
  const f = fixture(t);
  const pc = f.start();
  pc.sctp.maxMessageSize = 16384;
  f.handle("packet", new Uint8Array(32768));
  assert.equal(pc.closed, true);
  assert(!pc.channel.sent.some((value) => value instanceof Uint8Array));
  assert.equal(
    f.messages.filter((message) => message.kind === "credit").length,
    1,
  );
});

test("ICE arriving before SDP is applied in order after remote description", async (t) => {
  const f = fixture(t);
  const pc = f.start(false);
  f.handle("signal", JSON.stringify({ candidate: { candidate: "first" } }));
  f.handle("signal", JSON.stringify({ candidate: { candidate: "second" } }));
  await tick();
  assert.deepEqual(pc.addedCandidates, []);
  f.handle(
    "signal",
    JSON.stringify({ description: { type: "offer", sdp: "remote" } }),
  );
  await tick();
  assert.deepEqual(pc.addedCandidates, [
    { candidate: "first" },
    { candidate: "second" },
  ]);
  assert.equal(
    f.messages.filter((message) => message.kind === "signal").length,
    1,
  );
});

test("malformed or flooding signaling closes only its own session", async (t) => {
  const f = fixture(t);
  const first = f.start(false);
  const second = f.start(false, 2);
  f.handle("signal", "invalid json");
  await tick();
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  for (let n = 0; n < 65; n++)
    f.handle(
      "signal",
      JSON.stringify({ candidate: { candidate: String(n) } }),
      2,
    );
  assert.equal(second.closed, true);
});

test("session and history bounds hold and stats snapshots cannot mutate internal state", async (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 33; n++) f.start(false, n);
  assert.equal(f.peers.length, 32);
  assert(
    f.messages.some(
      (message) => message.session === 33 && message.kind === "closed",
    ),
  );
  f.rtc.setEnabled(false);
  assert(f.peers.every((pc) => pc.closed));
  f.rtc.setEnabled(true);
  f.start(false, 34);
  f.handle("closed", undefined, 34);
  const stats = await f.rtc.stats();
  assert.equal(stats.length, 32);
  stats[0].txBytes = 999;
  assert.equal(f.rtc.snapshot()[0].txBytes, 0);
});
