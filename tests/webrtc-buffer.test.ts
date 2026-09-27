import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { rtcFixture } from "./rtc-fixture.ts";
import { RTC_DATA, RTC_QUEUE_LIMIT } from "../src/rtc-protocol.ts";

test("brief SCTP congestion retains packets and credits until drain", async (t) => {
  const f = rtcFixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
  pc.channel.bufferedAmount = RTC_QUEUE_LIMIT;
  const packets = [
    new Uint8Array(32768).fill(1),
    new Uint8Array(32768).fill(2),
  ];
  for (const packet of packets) f.handle("packet", packet);
  assert.equal(pc.channel.sent.length, 0);
  assert.equal(f.messages.filter((m) => m.kind === "credit").length, 0);
  assert.equal((await f.rtc.stats())[0].bufferedBytes, RTC_QUEUE_LIMIT + 65536);
  pc.channel.bufferedAmount = 0;
  pc.channel.onbufferedamountlow?.();
  const frames = pc.channel.sent as Uint8Array[];
  assert(frames.every((b) => new DataView(b.buffer).getUint32(0) === RTC_DATA));
  assert.deepEqual(
    frames.map((b) => b.slice(8)),
    packets,
  );
  assert.equal(f.messages.filter((m) => m.kind === "credit").length, 2);
  assert.equal(f.rtc.snapshot()[0].droppedPackets, 0);
});

test("reserved RTC headroom survives queueing and frames ciphertext in its owned buffer", async (t) => {
  const f = rtcFixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
  pc.channel.bufferedAmount = RTC_QUEUE_LIMIT;
  const buffer = new ArrayBuffer(8 + 1024);
  const packet = new Uint8Array(buffer, 8).fill(37);
  f.handle("packet", packet);
  assert.equal(pc.channel.sent.length, 0);
  pc.channel.bufferedAmount = 0;
  pc.channel.onbufferedamountlow?.();
  const frame = pc.channel.sent[0] as Uint8Array;
  assert.equal(frame.buffer, buffer);
  assert.equal(new DataView(buffer).getUint32(0), RTC_DATA);
  assert.deepEqual(frame.subarray(8), new Uint8Array(1024).fill(37));
  assert.equal(
    f.messages.filter((m) => m.kind === "credit").at(-1)?.value,
    1024,
  );
});

test("a stalled queue falls back, releases credits, and never flushes stale packets", async (t) => {
  const f = rtcFixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
  pc.channel.bufferedAmount = RTC_QUEUE_LIMIT;
  f.handle("packet", new Uint8Array(32768));
  vi.advanceTimersByTime(2400);
  assert.equal(f.rtc.snapshot()[0].state, "derp");
  assert.equal(f.rtc.snapshot()[0].fallbackReason, "congestion");
  assert.equal(f.messages.filter((m) => m.kind === "credit").length, 1);
  pc.channel.bufferedAmount = 0;
  pc.channel.onbufferedamountlow?.();
  assert(
    !pc.channel.sent.some(
      (v) =>
        v instanceof Uint8Array &&
        new DataView(v.buffer).getUint32(0) === RTC_DATA,
    ),
  );
});

test("probe replies cannot grow a full SCTP buffer", async (t) => {
  const f = rtcFixture(t);
  const pc = f.start();
  await f.activate(pc);
  pc.channel.sent = [];
  pc.channel.bufferedAmount = RTC_QUEUE_LIMIT;
  const { RTC_PROBE, rtcFrame } = await import("../src/rtc-protocol.ts");
  for (let n = 0; n < 100; n++)
    pc.channel.receive(rtcFrame(RTC_PROBE, n).buffer);
  assert.equal(pc.channel.sent.length, 0);
  assert.equal(pc.closed, false);
});
