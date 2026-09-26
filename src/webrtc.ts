/** Browser transport for encrypted WireGuard datagrams. Signaling arrives over
 * an authenticated Tailcat stream; MQTT is never part of this trust boundary. */
export interface WebRTCOptions {
  // Keep the shared SDK declarations usable in Node without DOM typings.
  iceServers?: {
    urls: string | string[];
    username?: string;
    credential?: string;
  }[];
}
export interface TransportStats {
  session: number;
  peerNodeKey: string;
  state: "connecting" | "direct" | "webrtc-relay" | "derp";
  txBytes: number;
  rxBytes: number;
  droppedPackets: number;
  bufferedBytes: number;
  rttMS?: number;
  candidateProtocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
}
export interface PacketStats {
  derpTxBytes: number;
  derpRxBytes: number;
  pathDrops: number;
}
export type PeerTransport = Pick<TransportStats, "peerNodeKey" | "state"> &
  Partial<
    Omit<TransportStats, "session" | "peerNodeKey" | "state"> & PacketStats
  >;
interface Session {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  stats: TransportStats;
  pending: RTCIceCandidateInit[];
  signaling: Promise<void>;
  queuedSignals: number;
  inboundPending: number;
  outbound: Uint8Array<ArrayBuffer>[];
  heartbeat: ReturnType<typeof setInterval>;
  lastPong: number;
  ready: boolean;
}
const MAX_BUFFER = 1024 * 1024;
export function createWebRTC(
  options: WebRTCOptions,
  send: (message: Record<string, unknown>, transfer?: ArrayBuffer[]) => void,
  initiallyEnabled = true,
) {
  const sessions = new Map<number, Session>();
  const history: TransportStats[] = [];
  let enabled = initiallyEnabled;
  let changed = () => {};
  function post(session: number, kind: string, value?: unknown) {
    send({ method: "rtc", args: { session, kind, value } });
  }
  function ready(id: number, s: Session, value: boolean) {
    if (s.ready === value) return;
    s.ready = value;
    s.stats.state = value ? selectedPath(s) : "derp";
    post(id, "ready", value);
    changed();
    if (value) void refreshCandidates(s);
  }
  function selectedPath(s: Session): TransportStats["state"] {
    const { localCandidateType: local, remoteCandidateType: remote } = s.stats;
    if (!local || !remote) return "connecting";
    return local === "relay" || remote === "relay" ? "webrtc-relay" : "direct";
  }
  async function refreshCandidates(s: Session) {
    s.stats.bufferedBytes =
      (s.channel?.bufferedAmount ?? 0) +
      s.outbound.reduce((total, packet) => total + packet.byteLength, 0);
    try {
      const stats = await s.pc.getStats();
      let pair: any;
      stats.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId)
          pair = stats.get(entry.selectedCandidatePairId);
      });
      if (!pair)
        stats.forEach((entry) => {
          if (
            entry.type === "candidate-pair" &&
            entry.nominated &&
            entry.state === "succeeded"
          )
            pair = entry;
        });
      if (!pair || sessions.get(s.stats.session) !== s) return;
      s.stats.localCandidateType = stats.get(
        pair.localCandidateId,
      )?.candidateType;
      s.stats.remoteCandidateType = stats.get(
        pair.remoteCandidateId,
      )?.candidateType;
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
    } catch {
      /* Keep a closing or unclassified path out of the direct count. */
    }
  }
  function close(id: number) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearInterval(s.heartbeat);
    for (const packet of s.outbound) post(id, "credit", packet.byteLength);
    s.stats.droppedPackets += s.outbound.length;
    s.outbound.length = 0;
    ready(id, s, false);
    s.stats.state = "derp";
    s.channel?.close();
    s.pc.close();
    history.push(s.stats);
    if (history.length > 32) history.shift();
    post(id, "closed");
    changed();
  }
  function flush(id: number, s: Session) {
    if (sessions.get(id) !== s) return;
    const channel = s.channel;
    if (!channel || channel.readyState !== "open") return;
    try {
      while (s.outbound.length) {
        const packet = s.outbound[0];
        if (channel.bufferedAmount + packet.byteLength > MAX_BUFFER) return;
        if (packet.byteLength > (s.pc.sctp?.maxMessageSize ?? 65536)) {
          close(id);
          return;
        }
        channel.send(packet);
        s.stats.txBytes += packet.byteLength;
        s.outbound.shift();
        // Retain worker credit while queued: admitted packets must not be
        // discarded merely because the browser's SCTP buffer is temporarily full.
        post(id, "credit", packet.byteLength);
      }
    } catch {
      close(id);
    }
  }
  function attach(id: number, s: Session, channel: RTCDataChannel) {
    if (
      sessions.get(id) !== s ||
      s.channel ||
      channel.label !== "wireguard" ||
      channel.ordered ||
      channel.maxRetransmits !== 0
    ) {
      channel.close();
      return;
    }
    s.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = MAX_BUFFER / 2;
    channel.onbufferedamountlow = () => flush(id, s);
    channel.onmessage = ({ data }) => {
      if (sessions.get(id) !== s) return;
      if (data === "ping") {
        heartbeat(id, s, "pong");
        return;
      }
      if (data === "pong") {
        s.lastPong = Date.now();
        ready(id, s, true);
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength > 65535) return;
      s.stats.rxBytes += data.byteLength;
      if (s.inboundPending + data.byteLength > MAX_BUFFER) {
        s.stats.droppedPackets++;
        return;
      }
      s.inboundPending += data.byteLength;
      send(
        {
          method: "rtc",
          args: { session: id, kind: "packet", value: new Uint8Array(data) },
        },
        [data],
      );
    };
    channel.onopen = () => heartbeat(id, s, "ping");
    channel.onclose = () => close(id);
    channel.onerror = () => close(id);
  }
  function heartbeat(id: number, s: Session, message: "ping" | "pong") {
    if (sessions.get(id) !== s) return;
    try {
      s.channel?.send(message);
    } catch {
      close(id);
    }
  }
  function start(
    id: number,
    value: { initiator: boolean; peerNodeKey: string },
  ) {
    if (sessions.has(id)) return;
    if (
      !enabled ||
      typeof RTCPeerConnection === "undefined" ||
      sessions.size >= 32
    ) {
      post(id, "closed");
      return;
    }
    const pc = new RTCPeerConnection({
      iceServers: options.iceServers ?? [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });
    const s: Session = {
      pc,
      pending: [],
      signaling: Promise.resolve(),
      queuedSignals: 0,
      inboundPending: 0,
      outbound: [],
      lastPong: Date.now(),
      ready: false,
      stats: {
        session: id,
        peerNodeKey: value.peerNodeKey,
        state: "connecting",
        txBytes: 0,
        rxBytes: 0,
        droppedPackets: 0,
        bufferedBytes: 0,
      },
      heartbeat: setInterval(() => {
        void refreshCandidates(s).then(changed);
        flush(id, s);
        if (Date.now() - s.lastPong > 3500) ready(id, s, false);
        if (s.channel?.readyState === "open") {
          heartbeat(id, s, "ping");
        } else if (Date.now() - s.lastPong > 15_000) close(id);
      }, 1000),
    };
    sessions.set(id, s);
    changed();
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && sessions.get(id) === s)
        post(id, "signal", JSON.stringify({ candidate: candidate.toJSON() }));
    };
    pc.onconnectionstatechange = () => {
      if (sessions.get(id) !== s) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        close(id);
      else if (pc.connectionState === "disconnected") ready(id, s, false);
      else if (pc.connectionState === "connected") void refreshCandidates(s);
    };
    pc.ondatachannel = ({ channel }) => attach(id, s, channel);
    if (value.initiator) {
      attach(
        id,
        s,
        pc.createDataChannel("wireguard", {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
      s.signaling = (async () => {
        const offer = await pc.createOffer();
        if (sessions.get(id) !== s) return;
        await pc.setLocalDescription(offer);
        if (sessions.get(id) !== s) return;
        post(
          id,
          "signal",
          JSON.stringify({ description: pc.localDescription }),
        );
      })().catch(() => close(id));
    }
  }
  return {
    onChange(callback: () => void) {
      changed = callback;
    },
    snapshot(): PeerTransport[] {
      const latest = new Map(
        history.map((stats) => [stats.peerNodeKey, stats]),
      );
      for (const { stats } of sessions.values())
        latest.set(stats.peerNodeKey, stats);
      return Array.from(latest.values(), (stats) => ({ ...stats }));
    },
    handle({
      session: id,
      kind,
      value,
    }: {
      session: number;
      kind: string;
      value: any;
    }) {
      if (kind === "start") {
        try {
          start(id, value);
        } catch {
          if (sessions.has(id)) close(id);
          else post(id, "closed");
        }
        return;
      }
      if (kind === "closed") {
        close(id);
        return;
      }
      const s = sessions.get(id);
      if (kind === "packet") {
        if (s && s.channel?.readyState === "open") {
          s.outbound.push(value);
          flush(id, s);
        } else {
          if (s) s.stats.droppedPackets++;
          post(id, "credit", value.byteLength);
        }
      } else if (s && kind === "received") {
        s.inboundPending = Math.max(0, s.inboundPending - value);
      } else if (s && kind === "signal") {
        if (++s.queuedSignals > 64) {
          close(id);
          return;
        }
        s.signaling = s.signaling
          .then(async () => {
            if (sessions.get(id) !== s) return;
            const signal = JSON.parse(value);
            if (signal.description) {
              await s.pc.setRemoteDescription(signal.description);
              if (sessions.get(id) !== s) return;
              for (const candidate of s.pending.splice(0)) {
                await s.pc.addIceCandidate(candidate);
                if (sessions.get(id) !== s) return;
              }
              if (signal.description.type === "offer") {
                const answer = await s.pc.createAnswer();
                if (sessions.get(id) !== s) return;
                await s.pc.setLocalDescription(answer);
                if (sessions.get(id) !== s) return;
                post(
                  id,
                  "signal",
                  JSON.stringify({ description: s.pc.localDescription }),
                );
              }
            } else if (signal.candidate) {
              if (s.pc.remoteDescription)
                await s.pc.addIceCandidate(signal.candidate);
              else if (s.pending.length < 64) s.pending.push(signal.candidate);
              else close(id);
            }
          })
          .catch(() => close(id))
          .finally(() => s.queuedSignals--);
      }
    },
    async stats(): Promise<TransportStats[]> {
      await Promise.all(Array.from(sessions.values(), refreshCandidates));
      return [...history, ...Array.from(sessions.values(), (s) => s.stats)].map(
        (s) => ({ ...s }),
      );
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) for (const id of sessions.keys()) close(id);
    },
    close() {
      enabled = false;
      for (const id of sessions.keys()) close(id);
    },
  };
}
export type WebRTCManager = ReturnType<typeof createWebRTC>;
