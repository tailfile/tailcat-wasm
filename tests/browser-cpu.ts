import { readdir, readFile } from "node:fs/promises";
import type { Browser } from "@playwright/test";

/** Linux CPU tick snapshots for only the processes owned by these browsers. */
export async function browserCPU(browsers: Browser[]) {
  const sessions = await Promise.all(
    browsers.map((b) => b.newBrowserCDPSession()),
  );
  return async () => {
    const rows: {
      pid: number;
      tid: number;
      type: string;
      name: string;
      ticks: number;
    }[] = [];
    for (const session of sessions) {
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      await Promise.all(
        processInfo.map(async (p) => {
          try {
            const tasks = await readdir(`/proc/${p.id}/task`);
            await Promise.all(
              tasks.map(async (tid) => {
                try {
                  const stat = await readFile(
                    `/proc/${p.id}/task/${tid}/stat`,
                    "utf8",
                  );
                  const end = stat.lastIndexOf(")");
                  const fields = stat.slice(end + 2).split(" ");
                  rows.push({
                    pid: p.id,
                    tid: Number(tid),
                    type: p.type,
                    name: stat.slice(stat.indexOf("(") + 1, end),
                    ticks: Number(fields[11]) + Number(fields[12]),
                  });
                } catch {
                  /* A thread can exit between listing and reading it. */
                }
              }),
            );
          } catch {
            /* A browser child process can exit during collection. */
          }
        }),
      );
    }
    return { at: performance.now(), rows };
  };
}
