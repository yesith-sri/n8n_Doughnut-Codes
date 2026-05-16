# Forge — Deployment Control

Next.js control plane for the `agentic-idp` n8n workflow. Hand it a Docker image, chat with the deploy advisor, then commit a final decision and the n8n agents push it to AWS, GCP, or Azure.

## Run

```bash
bun install
cp .env.example .env.local           # then fill in N8N_DEPLOY_WEBHOOK_URL
bun run dev
```

The app is live at <http://localhost:3000>. There are **no mocks** — if n8n isn't reachable, the page tells you exactly what failed.

## Architecture

- **`app/page.tsx`** — the entire dashboard (intake, chat, pipeline canvas, logs).
- **`app/components/PipelineCanvas.tsx`** — animated 2D canvas of the pipeline.
- **`app/api/deploy/route.ts`** + **`app/api/resume/route.ts`** — server-side proxies to n8n. The browser never POSTs to n8n directly (n8n's Wait node can't satisfy a browser CORS preflight).

## Configuration

| Variable | Required | Where | Purpose |
| --- | :-: | --- | --- |
| `N8N_DEPLOY_WEBHOOK_URL` | yes | `.env.local` | Full URL of the n8n `Deployment Webhook` trigger |
| `N8N_ALLOWED_HOSTS` | no | `.env.local` | Extra hosts the resume proxy may forward to |

All cloud (AWS / GCP / Azure / Postgres / OpenAI) credentials live in **n8n's Credentials store**, not on the frontend. The full step-by-step is in [`docs/credentials.md`](docs/credentials.md).

## Project docs

- [`AGENTS.md`](AGENTS.md) — design system, n8n workflow contract, house style. Authoritative.
- [`docs/credentials.md`](docs/credentials.md) — where to put AWS / GCP / Azure / Postgres / OpenAI credentials in n8n and which placeholders to replace.
- [`docs/frontend-contract.md`](docs/frontend-contract.md) — request/response shapes between the page, the proxy, and n8n.
- [`docs/n8n-workflow.md`](docs/n8n-workflow.md) — the workflow itself (nodes, branches, why the chat loop exists).
- [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) — high-level project summary.
