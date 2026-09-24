#!/usr/bin/env python3
"""Always-on KNXCoin protocol-v2 SHA-256d miner for container platforms."""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import multiprocessing as mp
import os
import queue
import random
import signal
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

NODE_URL = os.getenv("KNX_NODE_URL", "https://knxcoin.vercel.app").rstrip("/")
API_KEY = os.getenv("KNX_API_KEY", "").strip()
PORT = int(os.getenv("PORT", "8080"))
HTTP_TIMEOUT = max(3.0, float(os.getenv("KNX_HTTP_TIMEOUT_SECONDS", "20")))
STATUS_POLL_SECONDS = max(1.0, float(os.getenv("KNX_STATUS_POLL_SECONDS", "2")))
LOG_INTERVAL_SECONDS = max(1.0, float(os.getenv("KNX_LOG_INTERVAL_SECONDS", "5")))
WORKERS = max(1, min(32, int(os.getenv("KNX_WORKERS", "1"))))
CHECK_EVERY_HASHES = 8192
USER_AGENT = "knxcoin-northflank-miner/1.0"

STOP = threading.Event()


def sha256d(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def display_hash(raw: bytes) -> str:
    return raw[::-1].hex()


def header_bytes(version: int, previous_hash: str, merkle_root: str, timestamp: int, bits: int, nonce: int) -> bytes:
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


class NodeError(RuntimeError):
    def __init__(self, status: int | None, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass
class RuntimeState:
    started_monotonic: float = field(default_factory=time.monotonic)
    phase: str = "starting"
    height: int | None = None
    template_id: str | None = None
    hash_rate: float = 0.0
    current_job_attempts: int = 0
    total_attempts: int = 0
    jobs_started: int = 0
    stale_jobs: int = 0
    blocks_accepted: int = 0
    last_node_contact: float | None = None
    last_error: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def mutate(self, **updates: Any) -> None:
        with self._lock:
            for key, value in updates.items():
                setattr(self, key, value)

    def finish_job(self, attempts: int, stale: bool = False) -> None:
        with self._lock:
            self.total_attempts += max(0, attempts)
            self.current_job_attempts = attempts
            self.hash_rate = 0.0
            if stale:
                self.stale_jobs += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": "stopping" if STOP.is_set() else "ok",
                "phase": self.phase,
                "uptime_seconds": round(time.monotonic() - self.started_monotonic, 1),
                "height": self.height,
                "hash_rate_hs": round(self.hash_rate, 2),
                "current_job_attempts": self.current_job_attempts,
                "total_attempts": self.total_attempts,
                "jobs_started": self.jobs_started,
                "stale_jobs": self.stale_jobs,
                "blocks_accepted": self.blocks_accepted,
                "last_node_contact_unix": self.last_node_contact,
                "last_error": self.last_error,
                "workers": WORKERS,
                "node": NODE_URL,
            }


STATE = RuntimeState()


def _json_error_message(raw: bytes, fallback: str) -> str:
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
        if isinstance(parsed, dict):
            for key in ("error", "message", "detail"):
                value = parsed.get(key)
                if value:
                    return str(value)[:300]
    except Exception:
        pass
    return fallback[:300]


class NodeClient:
    def __init__(self, node_url: str, api_key: str):
        self.node_url = node_url.rstrip("/")
        self.api_key = api_key

    def _request(self, path: str, payload: dict[str, Any] | None = None, *, method: str = "POST", auth: bool = True) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = "Bearer " + self.api_key
        request = urllib.request.Request(self.node_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                raw = response.read()
                STATE.mutate(last_node_contact=time.time(), last_error=None)
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read()
            retry_after = None
            try:
                if error.headers.get("Retry-After"):
                    retry_after = float(error.headers["Retry-After"])
            except Exception:
                retry_after = None
            message = _json_error_message(raw, f"HTTP {error.code}")
            STATE.mutate(last_node_contact=time.time(), last_error=message)
            raise NodeError(error.code, message, retry_after) from error
        except urllib.error.URLError as error:
            message = str(error.reason)[:300]
            STATE.mutate(last_error=message)
            raise NodeError(None, message) from error
        except TimeoutError as error:
            STATE.mutate(last_error="request timed out")
            raise NodeError(None, "request timed out") from error

    def template(self) -> dict[str, Any]:
        return self._request("/api/mining/template", {})

    def submit(self, solution: dict[str, Any]) -> dict[str, Any]:
        return self._request("/api/mining/submit", solution)

    def status(self, address: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"address": address})
        return self._request(f"/api/mining/status?{query}", None, method="GET", auth=False)


def parse_expiry(template: dict[str, Any]) -> float:
    return _dt.datetime.fromisoformat(str(template["expires_at"]).replace("Z", "+00:00")).timestamp()


def _mine_worker(
    template: dict[str, Any],
    worker_id: int,
    worker_count: int,
    stop_event: Any,
    result_queue: Any,
    attempts: Any,
) -> None:
    target = int(str(template["target"]), 16)
    expiry = float(template["expires_unix"])
    transaction_ids = [str(value) for value in template.get("transaction_ids", [])]
    minimum_timestamp = int(template["minimum_timestamp"])
    template_timestamp = int(template["timestamp"])
    local_attempts = 0
    extra_value = worker_id + 1

    while extra_value < (1 << 64) and not stop_event.is_set():
        extranonce = extra_value.to_bytes(8, "big").hex()
        root = merkle_root([coinbase_txid(template, extranonce)] + transaction_ids)
        timestamp = max(int(time.time()), minimum_timestamp, template_timestamp)
        start_nonce = random.getrandbits(32)

        for offset in range(1 << 32):
            nonce = (start_nonce + offset) & 0xFFFF_FFFF
            raw = sha256d(
                header_bytes(
                    int(template["version"]),
                    str(template["previous_hash"]),
                    root,
                    timestamp,
                    int(template["bits"]),
                    nonce,
                )
            )
            local_attempts += 1

            if int.from_bytes(raw, "little") <= target:
                attempts[worker_id] = local_attempts
                result_queue.put(
                    {
                        "protocol_version": 2,
                        "template_id": template["template_id"],
                        "extranonce": extranonce,
                        "timestamp": timestamp,
                        "nonce": nonce,
                        "merkle_root": root,
                        "header_hash": display_hash(raw),
                    }
                )
                stop_event.set()
                return

            if local_attempts % CHECK_EVERY_HASHES == 0:
                attempts[worker_id] = local_attempts
                if stop_event.is_set() or time.time() >= expiry:
                    return

        extra_value += worker_count

    attempts[worker_id] = local_attempts


def _watch_template(client: NodeClient, template: dict[str, Any], job_stop: Any, watcher_done: threading.Event) -> None:
    template_id = str(template["template_id"])
    height = int(template["height"])
    address = str(template["miner_address"])
    while not STOP.is_set() and not watcher_done.wait(STATUS_POLL_SECONDS):
        if job_stop.is_set():
            return
        try:
            status = client.status(address)
            active = status.get("active_template")
            if not isinstance(active, dict):
                print(f"[stale] height {height}: template was closed by the network", flush=True)
                job_stop.set()
                return
            if str(active.get("template_id")) != template_id or int(active.get("block_index", -1)) != height:
                print(f"[stale] height {height}: a newer template is active", flush=True)
                job_stop.set()
                return
        except NodeError:
            # Mining continues if the watcher temporarily cannot reach the node.
            pass
        except Exception as error:
            STATE.mutate(last_error=f"status watcher: {str(error)[:240]}")


def mine_template(client: NodeClient, template: dict[str, Any]) -> tuple[dict[str, Any] | None, int, bool]:
    template = dict(template)
    template["expires_unix"] = parse_expiry(template)
    height = int(template["height"])
    template_id = str(template["template_id"])
    STATE.mutate(
        phase="mining",
        height=height,
        template_id=template_id,
        current_job_attempts=0,
        hash_rate=0.0,
        jobs_started=STATE.snapshot()["jobs_started"] + 1,
    )

    ctx = mp.get_context("spawn")
    job_stop = ctx.Event()
    result_queue = ctx.Queue(maxsize=1)
    attempts = ctx.Array("Q", WORKERS, lock=False)
    processes = [
        ctx.Process(
            target=_mine_worker,
            args=(template, worker_id, WORKERS, job_stop, result_queue, attempts),
            name=f"knx-worker-{worker_id}",
        )
        for worker_id in range(WORKERS)
    ]
    for process in processes:
        process.start()

    watcher_done = threading.Event()
    watcher = threading.Thread(
        target=_watch_template,
        args=(client, template, job_stop, watcher_done),
        name="knx-template-watcher",
        daemon=True,
    )
    watcher.start()

    started = time.monotonic()
    next_log = started + LOG_INTERVAL_SECONDS
    solution: dict[str, Any] | None = None
    expired = False

    try:
        while not STOP.is_set():
            if time.time() >= float(template["expires_unix"]):
                expired = True
                job_stop.set()
            try:
                solution = result_queue.get(timeout=0.25)
                break
            except queue.Empty:
                pass

            total = int(sum(attempts))
            elapsed = max(0.001, time.monotonic() - started)
            rate = total / elapsed
            STATE.mutate(current_job_attempts=total, hash_rate=rate)

            now = time.monotonic()
            if now >= next_log:
                print(f"[mine] height {height} | {rate:,.0f} H/s | {total:,} attempts | {WORKERS} worker(s)", flush=True)
                next_log = now + LOG_INTERVAL_SECONDS

            if job_stop.is_set() and all(not process.is_alive() for process in processes):
                break
            if all(not process.is_alive() for process in processes):
                break

        if STOP.is_set():
            job_stop.set()
    finally:
        watcher_done.set()
        job_stop.set()
        watcher.join(timeout=1.0)
        for process in processes:
            process.join(timeout=2.0)
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=1.0)

    total = int(sum(attempts))
    stale = solution is None and not expired and not STOP.is_set()
    return solution, total, stale


