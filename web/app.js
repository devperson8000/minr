const ui = {
  pill: document.getElementById("status-pill"),
  status: document.getElementById("status-text"),
  hashRate: document.getElementById("hash-rate"),
  height: document.getElementById("height"),
  accepted: document.getElementById("accepted"),
  uptime: document.getElementById("uptime"),
  workers: document.getElementById("workers"),
  phase: document.getElementById("phase"),
  toggle: document.getElementById("toggle"),
  buttonIcon: document.getElementById("button-icon"),
  buttonLabel: document.getElementById("button-label"),
  error: document.getElementById("error"),
  acceptedBanner: document.getElementById("accepted-banner"),
  acceptedCopy: document.getElementById("accepted-copy"),
  refresh: document.getElementById("refresh-state"),

  walletEarnedKnx: document.getElementById("wallet-earned-knx"),
  walletValueAud: document.getElementById("wallet-value-aud"),
  sessionEarnedKnx: document.getElementById("session-earned-knx"),
  sessionValueAud: document.getElementById("session-value-aud"),
  walletBlocks: document.getElementById("wallet-blocks"),
  currentReward: document.getElementById("current-reward"),
  marketPrice: document.getElementById("market-price"),
  lastWin: document.getElementById("last-win"),
  lastWinDetail: document.getElementById("last-win-detail"),

  averageRate: document.getElementById("average-rate"),
  peakRate: document.getElementById("peak-rate"),
  totalHashes: document.getElementById("total-hashes"),
  jobsStarted: document.getElementById("jobs-started"),
  staleJobs: document.getElementById("stale-jobs"),
  staleRate: document.getElementById("stale-rate"),

  chartPeak: document.getElementById("chart-peak"),
  chartTotalHashes: document.getElementById("chart-total-hashes"),
  hashWindow: document.getElementById("hash-window"),
  hashSamples: document.getElementById("hash-samples"),
  heightRange: document.getElementById("height-range"),
  hashChart: document.getElementById("hash-chart"),
  workChart: document.getElementById("work-chart"),
  hashChartEmpty: document.getElementById("hash-chart-empty"),
  workChartEmpty: document.getElementById("work-chart-empty"),
};

let stats = null;
let busy = false;
let lastAcceptedHeight = null;
let lastHistory = [];

function formatRate(value) {
  const rate = Number(value || 0);
  if (rate >= 1e9) return (rate / 1e9).toFixed(2) + " GH/s";
  if (rate >= 1e6) return (rate / 1e6).toFixed(2) + " MH/s";
  if (rate >= 1e3) return (rate / 1e3).toFixed(1) + " kH/s";
  return Math.round(rate).toLocaleString() + " H/s";
}

function formatUptime(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours + "h " + minutes + "m";
}

function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number) >= 1e12) return (number / 1e12).toFixed(2) + "T";
  if (Math.abs(number) >= 1e9) return (number / 1e9).toFixed(2) + "B";
  if (Math.abs(number) >= 1e6) return (number / 1e6).toFixed(2) + "M";
  if (Math.abs(number) >= 1e3) return (number / 1e3).toFixed(1) + "k";
  return Math.round(number).toLocaleString();
}

