import { connectWorker, validateOptions, } from "./client.js";
import { createWebRTC } from "./webrtc.js";
/** Tailcat streams with experimental browser WebRTC upgrades and DERP fallback. */
export async function createTailcat(options) {
    const mtu = validateOptions(options);
    const worker = options.assetsURL
        ? new Worker(new URL("worker.js", new URL(options.assetsURL, location.href)), { type: "module" })
        : new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    return connectWorker({
        postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
        terminate: () => worker.terminate(),
        onMessage: (handler) => {
            worker.onmessage = ({ data }) => handler(data);
        },
        onError: (handler) => {
            worker.onerror = (event) => handler(new Error(event.message));
        },
    }, options, mtu, typeof RTCPeerConnection === "undefined"
        ? undefined
        : createWebRTC(options.webRTC || {}, (message, transfer) => worker.postMessage(message, transfer ?? []), options.webRTC !== false, mtu));
}
