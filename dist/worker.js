import "./wasm_exec.js";
import { startWorker } from "./worker-runtime.js";
startWorker(globalThis, () => fetch(new URL("./tailcat.wasm.gz", import.meta.url)));
