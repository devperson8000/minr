const BACKEND_URL = (process.env.MINER_BACKEND_URL || "").replace(/\/+$/, "");
const CONTROL_TOKEN = process.env.MINER_CONTROL_TOKEN || "";

function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

async function upstream(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(BACKEND_URL + path, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  securityHeaders(res);

  if (!BACKEND_URL) {
    res.status(503).json({ error: "MINER_BACKEND_URL is not configured in Vercel." });
    return;
  }

  if (req.method === "GET") {
    try {
      const response = await upstream("/stats", {
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      res.status(response.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? "Could not reach the Northflank miner: " + error.message : "Could not reach the Northflank miner.",
      });
    }
    return;
  }

  if (req.method === "POST") {
    if (!CONTROL_TOKEN) {
      res.status(503).json({ error: "MINER_CONTROL_TOKEN is not configured in Vercel." });
      return;
    }

    const raw = Array.isArray(req.query.action) ? req.query.action[0] : req.query.action;
    if (raw !== "start" && raw !== "stop") {
      res.status(400).json({ error: "action must be start or stop." });
      return;
    }

    try {
      const response = await upstream("/control/" + raw, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + CONTROL_TOKEN,
        },
      });
      const text = await response.text();
      res.status(response.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? "Could not control the Northflank miner: " + error.message : "Could not control the Northflank miner.",
      });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed." });
};
