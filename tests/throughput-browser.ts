// This function is serialized by Playwright; keep all browser helpers inside it.
export async function setupThroughput(config: {
  base: string;
  assets: string;
  kind: "raw" | "wrapped" | "bridge" | "tailcat";
  mtu: number;
  chunk: number;
  reliable?: boolean;
  rawBuffer?: number;
  verify?: boolean;
  derp?: boolean;
}) {
  const w = window as any;
  const { base, assets, kind, mtu, chunk, reliable } = config;
  const rawBuffer = config.rawBuffer ?? 256 * 1024;
  const absoluteNow = () => performance.timeOrigin + performance.now();
  w.peers = [];
  w.states = [];
  w.pcs = [];
  const OriginalPC = RTCPeerConnection;
  w.RTCPeerConnection = class extends OriginalPC {
    constructor(options: RTCConfiguration) {
      super(options);
      w.pcs.push(this);
    }
  };
  w.prepare = (target: number) => {
    w.target = target;
    w.received = 0;
    w.corrupt = 0;
    w.duplicates = 0;
    w.ended = 0;
    w.reported = false;
    w.seen = new Uint8Array(Math.ceil(target / mtu));
  };
  function receive(bytes: Uint8Array, datagram: boolean) {
    let offset = 0;
    if (datagram) {
      const sequence = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
        0,
      );
      if (sequence >= w.seen.length || w.seen[sequence]) w.duplicates++;
      else w.seen[sequence] = 1;
      offset = 4;
    }
    // Verify payload bytes unless this is an explicit count-only diagnostic.
    // Sender write completion alone is never counted as goodput.
    for (; config.verify !== false && offset < bytes.length; offset++) {
      if (bytes[offset] !== 37) w.corrupt++;
    }
    w.received += bytes.byteLength;
    w.ended = absoluteNow();
    if (kind === "raw" && reliable && w.received === w.target && !w.reported) {
      w.reported = true;
      w.channel.send(JSON.stringify({ kind: "receipt", bytes: w.received }));
    }
  }
  w.prepare(0);
  if (kind === "tailcat") {
    // Keep browser imports native when Vitest transforms the host module.
    const { createTailcat } = await new Function("url", "return import(url)")(
      assets + "/index.js",
    );
    w.accept = (connection: any) => {
      w.conn = connection;
      w.readTask = (async () => {
        for (;;) {
          const bytes = await connection.read();
          if (!bytes) return;
          receive(bytes, false);
        }
      })().catch((e: unknown) => (w.error = String(e)));
    };
    w.runtime = await createTailcat({
      tunnelMTU: mtu,
      webRTC: config.derp ? false : { iceServers: [] },
      onConnection: w.accept,
      onTransportChange(peers: any[]) {
        w.peers = peers;
        const state = peers.map((p) => p.state).join(",");
        if (state !== w.states.at(-1)?.state)
          w.states.push({
            state,
            at: absoluteNow(),
            reason: peers[0]?.fallbackReason,
          });
      },
      onError(error: unknown) {
        w.error = String(error);
      },
    });
    w.run = async (total: number) => {
      const bytes = new Uint8Array(chunk).fill(37);
      w.started = absoluteNow();
      for (let n = 0; n < total; n += chunk)
        await w.conn.write(bytes.subarray(0, Math.min(chunk, total - n)));
      return w.started;
    };
    return w.runtime.listen(base + "/derpmap-test.json");
  }
  if (kind === "raw") {
    const pc = new RTCPeerConnection({ iceServers: [] });
    w.pc = pc;
    w.attach = (channel: RTCDataChannel) => {
      w.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = rawBuffer / 2;
      channel.onmessage = ({ data }) => {
        if (typeof data === "string") {
          const receipt = JSON.parse(data);
          if (receipt.kind !== "receipt" || receipt.bytes !== w.expectedTotal)
            throw new Error("Unexpected benchmark receipt");
          w.receiptAt = absoluteNow();
        } else receive(new Uint8Array(data), true);
      };
    };
    pc.ondatachannel = ({ channel }) => w.attach(channel);
    // Wait for complete host candidates; signaling isn't part of timed work.
    w.description = async (offer: boolean) => {
      await pc.setLocalDescription(
        offer ? await pc.createOffer() : await pc.createAnswer(),
      );
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve) => {
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") resolve();
          });
        });
      return pc.localDescription!.toJSON();
    };
    w.open = () =>
      w.attach(
        pc.createDataChannel(
          "benchmark",
          reliable ? {} : { ordered: false, maxRetransmits: 2 },
        ),
      );
    w.run = async (total: number, warmup = false) => {
      let sequence = 0;
      w.receiptAt = 0;
      w.expectedTotal = total;
      const bytes = new Uint8Array(mtu).fill(37);
      const view = new DataView(bytes.buffer);
      const channel = w.channel as RTCDataChannel;
      w.started = absoluteNow();
      for (let n = 0; n < total; n += mtu) {
        const length = Math.min(mtu, total - n);
        if (channel.bufferedAmount + length > rawBuffer)
          await new Promise<void>((resolve) =>
            channel.addEventListener("bufferedamountlow", () => resolve(), {
              once: true,
            }),
          );
        view.setUint32(0, sequence++);
        channel.send(bytes.subarray(0, length));
        const allowance = 65536 * 2 ** Math.floor(n / (1024 * 1024));
        if (warmup && n < 4 * 1024 * 1024 && n % allowance === 0)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return w.started;
    };
  } else {
    const { createWebRTC } = await new Function("url", "return import(url)")(
      assets + "/webrtc.js",
    );
    let bridge: Worker | undefined;
    let startedResolve: (value: number) => void;
    let prepareResolve: () => void;
    if (kind === "bridge") {
      function syntheticWorker() {
        const scope = self as any;
        let mtu = 8192,
          target = 0,
          received = 0,
          corrupt = 0,
          duplicates = 0;
        let seen = new Uint8Array(),
          pending = 0,
          remaining = 0,
          sequence = 0,
          started = 0;
        let warming = false,
          burst = 0,
          produced = 0;
        let resume: ReturnType<typeof setTimeout> | undefined;
        function pump() {
          while (
            remaining &&
            pending + Math.min(mtu, remaining) <= 1024 * 1024
          ) {
            if (
              warming &&
              produced < 4 * 1024 * 1024 &&
              burst >= 65536 * 2 ** Math.floor(produced / (1024 * 1024))
            ) {
              resume ??= setTimeout(() => {
                resume = undefined;
                burst = 0;
                pump();
              }, 5);
              break;
            }
            const bytes = new Uint8Array(Math.min(mtu, remaining)).fill(37);
            burst += bytes.length;
            produced += bytes.length;
            new DataView(bytes.buffer).setUint32(0, sequence++);
            remaining -= bytes.length;
            pending += bytes.length;
            scope.postMessage(
              { event: "rtc", session: 1, kind: "packet", value: bytes },
              [bytes.buffer],
            );
          }
          if (!remaining && started) {
            scope.postMessage({ event: "sent", started });
            started = 0;
          }
        }
        scope.onmessage = ({ data }: MessageEvent) => {
          if (data.command === "prepare") {
            target = data.target;
            mtu = data.mtu;
            received = corrupt = duplicates = 0;
            seen = new Uint8Array(Math.ceil(target / mtu));
            scope.postMessage({ event: "prepared" });
          } else if (data.command === "run") {
            warming = data.warmup;
            burst = produced = 0;
            remaining = data.total;
            mtu = data.mtu;
            sequence = 0;
            started = performance.timeOrigin + performance.now();
            pump();
          } else if (data.args?.kind === "credit") {
            pending -= data.args.value;
            pump();
          } else if (data.args?.kind === "packet") {
            const { value: bytes, sequence } = data.args;
            const index = new DataView(
              bytes.buffer,
              bytes.byteOffset,
            ).getUint32(0);
            if (index >= seen.length || seen[index]) duplicates++;
            else seen[index] = 1;
            for (let i = 4; i < bytes.length; i++)
              if (bytes[i] !== 37) corrupt++;
            received += bytes.length;
            scope.postMessage({
              event: "rtc",
              session: 1,
              kind: "received",
              value: { bytes: bytes.byteLength, sequence, accepted: true },
              counters: {
                received,
                corrupt,
                duplicates,
                ended: performance.timeOrigin + performance.now(),
              },
            });
          }
        };
      }
      const url = URL.createObjectURL(
        new Blob([`(${syntheticWorker.toString()})()`], {
          type: "text/javascript",
        }),
      );
      bridge = new Worker(url);
      URL.revokeObjectURL(url);
      bridge.onerror = (event) => {
        w.error = event.message;
      };
      bridge.onmessage = ({ data }) => {
        if (data.event === "sent") startedResolve(data.started);
        else if (data.event === "prepared") prepareResolve();
        else {
          if (data.counters) Object.assign(w, data.counters);
          w.manager.handle(data);
        }
      };
      const prepare = w.prepare;
      w.prepare = (target: number) =>
        new Promise<void>((resolve) => {
          prepare(target);
          prepareResolve = resolve;
          bridge!.postMessage({ command: "prepare", target, mtu });
        });
    }
    let pending = 0;
    let pumping = false;
    let warming = false,
      burst = 0,
      produced = 0;
    let resume: ReturnType<typeof setTimeout> | undefined;
    let remaining = 0;
    let sequence = 0;
    let finished: (started: number) => void;
    function pump() {
      if (pumping) return;
      pumping = true;
      while (remaining && pending + Math.min(mtu, remaining) <= 1024 * 1024) {
        if (
          warming &&
          produced < 4 * 1024 * 1024 &&
          burst >= 65536 * 2 ** Math.floor(produced / (1024 * 1024))
        ) {
          resume ??= setTimeout(() => {
            resume = undefined;
            burst = 0;
            pump();
          }, 5);
          break;
        }
        const bytes = new Uint8Array(Math.min(mtu, remaining)).fill(37);
        burst += bytes.length;
        produced += bytes.length;
        new DataView(bytes.buffer).setUint32(0, sequence++);
        remaining -= bytes.length;
        pending += bytes.length;
        w.manager.handle({ session: 1, kind: "packet", value: bytes });
      }
      pumping = false;
      if (!remaining) finished?.(w.started);
    }
    w.manager = createWebRTC(
      { iceServers: [] },
      (message: any, transfer: ArrayBuffer[] = []) => {
        const { kind, value, sequence } = message.args;
        if (kind === "signal") void w.signal(value);
        else if (bridge) bridge.postMessage(message, transfer);
        else if (kind === "credit") {
          pending -= value;
          pump();
        } else if (kind === "packet") {
          receive(value, true);
          w.manager.handle({
            session: 1,
            kind: "received",
            value: { bytes: value.byteLength, sequence, accepted: true },
          });
        }
      },
      true,
      mtu,
    );
    w.manager.onChange(() => {
      w.peers = w.manager.snapshot();
      const state = w.peers.map((p: any) => p.state).join(",");
      if (state !== w.states.at(-1)?.state)
        w.states.push({
          state,
          at: absoluteNow(),
          reason: w.peers[0]?.fallbackReason,
        });
    });
    w.run = (total: number, warmup = false) =>
      new Promise<number>((resolve) => {
        if (bridge) {
          startedResolve = resolve;
          bridge.postMessage({ command: "run", total, mtu, warmup });
          return;
        }
        warming = warmup;
        burst = produced = 0;
        finished = resolve;
        remaining = total;
        sequence = 0;
        w.started = absoluteNow();
        pump();
      });
  }
  return null;
}
