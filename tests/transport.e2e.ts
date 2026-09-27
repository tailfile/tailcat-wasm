import { test } from "vitest";
import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture.ts";

test("transport fallback, recovery, MTU and loss", async () => {
  const fixture = await browserFixture();
  const { browser, base } = fixture;
  async function pair(mtu = 8192, loss?: number, remoteMTU = mtu) {
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
    ]);
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const addresses = [];
    for (const [i, page] of pages.entries()) {
      await page.goto(base + "/transport-test.html");
      addresses.push(
        await page.evaluate(
          async ({ base, mtu }) => {
            const w = window as any;
            // Keep browser imports native when Vitest transforms the host module.
            const { createTailcat } = await new Function(
              "url",
              "return import(url)",
            )(base + "/dist/index.js");
            w.received = 0;
            w.corrupt = 0;
            w.peers = [];
            w.states = [];
            w.channels = [];
            w.maxData = 0;
            w.connections = 0;
            const send = RTCDataChannel.prototype.send;
            RTCDataChannel.prototype.send = function (data: any) {
              if (!w.channels.includes(this)) w.channels.push(this);
              if (ArrayBuffer.isView(data) && data.byteLength >= 8) {
                const kind = new DataView(
                  data.buffer,
                  data.byteOffset,
                ).getUint32(0);
                if (kind === 0x54434432)
                  w.maxData = Math.max(w.maxData, data.byteLength);
                if (w.blackhole && data.byteLength > 1400) return;
              }
              return send.call(this, data);
            };
            w.accept = (connection: any) => {
              w.conn = connection;
              w.connections++;
              w.readTask = (async () => {
                for (;;) {
                  const bytes = await connection.read();
                  if (!bytes) return;
                  for (const byte of bytes) if (byte !== 37) w.corrupt++;
                  w.received += bytes.byteLength;
                }
              })().catch((e: unknown) => (w.readError = String(e)));
            };
            w.runtime = await createTailcat({
              tunnelMTU: mtu,
              webRTC: { iceServers: [] },
              onConnection: w.accept,
              onTransportChange(peers: any[]) {
                w.peers = peers;
                const state = peers.map((p) => p.state).join(",");
                if (state !== w.states.at(-1)?.state)
                  w.states.push({
                    state,
                    at: performance.now(),
                    reason: peers[0]?.fallbackReason,
                  });
              },
              onError() {},
            });
            return w.runtime.listen(base + "/derpmap-test.json");
          },
          { base, mtu: i ? remoteMTU : mtu },
        ),
      );
    }
    const [a, b] = pages;
    if (loss !== undefined) {
      const cdp = await contexts[0].newCDPSession(a);
      await cdp.send("Network.enable");
      // Install before ICE creates its sockets. Applying emulation to existing
      // sockets is ineffective on some Chromium versions.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 50,
        uploadThroughput: 1250000,
        downloadThroughput: 1250000,
        packetLoss: loss,
        packetReordering: false,
      });
    }
    await a.evaluate(
      async ({ base, address }) => {
        const w = window as any;
        w.accept(await w.runtime.dial(address, base + "/derpmap-test.json"));
      },
      { base, address: addresses[1] },
    );
    const direct = async () => {
      for (const page of pages)
        await page.waitForFunction(
          () => (window as any).peers[0]?.state === "direct",
          null,
          { timeout: 45_000 },
        );
    };
    await direct();
    const transfer = async (bytes: number) => {
      const before = await b.evaluate(() => (window as any).received);
      const started = Date.now();
      await Promise.all([
        a.evaluate(async (bytes) => {
          const w = window as any;
          const chunk = new Uint8Array(65536).fill(37);
          for (let n = 0; n < bytes; n += chunk.length)
            await w.conn.write(
              chunk.subarray(0, Math.min(chunk.length, bytes - n)),
            );
        }, bytes),
        b.waitForFunction(
          (target) => (window as any).received === target,
          before + bytes,
          { timeout: 30_000 },
        ),
      ]);
      assert.equal(await b.evaluate(() => (window as any).corrupt), 0);
      return Date.now() - started;
    };
    const stats = async () =>
      Promise.all(
        pages.map((p) =>
          p.evaluate(() => {
            const w = window as any;
            return {
              received: w.received,
              peers: w.peers,
              states: w.states,
              connections: w.connections,
              maxData: w.maxData,
            };
          }),
        ),
      );
    return {
      a,
      b,
      pages,
      direct,
      transfer,
      stats,
      close: async () => {
        await Promise.all(contexts.map((c) => c.close()));
      },
    };
  }
  try {
    {
      const f = await pair();
      try {
        await f.a.evaluate(() => {
          (window as any).blackhole = true;
        });
        await f.transfer(1024 * 1024);
        let [sender] = await f.stats();
        assert(
          sender.states.some(
            (s: any) => s.state === "derp" && s.reason === "delivery-timeout",
          ),
        );
        assert.equal(sender.peers[0].state, "derp");
        await f.a.evaluate(() => {
          (window as any).blackhole = false;
        });
        await f.direct();
        await f.transfer(256 * 1024);
        const old = await f.a.evaluate(() => (window as any).peers[0].session);
        await f.a.evaluate(() => {
          for (const c of (window as any).channels) c.close();
        });
        await f.a.waitForFunction(
          (old) =>
            (window as any).peers[0]?.session > old &&
            (window as any).peers[0]?.state === "direct",
          old,
          { timeout: 45_000 },
        );
        await f.direct();
        await f.transfer(256 * 1024);
        for (const peer of await f.stats()) assert.equal(peer.connections, 1);
        await f.a.evaluate(() =>
          (window as any).runtime.setWebRTCEnabled(false),
        );
        await f.transfer(256 * 1024);
        await f.a.evaluate(() =>
          (window as any).runtime.setWebRTCEnabled(true),
        );
        await f.direct();
        await f.transfer(256 * 1024);
        console.log(
          "PASS: large-packet blackhole automatically falls back; recovery, channel failure and disable/re-enable preserve the same application stream",
        );
      } finally {
        await f.close();
      }
    }
    {
      const f = await pair(32768, undefined, 1280);
      try {
        await f.transfer(1024 * 1024);
        assert((await f.stats())[0].maxData <= 1280 + 32 + 8);
        console.log(
          "PASS: mixed 32768/1280 tunnel MTUs negotiate a compatible TCP MSS",
        );
      } finally {
        await f.close();
      }
    }
    for (const loss of [0, 1, 3]) {
      const f = await pair(8192, loss);
      try {
        const ms = await f.transfer(2 * 1024 * 1024);
        const paths = (await f.stats()).map((peer) => peer.peers);
        console.log(
          `PASS: 2 MiB verified at 10 Mbps / 50 ms / ${loss}% loss in ${ms} ms`,
          JSON.stringify(paths),
        );
      } finally {
        await f.close();
      }
    }
  } finally {
    await fixture.close();
  }
}, 900000);
