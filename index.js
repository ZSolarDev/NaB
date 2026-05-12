import http from "http";
import pkg from '@tomphttp/bare-server-node';
const { createBareServer } = pkg;
import { createClient } from "redis";
import { createReadStream, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Redis ---
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));
await redis.connect();
console.log("Connected to Redis");

// --- Bare Server ---
const bare = createBareServer("/bare/", {
  logErrors: false,
  maintainer: { email: "you@example.com", website: "https://yoursite.com" },
});

// --- Cookie jar helpers ---
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days in seconds

async function getCookies(sessionToken, hostname) {
  if (!sessionToken) return {};
  const key = `cookies:${sessionToken}:${hostname}`;
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : {};
}

async function setCookies(sessionToken, hostname, cookies) {
  if (!sessionToken) return;
  const key = `cookies:${sessionToken}:${hostname}`;
  await redis.set(key, JSON.stringify(cookies), { EX: COOKIE_TTL });
}

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function parseSetCookieHeader(headers) {
  const cookies = {};
  const setCookieValues = headers["set-cookie"] || [];
  for (const raw of Array.isArray(setCookieValues) ? setCookieValues : [setCookieValues]) {
    const [nameVal] = raw.split(";");
    const [name, ...rest] = nameVal.split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function buildCookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// Strip headers that prevent iframing
function stripRestrictiveHeaders(headers) {
  const stripped = { ...headers };
  delete stripped["x-frame-options"];
  delete stripped["content-security-policy"];
  delete stripped["x-content-type-options"];
  // Normalize to allow cross-origin access
  stripped["access-control-allow-origin"] = "*";
  return stripped;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // Handle bare server routes
  if (bare.shouldRoute(req)) {
    const sessionToken = req.headers["x-meridian-session"] || null;

    // Intercept to inject + save cookies
    const originalUrl = req.headers["x-bare-url"];
    let hostname = null;

    try {
      if (originalUrl) hostname = new URL(originalUrl).hostname;
    } catch {}

    if (hostname && sessionToken) {
      // Inject saved cookies into outgoing request
      const saved = await getCookies(sessionToken, hostname);
      if (Object.keys(saved).length > 0) {
        const existing = parseCookieHeader(req.headers["cookie"] || "");
        const merged = { ...saved, ...existing }; // existing takes priority
        req.headers["cookie"] = buildCookieString(merged);
      }
    }

    // Wrap bare routing to intercept response and save Set-Cookie
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let responseHeaders = null;

    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode, headers) => {
      if (headers) {
        responseHeaders = headers;
        const cleaned = stripRestrictiveHeaders(headers);

        // Save any cookies from this response
        if (hostname && sessionToken) {
          const newCookies = parseSetCookieHeader(cleaned);
          if (Object.keys(newCookies).length > 0) {
            getCookies(sessionToken, hostname).then((existing) => {
              setCookies(sessionToken, hostname, { ...existing, ...newCookies });
            });
          }
        }

        return originalWriteHead(statusCode, cleaned);
      }
      return originalWriteHead(statusCode, headers);
    };

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
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NAB/1.0)" },
      });
      const xfo = response.headers.get("x-frame-options") || "";
      const csp = response.headers.get("content-security-policy") || "";
      const xfoDenied = /deny|sameorigin/i.test(xfo);
      const cspDenied = /frame-ancestors\s+['"]\s*none\s*['"]|frame-ancestors\s+(?!'self')[^;]+/i.test(csp) && !/frame-ancestors\s+\*/i.test(csp);
      const frameable = !xfoDenied && !cspDenied;
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ frameable, xfo, status: response.status }));
    } catch (e) {
      // If we can't even fetch it, assume not frameable
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ frameable: false, error: e.message }));
    }
    return;
  }

  // Serve UV static files
  const uvPath = join(__dirname, "public", req.url === "/" ? "/index.html" : req.url);
  if (existsSync(uvPath)) {
    const ext = extname(uvPath);
    const mimeTypes = {
      ".html": "text/html",
      ".js":   "application/javascript",
      ".css":  "text/css",
      ".json": "application/json",
      ".png":  "image/png",
      ".ico":  "image/x-icon",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    createReadStream(uvPath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Handle bare server WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Meridian server running on port ${PORT}`);
});
