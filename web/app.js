const ui = {
  pill: document.getElementById("status-pill"),
  status: document.getElementById("status-text"),
  hashRate: document.getElementById("hash-rate"),
  height: document.getElementById("height"),
  accepted: document.getElementById("accepted"),
  activeMiners: document.getElementById("active-miners"),
  workers: document.getElementById("workers"),
  phase: document.getElementById("phase"),
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

  slots: [1, 2].map((slot) => ({
    card: document.getElementById(`miner-${slot}-card`),
    pill: document.getElementById(`miner-${slot}-status-pill`),
    status: document.getElementById(`miner-${slot}-status`),
    rate: document.getElementById(`miner-${slot}-rate`),
    height: document.getElementById(`miner-${slot}-height`),
    phase: document.getElementById(`miner-${slot}-phase`),
    toggle: document.getElementById(`miner-${slot}-toggle`),
    buttonIcon: document.getElementById(`miner-${slot}-button-icon`),
    buttonLabel: document.getElementById(`miner-${slot}-button-label`),
    hint: document.getElementById(`miner-${slot}-hint`),
    error: document.getElementById(`miner-${slot}-error`),
  })),
};

const minerStats = [null, null];
const minerErrors = ["", ""];
const busy = [false, false];
const lastVisibleRate = [0, 0];
const lastVisibleRateAt = [0, 0];
const lastAcceptedMarker = [null, null];
let initializedAcceptedMarkers = false;
let lastHistory = [];

