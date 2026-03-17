// proxy-server.js — Multi-Agent Round Table
// Lee API keys desde .env y las inyecta automáticamente
const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const PORT  = 8080;

// ── .env loader ───────────────────────────────────────────────
function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) { console.log("⚠️  .env no encontrado"); return {}; }
  const env = {};
  fs.readFileSync(p, "utf8").split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    const idx = line.indexOf("=");
    if (idx < 0) return;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (k && v) env[k] = v;
  });
  const found = Object.keys(env).filter(k => k.endsWith("_API_KEY"));
  console.log("✅ .env cargado —", found.length ? "keys: " + found.join(", ") : "ninguna key encontrada");
  return env;
}
const ENV = loadEnv();

// ── Provider map ──────────────────────────────────────────────
const PROVIDERS = {
  "/proxy/anthropic": { host: "api.anthropic.com",                  envKey: "ANTHROPIC_API_KEY", type: "anthropic" },
  "/proxy/openai":    { host: "api.openai.com",                     envKey: "OPENAI_API_KEY",    type: "bearer"    },
  "/proxy/gemini":    { host: "generativelanguage.googleapis.com",  envKey: "GEMINI_API_KEY",    type: "gemini"    },
  "/proxy/groq":      { host: "api.groq.com",                       envKey: "GROQ_API_KEY",      type: "bearer"    },
  "/proxy/deepseek":  { host: "api.deepseek.com",                   envKey: "DEEPSEEK_API_KEY",  type: "bearer"    },
  "/proxy/mistral":   { host: "api.mistral.ai",                     envKey: "MISTRAL_API_KEY",   type: "bearer"    },
  "/proxy/xai":       { host: "api.x.ai",                           envKey: "XAI_API_KEY",       type: "bearer"    },
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".json":"application/json" };

// ── Helpers ───────────────────────────────────────────────────
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// ── Server ────────────────────────────────────────────────────
http.createServer(async (req, res) => {

  // CORS preflight
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // /proxy/keys — qué keys están disponibles en .env
  if (req.url === "/proxy/keys") {
    const out = {};
    Object.entries(PROVIDERS).forEach(([route, cfg]) => out[route] = !!ENV[cfg.envKey]);
    return sendJson(res, 200, out);
  }

  // Buscar proveedor por prefijo
  const providerKey = Object.keys(PROVIDERS).find(k => req.url.startsWith(k));

  if (providerKey) {
    const cfg = PROVIDERS[providerKey];
    const apiKey = ENV[cfg.envKey] || "";
    let targetPath = req.url.slice(providerKey.length) || "/";
    if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

    const body = await readBody(req);

    // Construir headers limpios
    const headers = {
      "host":           cfg.host,
      "content-type":   "application/json",
      "content-length": String(body.length),
      "accept":         "application/json",
    };

    // Inyectar API key según el tipo de proveedor
    if (apiKey) {
      if (cfg.type === "anthropic") {
        headers["x-api-key"]         = apiKey;
        headers["anthropic-version"] = "2023-06-01";
        // NO añadir anthropic-dangerous-direct-browser-access — no aplica en servidor
      } else if (cfg.type === "bearer") {
        headers["authorization"] = "Bearer " + apiKey;
      } else if (cfg.type === "gemini") {
        // Gemini usa query param — reemplazar cualquier key del cliente
        targetPath = targetPath.replace(/([?&])key=[^&]*/g, "");
        const sep = targetPath.includes("?") ? "&" : "?";
        targetPath += sep + "key=" + apiKey;
      }
    } else {
      // Sin key en .env — reenviar lo que mande el cliente
      if (req.headers["x-api-key"])     headers["x-api-key"]     = req.headers["x-api-key"];
      if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
      if (req.headers["anthropic-version"]) headers["anthropic-version"] = req.headers["anthropic-version"];
    }

    console.log(`→ ${cfg.type.toUpperCase()} ${req.method} ${targetPath.split("?")[0]} [key:${apiKey?"✅ .env":"❌ sin key"}]`);

    const proxyReq = https.request({
      hostname: cfg.host,
      port: 443,
      path: targetPath,
      method: req.method,
      headers,
    }, proxyRes => {
      const ct = proxyRes.headers["content-type"] || "application/json";
      res.writeHead(proxyRes.statusCode, { "content-type": ct, ...CORS });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", err => {
      console.error("Proxy error:", err.message);
      sendJson(res, 502, { error: { message: "Proxy error: " + err.message } });
    });

    proxyReq.write(body);
    proxyReq.end();
    return;
  }

  // Archivos estáticos
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end("Forbidden"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, "index.html"), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html", ...CORS });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", ...CORS });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║   Multi-Agent Round Table — Proxy      ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  ✅ http://localhost:${PORT}              ║`);
  console.log("║  Ctrl+C para detener                   ║");
  console.log("╚════════════════════════════════════════╝\n");
});