def submit_solution(client: NodeClient, solution: dict[str, Any], expires_unix: float) -> dict[str, Any] | None:
    delay = 0.25
    for attempt in range(1, 7):
        if STOP.is_set() or time.time() >= expires_unix:
            return None
        try:
            STATE.mutate(phase="submitting")
            return client.submit(solution)
        except NodeError as error:
            if error.status in (404, 409, 410, 422):
                print(f"[submit] solution rejected as stale/invalid: {error}", flush=True)
                return None
            if error.status in (401, 403):
                raise
            if error.status == 429 and error.retry_after is not None:
                delay = max(delay, error.retry_after)
            elif error.status is not None and error.status < 500:
                return None
            print(f"[submit] transient failure on attempt {attempt}/6: {error}", flush=True)
            time.sleep(min(delay, max(0.0, expires_unix - time.time())))
            delay = min(4.0, delay * 2)
    return None


def backoff_seconds(error: NodeError, current: float) -> float:
    if error.status in (401, 403):
        return 60.0
    if error.status == 429:
        return max(1.0, error.retry_after or current)
    if error.status == 503:
        return max(15.0, error.retry_after or 30.0)
    if error.status in (409, 410):
        return 0.5
    return min(300.0, max(2.0, current * 2.0))


class HealthHandler(BaseHTTPRequestHandler):
    server_version = "KNXMinerHealth/1.0"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            snapshot = STATE.snapshot()
            self._send(200, {"status": snapshot["status"], "phase": snapshot["phase"], "uptime_seconds": snapshot["uptime_seconds"]})
            return
        if self.path == "/stats":
            self._send(200, STATE.snapshot())
            return
        self._send(404, {"error": "not_found"})

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def start_health_server() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="health-server", daemon=True)
    thread.start()
    print(f"[health] listening on 0.0.0.0:{PORT} (/health, /stats)", flush=True)
    return server


