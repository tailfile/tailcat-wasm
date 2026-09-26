import "./wasm_exec.js";
import { startWorker, type RuntimeScope } from "./worker-runtime.js";

startWorker(globalThis as unknown as RuntimeScope, () =>
  fetch(new URL("./tailcat.wasm.gz", import.meta.url)),
);
