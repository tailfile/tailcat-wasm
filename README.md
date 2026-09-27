# Tailcat WASM

> **⚠️ Alpha demo — not for production.** This SDK is an experimental prototype. The browser WebRTC packet transport is new, cross-network and cross-browser validation is outstanding, and no part of this project has had a security review. Use it for demos, experiments and benchmarks only; do not carry real workloads or sensitive data with it.

## Highlights

- **Encrypted byte streams with zero native binaries.** The complete Tailcat stack — WireGuard tunnel, virtual TCP, DERP relay client — compiles to Go WASM and runs inside a browser Worker or a Node `worker_threads`. Consumers install one npm package: no Go toolchain, no install hooks, no runtime npm dependencies.
- **Browser WebRTC with automatic DERP fallback.** Streams upgrade to a peer-to-peer WebRTC DataChannel with receipt-based path qualification; large-packet blackhole detection, fallback to the DERP relay and re-qualification happen on the same application stream. A regression suite covers weak networks (10 Mbps / 50 ms, 0/1/3% loss), fallback, channel recovery and mixed-MTU negotiation.
- **An optimized Go↔JS packet path.** DataChannel payloads use one JS-to-Go memory copy with a recycled buffer pool and batched receipts, and the forked x/crypto carries a wasm32-native Poly1305 (poly1305-donna-32) in place of the emulated 128-bit multiplies. Run `test:crypto` for upstream correctness tests and `bench:crypto` / `bench:transport` for local measurements; this custom implementation has not had an independent security review.
- **Commit-level reproducible builds.** Tailcat, Tailscale and x/crypto are pinned to exact Go versions and full commits in `wasm/forks.json`; fork preparation re-downloads each module, verifies its origin commit and both module and `go.mod` checksums against the committed `wasm/go.sum`, and applies this project's patches. The build manifest fingerprints sources, patches and compiler flags.
- **Benchmarked against native controls.** The local harness measures the SDK against raw WebRTC, the native Tailcat CLI (DERP/UDP/WebSocket) and Node-hosted WASM, with browser-thread CPU counters. Local ablations point to WASM execution and Go↔JS bridging as major costs; they do not isolate encryption from the network stack and scheduling.

Tailcat byte streams for browsers and Node.js 24+, using the same Go WASM. Conditional exports choose a browser Worker or a Node `worker_threads` host. Browsers attempt an experimental WebRTC upgrade with DERP fallback; Node uses DERP only. Small committed Tailcat/Tailscale patches add an optional encrypted packet path. WireGuard and address formats are unchanged.

The tarball contains compiled JavaScript, declarations, Worker entries, gzip WASM, the matching Go runtime, build manifest and upstream notices. It has no runtime npm dependencies and needs no Go installation in consumers. The small local `wasm/main_js.go` imports pinned upstream modules and bridges native keys, authenticated peer metadata and stream operations.

Install development dependencies with `npm ci`; the demo can be served directly without installing anything.

## Browser demo

The standalone demo is `index.html`: styles and demo logic are inline, and its only module import is `./dist/index.js`. Opening the page starts a listener and prepares a temporary address automatically; paste the other browser's address to connect. One stream carries messages, a sender-verified 1 GiB test and transport counters in both directions. Keys stay in the tab.

Serve the checked-in files directly — no install or build is required:

```sh
python3 -m http.server 5174 --bind 127.0.0.1  # http://localhost:5174
```

Publish `index.html`, `dist/` and `.nojekyll` together on GitHub Pages or any HTTPS static host; all asset paths are relative. Stop the listener and expand **Relay settings** to switch between the Tailcat default map, the Tailscale relay map (`controlplane.tailscale.com`, also CORS-enabled) and a custom CORS-enabled map URL; the `?map=` query parameter preselects the custom entry. The default configuration uses STUN without TURN and falls back to DERP when direct connectivity is unavailable.

## Validation

```sh
npm run check
npm test
npm run test:coverage
# Requires the Go toolchain pinned in wasm/go.mod (or GO=/path/to/go):
npm run test:crypto
TEST_RACE=1 npm run test:patches # native race detector plus js/wasm regressions
# Prepare Chromium and the pinned native derper/tailcat binaries:
npm run bench:setup
# Real browser/native benchmarks and transport regressions:
npm run bench:transport
npm run test:demo
npm run test:transport
```

