import http from "http";
import { createBareServer } from "@tomphttp/bare-server-node";
import { createReadStream, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Bare Server ---
const bare = createBareServer("/bare/", {
  logErrors: false,
  maintainer: { email: "you@example.com", website: "https://yoursite.com" },
});

// --- MIME types ---
const mimeTypes = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".txt":  "text/plain",
};

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // Handle bare server routes
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
    return;
  }

  // ── /check/?url=... — tells the client if a URL is frameable ──
  if (req.url.startsWith("/check/")) {
    const params = new URL(req.url, "http://localhost").searchParams;
    const target = params.get("url");
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (!target) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: "missing url" }));
      return;
    }
    try {
      const response = await fetch(target, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NaB/1.0)" },
      });
      const xfo = response.headers.get("x-frame-options") || "";
      const csp = response.headers.get("content-security-policy") || "";
      const xfoDenied = /deny|sameorigin/i.test(xfo);
      const cspDenied =
        /frame-ancestors\s+['"]\s*none\s*['"]|frame-ancestors\s+(?!'self')[^;]+/i.test(csp) &&
        !/frame-ancestors\s+\*/i.test(csp);
      const frameable = !xfoDenied && !cspDenied;
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ frameable, xfo, status: response.status, finalUrl: response.url }));
    } catch (e) {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ frameable: false, error: e.message }));
    }
    return;
  }

  // Shim for baremux.js (not shipped in bare-mux v2 dist)
  if (req.url === '/baremux/baremux.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
    res.end(`(async () => { const m = await import('/baremux/index.mjs'); window.BareMux = m; })();`);
    return;
  }

  if (req.url.startsWith('/epoxy/')) {
  const epoxyFile = req.url.replace('/epoxy/', '');
  const epoxyPath = join(__dirname, 'node_modules/@mercuryworkshop/epoxy-transport/dist', epoxyFile);
  if (existsSync(epoxyPath)) {
    const ext = extname(epoxyPath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(epoxyPath).pipe(res);
    return;
  }
  }

  if (req.url === '/debug-files') {
  const { readdirSync } = await import('fs');
  const dirs = [
    'node_modules/@mercuryworkshop/epoxy-transport',
    'node_modules/@mercuryworkshop/epoxy-transport/dist',
  ];
  let out = '';
  for (const d of dirs) {
    try {
      const files = readdirSync(join(__dirname, d));
      out += `\n${d}:\n  ${files.join('\n  ')}`;
    } catch (e) {
      out += `\n${d}: ERROR - ${e.message}`;
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(out);
  return;
  }

  // Serve static files from public/
  const urlPath = req.url.split("?")[0];
  const filePath = join(__dirname, "public", urlPath === "/" ? "index.html" : urlPath);

  if (existsSync(filePath)) {
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "text/plain",
      "Access-Control-Allow-Origin": "*",
      "Service-Worker-Allowed": "/",
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
  } else if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`NaB server running on port ${PORT}`);
});
