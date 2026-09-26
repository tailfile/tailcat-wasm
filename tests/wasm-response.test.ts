import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { wasmResponse } from "../src/wasm-response.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const compressed = new Uint8Array(gzipSync(wasm));
function fragmented(bytes: Uint8Array<ArrayBuffer>) {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
  );
}

test("gzip-only WASM streams compile even when the signature spans chunks", async () => {
  const response = await wasmResponse(fragmented(compressed));
  assert.equal(response.headers.get("content-type"), "application/wasm");
  const { module } = await WebAssembly.instantiateStreaming(response);
  assert(module instanceof WebAssembly.Module);
});

test("HTTP-decoded WASM is not decompressed twice; headers do not determine body encoding", async () => {
  for (const bytes of [wasm, compressed]) {
    const response = fragmented(bytes);
    response.headers.set("Content-Encoding", "gzip");
    const { module } = await WebAssembly.instantiateStreaming(
      await wasmResponse(response),
    );
    assert(module instanceof WebAssembly.Module);
  }
});

test("HTTP failures, empty bodies, truncated headers and corrupt gzip fail cleanly", async () => {
  await assert.rejects(
    wasmResponse(new Response("missing", { status: 404 })),
    /HTTP 404/,
  );
  await assert.rejects(wasmResponse(new Response(null)), /no body/);
  await assert.rejects(wasmResponse(fragmented(wasm.slice(0, 3))), /Truncated/);
  await assert.rejects(
    wasmResponse(new Response("<!doctype html>")),
    /Invalid/,
  );
  const corrupt = compressed.slice();
  corrupt[corrupt.length - 8] ^= 1;
  await assert.rejects(
    WebAssembly.instantiateStreaming(await wasmResponse(fragmented(corrupt))),
  );
});

test("canceling the decoded response cancels the source stream", async () => {
  let canceled = false;
  const input = new Response(
    new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(compressed.slice(0, 4));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  const output = await wasmResponse(input);
  await output.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(canceled);
});

test("a browser without gzip decompression gets a readable error", async () => {
  const original = globalThis.DecompressionStream;
  Reflect.set(globalThis, "DecompressionStream", undefined);
  try {
    await assert.rejects(
      wasmResponse(fragmented(compressed)),
      /up-to-date browser/,
    );
  } finally {
    Reflect.set(globalThis, "DecompressionStream", original);
  }
});
