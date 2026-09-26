import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Static HTTP fixture for browser tests. The demo needs no custom server. */
export function createStaticServer({ staticDir }: { staticDir: string }) {
  const root = resolve(staticDir);
  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-cache");
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(405).end();
      return;
    }
    let pathname: string;
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname.split("/").some((part) => part.startsWith("."))) {
      response.writeHead(403).end();
      return;
    }
    let file = resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        response
          .writeHead(308, { Location: url.pathname + "/" + url.search })
          .end();
        return;
      }
      file = resolve(file, "index.html");
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader(
      "Content-Type",
      mime[extname(file)] || "application/octet-stream",
    );
    if (pathname.startsWith("/assets/"))
      response.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable",
      );
    response.setHeader("Content-Length", statSync(file).size);
    if (request.method === "HEAD") response.end();
    else
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
  });
  return {
    server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function serverPort(server: {
  address(): import("node:net").AddressInfo | string | null;
}) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a listening TCP server");
  return address.port;
}
