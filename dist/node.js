import { Worker } from "node:worker_threads";
import { connectWorker, validateOptions, } from "./client.js";
/** The shared WASM hosted by a Node.js Worker; this entry uses DERP only. */
export async function createTailcat(options) {
    const mtu = validateOptions(options);
    const worker = new Worker(new URL("./node-worker.js", import.meta.url), {
        workerData: { assetsURL: options.assetsURL },
        // A caller's --input-type or test runner flags do not apply to this file.
        execArgv: [],
    });
    const port = {
        postMessage: (message, transfer) => worker.postMessage(message, transfer),
        terminate: () => {
            void worker.terminate();
        },
        onMessage: (handler) => {
            worker.on("message", handler);
        },
        onError: (handler) => {
            worker.on("error", handler);
            worker.on("exit", (code) => handler(new Error(`Transport worker exited (${code})`)));
        },
    };
    return connectWorker(port, options, mtu);
}