Run `npm ci` first. `bench:setup` requires Git and Go 1.21+ on PATH (or `GO=/path/to/go`); Go's toolchain selection downloads the exact Go version pinned in `wasm/go.mod` when needed. The script verifies the pinned upstream modules, applies this project's committed patches, builds native `derper` and `tailcat`, and installs Playwright Chromium. Binaries and their build/hash manifest live in `.cache/bench/<platform>-<arch>/`, which tests discover automatically. Subsequent setup runs verify and reuse the cached binaries. `DERPER_BIN` and `TAILCAT_BIN` can still select existing executables. This prepares test tools; using the SDK's committed WASM does not require Go.

CI runs SDK checks, WASM crypto tests and packet-path race/bridge tests. The crypto test adapter uses a temporary Go overlay to retain the upstream generic reference alongside Donna and translate test-only accumulator state; it does not alter production code. Passing vectors is not a security audit.

All TypeScript test and benchmark entry points live in `tests/` and run through Vitest. `npm test` runs the unit suite; `npm run test:all` also runs Go/WASM and browser integration tests and requires Go, Chromium and the local DERP fixture. Go test bodies remain in their Go packages and are invoked by Vitest.

Unit tests control the Worker/Go/WebRTC boundaries to cover races, failure paths, ownership and buffering; coverage reports refer to the exercised TypeScript modules, not Go. The demo E2E serves the unchanged HTML from a project subdirectory using a plain static server. It checks automatic addresses, messages, cancellation and reconnecting, then verifies two real 1 GB transfers: one switching from WebRTC to DERP on the same stream, and one entirely over WebRTC after stopping DERP. It checks exact payload counts, completion receipts, elapsed-time averages and transport counters. The transport E2E also checks automatic large-packet blackhole fallback, recovery on the same stream, channel replacement, disable/re-enable, mixed 32768/1280 MTUs, and 0/1/3% WebRTC loss with 10 Mbps and 50 ms Chromium network emulation. These are local browser tests, not WAN throughput measurements. The local fixture's self-signed certificate is accepted by the test browser flag and the fixture map's `InsecureForTests` setting for native clients.

## API

```ts
import { createTailcat } from "@tailfile/tailcat-wasm";

// Download the map during your build and publish it as a static asset.
const mapURL = new URL("/derpmaps/tailcat.json", location.href).href;
const runtime = await createTailcat({
  onConnection(connection) {
    // connection.peerNodeKey is authenticated by Tailcat; port identifies the service.
    // read()/write() stream bytes; closeWrite() half-closes, close() tears down.
  },
  onError(error) {
    console.error(error.message);
  },
});
const address = await runtime.listen(mapURL);
console.info(await runtime.describeAddress(address)); // Upstream JSON; PresharedKey is redacted
const connection = await runtime.dial(otherAddress, mapURL, { port: 80 });
await connection.write(new TextEncoder().encode("hello"));
await connection.closeWrite();
// Consume the reply before closing. The receiving listener stays online.
await connection.close();
// Close runtime on page teardown.
```

The inner tunnel default is `tunnelMTU: 8192` (configurable from 1280 to 32768). This sets upstream's existing `TS_DEBUG_MTU` before Go starts. The default reduces large-message fragmentation compared with 32768 while retaining fewer WASM crossings than the original 1280 baseline. Larger values remain an explicit throughput tradeoff for clean paths. WebRTC adds an 8-byte receipt header to each encrypted WireGuard packet and checks the negotiated SCTP message limit, including up to 32 bytes of WireGuard overhead. SCTP still fragments these messages to the outer path MTU; its message-size limit is not a path MTU. TCP MSS negotiation supports peers with smaller tunnel MTUs. Use `tunnelMTU: 1280` for the original baseline. This setting is fixed for the runtime and is not a recommendation for native UDP paths.

Call `runtime.createIdentity()` to generate `{ nodeKey, sendNodeKey, privateKeyJSON }` locally, without a DERP map or connection. Persist the returned JSON and pass it to `listenWithIdentity` when ready to connect. Unbound identities use region `-1`; the first listener pins its selected region. This works in both browser and Node workers.

