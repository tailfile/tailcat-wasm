import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { TailcatConnection } from "../src/client.ts";

// Exercise the protocol that the unbuilt HTML actually serves.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = /<script id="demo-protocol">([\s\S]*?)<\/script>/.exec(
  html,
)?.[1];
assert(source, "The demo must contain its inline protocol");
const {
  readFrames,
  writeFrame,
  TEST_BYTES,
  CHUNK_BYTES,
  sha256,
  testDigest,
  validateProgress,
  RateMeter,
} = runInNewContext(source + "\n demoProtocol;", {
  Uint8Array,
  DataView,
  crypto,
}) as {
  TEST_BYTES: number;
  CHUNK_BYTES: number;
  testDigest(total?: number): {
    update(bytes: Uint8Array): Promise<number>;
    finish(): Promise<string>;
  };
  validateProgress(
    test: { id: string; sent: number; confirmed: number } | undefined,
    receipt: { id: string; bytes: number },
  ): number;
  RateMeter: new (
    now: number,
    initialBytes?: number,
  ) => { sample(bytes: number, now: number): number };
  readFrames(
    connection: TailcatConnection,
  ): AsyncGenerator<{ kind: number; bytes: Uint8Array<ArrayBuffer> }>;
  writeFrame(
    connection: TailcatConnection,
    kind: number,
    bytes: Uint8Array,
  ): Promise<void>;
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
};

function stream(chunks: Uint8Array[] = []) {
  const written: Uint8Array[] = [];
  const connection: TailcatConnection = {
    peerNodeKey: "peer",
    async read() {
      return chunks.shift() ?? null;
    },
    async write(bytes) {
      written.push(bytes.slice());
    },
    async closeWrite() {},
    async close() {},
  };
  return { connection, written };
}

test("demo frames preserve binary data across fragmented and coalesced stream reads", async () => {
  const writer = stream();
  const text = new TextEncoder().encode("你好 · <script>text only</script>");
  const binary = new Uint8Array(CHUNK_BYTES).map((_, index) => index % 251);
  await writeFrame(writer.connection, 1, text);
  await writeFrame(writer.connection, 3, binary);
  const bytes = new Uint8Array(Buffer.concat(writer.written));
  // Split within the header, body and next frame; also deliver multiple frames
  // in one read. Neither case is guaranteed by TCP or the Worker boundary.
  for (const chunks of [
    [bytes],
    [bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9, 60), bytes.slice(60)],
  ]) {
    const received = [];
    for await (const frame of readFrames(stream(chunks).connection))
      received.push(frame);
    assert.equal(received.length, 2);
    assert.equal(received[0].kind, 1);
    assert.deepEqual(received[0].bytes, text);
    assert.equal(received[1].kind, 3);
    assert.equal(await sha256(received[1].bytes), await sha256(binary));
  }
});

test("demo rejects invalid/oversized frames before reading their payload", async () => {
  for (const [kind, size] of [
    [9, 0],
    [1, 16385],
    [2, 16385],
    [3, CHUNK_BYTES + 1],
    [4, 0xffffffff],
    [5, 16385],
    [6, 16385],
    [7, 1],
  ]) {
    const header = new Uint8Array(5);
    header[0] = kind;
    new DataView(header.buffer).setUint32(1, size);
    const reader = stream([header]);
    await assert.rejects(
      readFrames(reader.connection).next(),
      /Unknown|size limit/,
    );
  }
  const writer = stream();
  await assert.rejects(
    writeFrame(writer.connection, 3, new Uint8Array(CHUNK_BYTES + 1)),
    /size limit/,
  );
  assert.equal(writer.written.length, 0);
});

test("demo distinguishes orderly EOF from a truncated frame and propagates read failures", async () => {
  assert.equal((await readFrames(stream().connection).next()).done, true);
  for (const bytes of [
    new Uint8Array([1, 0]),
    new Uint8Array([1, 0, 0, 0, 2, 65]),
  ])
    await assert.rejects(
      readFrames(stream([bytes]).connection).next(),
      /ended inside/,
    );
  const reader = stream();
  reader.connection.read = async () => {
    throw new Error("connection canceled");
  };
  await assert.rejects(readFrames(reader.connection).next(), /canceled/);
});

test("the demo sends one decimal GB in bounded chunks and detects corrupted or reordered payload", async () => {
  assert.equal(TEST_BYTES, 1_000_000_000);
  assert.equal(CHUNK_BYTES, 256 * 1024);
  const first = new Uint8Array(CHUNK_BYTES).fill(17);
  const second = new Uint8Array(CHUNK_BYTES).fill(29);
  const original = testDigest(CHUNK_BYTES * 2);
  assert.equal(await original.update(first), CHUNK_BYTES);
  await original.update(second);
  const expected = await original.finish();
  for (const parts of [
    [second, first],
    [first, new Uint8Array(CHUNK_BYTES)],
  ]) {
    const changed = testDigest(CHUNK_BYTES * 2);
    for (const part of parts) await changed.update(part);
    assert.notEqual(await changed.finish(), expected);
  }
  const partial = testDigest(CHUNK_BYTES + 7);
  await partial.update(first);
  await assert.rejects(partial.finish(), /Incomplete/);
  await assert.rejects(partial.update(new Uint8Array(8)), /chunk size/);
  assert.equal(await partial.update(new Uint8Array(7)), CHUNK_BYTES + 7);
  assert.match(await partial.finish(), /^[0-9a-f]{64}$/);
  await assert.rejects(partial.update(new Uint8Array(1)), /chunk size/);
});

test("throughput follows confirmed bytes, rejects stale or impossible receipts, and decays while stalled", () => {
  const pending = { id: "test", sent: 20_000_000, confirmed: 0 };
  const meter = new RateMeter(0);
  assert.equal(
    meter.sample(pending.confirmed, 1000),
    0,
    "queued writes are not delivery",
  );
  pending.confirmed = validateProgress(pending, {
    id: "test",
    bytes: 2_000_000,
  });
  assert.equal(meter.sample(pending.confirmed, 2000), 1_000_000);
  for (const receipt of [
    { id: "previous-test", bytes: 3_000_000 },
    { id: "test", bytes: 1_000_000 },
    { id: "test", bytes: 20_000_001 },
    { id: "test", bytes: NaN },
    { id: "test", bytes: 2_000_000.5 },
  ])
    assert.throws(() => validateProgress(pending, receipt), /Invalid/);
  assert.throws(
    () => validateProgress(undefined, { id: "test", bytes: 0 }),
    /Invalid/,
  );
  meter.sample(pending.confirmed, 3000);
  assert.equal(meter.sample(pending.confirmed, 4000), 0);
});

test("transport rates exclude old session totals and reset when counters restart", () => {
  const meter = new RateMeter(1000, 50_000_000);
  assert.equal(meter.sample(51_000_000, 2000), 1_000_000);
  assert.equal(meter.sample(51_000_000, 2000), 1_000_000);
  assert.equal(meter.sample(100, 3000), 0);
  assert.equal(meter.sample(100_100, 4000), 100_000);
});
