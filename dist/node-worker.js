import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { startWorker } from "./worker-runtime.js";
// Give Go the Web APIs used in browsers. Keeping process outside this context
// preserves Go's Fetch transport without changing Go, Tailcat or Node globals.
const context = createContext({
    console,
    crypto,
    performance,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    Headers,
    Request,
    Response,
    WebSocket,
    AbortController,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    WebAssembly,
    postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
});
runInContext(await readFile(new URL("./wasm_exec.js", import.meta.url), "utf8"), context);
const scope = context;
startWorker(scope, async () => {
    const url = new URL("./tailcat.wasm.gz", workerData.assetsURL ?? import.meta.url);
    return url.protocol === "file:"
        ? new Response(new Uint8Array(await readFile(url)))
        : fetch(url);
});
parentPort.on("message", (data) => scope.onmessage({ data }));
