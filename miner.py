#!/usr/bin/env python3
"""MINR: efficient KNXCoin protocol-v2 SHA-256d miner + control service."""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import multiprocessing as mp
import os
import queue
import random
import signal
import ssl
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

NODE_URL = os.getenv("KNX_NODE_URL", "https://knxcoin.vercel.app").rstrip("/")
API_KEY = os.getenv("KNX_API_KEY", "").strip()
PORT = int(os.getenv("PORT", "8080"))
WORKERS = max(1, min(32, int(os.getenv("KNX_WORKERS", "1"))))
STATUS_POLL_SECONDS = max(2.0, float(os.getenv("KNX_STATUS_POLL_SECONDS", "4")))
TEMPLATE_MIN_INTERVAL_SECONDS = max(
    10.0, float(os.getenv("KNX_TEMPLATE_MIN_INTERVAL_SECONDS", "12"))
)
HTTP_TIMEOUT_SECONDS = max(3.0, float(os.getenv("KNX_HTTP_TIMEOUT_SECONDS", "15")))
LOG_INTERVAL_SECONDS = max(1.0, float(os.getenv("KNX_LOG_INTERVAL_SECONDS", "2")))
CONTROL_TOKEN = os.getenv("MINER_CONTROL_TOKEN", "").strip()
# Dedicated MINR is intentionally manual-control only. Nothing at process
# startup, browser refresh, or stats polling can enable hashing. The sole
# start path is the authenticated POST /control/start endpoint.
CHECK_EVERY_HASHES = 16384
USER_AGENT = "minr/2.0"

_raw_session = os.getenv("KNX_MINER_SESSION_ID", "").strip()
try:
    SESSION_ID = str(uuid.UUID(_raw_session)) if _raw_session else str(uuid.uuid4())
    SESSION_ERROR = None
except ValueError:
    SESSION_ID = _raw_session
    SESSION_ERROR = "KNX_MINER_SESSION_ID must be a valid UUID."

CA_BUNDLE = os.getenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")
SSL_CONTEXT = ssl.create_default_context(
    cafile=CA_BUNDLE if os.path.exists(CA_BUNDLE) else None
)

SERVICE_STOP = threading.Event()