function formatKnx(shards) {
  let value;
  try {
    value = BigInt(String(shards ?? "0"));
  } catch {
    value = 0n;
  }
  const base = 100000000n;
  const whole = value / base;
  const fraction = (value % base).toString().padStart(8, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const decimals = trimmed.length > 2 ? trimmed : trimmed.padEnd(2, "0");
  return whole.toLocaleString("en-US") + (decimals ? "." + decimals : "");
}

function formatAudCents(cents) {
  let value;
  try {
    value = BigInt(String(cents ?? "0"));
  } catch {
    value = 0n;
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return (negative ? "-" : "") + "A$" + whole.toLocaleString("en-US") + "." + fraction;
}

function formatMarketPrice(cents) {
  const value = Number(cents || 0);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const decimals = value < 10 ? 4 : 2;
  return "A$" + (value / 100).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function relativeTime(iso) {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

function formatWindow(seconds) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return value + "s window";
  return Math.max(1, Math.round(value / 60)) + "m window";
}

function totalHashes(next) {
  return Number(next.total_attempts || 0) + Number(next.current_job_attempts || 0);
}

function chartPalette() {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#89ffba",
    muted: style.getPropertyValue("--muted").trim() || "#7e8a83",
    line: "rgba(255,255,255,.075)",
    text: "#657069",
  };
}

function drawLineChart(canvas, points, key, valueFormatter, emptyElement) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const valid = (points || [])
    .map((point) => ({ ...point, value: Number(point[key]) }))
    .filter((point) => Number.isFinite(point.value));

  if (valid.length < 2) {
    emptyElement?.classList.remove("hidden");
    return;
  }
  emptyElement?.classList.add("hidden");

  const palette = chartPalette();
  const pad = { left: 54, right: 14, top: 16, bottom: 28 };
  const width = rect.width - pad.left - pad.right;
  const height = rect.height - pad.top - pad.bottom;

  let min = Math.min(...valid.map((point) => point.value));
  let max = Math.max(...valid.map((point) => point.value));
  if (min === max) {
    const spread = Math.max(1, Math.abs(max) * 0.08);
    min = Math.max(0, min - spread);
    max += spread;
  } else {
    const spread = (max - min) * 0.12;
    min = Math.max(0, min - spread);
    max += spread;
  }

  const xAt = (index) => pad.left + (index / (valid.length - 1)) * width;
  const yAt = (value) => pad.top + (1 - (value - min) / (max - min)) * height;

  ctx.font = '10px ui-monospace, "SFMono-Regular", Consolas, monospace';
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 3; i += 1) {
    const ratio = i / 3;
    const y = pad.top + ratio * height;
    const value = max - ratio * (max - min);
    ctx.strokeStyle = palette.line;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(rect.width - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = palette.text;
    ctx.textAlign = "right";
    ctx.fillText(valueFormatter(value), pad.left - 8, y);
  }

  const firstTime = Number(valid[0].time || 0) * 1000;
  const lastTime = Number(valid[valid.length - 1].time || 0) * 1000;
  const timeLabel = (time) =>
    time
      ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

  ctx.fillStyle = palette.text;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(timeLabel(firstTime), pad.left, rect.height - 7);
  ctx.textAlign = "right";
  ctx.fillText(timeLabel(lastTime), rect.width - pad.right, rect.height - 7);

  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + height);
  gradient.addColorStop(0, "rgba(137,255,186,.18)");
  gradient.addColorStop(1, "rgba(137,255,186,0)");

  ctx.beginPath();
  valid.forEach((point, index) => {
    const x = xAt(index);
    const y = yAt(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xAt(valid.length - 1), pad.top + height);
  ctx.lineTo(xAt(0), pad.top + height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  valid.forEach((point, index) => {
    const x = xAt(index);
    const y = yAt(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function renderCharts(history) {
  lastHistory = Array.isArray(history) ? history : [];
  drawLineChart(ui.hashChart, lastHistory, "hash_rate_hs", formatRate, ui.hashChartEmpty);
  drawLineChart(
    ui.workChart,
    lastHistory,
    "total_hashes",
    (value) => formatCompact(value),
    ui.workChartEmpty,
  );

  ui.hashSamples.textContent = lastHistory.length.toLocaleString() + " samples";

  if (lastHistory.length > 1) {
    const first = lastHistory[0];
    const last = lastHistory[lastHistory.length - 1];
    ui.hashWindow.textContent = formatWindow(Number(last.time || 0) - Number(first.time || 0));

    const heights = lastHistory
      .map((point) => Number(point.height))
      .filter((value) => Number.isFinite(value));
    if (heights.length) {
      const minHeight = Math.min(...heights);
      const maxHeight = Math.max(...heights);
      ui.heightRange.textContent =
        minHeight === maxHeight
          ? "height " + minHeight.toLocaleString()
          : "height " + minHeight.toLocaleString() + " → " + maxHeight.toLocaleString();
    } else {
      ui.heightRange.textContent = "—";
    }
  } else {
    ui.hashWindow.textContent = "Recent samples";
    ui.heightRange.textContent = "—";
  }
}

function render(next) {
  stats = next;
  const requested = Boolean(next.mining_requested);
  const online = next.status === "ok";
  const phase = String(next.phase || "unknown");
  const hashes = totalHashes(next);

  ui.pill.classList.toggle("online", online);
  ui.status.textContent = online ? (requested ? "Mining" : "Online") : "Offline";
  ui.hashRate.textContent = formatRate(next.hash_rate_hs);
  ui.height.textContent = next.height == null ? "—" : Number(next.height).toLocaleString();
  ui.accepted.textContent = Number(next.accepted_blocks || 0).toLocaleString();
  ui.uptime.textContent = formatUptime(next.uptime_seconds);
  ui.workers.textContent = String(next.workers || "—");
  ui.phase.textContent = phase.replaceAll("_", " ");

  ui.walletEarnedKnx.textContent = formatKnx(next.wallet_earned_shards);
  ui.walletValueAud.textContent = formatAudCents(next.wallet_value_cents);
  ui.sessionEarnedKnx.textContent = formatKnx(next.session_earned_shards);
  ui.sessionValueAud.textContent = formatAudCents(next.session_value_cents);
  ui.walletBlocks.textContent = Number(next.wallet_blocks_mined || 0).toLocaleString();
  ui.currentReward.textContent = formatKnx(next.current_reward_shards);
  ui.marketPrice.textContent = formatMarketPrice(next.market_price_cents);

  ui.lastWin.textContent =
    next.last_accepted_height == null
      ? "—"
      : "Height " + Number(next.last_accepted_height).toLocaleString();
  ui.lastWinDetail.textContent = next.last_accepted_at
    ? relativeTime(next.last_accepted_at)
    : "No accepted block this session";

  ui.averageRate.textContent = formatRate(next.average_hash_rate_hs);
  ui.peakRate.textContent = formatRate(next.peak_hash_rate_hs);
  ui.totalHashes.textContent = formatCompact(hashes);
  ui.jobsStarted.textContent = Number(next.jobs_started || 0).toLocaleString();
  ui.staleJobs.textContent = Number(next.stale_jobs || 0).toLocaleString();
  ui.staleRate.textContent = Number(next.stale_rate_percent || 0).toFixed(1) + "%";

  ui.chartPeak.textContent = formatRate(next.peak_hash_rate_hs);
  ui.chartTotalHashes.textContent = formatCompact(hashes);

  ui.toggle.disabled = busy || !online;
  ui.toggle.classList.toggle("stop", requested);
  ui.buttonIcon.textContent = requested ? "Ⅱ" : "▶";
  ui.buttonLabel.textContent = requested ? "Pause mining" : "Start mining";

  if (next.last_error && phase !== "mining") {
    ui.error.textContent = next.last_error;
  } else {
    ui.error.textContent = "";
  }

  renderCharts(next.hash_history);

  const acceptedHeight = next.last_accepted_height;
  if (acceptedHeight != null && acceptedHeight !== lastAcceptedHeight) {
    if (lastAcceptedHeight !== null) {
      ui.acceptedCopy.textContent =
        "Block " + Number(acceptedHeight).toLocaleString() + " accepted";
      ui.acceptedBanner.classList.add("show");
      window.setTimeout(() => ui.acceptedBanner.classList.remove("show"), 6000);
    }
    lastAcceptedHeight = acceptedHeight;
  }
}

async function load() {
  try {
    const response = await fetch("/api/miner", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Miner backend unavailable.");
    render(body);
    ui.refresh.textContent = "Live";
  } catch (error) {
    ui.pill.classList.remove("online");
    ui.status.textContent = "Disconnected";
    ui.error.textContent = error instanceof Error ? error.message : String(error);
    ui.refresh.textContent = "Reconnecting";
    ui.toggle.disabled = true;
  }
}

async function control(action) {
  if (busy) return;
  busy = true;
  ui.toggle.disabled = true;
  ui.error.textContent = "";

  try {
    const response = await fetch("/api/miner?action=" + encodeURIComponent(action), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Control request failed.");
    if (body.stats) render(body.stats);
  } catch (error) {
    ui.error.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    await load();
  }
}

ui.toggle.addEventListener("click", () => {
  const action = stats?.mining_requested ? "stop" : "start";
  void control(action);
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderCharts(lastHistory), 90);
});

void load();
window.setInterval(load, 2000);
