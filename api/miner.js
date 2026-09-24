const BACKENDS = [
  {
    url: (process.env.MINER_BACKEND_URL_1 || process.env.MINER_BACKEND_URL || "").replace(/\/+$/, ""),
    token: process.env.MINER_CONTROL_TOKEN_1 || process.env.MINER_CONTROL_TOKEN || "",
  },
  {
    url: (process.env.MINER_BACKEND_URL_2 || "").replace(/\/+$/, ""),
    token: process.env.MINER_CONTROL_TOKEN_2 || process.env.MINER_CONTROL_TOKEN || "",
  },
];

function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

function parseSlot(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "1" || raw === undefined) return 0;
  if (raw === "2") return 1;
  return null;
}

async function upstream(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(baseUrl + path, {
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

  const slot = parseSlot(req.query.slot);
  if (slot === null) {
    res.status(400).json({ error: "slot must be 1 or 2." });
    return;
  }

  const backend = BACKENDS[slot];
  if (!backend.url) {
    res.status(503).json({
      error: `Miner ${slot + 1} is not configured in Vercel.`,
      slot: slot + 1,
    });
    return;
  }

  if (req.method === "GET") {
    try {
      const response = await upstream(backend.url, "/stats", {
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      res.status(response.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? `Could not reach Miner ${slot + 1}: ${error.message}`
            : `Could not reach Miner ${slot + 1}.`,
        slot: slot + 1,
      });
    }
    return;
  }

  if (req.method === "POST") {
    if (!backend.token) {
      res.status(503).json({
        error: `MINER_CONTROL_TOKEN_${slot + 1} is not configured in Vercel.`,
        slot: slot + 1,
      });
      return;
    }

    const raw = Array.isArray(req.query.action) ? req.query.action[0] : req.query.action;
    if (raw !== "start" && raw !== "stop") {
      res.status(400).json({ error: "action must be start or stop." });
      return;
    }

    try {
      const response = await upstream(backend.url, "/control/" + raw, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + backend.token,
        },
      });
      const text = await response.text();
      res.status(response.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? `Could not control Miner ${slot + 1}: ${error.message}`
            : `Could not control Miner ${slot + 1}.`,
        slot: slot + 1,
      });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed." });
};
