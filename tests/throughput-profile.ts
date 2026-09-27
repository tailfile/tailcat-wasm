import type { Page } from "@playwright/test";

// Chrome's sampling profiler can attach to the dedicated Go/WASM Worker as
// well as the page. Profiling is opt-in and runs after unprofiled samples.
export async function throughputProfiler(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const workers = new Set<string>();
  let next = 0;
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  function workerCall(sessionId: string, method: string) {
    return new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      void cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method }),
        })
        .catch(reject);
    });
  }
  cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type === "worker") workers.add(sessionId);
  });
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const data = JSON.parse(message);
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message));
    else request.resolve(data.result);
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  return {
    async start() {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
      for (const session of workers) {
        await workerCall(session, "Profiler.enable");
        await workerCall(session, "Profiler.start");
      }
    },
    async stop() {
      const profiles: { thread: string; profile: any }[] = [
        { thread: "page", profile: (await cdp.send("Profiler.stop")).profile },
      ];
      for (const session of workers)
        profiles.push({
          thread: "worker",
          profile: (await workerCall(session, "Profiler.stop")).profile,
        });
      return profiles;
    },
  };
}
