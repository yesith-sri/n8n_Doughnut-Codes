# Frontend Contract

Forge is a deploying harness on top of the `agentic-idp` n8n workflow. The frontend never reimplements workflow logic — it forwards requests to n8n via a tiny server-side proxy, renders **every** n8n response, hosts the chat between the user and the deployment advisor, and commits the final decision.

**There are no mocks anywhere.** If n8n is unreachable the page shows the real error inline; it does not pretend to deploy.

## What the UI does

- Collects a **Docker image URL** (and an optional Dockerfile).
- POSTs that to **`/api/deploy`** (the Next.js server-side proxy), which forwards to the n8n `Deployment Webhook`.
- Renders the n8n response: architecture recommendation, cost estimates for AWS / GCP / Azure, deployment ID, and the first resume URL.
- Drives a **multi-turn chat** with the Deployment Chat Agent by POSTing every turn through **`/api/resume`**, which proxies to the rotating resume URL.
- Surfaces every reply in two places: the chat bubble panel and the activity log.
- Commits the final decision with one `{ type: "final", action, provider }` POST through `/api/resume`.
- Visualizes the pipeline state as an animated canvas (Ingest → Inspect → Analyze → Architect → **Advise** → Deploy → Verify → Heal).

## Why the proxy exists

n8n's `Wait` node has no `allowedOrigins` option (unlike the regular Webhook trigger). Its resume URL therefore can't satisfy the browser's CORS preflight, so a direct browser POST is structurally impossible. The Next.js proxy is the only honest fix — it forwards server-side, where CORS doesn't apply, and is the load-bearing reason the page can talk to n8n at all.

## What the UI does NOT do

- It does not call n8n directly from the browser. All traffic goes through `/api/deploy` or `/api/resume`.
- It does not hold AWS / GCP / Azure secrets — those live exclusively in n8n's Credentials store. See [`docs/credentials.md`](./credentials.md).
- It does not recompute architecture, costs, or provider routing.
- It does not poll for the post-deploy outcome yet — left as a future improvement. After a final `approve`, the page sits at `deploying`; the actual deploy result lives in the n8n execution log and the Postgres `deployments` row.

## Data exchange

### Submitting a deployment (frontend → `/api/deploy` → n8n)

`POST /api/deploy` with:

```json
{
  "dockerImageUrl": "nginx:latest",
  "dockerfileContent": "FROM nginx:latest\nEXPOSE 80"
}
```

`dockerfileContent` is optional. The proxy forwards the body verbatim to `process.env.N8N_DEPLOY_WEBHOOK_URL`.

### Response (n8n → `/api/deploy` → frontend)

```json
{
  "deploymentId": 42,
  "status": "pending_approval",
  "architecture": "GCP Cloud Run",
  "recommendedProvider": "gcp",
  "dockerImageUrl": "nginx:latest",
  "runtime": "static",
  "ports": "80",
  "memoryMB": 256,
  "cpuCores": 0.25,
  "costs": { "aws": 40, "gcp": 30, "azure": 43 },
  "resumeUrl": "https://.../webhook/resume/<exec-id>"
}
```

### Chatting with the advisor (frontend → `/api/resume` → n8n)

After the initial response, the page keeps `currentResumeUrl` in state. **Every chat turn must POST that URL through `/api/resume`.**

`POST /api/resume` with:

```json
{
  "resumeUrl": "<currentResumeUrl>",
  "body": {
    "type": "chat",
    "message": "what is the cheapest option?",
    "history": [
      { "role": "user", "content": "previous user turn" },
      { "role": "assistant", "content": "previous assistant turn" }
    ]
  }
}
```

### Chat reply (n8n → `/api/resume` → frontend)

```json
{
  "type": "chat",
  "reply": "GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.",
  "history": [
    { "role": "user", "content": "what is the cheapest option?" },
    { "role": "assistant", "content": "GCP Cloud Run is cheapest..." }
  ],
  "resumeUrl": "https://.../webhook/resume/<new-exec-id>",
  "deploymentId": 42
}
```

Update `currentResumeUrl` to the new value before the next request.

### Committing a final decision (frontend → `/api/resume` → n8n)

`POST /api/resume` with `body` being one of:

```json
{ "type": "final", "action": "approve", "provider": "aws", "plan": "" }
{ "type": "final", "action": "approve", "provider": "gcp", "plan": "" }
{ "type": "final", "action": "approve", "provider": "azure", "plan": "" }
{ "type": "final", "action": "reject", "plan": "" }
```

### Final ack (n8n → `/api/resume` → frontend)

```json
{ "type": "final", "status": "deploying", "action": "approve", "provider": "gcp", "plan": "" }
```

After the final ack, `currentResumeUrl` is spent — the page sets it to `null`.

## Proxy safety

`/api/resume` will only forward to hosts in its allowlist:

1. The host parsed from `N8N_DEPLOY_WEBHOOK_URL` (always allowed).
2. Optional comma-separated extras in `N8N_ALLOWED_HOSTS`.

If a request arrives with a `resumeUrl` whose host isn't allowed, the proxy returns `403`. This prevents the route from being turned into an open relay.

## UI states

The page handles these `Status` values:

- `idle` — ready for input
- `submitting` — POST to `/api/deploy` in flight
- `pending_approval` — chat loop is active; the user can keep talking or commit
- `deploying` — final approval sent, provider branch running in n8n
- `deployed` — health check passed (future: status polling)
- `failed` — deploy failed (future: status polling)
- `unhealthy` — monitor detected a regression (future: status polling)
- `rejected` — user committed a `reject`

## File map

- `app/layout.tsx` — root layout, font wiring (Oxanium primary, Roboto secondary).
- `app/globals.css` — design tokens, helper classes, prefers-reduced-motion handling.
- `app/page.tsx` — entire dashboard, including submission, chat, final commit, logs.
- `app/components/PipelineCanvas.tsx` — animated canvas pipeline visualization.
- `app/api/deploy/route.ts` — server-side proxy to the n8n deploy webhook.
- `app/api/resume/route.ts` — server-side proxy to n8n resume URLs (host-allowlisted).
- `app/api/_lib/n8n.ts` — small helpers shared by the two route handlers.

## Configuration

- `N8N_DEPLOY_WEBHOOK_URL` in `.env.local` — required. Full URL of the n8n `Deployment Webhook` trigger.
- `N8N_ALLOWED_HOSTS` in `.env.local` — optional. Extra hostnames that `/api/resume` is allowed to forward to.
- No cloud secrets live on the frontend. AWS / GCP / Azure / Postgres / OpenAI credentials are all configured in n8n — see [`docs/credentials.md`](./credentials.md).

## Design rules (short version, full in `AGENTS.md`)

- Oxanium for display + numerals; Roboto for body.
- One warm-gold brand accent, one teal supporting accent. No neon, no purple-to-pink AI gradients.
- GSAP for entrances and ambient motion; honor `prefers-reduced-motion`.
- Canvas pipeline naps when nothing is animating.
