# Tailcat WASM

Tailcat v0.7.0 byte streams for browsers and Node.js 24+, using the same Go WASM. Conditional exports choose a browser Worker or a Node `worker_threads` host. Browsers attempt an experimental WebRTC upgrade with DERP fallback; Node uses DERP only. Small committed Tailcat/Tailscale patches add an optional encrypted packet path. WireGuard and address formats are unchanged.

The tarball contains compiled JavaScript, declarations, Worker entries, gzip WASM, the matching Go runtime, build manifest and upstream notices. It has no runtime npm dependencies and needs no Go installation in consumers. The small local `wasm/main_js.go` imports pinned upstream modules and bridges native keys, authenticated peer metadata and stream operations.

Install development dependencies with `npm ci`; the demo can be served directly without installing anything.

## Browser demo

The standalone demo is `index.html`: styles and demo logic are inline, and its only module import is `./dist/index.js`. Opening the page starts a listener and prepares a temporary address automatically; paste the other browser's address to connect. One stream carries messages and tests in both directions. Keys stay in the tab. The demo accepts one peer at a time and uses application port 7443.

The test sends exactly **1 GB (1,000,000,000 bytes)** in 256 KiB chunks without allocating a gigabyte buffer. It hashes each chunk with Web Crypto, then hashes the ordered chunk digests for the completion receipt; this verifies the sequence but is not the standard SHA-256 of the whole payload. Send speed uses receiver-confirmed payload bytes, receive speed uses locally processed payload, and both use a rolling two-second window. The final average includes streaming, chunk verification and the receiver's receipt.

Live transport shows separate WebRTC/DERP upload and download rates, cumulative encrypted packet counters and the selected ICE path. Transport upload counts local sends, not confirmed delivery. Disable WebRTC to verify relay fallback during a test. Stop test disconnects the current stream while leaving your address available to reconnect. Expand **WebRTC debugging** to copy `chrome://webrtc-internals`; open it in another tab before connecting to inspect the browser's DataChannel and ICE statistics.

From this package directory, serve the checked-in files directly—no install or build is required:

```sh
python3 -m http.server 5174 --bind 127.0.0.1  # http://localhost:5174
```

Publish `index.html`, `dist/` and `.nojekyll` together on GitHub Pages or any HTTPS static host. All asset paths are relative, so a project subdirectory also works. The Worker and WASM remain separate SDK assets. No demo build, export command or custom server is required. Serve `.js` as JavaScript and `.wasm.gz` as an ordinary static file. By default the demo uses the CORS-enabled public Tailcat DERP map. To select your own, stop the listener and expand Relay settings, or open the page with `?map=` followed by the URL-encoded HTTP(S) map URL. TURN requires configured ICE credentials; the demo's default configuration uses STUN and falls back to DERP when direct connectivity is unavailable.

## Validation

```sh
npm run check
npm test
npm run test:coverage
# Real browsers + Go WASM + a local TLS DERP:
npx playwright install chromium
DERPER_BIN=/path/to/derper npm run test:demo
```

Unit tests control the Worker/Go/WebRTC boundaries to cover races, failure paths, ownership and buffering; coverage reports refer to the exercised TypeScript modules, not Go. The demo E2E serves the unchanged HTML from a project subdirectory using a plain static server. It checks automatic addresses, messages, cancellation and reconnecting, then verifies two real 1 GB transfers: one switching from WebRTC to DERP on the same stream, and one entirely over WebRTC after stopping DERP. It checks exact payload counts, completion receipts, elapsed-time averages and transport counters. These are local browser tests, not WAN throughput measurements. Only the local fixture's self-signed certificate is trusted through a test browser flag.

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

The inner tunnel default is `tunnelMTU: 32768` (configurable from 1280 to 32768). This sets upstream's existing `TS_DEBUG_MTU` before Go starts and reduces per-packet WASM/WebSocket overhead. WebRTC carries each encrypted packet as one SCTP message, subject to its negotiated message limit; this can involve fragmentation. It is the inner tunnel MTU, not the Ethernet MTU. Use `tunnelMTU: 1280` to reproduce the original baseline. This is not a recommendation for native UDP paths.