def run() -> int:
    if not API_KEY or API_KEY.startswith("PASTE_"):
        STATE.mutate(phase="configuration_error", last_error="KNX_API_KEY is not set")
        print("[fatal] Set KNX_API_KEY to the API key shown on the KNXCoin mining page.", flush=True)
        while not STOP.wait(60):
            pass
        return 2

    client = NodeClient(NODE_URL, API_KEY)
    print(f"[start] KNXCoin miner | node={NODE_URL} | workers={WORKERS} | stale-poll={STATUS_POLL_SECONDS:.1f}s", flush=True)
    delay = 2.0

    while not STOP.is_set():
        try:
            STATE.mutate(phase="fetching_template")
            template = client.template()
            delay = 2.0
            height = int(template["height"])
            print(
                f"[job] height {height} | nBits {int(template['bits']):08x} | expires {template['expires_at']}",
                flush=True,
            )

            solution, attempts, stale = mine_template(client, template)
            STATE.finish_job(attempts, stale=stale)
            if STOP.is_set():
                break
            if solution is None:
                STATE.mutate(phase="refreshing")
                continue

            print(f"[solve] height {height} | hash {solution['header_hash']}", flush=True)
            result = submit_solution(client, solution, parse_expiry(template))
            if result and bool(result.get("accepted")):
                snapshot = STATE.snapshot()
                STATE.mutate(blocks_accepted=int(snapshot["blocks_accepted"]) + 1, phase="accepted")
                print(f"[accepted] height {result.get('height', height)} | hash {result.get('hash', solution['header_hash'])}", flush=True)
            else:
                STATE.mutate(phase="refreshing")

        except NodeError as error:
            delay = backoff_seconds(error, delay)
            STATE.mutate(phase="backoff", last_error=str(error)[:300])
            print(f"[node] {error}; retrying in about {delay:.1f}s", flush=True)
            STOP.wait(delay + random.random() * min(2.0, delay * 0.1))
        except KeyboardInterrupt:
            STOP.set()
        except Exception as error:
            delay = min(300.0, max(2.0, delay * 2.0))
            STATE.mutate(phase="backoff", last_error=str(error)[:300])
            print(f"[error] {type(error).__name__}: {error}; retrying in about {delay:.1f}s", flush=True)
            STOP.wait(delay + random.random())

    STATE.mutate(phase="stopped")
    return 0


def _stop(*_args: Any) -> None:
    STOP.set()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    health_server = start_health_server()
    try:
        raise SystemExit(run())
    finally:
        health_server.shutdown()
        health_server.server_close()
