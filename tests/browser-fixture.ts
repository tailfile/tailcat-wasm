import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser } from "@playwright/test";
import { createStaticServer, serverPort } from "./static-server.ts";
import { benchBinary } from "../scripts/bench-binaries.ts";

export async function relayFixture() {
  const binary = benchBinary("derper");
  const temporary = await mkdtemp(join(tmpdir(), "tailcat-demo-"));
  const site = join(temporary, "site");
  const demo = join(site, "tailcat-wasm");
  const mapFile = join(demo, "derpmap-test.json");
  let relay: ReturnType<typeof spawn> | undefined;
  let host: ReturnType<typeof createStaticServer> | undefined;
  async function stopRelay() {
    if (relay && relay.exitCode === null) {
      relay.kill("SIGTERM");
      await once(relay, "exit");
    }
    relay = undefined;
  }
  async function close() {
    await host?.close();
    await stopRelay();
    await rm(temporary, { recursive: true, force: true });
  }
  try {
    // A project-page subdirectory catches accidental root-relative asset paths.
    await mkdir(demo, { recursive: true });
    for (const name of ["index.html", ".nojekyll", "dist"])
      await cp(new URL(`../${name}`, import.meta.url), join(demo, name), {
        recursive: true,
      });
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const certs = join(temporary, "certs");
    relay = spawn(
      binary,
      [
        "-a",
        `127.0.0.1:${port}`,
        "-http-port",
        "-1",
        "-stun=false",
        "-hostname",
        "127.0.0.1",
        "-certmode",
        "manual",
        "-certdir",
        certs,
        "-c",
        join(temporary, "derper.json"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let relayLog = "";
    relay.stderr!.on("data", (bytes) => {
      relayLog += bytes;
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await access(join(certs, "127.0.0.1.crt"));
        break;
      } catch {}
      if (Date.now() > deadline || relay.exitCode !== null)
        throw new Error(relayLog || "DERP fixture did not start");
      await delay(100);
    }
    await writeFile(
      mapFile,
      JSON.stringify({
        Regions: {
          900: {
            RegionID: 900,
            RegionCode: "local",
            RegionName: "Local test relay",
            Nodes: [
              {
                Name: "local",
                RegionID: 900,
                HostName: "127.0.0.1",
                IPv4: "127.0.0.1",
                IPv6: "none",
                DERPPort: port,
                STUNPort: -1,
                InsecureForTests: true,
              },
            ],
          },
        },
      }),
    );
    host = createStaticServer({ staticDir: site });
    host.server.listen(0, "127.0.0.1");
    await once(host.server, "listening");
    const base = `http://127.0.0.1:${serverPort(host.server)}/tailcat-wasm`;
    const response = await fetch(base);
    assert.equal(response.url, base + "/");
    assert.equal(
      await response.text(),
      await readFile(new URL("../index.html", import.meta.url), "utf8"),
    );
    await writeFile(
      join(demo, "transport-test.html"),
      "<!doctype html><title>Transport regression</title>",
    );
    return {
      base,
      siteDirectory: demo,
      caFile: join(certs, "127.0.0.1.crt"),
      stopRelay,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function browserFixture() {
  const fixture = await relayFixture();
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN || undefined,
      args: ["--no-sandbox", "--ignore-certificate-errors"],
    });
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return {
    ...fixture,
    browser,
    async close() {
      try {
        await browser.close();
      } finally {
        await fixture.close();
      }
    },
  };
}
