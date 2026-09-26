import test from "node:test";
import assert from "node:assert/strict";
import { createWebRTC } from "../src/webrtc.ts";

test("SCTP congestion retains already admitted packets and worker credits until drain", async (t) => {
  const binary: Uint8Array[] = [];
  const messages: any[] = [];
  const channel: any = {
    label: "wireguard",
    ordered: false,
    maxRetransmits: 0,
    readyState: "open",
    bufferedAmount: 1024 * 1024,
    send(value: unknown) {
      if (value instanceof Uint8Array) binary.push(value);
    },
    close() {
      this.readyState = "closed";
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "RTCPeerConnection",
  );
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: class {
      sctp = { maxMessageSize: 65536 };
      createDataChannel() {
        return channel;
      }
      async createOffer() {
        return {};
      }
      async setLocalDescription() {}
      async getStats() {
        return new Map();
      }
      close() {}
    },
  });
  const rtc = createWebRTC({}, (message) => messages.push(message));
  t.after(() => {
    rtc.close();
    if (descriptor)
      Object.defineProperty(globalThis, "RTCPeerConnection", descriptor);
    else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  });
  rtc.handle({
    session: 1,
    kind: "start",
    value: { initiator: true, peerNodeKey: "peer" },
  });
  channel.onmessage({ data: "pong" });
  const packets = [
    new Uint8Array(32768).fill(1),
    new Uint8Array(32768).fill(2),
  ];
  for (const packet of packets)
    rtc.handle({ session: 1, kind: "packet", value: packet });
  assert.equal(binary.length, 0);
  assert.equal(
    messages.filter((message) => message.args.kind === "credit").length,
    0,
  );
  assert.equal((await rtc.stats())[0].bufferedBytes, 1024 * 1024 + 65536);
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  assert.deepEqual(binary, packets);
  assert.equal(
    messages.filter((message) => message.args.kind === "credit").length,
    2,
  );
  assert.equal((await rtc.stats())[0].droppedPackets, 0);
});
