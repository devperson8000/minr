# KNXCoin Northflank Miner

An independent, always-on KNXCoin protocol-v2 SHA-256d miner designed to run as a **single Northflank service 24/7**.

It talks to the existing KNXCoin node over the public mining API. It does **not** need Supabase credentials, wallet private keys, or access to the KNXCoin source repository.

## What it does

- Requests protocol-v2 work from `/api/mining/template`.
- Mines SHA-256d block headers using the exact KNXCoin v2 commitment format.
- Submits valid solutions to `/api/mining/submit`.
- Polls the lightweight miner-status endpoint while hashing and abandons stale work quickly when another miner wins the height.
- Retries transient network/server failures with bounded exponential backoff.
- Retries a solved block submission while the template is still valid, so a temporary connection failure does not immediately throw away a winning solution.
- Supports multiple local worker processes with `KNX_WORKERS`.
- Exposes `GET /health` and `GET /stats` on port `8080` for container health checks and basic diagnostics.
- Uses only the Python standard library.
- Runs as a non-root user in Docker.

## Required environment variable

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `KNX_API_KEY` | Yes | none | The `knx_sk_...` mining API key from the KNXCoin mining page. |
| `KNX_NODE_URL` | No | `https://knxcoin.vercel.app` | Public KNXCoin node URL. |
| `KNX_WORKERS` | No | `1` | CPU worker processes. Match this to the vCPUs allocated to the service. |
| `KNX_STATUS_POLL_SECONDS` | No | `2` | How often the miner checks whether its current template became stale. |
| `KNX_HTTP_TIMEOUT_SECONDS` | No | `20` | Node HTTP timeout. |
| `KNX_LOG_INTERVAL_SECONDS` | No | `5` | Mining progress log interval. |
| `PORT` | No | `8080` | Health/stats HTTP server port. |

## Northflank deployment

1. Create a **combined service** from this GitHub repository.
2. Select the `main` branch.
3. Select **Dockerfile** as the build type. The Dockerfile is at `/Dockerfile` and the build context is the repository root.
4. Add the runtime variable `KNX_API_KEY` with your real KNXCoin mining API key.
5. Leave `KNX_NODE_URL=https://knxcoin.vercel.app` unless you intentionally run a different KNXCoin node.
6. Keep the service at **1 instance**. Do not horizontally replicate one API key/address: KNXCoin keeps one open non-browser mining template per address, so replicas would continuously stale each other's jobs.
7. Set `KNX_WORKERS` to the number of vCPUs allocated to the container. On a 1-vCPU plan, leave it at `1`.
8. You do not need a public website. If you configure a health check, use HTTP port `8080` and path `/health`.
9. Deploy. Northflank will run the container continuously and rebuild it when new commits are pushed if CI/CD is enabled.

## Logs you should see

```text
[health] listening on 0.0.0.0:8080 (/health, /stats)
[start] KNXCoin miner | node=https://knxcoin.vercel.app | workers=1 | stale-poll=2.0s
[job] height 123 | nBits 1f0fffff | expires 2026-...
[mine] height 123 | 150,000 H/s | 750,000 attempts | 1 worker(s)
[stale] height 123: template was closed by the network
[job] height 124 | ...
```

If this miner finds a valid header:

```text
[solve] height 124 | hash 0000...
[accepted] height 124 | hash 0000...
```

## Health endpoints

`GET /health` is intentionally a **liveness** check. It stays healthy during a temporary KNXCoin-node outage so Northflank does not restart a perfectly good miner just because the remote node is unavailable.

`GET /stats` reports current height, hash rate, attempts, accepted blocks, stale jobs, phase, uptime, worker count, and the last node error. It never returns the mining API key.

## Important deployment rule

Run **one Northflank instance per KNX mining address/API key**. If you want multiple independent miners, use separate KNX mining identities/keys rather than cloning the same key across replicas.

## Local check

```bash
export KNX_API_KEY='knx_sk_...'
python3 miner.py
```

Tests:

```bash
python3 -m unittest discover -s tests -v
```
