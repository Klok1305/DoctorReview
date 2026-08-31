const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "mobile-pilot");
const args = process.argv.slice(2);
const requestedPort = Number(args.find((value) => /^\d+$/.test(value)) || 4173);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 4173;
const host = args.includes("--lan") ? "0.0.0.0" : "127.0.0.1";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (!req.url || !["GET", "HEAD"].includes(req.method || "")) {
    send(res, 405, "Method not allowed");
    return;
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).replace(/^\/+/, "") || "index.html";
  } catch {
    send(res, 400, "Bad request");
    return;
  }

  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    const target = !statError && stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    fs.readFile(target, (readError, data) => {
      if (readError) {
        send(res, readError.code === "ENOENT" ? 404 : 500, readError.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }
      const extension = path.extname(target).toLowerCase();
      const cacheControl = ["index.html", "service-worker.js", "manifest.webmanifest"].includes(path.basename(target)) ? "no-cache" : "public, max-age=3600";
      res.writeHead(200, {
        "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": cacheControl,
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      if (req.method === "HEAD") res.end(); else res.end(data);
    });
  });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (host === "127.0.0.1") {
    console.log(`КлинВект mobile pilot: http://127.0.0.1:${actualPort}/`);
    return;
  }
  const localAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${actualPort}/`);
  console.log(`КлинВект mobile pilot (LAN):\n${localAddresses.join("\n") || `http://127.0.0.1:${actualPort}/`}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
