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
};

let stats = null;
let busy = false;
let lastAcceptedHeight = null;

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

function render(next) {
  stats = next;
  const requested = Boolean(next.mining_requested);
  const online = next.status === "ok";
  const phase = String(next.phase || "unknown");

  ui.pill.classList.toggle("online", online);
  ui.status.textContent = online ? (requested ? "Mining" : "Online") : "Offline";
  ui.hashRate.textContent = formatRate(next.hash_rate_hs);
  ui.height.textContent = next.height == null ? "—" : Number(next.height).toLocaleString();
  ui.accepted.textContent = Number(next.accepted_blocks || 0).toLocaleString();
  ui.uptime.textContent = formatUptime(next.uptime_seconds);
  ui.workers.textContent = String(next.workers || "—");
  ui.phase.textContent = phase.replaceAll("_", " ");

  ui.toggle.disabled = busy || !online;
  ui.toggle.classList.toggle("stop", requested);
  ui.buttonIcon.textContent = requested ? "Ⅱ" : "▶";
  ui.buttonLabel.textContent = requested ? "Pause mining" : "Start mining";

  if (next.last_error && phase !== "mining") {
    ui.error.textContent = next.last_error;
  } else {
    ui.error.textContent = "";
  }

  const acceptedHeight = next.last_accepted_height;
  if (acceptedHeight != null && acceptedHeight !== lastAcceptedHeight) {
    if (lastAcceptedHeight !== null) {
      ui.acceptedCopy.textContent = "Block " + Number(acceptedHeight).toLocaleString() + " accepted";
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

void load();
window.setInterval(load, 2000);