function formatRate(value) {
  const rate = Number(value || 0);
  if (rate >= 1e9) return (rate / 1e9).toFixed(2) + " GH/s";
  if (rate >= 1e6) return (rate / 1e6).toFixed(2) + " MH/s";
  if (rate >= 1e3) return (rate / 1e3).toFixed(1) + " kH/s";
  return Math.round(rate).toLocaleString() + " H/s";
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

function asBigInt(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function maxBigIntString(values) {
  let maximum = 0n;
  for (const value of values) maximum = maximum > asBigInt(value) ? maximum : asBigInt(value);
  return maximum.toString();
}

function sumBigIntString(values) {
  return values.reduce((total, value) => total + asBigInt(value), 0n).toString();
}

function formatKnx(shards) {
  const value = asBigInt(shards);
  const base = 100000000n;
  const whole = value / base;
  const fraction = (value % base).toString().padStart(8, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const decimals = trimmed.length > 2 ? trimmed : trimmed.padEnd(2, "0");
  return whole.toLocaleString("en-US") + (decimals ? "." + decimals : "");
}

function formatAudCents(cents) {
  const value = asBigInt(cents);
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

function publicPhase(next) {
  if (!next) return "Offline";
  if (!next.mining_requested) return "Paused";
  const phase = String(next.phase || "");
  if (phase === "configuration_error") return "Needs setup";
  if (phase === "backoff") return "Retrying";
  if (phase === "stopped" || phase === "paused") return "Paused";
  // Template fetch/refresh/submit are normal parts of continuous mining.
  return "Mining";
}

function effectiveRate(next, slotIndex) {
  if (!next) return 0;
  const raw = Number(next.hash_rate_hs || 0);
  const phase = String(next.phase || "");
  const requested = Boolean(next.mining_requested);

  if (raw > 0) {
    lastVisibleRate[slotIndex] = raw;
    lastVisibleRateAt[slotIndex] = Date.now();
    return raw;
  }

  const handoff =
    requested &&
    ["fetching_template", "refreshing", "submitting", "accepted", "mining"].includes(phase);

  if (
    handoff &&
    lastVisibleRate[slotIndex] > 0 &&
    Date.now() - lastVisibleRateAt[slotIndex] < 15000
  ) {
    return lastVisibleRate[slotIndex];
  }

  return 0;
}

function totalHashes(next) {
  if (!next) return 0;
  return Number(next.total_attempts || 0) + Number(next.current_job_attempts || 0);
}

function latestAccepted(miners) {
  const candidates = miners
    .filter(Boolean)
    .map((miner, slot) => ({
      slot,
      height: miner.last_accepted_height,
      at: miner.last_accepted_at,
    }))
    .filter((entry) => entry.height != null && entry.at);
  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return candidates[0] || null;
}

function mergeHistories(miners) {
  const buckets = new Map();

  miners.forEach((miner, slot) => {
    const history = Array.isArray(miner?.hash_history) ? miner.hash_history : [];
    for (const point of history) {
      const rawTime = Number(point.time || 0);
      if (!Number.isFinite(rawTime) || rawTime <= 0) continue;
      const time = Math.round(rawTime / 2) * 2;
      if (!buckets.has(time)) {
        buckets.set(time, {
          time,
          rates: [null, null],
          hashes: [null, null],
          heights: [null, null],
        });
      }
      const bucket = buckets.get(time);
      bucket.rates[slot] = Number(point.hash_rate_hs || 0);
      bucket.hashes[slot] = Number(point.total_hashes || 0);
      bucket.heights[slot] = point.height == null ? null : Number(point.height);
    }
  });

  const rows = [...buckets.values()].sort((a, b) => a.time - b.time);
  const lastRate = [0, 0];
  const lastRateTime = [0, 0];
  const lastHashes = [0, 0];
  const lastHeights = [null, null];

  return rows.map((row) => {
    for (let slot = 0; slot < 2; slot += 1) {
      if (row.rates[slot] != null) {
        lastRate[slot] = row.rates[slot];
        lastRateTime[slot] = row.time;
      }
      if (row.hashes[slot] != null) lastHashes[slot] = row.hashes[slot];
      if (row.heights[slot] != null) lastHeights[slot] = row.heights[slot];
    }

    const rate = lastRate.reduce(
      (sum, value, slot) =>
        sum + (row.time - lastRateTime[slot] <= 8 ? Number(value || 0) : 0),
      0,
    );
    const heights = lastHeights.filter((value) => Number.isFinite(value));

    return {
      time: row.time,
      hash_rate_hs: rate,
      total_hashes: lastHashes[0] + lastHashes[1],
      height: heights.length ? Math.max(...heights) : null,
    };
  }).slice(-240);
}

function chartPalette() {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim() || "#89ffba",
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

function renderSlot(slotIndex) {
  const next = minerStats[slotIndex];
  const slot = slotIndex + 1;
  const elements = ui.slots[slotIndex];

  if (!next) {
    elements.card.classList.remove("running");
    elements.pill.classList.remove("online");
    elements.status.textContent = minerErrors[slotIndex] ? "Unavailable" : "Connecting";
    elements.rate.textContent = "—";
    elements.height.textContent = "—";
    elements.phase.textContent = "Offline";
    elements.toggle.disabled = true;
    elements.hint.textContent = minerErrors[slotIndex] ? "Miner service unavailable." : "Waiting for miner status…";
    elements.error.textContent = minerErrors[slotIndex];
    return;
  }

  const requested = Boolean(next.mining_requested);
  const online = next.status === "ok";
  const rate = effectiveRate(next, slotIndex);

  elements.card.classList.toggle("running", online && requested);
  elements.pill.classList.toggle("online", online);
  elements.status.textContent = online ? (requested ? "Mining" : "Paused") : "Offline";
  elements.rate.textContent = formatRate(rate);
  elements.height.textContent =
    next.height == null ? "—" : Number(next.height).toLocaleString();
  elements.phase.textContent = publicPhase(next);
  elements.toggle.disabled = busy[slotIndex] || !online;
  elements.toggle.classList.toggle("stop", requested);
  elements.buttonIcon.textContent = requested ? "Ⅱ" : "▶";
  elements.buttonLabel.textContent = requested ? `Stop Miner ${slot}` : `Start Miner ${slot}`;
  elements.hint.textContent = requested
    ? "Runs in Northflank even if this tab is closed."
    : "Paused until you explicitly resume it.";

  const phase = String(next.phase || "");
  elements.error.textContent =
    next.last_error && ["backoff", "configuration_error"].includes(phase)
      ? next.last_error
      : minerErrors[slotIndex];
}

function renderAggregate() {
  const miners = minerStats.filter(Boolean);
  const active = miners.filter((miner) => miner.mining_requested).length;
  const reachable = miners.length;
  const rates = minerStats.map((miner, index) => effectiveRate(miner, index));
  const combinedRate = rates[0] + rates[1];
  const heights = miners
    .map((miner) => Number(miner.height))
    .filter((value) => Number.isFinite(value));

  ui.pill.classList.toggle("online", reachable > 0);
  ui.status.textContent =
    reachable === 2
      ? active === 2
        ? "2 miners live"
        : active === 1
          ? "1 miner live"
          : "Miners paused"
      : reachable === 1
        ? "1 miner connected"
        : "Disconnected";

  ui.hashRate.textContent = formatRate(combinedRate);
  ui.height.textContent = heights.length ? Math.max(...heights).toLocaleString() : "—";
  ui.accepted.textContent = miners
    .reduce((sum, miner) => sum + Number(miner.accepted_blocks || 0), 0)
    .toLocaleString();
  ui.activeMiners.textContent = active + " / 2";
  ui.workers.textContent = miners
    .reduce((sum, miner) => sum + Number(miner.workers || 0), 0)
    .toLocaleString();
  ui.phase.textContent =
    active === 2 ? "Both mining" : active === 1 ? "1 miner active" : reachable ? "Paused" : "Offline";

  const walletShards = maxBigIntString(miners.map((miner) => miner.wallet_earned_shards));
  const walletValue = maxBigIntString(miners.map((miner) => miner.wallet_value_cents));
  const sessionShards = sumBigIntString(miners.map((miner) => miner.session_earned_shards));
  const sessionValue = sumBigIntString(miners.map((miner) => miner.session_value_cents));
  const currentReward = maxBigIntString(miners.map((miner) => miner.current_reward_shards));
  const walletBlocks = Math.max(0, ...miners.map((miner) => Number(miner.wallet_blocks_mined || 0)));
  const marketPrice = Math.max(0, ...miners.map((miner) => Number(miner.market_price_cents || 0)));

  ui.walletEarnedKnx.textContent = formatKnx(walletShards);
  ui.walletValueAud.textContent = formatAudCents(walletValue);
  ui.sessionEarnedKnx.textContent = formatKnx(sessionShards);
  ui.sessionValueAud.textContent = formatAudCents(sessionValue);
  ui.walletBlocks.textContent = walletBlocks.toLocaleString();
  ui.currentReward.textContent = formatKnx(currentReward);
  ui.marketPrice.textContent = formatMarketPrice(marketPrice);

  const latest = latestAccepted(miners);
  ui.lastWin.textContent = latest ? "Height " + Number(latest.height).toLocaleString() : "—";
  ui.lastWinDetail.textContent = latest ? relativeTime(latest.at) : "No accepted block this session";

  const totalHashCount = miners.reduce((sum, miner) => sum + totalHashes(miner), 0);
  const jobs = miners.reduce((sum, miner) => sum + Number(miner.jobs_started || 0), 0);
  const stale = miners.reduce((sum, miner) => sum + Number(miner.stale_jobs || 0), 0);
  const combinedHistory = mergeHistories(minerStats);
  const historyRates = combinedHistory.map((point) => Number(point.hash_rate_hs || 0));
  const peakCombined = historyRates.length ? Math.max(...historyRates) : combinedRate;
  const averageCombined = miners.reduce(
    (sum, miner) => sum + Number(miner.average_hash_rate_hs || 0),
    0,
  );

  ui.averageRate.textContent = formatRate(averageCombined);
  ui.peakRate.textContent = formatRate(peakCombined);
  ui.totalHashes.textContent = formatCompact(totalHashCount);
  ui.jobsStarted.textContent = jobs.toLocaleString();
  ui.staleJobs.textContent = stale.toLocaleString();
  ui.staleRate.textContent = jobs ? ((stale / jobs) * 100).toFixed(1) + "%" : "0.0%";
  ui.chartPeak.textContent = formatRate(peakCombined);
  ui.chartTotalHashes.textContent = formatCompact(totalHashCount);

  renderCharts(combinedHistory);

  ui.error.textContent =
    reachable === 0
      ? "Neither Northflank miner is reachable."
      : "";

  for (let slot = 0; slot < 2; slot += 1) {
    const miner = minerStats[slot];
    const marker = miner?.last_accepted_at
      ? `${miner.last_accepted_height}:${miner.last_accepted_at}`
      : null;

    if (!initializedAcceptedMarkers) {
      lastAcceptedMarker[slot] = marker;
      continue;
    }

    if (marker && marker !== lastAcceptedMarker[slot]) {
      ui.acceptedCopy.textContent =
        `Miner ${slot + 1} accepted block ${Number(miner.last_accepted_height).toLocaleString()}`;
      ui.acceptedBanner.classList.add("show");
      window.setTimeout(() => ui.acceptedBanner.classList.remove("show"), 6000);
      lastAcceptedMarker[slot] = marker;
    }
  }
  initializedAcceptedMarkers = true;
}

async function fetchMiner(slot) {
  const response = await fetch(`/api/miner?slot=${slot}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Miner ${slot} unavailable.`);
  return body;
}

async function load() {
  const results = await Promise.allSettled([fetchMiner(1), fetchMiner(2)]);

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      minerStats[index] = result.value;
      minerErrors[index] = "";
    } else {
      minerStats[index] = null;
      minerErrors[index] =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
    renderSlot(index);
  });

  renderAggregate();
  ui.refresh.textContent = minerStats.some(Boolean) ? "Live" : "Reconnecting";
}

async function control(slot, action) {
  const index = slot - 1;
  if (busy[index]) return;

  busy[index] = true;
  renderSlot(index);

  try {
    const response = await fetch(
      `/api/miner?slot=${slot}&action=${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Miner ${slot} control failed.`);
    if (body.stats) {
      minerStats[index] = body.stats;
      minerErrors[index] = "";
    }
  } catch (error) {
    minerErrors[index] = error instanceof Error ? error.message : String(error);
  } finally {
    busy[index] = false;
    await load();
  }
}

ui.slots.forEach((elements, index) => {
  const slot = index + 1;
  elements.toggle.addEventListener("click", () => {
    const action = minerStats[index]?.mining_requested ? "stop" : "start";
    void control(slot, action);
  });
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderCharts(lastHistory), 90);
});

void load();
window.setInterval(load, 2000);
