import { DEFAULT_TUNNEL_MTU, RTC_ACK, RTC_DATA, RTC_HEADER, RTC_PROBE, RTC_QUEUE_LIMIT, RTC_WORKER_LIMIT, RTC_VERSION, rtcFrame, } from "./rtc-protocol.js";
const now = () => performance.now();
const MAX_BUFFER = RTC_QUEUE_LIMIT;
export function createWebRTC(options, send, initiallyEnabled = true, tunnelMTU = DEFAULT_TUNNEL_MTU) {
    const sessions = new Map();
    const history = [];
    let enabled = initiallyEnabled;
    let changed = () => { };
    function post(session, kind, value) {
        send({ method: "rtc", args: { session, kind, value } });
    }
    function ready(id, s, value) {
        const transitioned = s.ready !== value;
        s.ready = value;
        s.stats.state = value ? selectedPath(s) : "derp";
        if (value) {
            s.readyAt = now();
            delete s.stats.fallbackReason;
        }
        if (transitioned)
            post(id, "ready", value);
        changed();
        if (value)
            void refreshCandidates(s);
    }
    function selectedPath(s) {
        const { localCandidateType: local, remoteCandidateType: remote } = s.stats;
        if (!local || !remote)
            return "connecting";
        return local === "relay" || remote === "relay" ? "webrtc-relay" : "direct";
    }
    async function refreshCandidates(s) {
        s.stats.bufferedBytes =
            (s.channel?.bufferedAmount ?? 0) +
                s.outbound.reduce((total, packet) => total + packet.bytes.byteLength, 0);
        try {
            const stats = await s.pc.getStats();
            let pair;
            stats.forEach((entry) => {
                if (entry.type === "transport" && entry.selectedCandidatePairId)
                    pair = stats.get(entry.selectedCandidatePairId);
            });
            if (!pair)
                stats.forEach((entry) => {
                    if (entry.type === "candidate-pair" &&
                        entry.nominated &&
                        entry.state === "succeeded")
                        pair = entry;
                });
            if (!pair || sessions.get(s.stats.session) !== s)
                return;
            s.stats.localCandidateType = stats.get(pair.localCandidateId)?.candidateType;
            s.stats.remoteCandidateType = stats.get(pair.remoteCandidateId)?.candidateType;
            s.stats.candidateProtocol = stats.get(pair.localCandidateId)?.protocol;
            s.stats.rttMS =
                typeof pair.currentRoundTripTime === "number"
                    ? pair.currentRoundTripTime * 1000
                    : undefined;
            if (s.ready) {
                const state = selectedPath(s);
                if (s.stats.state !== state) {
                    s.stats.state = state;
                    changed();
                }
            }
        }
        catch {
            /* Keep a closing or unclassified path out of the direct count. */
        }
    }
    function releaseQueue(id, s) {
        for (const packet of s.outbound)
            post(id, "credit", packet.bytes.byteLength);
        s.stats.droppedPackets += s.outbound.length;
        s.outbound.length = 0;
        s.inflight.clear();
        s.pendingCounts = [0, 0];
    }
    function fallback(id, s, reason) {
        if (!s.ready && now() < s.cooldown)
            return;
        s.stats.fallbackReason = reason;
        s.cooldown = now() + s.backoff;
        s.backoff = Math.min(30_000, s.backoff * 2);
        s.goodProbes = 0;
        s.slowSince = undefined;
        delete s.stats.deliveryRTTMS;
        s.probe = undefined;
        try {
            ready(id, s, false);
        }
        finally {
            releaseQueue(id, s);
        }
    }
    function close(id) {
        const s = sessions.get(id);
        if (!s)
            return;
        sessions.delete(id);
        clearInterval(s.heartbeat);
        clearTimeout(s.ackTimer);
        releaseQueue(id, s);
        s.stats.bufferedBytes = 0;
        const wasReady = s.ready;
        s.ready = false;
        s.stats.state = "derp";
        if (wasReady)
            post(id, "ready", false);
        s.channel?.close();
        s.pc.close();
        history.push(s.stats);
        if (history.length > 32)
            history.shift();
        post(id, "closed");
        changed();
    }
    function closeAll() {
        // Observers can throw. Release every peer before propagating their error.
        const errors = [];
        for (const id of sessions.keys()) {
            try {
                close(id);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw errors[0];
    }
    function timeout(s) {
        return Math.max(3000, Math.min(8000, (s.stats.rttMS ?? 0) * 6 + 1000));
    }
    function nextSequence(s) {
        s.sequence = (s.sequence + 1) >>> 0;
        return s.sequence;
    }
    function transmit(id, s, bytes) {
        if (bytes.byteLength > (s.pc.sctp?.maxMessageSize ?? 65536)) {
            s.stats.fallbackReason = "message-size";
            close(id);
            return false;
        }
        // Receipts/probes are expendable too. They must not bypass the byte bound
        // when the reverse direction is congested; subsequent receipts and probes
        // can establish progress again after the browser drains its send queue.
        if (s.channel.bufferedAmount + bytes.byteLength > MAX_BUFFER)
            return false;
        try {
            s.channel.send(bytes);
            return true;
        }
        catch {
            close(id);
            return false;
        }
    }
    function flush(id, s) {
        if (sessions.get(id) !== s || !s.ready || s.channel?.readyState !== "open")
            return;
        while (s.outbound.length) {
            const packet = s.outbound[0];
            if (now() - packet.at > 2000 || s.inflight.size >= 8192) {
                fallback(id, s, "congestion");
                return;
            }
            if (s.channel.bufferedAmount + packet.bytes.byteLength + RTC_HEADER >
                MAX_BUFFER)
                return;
            const sequence = nextSequence(s);
            // Worker packets own a transferred buffer with reserved framing space.
            // Synthetic/older producers without that headroom retain the copy path.
            const hasHeadroom = packet.bytes.byteOffset === RTC_HEADER &&
                packet.bytes.buffer.byteLength === RTC_HEADER + packet.bytes.byteLength;
            const frame = hasHeadroom
                ? new Uint8Array(packet.bytes.buffer)
                : rtcFrame(RTC_DATA, sequence, RTC_HEADER + packet.bytes.byteLength);
            if (hasHeadroom) {
                const view = new DataView(frame.buffer);
                view.setUint32(0, RTC_DATA);
                view.setUint32(4, sequence);
            }
            else
                frame.set(packet.bytes, RTC_HEADER);
            // Small TCP ACKs must not disguise a blackhole affecting large packets.
            const group = packet.bytes.byteLength > 512 ? 1 : 0;
            if (s.pendingCounts[group]++ === 0)
                s.progress[group] = now();
            s.inflight.set(sequence, {
                at: now(),
                bytes: packet.bytes.byteLength,
                group,
            });
            if (!transmit(id, s, frame))
                return;
            s.stats.txBytes += packet.bytes.byteLength;
            s.outbound.shift();
            post(id, "credit", packet.bytes.byteLength);
        }
    }
    function flushAcknowledgments(id, s) {
        clearTimeout(s.ackTimer);
        s.ackTimer = undefined;
        if (sessions.get(id) !== s || !s.acknowledgments.length)
            return;
        const sequences = s.acknowledgments.splice(0);
        const frame = rtcFrame(RTC_ACK, sequences[0], 4 + sequences.length * 4);
        const view = new DataView(frame.buffer);
        sequences.forEach((sequence, i) => view.setUint32(4 + i * 4, sequence));
        transmit(id, s, frame);
    }
    function acknowledge(id, s, sequence) {
        s.acknowledgments.push(sequence);
        if (s.acknowledgments.length >= 64)
            flushAcknowledgments(id, s);
        else
            s.ackTimer ??= setTimeout(() => flushAcknowledgments(id, s), 10);
    }
    function probe(id, s) {
        const sequence = nextSequence(s);
        s.probe = { sequence, at: now() };
        s.lastProbe = now();
        // Only qualification needs a full-sized probe. While transferring, actual
        // packet receipts supply the large-packet health check without extra load.
        transmit(id, s, rtcFrame(RTC_PROBE, sequence, s.ready ? RTC_HEADER : tunnelMTU + 32 + RTC_HEADER));
    }
    function poll(id, s) {
        if (sessions.get(id) !== s)
            return;
        const time = now();
        const gap = time - s.lastPollAt;
        s.lastPollAt = time;
        if (gap > 3000) {
            // A hidden tab can throttle timers down to one task per minute. The
            // absence of progress during such a gap is not evidence against the
            // path: restart the health windows so one stall cannot trip a fallback,
            // and re-age queued packets that only sat while this loop was paused.
            s.progress[0] = s.progress[1] = time;
            s.lastHealth = time;
            s.slowSince = undefined;
            for (const packet of s.outbound)
                packet.at = time;
        }
        if (time - s.lastStats >= 1000) {
            s.lastStats = time;
            void refreshCandidates(s).then(changed);
        }
        // Some ICE implementations remain disconnected without ever emitting
        // failed. Bound that state so Go can rebuild the signaling/session pair.
        if (s.pc.connectionState === "disconnected") {
            s.disconnectedAt ??= time;
            if (time - s.disconnectedAt >= timeout(s)) {
                s.stats.fallbackReason = "disconnected-timeout";
                close(id);
                return;
            }
        }
        else
            s.disconnectedAt = undefined;
        if (s.channel?.readyState !== "open") {
            if (time - s.started > 15_000)
                close(id);
            return;
        }
        if (!s.negotiated)
            return;
        const limit = timeout(s);
        if (s.ready) {
            if (s.pendingCounts.some((count, group) => count > 0 && time - s.progress[group] > limit))
                fallback(id, s, "delivery-timeout");
            else if (s.slowSince !== undefined && time - s.slowSince > 5000)
                fallback(id, s, "delivery-delay");
            else if (time - s.lastHealth > limit)
                fallback(id, s, "heartbeat-timeout");
            else if (s.backoff > 5000 && time - s.readyAt > 120_000)
                s.backoff = Math.max(5000, s.backoff / 2);
        }
        // Receipts can themselves be lost. Bound accounting without waiting for
        // cumulative ACKs, which would be incorrect for unordered datagrams.
        for (const [sequence, packet] of s.inflight) {
            if (time - packet.at > limit * 2) {
                s.inflight.delete(sequence);
                s.pendingCounts[packet.group]--;
            }
        }
        flush(id, s);
        if (s.probe && time - s.probe.at > limit) {
            s.probe = undefined;
            s.goodProbes = 0;
            if (!s.ready)
                fallback(id, s, "probe-timeout");
        }
        if (time < s.cooldown || s.pc.connectionState === "disconnected")
            return;
        if (!s.probe &&
            time - s.lastProbe >= (s.ready ? 1000 : 250) &&
            (!s.ready || time - s.lastHealth >= 1000))
            probe(id, s);
    }
    function attach(id, s, channel) {
        if (sessions.get(id) !== s ||
            s.channel ||
            channel.label !== "wireguard-v2" ||
            channel.ordered ||
            channel.maxRetransmits !== 2) {
            channel.close();
            return;
        }
        s.channel = channel;
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = MAX_BUFFER / 2;
        channel.onbufferedamountlow = () => flush(id, s);
        channel.onmessage = ({ data }) => {
            if (sessions.get(id) !== s ||
                !s.negotiated ||
                !(data instanceof ArrayBuffer) ||
                data.byteLength < RTC_HEADER ||
                data.byteLength > 65535 + RTC_HEADER)
                return;
            const view = new DataView(data);
            const kind = view.getUint32(0);
            const sequence = view.getUint32(4);
            if (kind === RTC_PROBE) {
                transmit(id, s, rtcFrame(RTC_ACK, sequence));
            }
            else if (kind === RTC_ACK &&
                data.byteLength <= 260 &&
                data.byteLength % 4 === 0) {
                for (let offset = 4; offset < data.byteLength; offset += 4) {
                    const sequence = view.getUint32(offset);
                    if (sequence === s.probe?.sequence) {
                        const elapsed = now() - s.probe.at;
                        s.probe = undefined;
                        if (elapsed <= timeout(s) &&
                            now() >= s.cooldown &&
                            s.pc.connectionState !== "disconnected") {
                            s.lastHealth = now();
                            if (!s.ready && ++s.goodProbes >= 2)
                                ready(id, s, true);
                        }
                        else
                            s.goodProbes = 0;
                    }
                    const packet = s.inflight.get(sequence);
                    if (packet) {
                        s.inflight.delete(sequence);
                        s.pendingCounts[packet.group]--;
                        s.progress[packet.group] = s.lastHealth = now();
                        s.stats.acknowledgedBytes += packet.bytes;
                        if (packet.group === 1) {
                            const delay = now() - packet.at;
                            const average = (s.stats.deliveryRTTMS =
                                s.stats.deliveryRTTMS === undefined
                                    ? delay
                                    : s.stats.deliveryRTTMS * 0.875 + delay * 0.125);
                            // A trickle of receipts must not pin bulk traffic to a path
                            // with seconds of SCTP queueing. Compare delivery (including Go
                            // admission) with ICE RTT and require sustained deterioration.
                            const budget = Math.max(1000, (s.stats.rttMS ?? 0) * 8 + 250);
                            if (average > budget)
                                s.slowSince ??= now();
                            else if (average < budget * 0.75)
                                s.slowSince = undefined;
                        }
                    }
                }
            }
            else if (kind === RTC_DATA && data.byteLength > RTC_HEADER) {
                const bytes = new Uint8Array(data, RTC_HEADER);
                s.stats.rxBytes += bytes.byteLength;
                if (s.inboundPending + bytes.byteLength > RTC_WORKER_LIMIT) {
                    s.stats.droppedPackets++;
                    return;
                }
                s.inboundPending += bytes.byteLength;
                send({
                    method: "rtc",
                    args: { session: id, kind: "packet", value: bytes, sequence },
                }, [data]);
            }
        };
        channel.onopen = () => poll(id, s);
        channel.onclose = () => close(id);
        channel.onerror = () => close(id);
    }
    function start(id, value) {
        if (sessions.has(id))
            return;
        if (!enabled ||
            typeof RTCPeerConnection === "undefined" ||
            sessions.size >= 32) {
            post(id, "closed");
            return;
        }
        const pc = new RTCPeerConnection({
            iceServers: options.iceServers ?? [
                { urls: "stun:stun.l.google.com:19302" },
            ],
        });
        const s = {
            pc,
            pending: [],
            signaling: Promise.resolve(),
            queuedSignals: 0,
            inboundPending: 0,
            outbound: [],
            acknowledgments: [],
            inflight: new Map(),
            pendingCounts: [0, 0],
            progress: [0, 0],
            sequence: 0,
            lastProbe: -Infinity,
            lastHealth: now(),
            lastPollAt: now(),
            lastStats: now(),
            started: now(),
            readyAt: 0,
            cooldown: 0,
            backoff: 5000,
            goodProbes: 0,
            negotiated: false,
            ready: false,
            stats: {
                session: id,
                peerNodeKey: value.peerNodeKey,
                state: "connecting",
                txBytes: 0,
                rxBytes: 0,
                droppedPackets: 0,
                bufferedBytes: 0,
                acknowledgedBytes: 0,
            },
            heartbeat: setInterval(() => poll(id, s), 250),
        };
        sessions.set(id, s);
        changed();
        pc.onicecandidate = ({ candidate }) => {
            if (candidate && sessions.get(id) === s)
                post(id, "signal", JSON.stringify({ candidate: candidate.toJSON() }));
        };
        pc.onconnectionstatechange = () => {
            if (sessions.get(id) !== s)
                return;
            if (pc.connectionState === "failed" || pc.connectionState === "closed")
                close(id);
            else if (pc.connectionState === "disconnected") {
                s.disconnectedAt ??= now();
                fallback(id, s, "disconnected");
            }
            else {
                s.disconnectedAt = undefined;
                if (pc.connectionState === "connected")
                    void refreshCandidates(s);
            }
        };
        pc.ondatachannel = ({ channel }) => attach(id, s, channel);
        if (value.initiator) {
            attach(id, s, pc.createDataChannel("wireguard-v2", {
                ordered: false,
                maxRetransmits: 2,
            }));
            s.signaling = (async () => {
                const offer = await pc.createOffer();
                if (sessions.get(id) !== s)
                    return;
                await pc.setLocalDescription(offer);
                if (sessions.get(id) !== s)
                    return;
                post(id, "signal", JSON.stringify({
                    description: pc.localDescription,
                    version: RTC_VERSION,
                }));
            })().catch(() => close(id));
        }
    }
    return {
        onChange(callback) {
            changed = callback;
        },
        snapshot() {
            const latest = new Map(history.map((stats) => [stats.peerNodeKey, stats]));
            for (const { stats } of sessions.values())
                latest.set(stats.peerNodeKey, stats);
            return Array.from(latest.values(), (stats) => ({ ...stats }));
        },
        handle({ session: id, kind, value, }) {
            if (kind === "start") {
                try {
                    start(id, value);
                }
                catch {
                    if (sessions.has(id))
                        close(id);
                    else
                        post(id, "closed");
                }
                return;
            }
            if (kind === "closed") {
                close(id);
                return;
            }
            const s = sessions.get(id);
            if (kind === "packet") {
                if (s?.ready && s.channel?.readyState === "open") {
                    s.outbound.push({ bytes: value, at: now() });
                    flush(id, s);
                }
                else {
                    if (s)
                        s.stats.droppedPackets++;
                    post(id, "credit", value.byteLength);
                }
            }
            else if (s && kind === "received") {
                s.inboundPending = Math.max(0, s.inboundPending - value.bytes);
                // The Worker batches receipts; a single-item shape remains accepted.
                for (const item of value.items ?? [value])
                    if (item.accepted && Number.isInteger(item.sequence))
                        acknowledge(id, s, item.sequence);
            }
            else if (s && kind === "dropped") {
                s.stats.droppedPackets += value;
            }
            else if (s && kind === "signal") {
                if (++s.queuedSignals > 64) {
                    close(id);
                    return;
                }
                s.signaling = s.signaling
                    .then(async () => {
                    if (sessions.get(id) !== s)
                        return;
                    const signal = JSON.parse(value);
                    if (signal.description) {
                        if (signal.version !== RTC_VERSION) {
                            s.stats.fallbackReason = "incompatible";
                            close(id);
                            return;
                        }
                        s.negotiated = true;
                        await s.pc.setRemoteDescription(signal.description);
                        if (sessions.get(id) !== s)
                            return;
                        for (const candidate of s.pending.splice(0)) {
                            await s.pc.addIceCandidate(candidate);
                            if (sessions.get(id) !== s)
                                return;
                        }
                        if (signal.description.type === "offer") {
                            const answer = await s.pc.createAnswer();
                            if (sessions.get(id) !== s)
                                return;
                            await s.pc.setLocalDescription(answer);
                            if (sessions.get(id) !== s)
                                return;
                            post(id, "signal", JSON.stringify({
                                description: s.pc.localDescription,
                                version: RTC_VERSION,
                            }));
                        }
                    }
                    else if (signal.candidate) {
                        if (s.pc.remoteDescription)
                            await s.pc.addIceCandidate(signal.candidate);
                        else if (s.pending.length < 64)
                            s.pending.push(signal.candidate);
                        else
                            close(id);
                    }
                })
                    .catch(() => close(id))
                    .finally(() => s.queuedSignals--);
            }
        },
        async stats() {
            await Promise.all(Array.from(sessions.values(), refreshCandidates));
            return [...history, ...Array.from(sessions.values(), (s) => s.stats)].map((s) => ({ ...s }));
        },
        setEnabled(value) {
            enabled = value;
            if (!value)
                closeAll();
        },
        close() {
            enabled = false;
            closeAll();
        },
    };
}
