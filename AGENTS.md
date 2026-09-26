# Architecture

Tailcat WASM is a standalone browser and Node.js SDK for encrypted byte streams.

- `src/index.ts` and `src/node.ts` select the browser Worker or Node worker_threads host; `src/client.ts` owns RPC and connection lifetimes.
- `src/worker-runtime.ts` runs the Go bridge in `wasm/`. Browser WebRTC carries encrypted packets with DERP fallback; Node uses DERP.
- `wasm/go.mod`, `wasm/go.sum` and `patches/` pin the upstream fork baselines. Normal builds use committed `dist/`; Go or patch changes require a WASM rebuild and matching artifacts.
- `index.html` is the unbuilt static demo. Serve it with `dist/` using any static server.
- `tests/` owns unit and browser tests. Run `npm ci`, `npm run check`, `npm test` and `npm run build`. The real 1 GB browser tests also require Chromium and `DERPER_BIN` pointing to a local derper binary.
