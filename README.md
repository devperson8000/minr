# MINR

MINR is a dedicated KNXCoin cloud miner with a small Northflank backend and a minimal Vercel dashboard.

The same GitHub repository is deployed twice:

- **Northflank** builds the root Dockerfile and runs the miner.
- **Vercel** serves the static dashboard in \`web/\` and the protected \`/api/miner\` proxy.

The KNX mining key is never sent to the browser.

## Northflank

Create a combined service from this repository, branch \`main\`, using the root \`Dockerfile\`.

Use one service instance and add:

\`\`\`text
KNX_API_KEY=your_knx_key
KNX_MINER_SESSION_ID=a_unique_uuid
KNX_WORKERS=1
MINER_CONTROL_TOKEN=a_long_random_secret
MINER_AUTOSTART=0
PORT=8080
\`\`\`

Optional defaults:

\`\`\`text
KNX_NODE_URL=https://knxcoin.vercel.app
KNX_STATUS_POLL_SECONDS=4
KNX_TEMPLATE_MIN_INTERVAL_SECONDS=12
KNX_HTTP_TIMEOUT_SECONDS=15
KNX_LOG_INTERVAL_SECONDS=2
\`\`\`

The default template gate is deliberately conservative. A miner normally requests about five templates per minute because KNX templates expire after roughly 12 seconds. If two miners share one KNX API key, the two services stay around ten template requests per minute combined, below the current 12/minute template limit. Status checks are also intentionally modest.

Northflank health check:

\`\`\`text
GET /health
port 8080
\`\`\`

With `MINER_AUTOSTART=0`, the miner stays paused after a deployment until the Vercel dashboard starts it. Its normal console output is intentionally short:

\`\`\`text
82.4 kH/s | height 1432
ACCEPTED | height 1432
\`\`\`

## Vercel

Import the same repository into Vercel. \`vercel.json\` publishes \`web/\` as the frontend.

Add these Vercel environment variables:

\`\`\`text
MINER_BACKEND_URL=https://your-northflank-service-domain
MINER_CONTROL_TOKEN=the_exact_same_secret_used_on_northflank
\`\`\`

Do **not** add \`KNX_API_KEY\` to the frontend. Vercel only needs the Northflank URL and the control secret.

The dashboard shows:

- live hash rate
- current block height
- accepted-block count
- uptime and worker count
- start/pause control
- a small notification when a block is accepted

## Miner endpoints

Northflank exposes:

- \`GET /health\` — liveness
- \`GET /stats\` — safe runtime statistics
- \`POST /control/start\` — protected by \`MINER_CONTROL_TOKEN\`
- \`POST /control/stop\` — protected by \`MINER_CONTROL_TOKEN\`

No endpoint exposes the KNX API key.

## Two miners

KNXCoin supports two active miner sessions per wallet. If you deploy two dedicated MINR services, use:

- the same KNX API key if both mine to the same wallet
- a **different** \`KNX_MINER_SESSION_ID\` on each service
- the conservative default template interval, or slower
- one Northflank instance per service

Do not horizontally replicate a single MINR service.

## Tests

\`\`\`bash
python3 -m unittest discover -s tests -v
python3 -m py_compile miner.py
\`\`\`