def sha256d(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def display_hash(raw: bytes) -> str:
    return raw[::-1].hex()


def header_bytes(
    version: int,
    previous_hash: str,
    merkle_root: str,
    timestamp: int,
    bits: int,
    nonce: int,
) -> bytes:
    return (
        struct.pack("<i", version)
        + bytes.fromhex(previous_hash)[::-1]
        + bytes.fromhex(merkle_root)[::-1]
        + struct.pack("<III", timestamp, bits, nonce)
    )


def coinbase_txid(template: dict[str, Any], extranonce: str) -> str:
    reward = int(template["subsidy_shards"]) + int(template["fees_shards"])
    body = "knxcoin/coinbase/v2|{}|{}|{}|{}".format(
        template["height"], template["miner_address"], reward, extranonce
    )
    return hashlib.sha256(body.encode()).hexdigest()


def merkle_root(txids: list[str]) -> str:
    if not txids:
        raise ValueError("Cannot build a Merkle root from an empty transaction list.")
    level = [bytes.fromhex(txid)[::-1] for txid in txids]
    while len(level) > 1:
        if len(level) & 1:
            level.append(level[-1])
        level = [sha256d(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0][::-1].hex()


def build_coinbase_branch(transaction_ids: list[str]) -> list[bytes]:
    """Precompute the Merkle siblings for transaction index zero."""
    if not transaction_ids:
        return []

    level: list[bytes | None] = [None]
    level.extend(bytes.fromhex(txid)[::-1] for txid in transaction_ids)
    branch: list[bytes] = []
    index = 0

    while len(level) > 1:
        if len(level) & 1:
            level.append(level[-1])

        sibling = level[index ^ 1]
        if sibling is None:
            raise ValueError("Invalid Merkle branch state.")
        branch.append(sibling)

        next_level: list[bytes | None] = []
        for i in range(0, len(level), 2):
            left, right = level[i], level[i + 1]
            if left is None or right is None:
                next_level.append(None)
            else:
                next_level.append(sha256d(left + right))

        index //= 2
        level = next_level

    return branch


def merkle_from_coinbase(coinbase_internal: bytes, branch: list[bytes]) -> str:
    current = coinbase_internal
    for sibling in branch:
        current = sha256d(current + sibling)
    return current[::-1].hex()


def format_rate(rate: float) -> str:
    if rate >= 1_000_000_000:
        return f"{rate / 1_000_000_000:.2f} GH/s"
    if rate >= 1_000_000:
        return f"{rate / 1_000_000:.2f} MH/s"
    if rate >= 1_000:
        return f"{rate / 1_000:.1f} kH/s"
    return f"{rate:.0f} H/s"


class NodeError(RuntimeError):
    def __init__(self, status: int | None, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass
class RuntimeState:
    service_started: float = field(default_factory=time.monotonic)
    phase: str = "starting"
    mining_requested: bool = False
    height: int | None = None
    hash_rate_hs: float = 0.0
    current_job_attempts: int = 0
    total_attempts: int = 0
    jobs_started: int = 0
    stale_jobs: int = 0
    accepted_blocks: int = 0
    session_earned_shards: int = 0
    wallet_blocks_mined: int = 0
    wallet_earned_shards: str = "0"
    current_reward_shards: str = "0"
    market_price_cents: float = 0.0
    peak_hash_rate_hs: float = 0.0
    hash_rate_sum: float = 0.0
    hash_rate_samples: int = 0
    hash_history: list[dict[str, Any]] = field(default_factory=list)
    last_accepted_height: int | None = None
    last_accepted_hash: str | None = None
    last_accepted_at: str | None = None
    last_node_contact: float | None = None
    last_error: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def set(self, **updates: Any) -> None:
        with self._lock:
            for key, value in updates.items():
                setattr(self, key, value)

    def add_job_result(self, attempts: int, stale: bool) -> None:
        with self._lock:
            self.total_attempts += max(0, attempts)
            self.current_job_attempts = attempts
            # Keep the most recent measured rate visible while the miner swaps
            # a 12-second template for the next one. Only a real pause/backoff
            # resets it, so dashboards do not flicker to 0 H/s every handoff.
            if stale:
                self.stale_jobs += 1

    def record_rate(self, rate: float, height: int | None) -> None:
        if not (rate >= 0):
            return
        with self._lock:
            self.peak_hash_rate_hs = max(self.peak_hash_rate_hs, rate)
            self.hash_rate_sum += rate
            self.hash_rate_samples += 1
            total_hashes = self.total_attempts + self.current_job_attempts
            self.hash_history.append(
                {
                    "time": int(time.time()),
                    "hash_rate_hs": round(rate, 2),
                    "height": height,
                    "total_hashes": total_hashes,
                }
            )
            if len(self.hash_history) > 240:
                del self.hash_history[:-240]

    def update_wallet_status(self, status: dict[str, Any]) -> None:
        with self._lock:
            self.wallet_blocks_mined = int(status.get("blocks_mined") or 0)
            shards = str(status.get("shards_earned") or "0")
            self.wallet_earned_shards = shards if shards.isdigit() else "0"

    def update_market(self, summary: dict[str, Any]) -> None:
        price = float(summary.get("price_cents") or 0)
        with self._lock:
            self.market_price_cents = price if price > 0 else 0.0

    def accepted(self, height: int, block_hash: str | None, reward_shards: int) -> None:
        with self._lock:
            self.accepted_blocks += 1
            self.session_earned_shards += max(0, reward_shards)
            self.last_accepted_height = height
            self.last_accepted_hash = block_hash
            self.last_accepted_at = dt.datetime.now(dt.timezone.utc).isoformat()
            self.phase = "accepted"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            average_rate = (
                self.hash_rate_sum / self.hash_rate_samples
                if self.hash_rate_samples
                else 0.0
            )
            jobs = max(0, self.jobs_started)
            stale_rate = (self.stale_jobs / jobs * 100.0) if jobs else 0.0
            price_scale = 10_000
            shards_per_knx = 100_000_000
            scaled_price = int(round(self.market_price_cents * price_scale))
            wallet_value_cents = (
                int(self.wallet_earned_shards) * scaled_price
                // (shards_per_knx * price_scale)
                if scaled_price > 0
                else 0
            )
            session_value_cents = (
                self.session_earned_shards * scaled_price
                // (shards_per_knx * price_scale)
                if scaled_price > 0
                else 0
            )
            return {
                "status": "stopping" if SERVICE_STOP.is_set() else "ok",
                "phase": self.phase,
                "mining_requested": self.mining_requested,
                "uptime_seconds": round(time.monotonic() - self.service_started, 1),
                "height": self.height,
                "hash_rate_hs": round(self.hash_rate_hs, 2),
                "current_job_attempts": self.current_job_attempts,
                "total_attempts": self.total_attempts,
                "jobs_started": self.jobs_started,
                "stale_jobs": self.stale_jobs,
                "accepted_blocks": self.accepted_blocks,
                "session_earned_shards": str(self.session_earned_shards),
                "session_value_cents": str(session_value_cents),
                "wallet_blocks_mined": self.wallet_blocks_mined,
                "wallet_earned_shards": self.wallet_earned_shards,
                "wallet_value_cents": str(wallet_value_cents),
                "current_reward_shards": self.current_reward_shards,
                "market_price_cents": round(self.market_price_cents, 6),
                "peak_hash_rate_hs": round(self.peak_hash_rate_hs, 2),
                "average_hash_rate_hs": round(average_rate, 2),
                "stale_rate_percent": round(stale_rate, 2),
                "hash_history": list(self.hash_history),
                "last_accepted_height": self.last_accepted_height,
                "last_accepted_hash": self.last_accepted_hash,
                "last_accepted_at": self.last_accepted_at,
                "last_node_contact_unix": self.last_node_contact,
                "last_error": self.last_error,
                "workers": WORKERS,
                "node": NODE_URL,
                "template_min_interval_seconds": TEMPLATE_MIN_INTERVAL_SECONDS,
                "status_poll_seconds": STATUS_POLL_SECONDS,
            }


STATE = RuntimeState()


def _json_error(raw: bytes, fallback: str) -> str:
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
        if isinstance(value, dict):
            for key in ("error", "message", "detail"):
                if value.get(key):
                    return str(value[key])[:300]
    except Exception:
        pass
    return fallback[:300]


class NodeClient:
    def __init__(self) -> None:
        self.node_url = NODE_URL
        self.api_key = API_KEY

    def _request(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        method: str = "POST",
        auth: bool = True,
    ) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        headers = {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
            "x-knx-miner-session": SESSION_ID,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = "Bearer " + self.api_key

        request = urllib.request.Request(
            self.node_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=HTTP_TIMEOUT_SECONDS,
                context=SSL_CONTEXT,
            ) as response:
                raw = response.read()
                STATE.set(last_node_contact=time.time(), last_error=None)
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read()
            retry_after = None
            try:
                value = error.headers.get("Retry-After")
                if value:
                    retry_after = float(value)
            except Exception:
                pass
            message = _json_error(raw, f"HTTP {error.code}")
            STATE.set(last_node_contact=time.time(), last_error=message)
            raise NodeError(error.code, message, retry_after) from error
        except (urllib.error.URLError, TimeoutError) as error:
            message = str(getattr(error, "reason", error))[:300]
            STATE.set(last_error=message)
            raise NodeError(None, message) from error

    def template(self) -> dict[str, Any]:
        return self._request("/api/mining/template", {})

    def submit(self, solution: dict[str, Any]) -> dict[str, Any]:
        return self._request("/api/mining/submit", solution)

    def status(self, address: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"address": address})
        return self._request(
            f"/api/mining/status?{query}",
            None,
            method="GET",
            auth=False,
        )

    def market(self) -> dict[str, Any]:
        return self._request(
            "/api/market/summary",
            None,
            method="GET",
            auth=False,
        )

    def release(self) -> None:
        try:
            self._request("/api/mining/lease", None, method="DELETE")
        except Exception:
            pass


def parse_expiry(template: dict[str, Any]) -> float:
    return dt.datetime.fromisoformat(
        str(template["expires_at"]).replace("Z", "+00:00")
    ).timestamp()


def _worker_loop(
    worker_id: int,
    worker_count: int,
    job_queue: Any,
    result_queue: Any,
    active_job: Any,
    attempts: Any,
) -> None:
    sha = hashlib.sha256
    pack_into = struct.pack_into

    while True:
        job = job_queue.get()
        if job is None:
            return

        job_id, template, branch, coinbase_prefix = job
        target = int(str(template["target"]), 16)
        expiry = float(template["expires_unix"])
        version = int(template["version"])
        previous = bytes.fromhex(str(template["previous_hash"]))[::-1]
        bits = int(template["bits"])
        minimum_timestamp = int(template["minimum_timestamp"])
        template_timestamp = int(template["timestamp"])

        local_attempts = 0
        extra_value = worker_id + 1
        solved = False

        while active_job.value == job_id and time.time() < expiry:
            extranonce = extra_value.to_bytes(8, "big").hex()
            coinbase_internal = sha(
                coinbase_prefix + extranonce.encode("ascii")
            ).digest()[::-1]
            root_hex = merkle_from_coinbase(coinbase_internal, branch)
            root_internal = bytes.fromhex(root_hex)[::-1]
            timestamp = max(int(time.time()), minimum_timestamp, template_timestamp)

            header = bytearray(80)
            pack_into("<i", header, 0, version)
            header[4:36] = previous
            header[36:68] = root_internal
            pack_into("<I", header, 68, timestamp)
            pack_into("<I", header, 72, bits)

            midstate = sha(bytes(header[:64]))
            tail = bytearray(header[64:80])
            start_nonce = random.getrandbits(32)

            for offset in range(1 << 32):
                if offset % CHECK_EVERY_HASHES == 0:
                    attempts[worker_id] = local_attempts
                    if active_job.value != job_id or time.time() >= expiry:
                        break

                nonce = (start_nonce + offset) & 0xFFFF_FFFF
                pack_into("<I", tail, 12, nonce)
                first = midstate.copy()
                first.update(tail)
                raw = sha(first.digest()).digest()
                local_attempts += 1

                if int.from_bytes(raw, "little") <= target:
                    attempts[worker_id] = local_attempts
                    result_queue.put(
                        {
                            "job_id": job_id,
                            "protocol_version": 2,
                            "template_id": template["template_id"],
                            "extranonce": extranonce,
                            "timestamp": timestamp,
                            "nonce": nonce,
                            "merkle_root": root_hex,
                            "header_hash": display_hash(raw),
                        }
                    )
                    solved = True
                    break

            if solved:
                break
            extra_value += worker_count

        attempts[worker_id] = local_attempts


class MinerEngine:
    def __init__(self) -> None:
        self.enabled = threading.Event()
        self.thread: threading.Thread | None = None
        self.client = NodeClient()
        self.ctx: Any = None
        self.job_queues: list[Any] = []
        self.result_queue: Any = None
        self.active_job: Any = None
        self.attempts: Any = None
        self.processes: list[Any] = []
        self.job_seq = 0
        self.last_template_fetch = 0.0
        self.last_market_fetch = 0.0
        self.lease_held = False

    def start_service(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, name="miner-engine", daemon=True)
        self.thread.start()

    def request_start(self) -> None:
        # This is the only method that enables mining and it is only called
        # from the authenticated control endpoint.
        STATE.set(mining_requested=True, last_error=None, phase="starting")
        self.enabled.set()

    def request_stop(self) -> None:
        # Latch the service off first, then invalidate any in-flight job.
        # Once cleared, the engine cannot re-enable itself.
        self.enabled.clear()
        self._invalidate_job()
        STATE.set(
            mining_requested=False,
            phase="paused",
            hash_rate_hs=0.0,
            current_job_attempts=0,
        )

        # Release the wallet's two-slot lease immediately. Do this even if the
        # local lease flag is false because a template request may have acquired
        # the remote lease just before the user pressed Stop.
        threading.Thread(
            target=self._force_release_lease,
            name="miner-lease-release",
            daemon=True,
        ).start()

    def _setup_workers(self) -> None:
        if self.processes and all(process.is_alive() for process in self.processes):
            return

        self._shutdown_workers()
        self.ctx = mp.get_context("spawn")
        self.result_queue = self.ctx.Queue()
        self.active_job = self.ctx.Value("Q", 0, lock=True)
        self.attempts = self.ctx.Array("Q", WORKERS, lock=False)
        self.job_queues = [self.ctx.Queue(maxsize=1) for _ in range(WORKERS)]
        self.processes = []

        for worker_id in range(WORKERS):
            process = self.ctx.Process(
                target=_worker_loop,
                args=(
                    worker_id,
                    WORKERS,
                    self.job_queues[worker_id],
                    self.result_queue,
                    self.active_job,
                    self.attempts,
                ),
                name=f"minr-{worker_id}",
            )
            process.start()
            self.processes.append(process)

    def _shutdown_workers(self) -> None:
        self._invalidate_job()
        for job_queue in self.job_queues:
            try:
                job_queue.put_nowait(None)
            except Exception:
                pass
        for process in self.processes:
            process.join(timeout=1.5)
            if process.is_alive():
                process.terminate()
                process.join(timeout=1)
        self.job_queues = []
        self.processes = []

    def _invalidate_job(self) -> None:
        if self.active_job is None:
            return
        try:
            with self.active_job.get_lock():
                self.active_job.value = 0
        except Exception:
            pass

    def _set_active_job(self, job_id: int) -> None:
        with self.active_job.get_lock():
            self.active_job.value = job_id

    def _wait_enabled(self, seconds: float) -> bool:
        end = time.monotonic() + max(0.0, seconds)
        while (
            self.enabled.is_set()
            and not SERVICE_STOP.is_set()
            and time.monotonic() < end
        ):
            SERVICE_STOP.wait(min(0.2, max(0.0, end - time.monotonic())))
        return self.enabled.is_set() and not SERVICE_STOP.is_set()

    def _template_gate(self) -> bool:
        remaining = (
            self.last_template_fetch
            + TEMPLATE_MIN_INTERVAL_SECONDS
            - time.monotonic()
        )
        if remaining > 0:
            return self._wait_enabled(remaining)
        return self.enabled.is_set() and not SERVICE_STOP.is_set()

    def _backoff(self, error: NodeError, current: float) -> float:
        if error.status in (401, 403):
            return 60.0
        if error.status == 429:
            return max(15.0, error.retry_after or 15.0)
        if error.status == 503:
            return max(30.0, error.retry_after or 30.0)
        if error.status in (409, 410):
            return 1.0
        return min(120.0, max(2.0, current * 2.0))

    def _watch_template(
        self,
        template: dict[str, Any],
        job_id: int,
        done: threading.Event,
    ) -> None:
        address = str(template["miner_address"])
        template_id = str(template["template_id"])
        height = int(template["height"])

        while not done.wait(STATUS_POLL_SECONDS):
            if (
                SERVICE_STOP.is_set()
                or not self.enabled.is_set()
                or self.active_job.value != job_id
            ):
                return
            try:
                status = self.client.status(address)
                active = status.get("active_template")
                if (
                    not isinstance(active, dict)
                    or str(active.get("template_id")) != template_id
                    or int(active.get("block_index", -1)) != height
                ):
                    self._invalidate_job()
                    return
            except NodeError:
                pass

    def _refresh_market_if_due(self) -> None:
        if time.monotonic() - self.last_market_fetch < 60.0:
            return
        try:
            STATE.update_market(self.client.market())
            self.last_market_fetch = time.monotonic()
        except NodeError:
            pass

    def _force_release_lease(self) -> None:
        try:
            self.client.release()
        finally:
            self.lease_held = False

    def _release_lease(self) -> None:
        if self.lease_held:
            self._force_release_lease()

    def _run(self) -> None:
        delay = 2.0

        while not SERVICE_STOP.is_set():
            if not self.enabled.wait(0.5):
                self._release_lease()
                STATE.set(phase="paused", hash_rate_hs=0.0)
                continue

            if SESSION_ERROR:
                STATE.set(phase="configuration_error", last_error=SESSION_ERROR)
                self._wait_enabled(30)
                continue
            if not API_KEY:
                STATE.set(
                    phase="configuration_error",
                    last_error="KNX_API_KEY is not configured.",
                )
                self._wait_enabled(30)
                continue

            try:
                self._setup_workers()
                if not self._template_gate():
                    continue

                # Fetching the next short-lived template is part of normal
                # mining. Preserve the last measured rate through this handoff.
                STATE.set(phase="fetching_template")
                self.last_template_fetch = time.monotonic()
                template = self.client.template()

                # A Stop command may arrive while the network request is in
                # flight. Do not dispatch that freshly returned template if
                # the user paused the miner meanwhile.
                if not self.enabled.is_set() or SERVICE_STOP.is_set():
                    # The template endpoint acquires/renews the session lease
                    # before returning. If Stop happened while this request was
                    # in flight, explicitly release that just-created lease.
                    self._force_release_lease()
                    STATE.set(
                        mining_requested=False,
                        phase="paused",
                        hash_rate_hs=0.0,
                        current_job_attempts=0,
                    )
                    continue

                self.lease_held = True
                delay = 2.0
                template = dict(template)
                template["expires_unix"] = parse_expiry(template)
                height = int(template["height"])
                transaction_ids = [
                    str(value) for value in template.get("transaction_ids", [])
                ]
                branch = build_coinbase_branch(transaction_ids)
                reward = int(template["subsidy_shards"]) + int(template["fees_shards"])
                STATE.set(current_reward_shards=str(reward))
                try:
                    STATE.update_wallet_status(
                        self.client.status(str(template["miner_address"]))
                    )
                except NodeError:
                    pass
                self._refresh_market_if_due()
                coinbase_prefix = (
                    f"knxcoin/coinbase/v2|{height}|"
                    f"{template['miner_address']}|{reward}|"
                ).encode("ascii")

                if not self.enabled.is_set() or SERVICE_STOP.is_set():
                    STATE.set(
                        mining_requested=False,
                        phase="paused",
                        hash_rate_hs=0.0,
                        current_job_attempts=0,
                    )
                    continue

                self.job_seq += 1
                job_id = self.job_seq
                self._set_active_job(job_id)
                for worker_id in range(WORKERS):
                    self.attempts[worker_id] = 0
                    self.job_queues[worker_id].put(
                        (job_id, template, branch, coinbase_prefix)
                    )

                current_jobs = STATE.snapshot()["jobs_started"] + 1
                STATE.set(
                    phase="mining",
                    height=height,
                    current_job_attempts=0,
                    jobs_started=current_jobs,
                )

                watcher_done = threading.Event()
                watcher = threading.Thread(
                    target=self._watch_template,
                    args=(template, job_id, watcher_done),
                    daemon=True,
                )
                watcher.start()

                started = time.monotonic()
                last_log = 0.0
                solution: dict[str, Any] | None = None
                expired = False

                while (
                    self.enabled.is_set()
                    and not SERVICE_STOP.is_set()
                    and self.active_job.value == job_id
                ):
                    if time.time() >= float(template["expires_unix"]):
                        expired = True
                        self._invalidate_job()
                        break

                    try:
                        candidate = self.result_queue.get(timeout=0.2)
                        if int(candidate.get("job_id", -1)) == job_id:
                            solution = candidate
                            self._invalidate_job()
                            break
                    except queue.Empty:
                        pass

                    total = int(sum(self.attempts))
                    elapsed = max(0.001, time.monotonic() - started)
                    rate = total / elapsed
                    STATE.set(
                        hash_rate_hs=rate,
                        current_job_attempts=total,
                    )

                    now = time.monotonic()
                    if now - last_log >= LOG_INTERVAL_SECONDS:
                        STATE.record_rate(rate, height)
                        print(f"{format_rate(rate)} | height {height}", flush=True)
                        last_log = now

                watcher_done.set()
                watcher.join(timeout=0.5)

                total = int(sum(self.attempts))
                stale = (
                    solution is None
                    and not expired
                    and self.enabled.is_set()
                    and not SERVICE_STOP.is_set()
                )
                STATE.add_job_result(total, stale)

                if not self.enabled.is_set() or SERVICE_STOP.is_set():
                    continue
                if solution is None:
                    # The protocol intentionally uses 12-second templates.
                    # Transition straight to the next job without zeroing the
                    # last good rate shown to monitoring clients.
                    STATE.set(phase="refreshing")
                    continue

                payload = {key: value for key, value in solution.items() if key != "job_id"}
                STATE.set(phase="submitting")
                result = self.client.submit(payload)
                if bool(result.get("accepted")):
                    accepted_height = int(result.get("height", height))
                    block_hash = str(
                        result.get("hash", payload.get("header_hash", ""))
                    ) or None
                    STATE.accepted(accepted_height, block_hash, reward)
                    print(f"ACCEPTED | height {accepted_height}", flush=True)

            except NodeError as error:
                delay = self._backoff(error, delay)
                STATE.set(phase="backoff", last_error=str(error)[:300], hash_rate_hs=0.0)
                self._wait_enabled(delay + random.random() * min(1.0, delay * 0.05))
            except Exception as error:
                delay = min(120.0, max(2.0, delay * 2.0))
                STATE.set(
                    phase="backoff",
                    last_error=f"{type(error).__name__}: {error}"[:300],
                    hash_rate_hs=0.0,
                )
                self._wait_enabled(delay)

        self._release_lease()
        self._shutdown_workers()
        STATE.set(phase="stopped", hash_rate_hs=0.0)


ENGINE = MinerEngine()


class Handler(BaseHTTPRequestHandler):
    server_version = "MINR/2"

    def _json(self, status: int, value: dict[str, Any]) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        if not CONTROL_TOKEN:
            return False
        auth = self.headers.get("Authorization", "")
        candidate = auth[7:] if auth.startswith("Bearer ") else ""
        if not candidate:
            candidate = self.headers.get("x-miner-control-token", "")
        return hmac.compare_digest(candidate, CONTROL_TOKEN)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            snapshot = STATE.snapshot()
            self._json(
                200,
                {
                    "status": snapshot["status"],
                    "phase": snapshot["phase"],
                    "uptime_seconds": snapshot["uptime_seconds"],
                },
            )
            return
        if path in {"/stats", "/api/stats"}:
            self._json(200, STATE.snapshot())
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in {"/control/start", "/control/stop"}:
            self._json(404, {"error": "not_found"})
            return
        if not CONTROL_TOKEN:
            self._json(503, {"error": "MINER_CONTROL_TOKEN is not configured."})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return

        if path == "/control/start":
            ENGINE.request_start()
            self._json(200, {"ok": True, "stats": STATE.snapshot()})
        else:
            ENGINE.request_stop()
            self._json(200, {"ok": True, "stats": STATE.snapshot()})

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def _shutdown(*_args: object) -> None:
    SERVICE_STOP.set()
    ENGINE.request_stop()


def main() -> int:
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server_thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.5},
        daemon=True,
    )
    server_thread.start()

    ENGINE.start_service()
    # Always boot paused. A Northflank restart or a new deployment must never
    # silently resume mining after the user previously stopped it.
    STATE.set(
        mining_requested=False,
        phase="paused",
        hash_rate_hs=0.0,
        current_job_attempts=0,
    )

    try:
        while not SERVICE_STOP.wait(0.5):
            pass
    finally:
        ENGINE.request_stop()
        if ENGINE.thread:
            ENGINE.thread.join(timeout=5)
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
