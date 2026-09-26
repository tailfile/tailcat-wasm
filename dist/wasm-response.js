/** Decode the packaged gzip asset without requiring HTTP compression settings. */
export async function wasmResponse(response) {
    if (!response.ok)
        throw new Error(`Transport asset HTTP ${response.status}`);
    if (!response.body)
        throw new Error("Transport asset has no body");
    // Some hosts set Content-Encoding themselves, so Fetch may already have
    // decoded the body. Inspect bytes to avoid decompressing it a second time.
    const [probe, body] = response.body.tee();
    const reader = probe.getReader();
    const signature = new Uint8Array(4);
    let length = 0;
    try {
        while (length < signature.length) {
            const { value, done } = await reader.read();
            if (done)
                throw new Error("Truncated transport asset");
            const prefix = value.subarray(0, signature.length - length);
            signature.set(prefix, length);
            length += prefix.length;
        }
        const gzip = signature[0] === 0x1f && signature[1] === 0x8b;
        const wasm = signature.every((byte, index) => byte === [0, 97, 115, 109][index]);
        if (!gzip && !wasm)
            throw new Error("Invalid transport asset");
        if (gzip && typeof DecompressionStream !== "function")
            throw new Error("This browser cannot load the transport. Use an up-to-date browser.");
        return new Response(gzip ? body.pipeThrough(new DecompressionStream("gzip")) : body, { headers: { "Content-Type": "application/wasm" } });
    }
    catch (error) {
        void body.cancel().catch(() => { });
        throw error;
    }
    finally {
        // A tee branch's cancellation waits for the other branch; do not await it
        // before instantiateStreaming has had a chance to consume that branch.
        void reader.cancel().catch(() => { });
    }
}
