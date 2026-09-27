import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  RTC_ACK,
  RTC_DATA,
  RTC_PROBE,
  RTC_QUEUE_LIMIT,
  rtcFrame,
} from "../src/rtc-protocol.ts";
import { tick } from "./helpers.ts";

import { rtcFixture as fixture, Channel } from "./rtc-fixture.ts";

for (const action of ["remote", "disable", "close"] as const) {
  test(`a throwing observer cannot prevent ${action} from releasing RTC resources`, async (t) => {
    const f = fixture(t);
    const first = f.start();
    await f.activate(first);
    if (action !== "remote") f.start(true, 2);
    await tick();
    const failure = new Error("observer failed");
    f.rtc.onChange(() => { throw failure; });
    assert.throws(() => {
      if (action === "remote") f.handle("closed");
      else if (action === "disable") f.rtc.setEnabled(false);
      else f.rtc.close();
    }, (error) => error === failure);
    for (const pc of f.peers) {
      assert.equal(pc.closed, true);
      assert.equal(pc.channel.readyState, "closed");
    }
    assert.equal(f.messages.filter((m) => m.kind === "closed").length, f.peers.length);
    assert(f.messages.some((m) => m.session === 1 && m.kind === "ready" && m.value === false));
    assert(f.rtc.snapshot().every((path) => path.state === "derp"));
    const count = f.messages.length;
    vi.advanceTimersByTime(20_000);
    await tick();
    assert.equal(f.messages.length, count, "closed sessions leave no active heartbeat");
  });
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

for (const event of ["open", "probe"] as const) {
  test(`a failed ${event} response closes the path without an uncaught exception`, async (t) => {
    const f = fixture(t);
    const pc = f.start();
    await f.negotiate();
    pc.channel.failure = new Error("channel closed while sending");
    assert.doesNotThrow(() =>
      event === "open"
        ? pc.channel.onopen?.()
        : pc.channel.receive(rtcFrame(RTC_PROBE, 90).buffer),
    );
    assert.equal(pc.closed, true);
    assert.equal(f.rtc.snapshot()[0].state, "derp");
  });
}

for (const remote of ["host", "relay"]) {
  test(`${remote} candidate classification requires a live heartbeat and selected ICE pair`, async (t) => {
    const f = fixture(t);
    const pc = f.start();
    await f.activate(pc);
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
    // Step the clock so each poll observes advancing time; a single large
    // tick fires every interval at the end time and reads as a throttle gap.
    for (let n = 0; n < 4; n++) vi.advanceTimersByTime(1000);
    assert.equal(f.rtc.snapshot()[0].state, "derp");
    assert(
      f.messages.some(
        (message) => message.kind === "ready" && message.value === false,
      ),
    );
    // A stale receipt cannot restore a cooled-down path.
    pc.channel.receive("pong");
    assert.equal(f.rtc.snapshot()[0].state, "derp");
    // Cross the 5 s cooldown without leaving probes unacked long enough to
    // trip probe-timeout and push the cooldown further out.
    for (let n = 0; n < 5; n++) vi.advanceTimersByTime(1000);
    f.confirmProbe(pc);
    vi.advanceTimersByTime(250);
    f.confirmProbe(pc);
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
  vi.advanceTimersByTime(16_000);
  assert.equal(pc.closed, true);
});

test("inbound packets are bounded until worker acknowledgments return capacity", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  for (let n = 0; n < 33; n++)
    pc.channel.receive(rtcFrame(RTC_DATA, n, 32768 + 8).buffer);
  assert.equal(
    f.messages.filter((message) => message.kind === "packet").length,
    32,
  );
  assert.equal(f.rtc.snapshot()[0].droppedPackets, 1);
  f.handle("received", { bytes: 32768, sequence: 0, accepted: true });
  pc.channel.receive(rtcFrame(RTC_DATA, 9, 32768 + 8).buffer);
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

test("closing a congested channel returns each queued worker credit exactly once", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.bufferedAmount = RTC_QUEUE_LIMIT;
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

test("SCTP size limits fall back and restore credit without sending a truncated datagram", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
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
    JSON.stringify({
      version: 2,
      description: { type: "offer", sdp: "remote" },
    }),
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

test("small heartbeats and small packet receipts cannot hide a large-packet blackhole", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  f.handle("packet", new Uint8Array(8192));
  for (let n = 0; n < 14; n++) {
    vi.advanceTimersByTime(250);
    f.confirmProbe(pc);
    f.handle("packet", new Uint8Array(80));
    const frame = pc.channel.sent.findLast(
      (v): v is Uint8Array<ArrayBuffer> =>
        v instanceof Uint8Array &&
        new DataView(v.buffer).getUint32(0) === RTC_DATA &&
        v.byteLength === 88,
    );
    if (frame)
      pc.channel.receive(
        rtcFrame(RTC_ACK, new DataView(frame.buffer).getUint32(4)).buffer,
      );
  }
  assert.equal(f.rtc.snapshot()[0].state, "derp");
  assert.equal(f.rtc.snapshot()[0].fallbackReason, "delivery-timeout");
});

test("duplicate and late probe receipts cannot qualify a path", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.negotiate();
  pc.channel.onopen?.();
  f.confirmProbe(pc);
  f.confirmProbe(pc);
  assert(!f.messages.some((m) => m.kind === "ready" && m.value === true));
  vi.advanceTimersByTime(250);
  pc.connectionState = "disconnected";
  pc.onconnectionstatechange?.();
  f.confirmProbe(pc);
  assert(!f.messages.some((m) => m.kind === "ready" && m.value === true));
});

test("data receipts wait for admission to Go and do not acknowledge rejected packets", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
  pc.channel.receive(rtcFrame(RTC_DATA, 100, 1008).buffer);
  vi.advanceTimersByTime(10);
  assert.equal(pc.channel.sent.length, 0);
  f.handle("received", { bytes: 1000, sequence: 100, accepted: false });
  vi.advanceTimersByTime(10);
  assert.equal(pc.channel.sent.length, 0);
  pc.channel.receive(rtcFrame(RTC_DATA, 101, 1008).buffer);
  f.handle("received", { bytes: 1000, sequence: 101, accepted: true });
  vi.advanceTimersByTime(10);
  assert.deepEqual(pc.channel.sent, [rtcFrame(RTC_ACK, 101)]);
});

test("legacy signaling retains DERP instead of interpreting raw ciphertext as version 2 frames", async (t) => {
  const f = fixture(t);
  const pc = f.start(false);
  f.handle(
    "signal",
    JSON.stringify({ description: { type: "offer", sdp: "legacy" } }),
  );
  await tick();
  assert.equal(pc.closed, true);
  assert.equal(f.rtc.snapshot()[0].state, "derp");
  assert.equal(f.rtc.snapshot()[0].fallbackReason, "incompatible");
});

test("sustained slow delivery falls back even while receipts keep arriving", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  await f.activate(pc);
  for (let n = 0; n < 6; n++) {
    f.handle("packet", new Uint8Array(8192));
    const packet = pc.channel.sent.findLast(
      (v): v is Uint8Array<ArrayBuffer> =>
        v instanceof Uint8Array &&
        new DataView(v.buffer).getUint32(0) === RTC_DATA,
    );
    assert(packet);
    vi.advanceTimersByTime(1600);
    f.confirmProbe(pc);
    pc.channel.receive(
      rtcFrame(RTC_ACK, new DataView(packet.buffer).getUint32(4)).buffer,
    );
  }
  assert.equal(f.rtc.snapshot()[0].state, "derp");
  assert.equal(f.rtc.snapshot()[0].fallbackReason, "delivery-delay");
});

test("qualification budgets WireGuard and framing overhead against the SCTP message limit", async (t) => {
  const f = fixture(t);
  const pc = f.start();
  pc.sctp.maxMessageSize = 8192;
  await f.negotiate();
  pc.channel.onopen?.();
  assert.equal(pc.closed, true);
  assert.equal(f.rtc.snapshot()[0].fallbackReason, "message-size");
  assert(!f.messages.some((m) => m.kind === "ready" && m.value === true));
});


for (const recovered of [false, true]) {
  test(`ICE disconnected ${recovered ? "can recover before its deadline" : "cannot retain a session indefinitely"}`, async (t) => {
    const f = fixture(t);
    const pc = f.start();
    await f.activate(pc);
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    vi.advanceTimersByTime(2000);
    assert.equal(pc.closed, false);
    if (recovered) {
      pc.connectionState = "connected";
      pc.onconnectionstatechange?.();
    }
    vi.advanceTimersByTime(1250);
    assert.equal(pc.closed, !recovered);
    if (!recovered) {
      assert.equal(f.rtc.snapshot()[0].fallbackReason, "disconnected-timeout");
      assert.equal(f.messages.filter((m) => m.kind === "closed").length, 1);
    }
  });
}