Call `runtime.createIdentity()` to generate `{ nodeKey, sendNodeKey, privateKeyJSON }` locally, without a DERP map or connection. Persist the returned JSON and pass it to `listenWithIdentity` when ready to connect. Unbound identities use region `-1`; the first listener pins its selected region. This works in both browser and Node workers.

Call `listen` or `listenWithIdentity` once per runtime. `listen(mapURL)` preserves the original API and creates an ephemeral listener. For explicit persistence, use `listenWithIdentity(mapURL, { privateKeyJSON, regionID })`, which returns `{ address, nodeKey, sendNodeKey, privateKeyJSON }`. Omit `privateKeyJSON` on first use, then persist the returned secret JSON and pass it on later starts. Optional `regionID` moves a stored identity to the selected region while keeping its keys. Do not publish or log the private JSON.

Each runtime owns two native node keys: a receiving Server key and a sending Client key. `privateKeyJSON` contains symmetric `serverKey` and `clientKey` objects, both complete upstream `tailcat.PrivateKey` values with `Private` and `Public` fields. Both are independently generated locally by `tailcat.NewPrivateKey()`; key generation needs no network access. Only the receiving record supplies a listening address. The client keeps the same shape with an unused DERP region (`-1`), and dialing uses `clientKey.Private`. Persist the complete record. Older serialized formats require an explicit identity reset and renewed pairing; no migration is performed.

Receiving remains available while dialing and sending. Outgoing operations queue until the previous connection closes, because independent Clients cannot safely share the sending key concurrently. Up to 64 dials may wait; additional requests reject. Canceling a queued dial removes it immediately without waiting for the active stream to close. Close every outgoing connection after use.

These keys identify the listener and initiator roles, not one-way data channels. Every established stream supports simultaneous reads and writes. The two-key design keeps the independent Server and Client online together; it does not provide concurrent outgoing Clients to every peer or let multiple tabs own the same identity.

Await each `read()` before starting the next read on that stream; overlapping reads reject because the Go bridge shares one receive buffer per connection. Reads and writes may run simultaneously. `write()` copies the supplied view, including Node `Buffer` views, and preserves caller memory. `close()` is idempotent and can interrupt a pending read. Application ports must be integers from 1 to 65535, excluding reserved signaling port 65534.

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

The patch baselines are locked in `wasm/go.mod`: Tailcat **v0.7.0** and Tailscale **v1.103.0-pre.0.20260916030321-a2263542f260** (commit `a2263542f260`). The Tailscale pseudo-version identifies a fixed commit. `prepare-forks.ts` rejects floating version queries and checks the downloaded module version, module checksum and go.mod checksum against the committed `wasm/go.sum` before copying sources into ignored `.forks/` directories and applying `patches/tailcat.patch` and `patches/tailscale.patch`. It recreates those directories on each run, discarding previous local edits. Change the version and checksums together when deliberately updating a patch baseline; no branch head or `latest` is fetched.

The build then compiles the local `wasm/` module with pinned build tags into an OS temporary directory, writes only gzip to dist, and removes the temporary directory even when compilation fails. `-trimpath` removes local source paths and `-buildvcs=false` excludes checkout-specific Git revisions, timestamps and dirty state. It also regenerates the runtime, manifest and notices. `wasm_exec.js` is copied unchanged from that compiler's `$GOROOT/lib/wasm/wasm_exec.js`; it is Go's JavaScript runtime bridge and must match the compiler version. Do not edit it manually. The build manifest records both upstream versions, WASM and runtime SHA-256 hashes, and a fingerprint of the adapter source, dependencies and compiler flags.

Commit the regenerated `dist/` alongside source changes. Normal `build` refreshes the JavaScript wrapper and declarations without invoking Go, then verifies the prebuilt gzip WASM and removes obsolete raw/Brotli leftovers. `npm pack` runs this build first, so it requires installed development dependencies and cannot silently ship an older JavaScript wrapper. Missing or stale compressed assets fail with an explicit restore/rebuild instruction. Installing or using the resulting tarball needs no compiler or install hook.