Call `listen` or `listenWithIdentity` once per runtime. `listen(mapURL)` preserves the original API and creates an ephemeral listener. For explicit persistence, use `listenWithIdentity(mapURL, { privateKeyJSON, regionID })`, which returns `{ address, nodeKey, sendNodeKey, privateKeyJSON }`. Omit `privateKeyJSON` on first use, then persist the returned secret JSON and pass it on later starts. Optional `regionID` selects the relay region on first use or moves a stored identity to that region while keeping its keys. Do not publish or log the private JSON.

Each runtime owns two native node keys: a receiving Server key and a sending Client key. `privateKeyJSON` contains symmetric `serverKey` and `clientKey` objects, both complete upstream `tailcat.PrivateKey` values with `Private` and `Public` fields. Both are independently generated locally by `tailcat.NewPrivateKey()`; key generation needs no network access. Only the receiving record supplies a listening address. The client keeps the same shape with an unused DERP region (`-1`), and dialing uses `clientKey.Private`. Persist the complete record. Older serialized formats require an explicit identity reset and renewed pairing; no migration is performed.

Receiving remains available while dialing and sending. Outgoing operations queue until the previous connection closes, because independent Clients cannot safely share the sending key concurrently. Up to 64 dials may wait; additional requests reject. Canceling a queued dial removes it immediately without waiting for the active stream to close. Close every outgoing connection after use.

These keys identify the listener and initiator roles, not one-way data channels. Every established stream supports simultaneous reads and writes. The two-key design keeps the independent Server and Client online together; it does not provide concurrent outgoing Clients to every peer or let multiple tabs own the same identity.

Await each `read()` before starting the next read on that stream; overlapping reads reject because the Go bridge shares one receive buffer per connection. Reads and writes may run simultaneously. `write()` copies the supplied view, including Node `Buffer` views, and preserves caller memory. Writes are serialized in call order; `closeWrite()` waits for preceding writes and rejects subsequent writes. Each connection permits at most 4 MiB and 64 pending writes. Larger writes or excess queued writes reject before copying; use bounded chunks (for example 64 KiB) and await each write for backpressure. A failed write rejects the remaining write queue. `close()` interrupts active I/O and discards queued writes. `close()` is idempotent and can interrupt a pending read. Application ports must be integers from 1 to 65535, excluding reserved signaling port 65534.

Only one runtime may own a saved identity. Browser applications should hold a Web Lock across startup, storage and runtime lifetime. Node applications must enforce ownership themselves. `createTailcat({ signal, ... })` terminates the Worker on cancellation, including during startup. `dial(address, mapURL, { port, signal })` supports cancellation while queued or connecting.

## Node.js

The same import and API work in Node.js 24+. Use an absolute HTTP(S) map URL, call `listenWithIdentity`, and persist its secret JSON with an appropriate file permission or secret store. Pass it back on subsequent starts. `runtime.close()` stops the Worker and allows the process to exit.

The Node Worker loads the same gzip asset from disk and runs unmodified `wasm_exec.js` in a VM context supplied with Node's Fetch, WebSocket, crypto and timer APIs. The context excludes Node's `process`, preserving Go's browser Fetch path without modifying Go or the caller's globals. The VM is an environment adapter, not a security sandbox. `assetsURL` may override the gzip location with an absolute file/HTTP(S) directory URL; the Node Worker and Go runtime remain package-local.

## Browser assets

Vite resolves package-relative Worker/WASM assets automatically. For other bundlers, host the package `dist/` files together and pass `assetsURL: new URL('/sdk/', location.href).href`. Serve `.wasm.gz` as an ordinary static file (`application/gzip` or `application/octet-stream`). The Worker decompresses it and supplies `application/wasm` to the WebAssembly compiler. The default worker is a JavaScript module; serve JS with a JavaScript MIME type. No HTTP compression negotiation or URL rewriting is required. If a host already sends `Content-Encoding: gzip`, the Worker detects the decoded body and avoids double decompression. Include `dist/THIRD_PARTY_NOTICES.txt` in your application deployment.

