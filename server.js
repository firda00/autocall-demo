// AutoCall — standalone server. Zero npm dependencies (Node >= 22).
//   node server.js        → http://localhost:4600
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

const { AutoCallEngine } = await import("./engine.js");
const { createDemoProvider } = await import("./providers/demo.js");
const { createOnlinePbxProvider } = await import("./providers/onlinepbx.js");

const PORT = Number(process.env.PORT || 4600);
const HOST = process.env.HOST || "127.0.0.1";
const PROVIDER = (process.env.AUTOCALL_PROVIDER || "demo").toLowerCase();
const ADMIN_TOKEN = process.env.AUTOCALL_ADMIN_TOKEN || "";

let provider;
if (PROVIDER === "onlinepbx") {
  if (process.env.AUTOCALL_REAL_CALLS_CONFIRMED !== "true") {
    console.error("Refusing to start real calls: set AUTOCALL_REAL_CALLS_CONFIRMED=true in .env");
    process.exit(1);
  }
  provider = createOnlinePbxProvider();
} else {
  provider = createDemoProvider();
}

const engine = new AutoCallEngine({ provider, dataFile: path.join(ROOT, "data", `state.${PROVIDER}.json`) });
engine.start(1000);

// ---------- seed demo data on first run ----------
export function seedDemo() {
  if (!engine.state.managers.length) {
    engine.addManager({ name: "Muxlisa", extension: "104" });
    engine.addManager({ name: "Xonzoda", extension: "106" });
  }
  const [m1, m2] = engine.state.managers;
  const sample = [
    ["Aziz Karimov", "998901234501", m1], ["Dilnoza Rahimova", "998935557712", m2],
    ["Jasur Toshmatov", "998977771100", m1], ["Malika Yusupova", "998946663377", m2],
    ["Sardor Aliyev", "998998881299", m1], ["Nilufar Saidova", "998909994455", m2],
    ["Bekzod Ergashev", "998881112233", m1], ["Kamola Nazarova", "998951231277", m2],
  ];
  for (const [name, phone, m] of sample) {
    try { engine.addLead({ name, phone, managerId: m?.id }); } catch { /* already exists */ }
  }
}
if (PROVIDER === "demo" && !engine.state.managers.length && !engine.state.leads.length) seedDemo();

// ---------- SSE ----------
const clients = new Set();
let pending = null;
engine.on("change", () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 120);
});
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000);

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error("payload_too_large"), { code: 413 }); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid_json"), { code: 400 }); }
}

const routes = [
  ["GET", /^\/api\/state$/, () => engine.snapshot()],
  ["POST", /^\/api\/run\/start$/, () => engine.startRun()],
  ["POST", /^\/api\/run\/stop$/, () => (engine.stopRun(), { ok: true })],
  ["POST", /^\/api\/reset$/, () => (engine.reset(), { ok: true })],
  ["POST", /^\/api\/demo\/seed$/, () => (engine.wipe(), seedDemo(), { ok: true })],
  ["POST", /^\/api\/settings$/, (b) => engine.updateSettings(b)],
  ["POST", /^\/api\/managers$/, (b) => engine.addManager(b)],
  ["DELETE", /^\/api\/managers\/([\w-]+)$/, (b, [id]) => (engine.removeManager(id), { ok: true })],
  ["POST", /^\/api\/managers\/([\w-]+)\/shift$/, (b, [id]) => engine.setShift(id, b.onShift)],
  ["POST", /^\/api\/leads$/, (b) => engine.addLead(b)],
  ["POST", /^\/api\/leads\/bulk$/, (b) => engine.addLeadsBulk(b.text, b.managerId)],
  ["PATCH", /^\/api\/leads\/([\w-]+)$/, (b, [id]) => engine.updateLead(id, b)],
  ["DELETE", /^\/api\/leads\/([\w-]+)$/, (b, [id]) => (engine.removeLead(id), { ok: true })],
  ["POST", /^\/api\/leads\/([\w-]+)\/call$/, (b, [id]) => engine.callNow(id)],
  ["POST", /^\/api\/blacklist$/, (b) => (engine.addBlacklist(b.phone), { ok: true })],
  ["DELETE", /^\/api\/blacklist\/(\d+)$/, (b, [phone]) => (engine.removeBlacklist(phone), { ok: true })],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (ADMIN_TOKEN && req.headers["x-admin-token"] !== ADMIN_TOKEN && url.searchParams.get("token") !== ADMIN_TOKEN) return send(res, 401, { error: "unauthorized" });
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      for (const [method, re, handler] of routes) {
        const m = req.method === method && re.exec(url.pathname);
        if (!m) continue;
        const body = method === "GET" ? {} : await readJson(req);
        return send(res, 200, await handler(body, m.slice(1)));
      }
      return send(res, 404, { error: "not_found" });
    }
    const file = path.normalize(path.join(ROOT, "public", url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, Number(e.code) >= 400 && Number(e.code) < 600 ? Number(e.code) : 500, { error: e.message || "error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  AutoCall (${PROVIDER === "onlinepbx" ? "onlinePBX — REAL CALLS" : "demo mode — no real calls"})`);
  console.log(`  → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}\n`);
});