The local `main_js.go` is based on Tailcat v0.7.0's browser entry point; `webrtc_js.go` supplies experimental tunneled signaling and packet bridging. Its additions are persisted receiving/sending keys, Promise executor release, asynchronous close, authenticated peer metadata and a bounded, redacted diagnostic export calling `ParseAddr` / `ParseAddrRaw`. Incoming peer identity is obtained from upstream `Server.PeerEnv`; outgoing identity comes from the target address after a successful tunnel connection. Listening addresses embed the resolved relay with upstream `ConnInfo.Addr()`, so dialing does not depend on a peer using the same DERP map. The close bridge returns a Promise so Go teardown cannot block the Worker event loop, and releases its Go callbacks after closing. `dial(address, mapURL, { port, signal })` supports cancellation while queued or establishing the connection. Listening, dialing and stream handling call upstream implementations. No separate `address.go` is needed.

## Experimental browser WebRTC

The browser entry enables WebRTC automatically. Pass `webRTC: false` to retain DERP-only behavior, or `webRTC: { iceServers: [...] }` to configure ICE. The default is Google's `stun:stun.l.google.com:19302`; no TURN server is configured. Use `iceServers: []` for a local host-candidate test without external STUN. Direct peers learn one another's network addresses through ICE. This feature is a local prototype, verified with two isolated Chromium contexts on one host; cross-network and other-browser validation remains outstanding.

An internal TCP stream on reserved port 65534 exchanges SDP and ICE inside the existing authenticated WireGuard tunnel. It belongs to the same Tailcat Client as the application stream, avoiding the SDK's single-outgoing-client queue. The browser owns RTCPeerConnection and bridges bounded binary packets to the WASM Worker. An unordered DataChannel with `maxRetransmits: 0` carries WireGuard ciphertext; the original virtual TCP stream still provides application reliability. A heartbeat marks unavailable paths for DERP fallback. No new identity, MQTT signaling or application backend is required.

`await runtime.getTransportStats()` reports per-session state, encrypted packet byte counters and selected ICE candidate types. A TURN candidate is labeled `webrtc-relay`, not `direct`. `runtime.setWebRTCEnabled(false)` closes direct paths and preserves established application streams through DERP. Re-enabling applies to subsequent outgoing and incoming connections, including runtimes created with `webRTC: false`. Node returns an empty stats list and continues to use DERP.

Pass `onTransportChange(peers)` to `createTailcat` for live status without polling. Each `PeerTransport` contains the authenticated `peerNodeKey` and a state (`connecting`, `direct`, `webrtc-relay`, or `derp`). Updates describe peers with active application streams; closing the last stream removes that peer. Outgoing streams identify the remote receiving key, while incoming streams identify its sending key. Match these role keys when displaying the path for a transfer. A direct status requires the selected ICE candidates to be known and neither to use TURN.

These events also carry optional counters refreshed once per second: WebRTC `txBytes`/`rxBytes`, actual magicsock `derpTxBytes`/`derpRxBytes`, browser `droppedPackets` and Go `pathDrops`, `bufferedBytes`, ICE `rttMS`, and candidate types/protocol. Until measured, fields can be absent. Counters describe encrypted peer traffic including tunnel control and retransmissions, not file payload or outer headers. WebRTC tx counts admission to DataChannel.send, and DERP tx counts successful DERP client sends; neither is delivery confirmation. WebRTC rx counts actual channel reception. Listener DERP counters follow the peer endpoint lifetime and may cover multiple streams; RTC counters describe the latest session. A direct state can coexist with DERP traffic when queues fill. `getTransportStats()` remains the per-WebRTC-session diagnostic history, including RTC counters and ICE details; DERP counters are supplied through `onTransportChange`.

A reachable DERP is required for initial bootstrap and signaling. Once upgraded, an existing connection can carry data with DERP unavailable; a new connection cannot bootstrap that way. Closing the owning application connection closes its WebRTC session. Browser/native direct interoperability, ICE restart, and WAN MTU/performance tuning are not part of this prototype.