`src/worker.ts` is compiled to `dist/worker.js` by the normal TypeScript build. Consumers import `createTailcat` from the package entry, which creates `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. During development Vite serves the compiled module; production Vite builds bundle it as a separate `worker-<hash>.js` asset and rewrite the URL. Inside the Worker, `wasm_exec.js` supplies Go's runtime and `new URL('./tailcat.wasm.gz', import.meta.url)` locates the single compressed asset. `wasm-response.ts` recognizes its signature and uses `DecompressionStream('gzip')` before `WebAssembly.instantiateStreaming`. This streams decompression without buffering the entire decoded binary in JavaScript. Browsers need the Compression Streams API when the server delivers gzip bytes unchanged. The main thread and Worker exchange messages for identity generation, listen, dial and streaming operations. TypeScript source is for development; consuming browsers execute the generated JavaScript.

Third-party license and notice texts are combined, unmodified, into one `THIRD_PARTY_NOTICES.txt`, with a component/version heading for each source file. The WASM build collects the Go runtime license and module-root license/notice files from its actual compiled dependency graph, including transitive dependencies. It does not collect every entry in `go.sum`. The npm package and application distribution include this file; the runtime does not fetch it or embed it in WASM.

Use a same-origin static map downloaded during the application build, or a remote provider that permits CORS. This adapter accepts an explicit map URL and does not proxy requests or select regions. Upstream WASM selects a random region from a full map; applications should probe relays and pass a one-region map to `listen`, retaining the full map for `dial`.

A Tailcat address is a connection capability: `tc` + base64url(CBOR). Fields `p`, `k`, `q`, `i`, `r` encode the server public key, optional discovery public key, secret pre-shared key, DERP region ID and optional embedded region respectively. `await runtime.describeAddress(address)` invokes upstream `ParseAddr` and `ParseAddrRaw` inside WASM without dialing or fetching a DERP map. It returns upstream JSON field names directly (`ServerPublic`, `ServerDiscoPublic`, `PresharedKey`, `RegionID`, `Region`), redacting `PresharedKey` before Worker RPC. Absent optional fields stay omitted. There is no CBOR decoder or field-remapping layer in this adapter. This replaces the former synchronous named export. The current format has no version field. Share complete addresses only with intended peers.

The SDK `dist/` is committed for frontend development and independent consumption. Git, SDK dist, npm tarballs and application output store only `tailcat.wasm.gz`. Normal builds and packing verify its decoded SHA-256 without restoring a raw file. Consumers need no install hook or Go compiler. Node 24+ and TypeScript are sufficient for the normal wrapper build:

```sh
npm ci
npm run build
npm pack
```

Changes to the Go adapter, its dependencies or `patches/` need a WASM rebuild using Go 1.27.1 and Git:

```sh
GO=/path/to/go npm run build:wasm
```

The patch baselines are locked by `wasm/go.mod`, `wasm/go.sum` and `wasm/forks.json`: Tailcat **v0.7.0** (commit `15ab9e68bfc6534a61797d7af28cedd42b54a3a5`), Tailscale **v1.103.0-pre.0.20260916030321-a2263542f260** (commit `a2263542f260e73260e821a2d1b81475c35b0766`) and x/crypto **v0.57.0** (commit `3f62bf119e84c6e35e8518a2958089ade622d1a3`). Go requires the canonical tag when that tag names a revision; manufacturing a pseudo-version for it can fail validation. The separate full-commit lock ensures a moved tag still fails verification. `prepare-forks.ts` rejects floating queries and checks the downloaded module version, origin commit, module checksum and go.mod checksum before copying sources into ignored `.forks/` directories and applying the three committed patches. It recreates those directories on each run, discarding previous local edits. Update the version, full commit and checksums together when deliberately changing a baseline; no branch head or `latest` is fetched.

The build then compiles the local `wasm/` module with pinned build tags into an OS temporary directory, writes only gzip to dist, and removes the temporary directory even when compilation fails. `-trimpath` removes local source paths and `-buildvcs=false` excludes checkout-specific Git revisions, timestamps and dirty state. It also regenerates the runtime, manifest and notices. `wasm_exec.js` is copied unchanged from that compiler's `$GOROOT/lib/wasm/wasm_exec.js`; it is Go's JavaScript runtime bridge and must match the compiler version. Do not edit it manually. The build manifest records upstream versions, WASM and runtime SHA-256 hashes, and a fingerprint of the adapter source, dependency locks and compiler flags.

Commit the regenerated `dist/` alongside source changes. Normal `build` refreshes the JavaScript wrapper and declarations without invoking Go, then verifies the prebuilt gzip WASM and removes obsolete raw/Brotli leftovers. `npm pack` runs this build first, so it requires installed development dependencies and cannot silently ship an older JavaScript wrapper. Missing or stale compressed assets fail with an explicit restore/rebuild instruction. Installing or using the resulting tarball needs no compiler or install hook.

The local `main_js.go` is based on Tailcat v0.7.0's browser entry point; `webrtc_js.go` supplies experimental tunneled signaling and packet bridging. Its additions are persisted receiving/sending keys, Promise executor release, asynchronous close, authenticated peer metadata and a bounded, redacted diagnostic export calling `ParseAddr` / `ParseAddrRaw`. Incoming peer identity is obtained from upstream `Server.PeerEnv`; outgoing identity comes from the target address after a successful tunnel connection. Listening addresses embed the resolved relay with upstream `ConnInfo.Addr()`, so dialing does not depend on a peer using the same DERP map. The close bridge returns a Promise so Go teardown cannot block the Worker event loop, and releases its Go callbacks after closing. `dial(address, mapURL, { port, signal })` supports cancellation while queued or establishing the connection. Listening, dialing and stream handling call upstream implementations. No separate `address.go` is needed.

## Experimental browser WebRTC

The browser entry enables WebRTC automatically. Pass `webRTC: false` to retain DERP-only behavior, or `webRTC: { iceServers: [...] }` to configure ICE. The default is Google's `stun:stun.l.google.com:19302`; no TURN server is configured. Use `iceServers: []` for a local host-candidate test without external STUN. Direct peers learn one another's network addresses through ICE. This feature is a local prototype, verified with isolated Chromium contexts and independent Chromium instances on one host; cross-network and other-browser validation remains outstanding.

An internal TCP stream on reserved port 65534 exchanges SDP, ICE and the packet protocol version inside the existing authenticated WireGuard tunnel. It belongs to the same Tailcat Client as the application stream, avoiding the SDK's single-outgoing-client queue. Protocol version 2 uses an unordered `wireguard-v2` DataChannel with `maxRetransmits: 2`: SCTP can repair individual fragment losses a limited number of times; the original virtual TCP stream remains responsible for reliable application delivery. Older browser packet protocols and native peers remain compatible through DERP.

Two fresh, full-sized probe receipts qualify a path before traffic switches. Data receipts are issued only after Go admits the encrypted packet to its receive queue; receipts for small packets cannot hide a large-packet blackhole. Missing receipts or heartbeats trigger fallback after an RTT-adjusted 3–8 seconds. Sustained delivery delay above the ICE RTT budget also triggers fallback even when some receipts still arrive. Hidden-tab timer throttling is detected and does not count as missing progress. Requalification waits 5–30 seconds and requires fresh probes; repeated failures lengthen the cooldown, and the penalty decays only after minutes of stability, preventing marginal paths from flapping between direct and DERP.

SCTP buffering is capped at 256 KiB; Worker admission and receive queues are capped at 1 MiB per session. A transient full Worker queue drops packets like a bounded UDP socket, so inner TCP applies backpressure without spilling individual packets onto DERP. Outbound packets queued for more than two seconds trigger path fallback. Unsent packets are discarded and their credits released; already-submitted packets may arrive late, and inner TCP handles loss, duplication and reordering. Packet receipt accounting and receipt batches are bounded. No new identity, MQTT signaling or application backend is required.

`await runtime.getTransportStats()` reports per-session state, encrypted packet byte counters and selected ICE candidate types. A TURN candidate is labeled `webrtc-relay`, not `direct`. `runtime.setWebRTCEnabled(false)` closes direct paths and preserves established application streams through DERP. Failed or closed WebRTC sessions are rebuilt using the same Tailcat Client with 1–30 second retry backoff and a 10-second signaling dial deadline. Disabling pauses these retries. Re-enabling resumes upgrades for outgoing streams that originally enabled WebRTC, and enables subsequent connections, including runtimes created with `webRTC: false`. Streams originally dialed with WebRTC disabled need a new connection to start upgrading. Node returns an empty stats list and continues to use DERP.

Pass `onTransportChange(peers)` to `createTailcat` for live status without polling. Each `PeerTransport` contains the authenticated `peerNodeKey` and a state (`connecting`, `direct`, `webrtc-relay`, or `derp`). Updates describe peers with active application streams; closing the last stream removes that peer. Outgoing streams identify the remote receiving key, while incoming streams identify its sending key. Match these role keys when displaying the path for a transfer. A direct status requires the selected ICE candidates to be known and neither to use TURN.

These events also carry optional counters refreshed once per second: WebRTC `txBytes`/`rxBytes`, actual magicsock `derpTxBytes`/`derpRxBytes`, browser `droppedPackets` and Go `pathDrops`, `bufferedBytes`, `acknowledgedBytes`, receipt `deliveryRTTMS`, ICE `rttMS`, `fallbackReason`, and candidate types/protocol. Until measured, fields can be absent. Counters describe encrypted peer traffic including tunnel control and retransmissions, not file payload or outer headers. WebRTC tx counts admission to DataChannel.send, and DERP tx counts successful DERP client sends; neither is delivery confirmation. WebRTC rx counts actual channel reception. `acknowledgedBytes` counts ciphertext admitted to the remote Go queue, not application consumption. Probe, receipt and framing bytes are excluded from the ciphertext counters. Listener DERP counters follow the peer endpoint lifetime and may cover multiple streams; RTC counters describe the latest session. The two directions select their paths independently; packets already in flight and tunnel control can also overlap a transition. Buffer overflow alone does not spill individual packets to DERP. `getTransportStats()` remains the per-WebRTC-session diagnostic history, including RTC counters and ICE details; DERP counters are supplied through `onTransportChange`.

A reachable DERP is required for initial bootstrap and signaling. Once upgraded, an existing connection can carry data with DERP unavailable; a new connection cannot bootstrap that way. Closing the owning application connection closes its WebRTC session. Recovery replaces failed PeerConnections instead of restarting ICE in place. Browser/native direct interoperability and validation on real WANs and other browser engines remain outstanding. Fallback still requires a reachable DERP; it does not guarantee that the relay is faster than every impaired direct path.

After `npm run bench:setup`, `npm run bench:transport` runs six standard comparisons without parameters:

| Case | Runtime and transport | Inner MTU / raw message size |
| --- | --- | ---: |
| `raw-audit-reference` | Raw reliable browser WebRTC | 32768-byte messages |
| `tailcat-8k` | Go WASM SDK over WebRTC | MTU 8192 |
| `tailcat-32k` | Go WASM SDK over WebRTC | MTU 32768 |
| `tailcat-derp-8k` | Go WASM SDK over DERP, WebRTC disabled | MTU 8192 |
| `native-derp-8k` | Native Tailcat CLI over DERP, UDP disabled | MTU 8192 |
| `native-direct-1280` | Native Tailcat CLI over direct UDP, relay stopped after warmup | MTU 1280 |

Browser endpoints use two independent Chromium instances: two contexts in one browser share a NetworkService thread that can limit the result. Each case warms up for 128 MiB, then measures three receiver-verified 1 GiB transfers. Native cases use two separate CLI processes; timing includes stdin/stdout pipes and CLI copies, with Node checking every received byte. The UDP case requires both peers to discover direct endpoints, then stops its private relay before measuring; it fails if a direct path cannot be established. The DERP case confirms that both native endpoints disabled UDP. Native builds retain native assembly and Go concurrency, whereas WASM uses its JS bridge and Worker execution model. The equal-MTU DERP pair helps locate runtime/host overhead, but also includes native DERP streaming versus browser WebSocket framing; it does not isolate encryption or WASM alone. Results, tool hashes/build versions, CPU model, platform, and Chromium version go to `test-results/throughput.json`.

`BENCH_CASES=all` runs the extended ablation suite, including the WebRTC manager, synthetic Worker bridge, and queue/receipt variants. `BENCH_CASES` also accepts comma-separated case names; `BENCH_BYTES`, `BENCH_WARMUP_BYTES`, and `BENCH_RUNS` override the sample size and count. `BENCH_SEPARATE_BROWSERS=0` reproduces the shared-browser layout. `BENCH_BASELINE=<git revision>` adds matching-MTU comparisons against that revision's committed `dist/`. `BENCH_CPU=1` records Linux CPU time by browser thread, while `BENCH_PROFILE=1` collects page and Worker CPU profiles in a separate transfer excluded from the throughput table. Diagnostic variants are intercepted only by the test harness and do not change SDK assets. Routine benchmark reports stay local in `benchmarks/` and `test-results/`.
