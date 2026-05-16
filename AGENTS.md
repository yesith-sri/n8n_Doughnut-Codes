<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Forge — Agent rules

Forge is a Next.js control plane for an n8n-driven agentic deployment pipeline. The frontend never makes deployment decisions on its own — it submits work to n8n, renders n8n's response, and forwards human approvals back via n8n's resume webhook.

This document is the contract for any agent (human or AI) editing this repo.

---

## 1. Product surface

- **One-line pitch**: a deploying harness — hand a Docker image to a crew of agents, chat with the advisor to catch mistakes, then watch them deploy it.
- **Primary user action**: paste a Docker image URL, click *Forge deployment*, chat with the advisor, then click one of the *Deploy to {AWS|GCP|Azure}* buttons.
- **Approval model**: the workflow pauses on an n8n Chat Wait node. The frontend has a multi-turn conversation with the **Deployment Chat Agent** via the rotating resume URL, then commits one **final** decision (`{ type: "final", action, provider }`). **No Slack, no email.**
- **Providers**: `aws`, `gcp`, `azure` — exactly these three labels in code and UI. Do not reintroduce Railway or Fly.

---

## 2. Design system

### Typography
- **Display / brand / numerals → `Oxanium`** via `next/font/google`, weights 300–800.
- **Body / UI / paragraphs → `Roboto`** via `next/font/google`, weights 300–700.
- Wired as CSS variables `--font-display` and `--font-body` in `app/layout.tsx`.
- Helper classes in `app/globals.css`: `.font-display`, `.font-body`, `.font-mono`, `.numerals` (Oxanium + tabular-nums), `.eyebrow` (uppercase Oxanium label).

Rules:
- Headings, brand text, stat numbers, button labels, eyebrow tags → Oxanium.
- Sentences, descriptions, log messages, paragraphs → Roboto.
- Never load a third sans-serif. Never inline a Google Fonts `<link>` — always go through `next/font`.

### Color palette
Tokens live in `app/globals.css` as CSS custom properties on `:root`. **Do not introduce new ad-hoc colors** — extend the token set if a new role is genuinely needed.

| Token | Hex | Role |
| --- | --- | --- |
| `--bg-base` | `#0c1014` | App canvas |
| `--bg-elevated` | `#11161d` | Panels |
| `--bg-raised` | `#161c25` | Cards inside panels |
| `--bg-input` | `#0a0e13` | Inputs, code, mono surfaces |
| `--ink-primary` | `#ede5d3` | Body text (warm off-white, not stark) |
| `--ink-secondary` | `#a8a89b` | Secondary text |
| `--ink-tertiary` | `#6e7177` | Captions, metadata |
| `--brand` | `#d4a24b` | Primary action / focus / brand |
| `--accent` | `#4d8a89` | Secondary action / focus rings |
| `--status-ok` | `#7ea676` | Success / healthy |
| `--status-pending` | `#c7a456` | Pending / waiting |
| `--status-active` | `#6aaba9` | Active / in flight |
| `--status-warn` | `#c9925a` | Warnings |
| `--status-error` | `#c4655a` | Failures |

Palette intent: an editorial, "trustworthy operator" feel (Stripe / Linear / Mercury). Warm charcoal background, single amber-gold accent, muted earth-tone status colors. **No neon, no purple-to-pink gradients, no AI-blue-purple combos**.

### Motion
- Library: **GSAP** with `@gsap/react` (`useGSAP` hook + scoped refs).
- Register the plugin once at module scope: `gsap.registerPlugin(useGSAP)`.
- All GSAP code must be scoped to a ref: `useGSAP(() => { ... }, { scope: rootRef })`. Never let selectors leak across components.
- Honor `prefers-reduced-motion` — `app/globals.css` already disables long animations under that media query. Don't bypass it with inline styles.
- Entrance choreography: stagger by intent. Heading first, stats next, panels last. Never animate everything at once.
- Don't animate things the user has to read (paragraphs > 2 lines, log messages). Animate containers, not text.

### Pipeline visualization
- Lives in `app/components/PipelineCanvas.tsx`.
- Pure 2D canvas, devicePixelRatio-aware, observes its wrapper for resize.
- Renders nodes from a `PipelineStage[]` array; each stage has one of: `done | active | pending | failed | skipped`.
- The render loop naps when no stage is `active` or `pending`. Don't replace it with `setInterval`.

---

## 3. n8n workflow contract

The single source of truth is the n8n workflow `agentic-idp` (id `Co7HN1Zf7FQT6YSa`). Update it through the n8n MCP using the Workflow SDK; never hand-edit JSON.

### Triggers (2)
1. **`Deployment Webhook`** — `POST /deploy`, `responseMode: responseNode`. Accepts:
   ```json
   { "dockerImageUrl": "nginx:latest", "dockerfileContent": "FROM ..." }
   ```
2. **`Monitoring Schedule`** — every 5 minutes; re-checks `status=deployed AND health_status=healthy` rows and flips them to `unhealthy` on failure.

### Main pipeline
`Deployment Webhook → Normalize Input → Fetch Docker Image Metadata → Compose App Spec → Analyzer Agent → Architect Agent → Cost Estimator → Save Deployment Request → Respond to Frontend → Chat Wait → Is Final Decision?`

### Chat loop (the harness)
When the body is `{ type: "chat", message, history }`, the `Is Final Decision?` IF routes to the **false** branch:
`Chat Wait → Is Final Decision? (false) → Build Chat History → Deployment Chat Agent → Append AI Response → Respond Chat Reply → Chat Wait`

The loop keeps cycling until the frontend POSTs a final message. Each iteration:
- `Respond Chat Reply` returns `{ type: "chat", reply, history, resumeUrl, deploymentId }` synchronously.
- The new `resumeUrl` is generated for the next Chat Wait suspension — the frontend must use it for the next message.

### Final decision
When the body is `{ type: "final", action, provider, plan? }`, the `Is Final Decision?` IF routes to the **true** branch:
`Chat Wait → Is Final Decision? (true) → Extract Final Decision → Respond Final Decision → Check Final Approval`

- On `approve`: current POC routes `aws` to `Capture Approval → Update Status Approved → Deploy Agent → Prepare AWS Deployment → Provision AWS ECS → Wait for ECS Ready → Describe AWS ECS → Health Check → Check Health Status → (Update Status Success | Debugger Agent → Update Status Failed)`. Non-AWS final selections are marked unsupported for this POC.
- On `reject`: `Update Status Rejected`.

### Response shapes
**Initial response (`Respond to Frontend`)**
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
  "resumeUrl": "https://.../webhook/resume/..."
}
```

**Chat reply (`Respond Chat Reply`)**
```json
{
  "type": "chat",
  "reply": "GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.",
  "history": [{ "role": "user", "content": "what is the cheapest?" }, { "role": "assistant", "content": "..." }],
  "resumeUrl": "https://.../webhook/resume/<new>",
  "deploymentId": 42
}
```

**Final ack (`Respond Final Decision`)**
```json
{ "type": "final", "status": "deploying", "action": "approve", "provider": "gcp", "plan": "" }
```

### Frontend → n8n calls
- **All browser → n8n traffic goes through a Next.js server-side proxy.** Initial submit hits `/api/deploy`; every chat turn and the final commit hit `/api/resume`. The route handlers live in `app/api/deploy/route.ts` and `app/api/resume/route.ts` and forward to the configured n8n URL.
- This is **deliberate and required**: the `Wait` node in n8n has no `allowedOrigins` option, so the browser CORS preflight on a resume URL is structurally impossible to satisfy. Server-side proxying is the only honest fix.
- **Chat turn:** POST `/api/resume` with `{ "resumeUrl": "<currentResumeUrl>", "body": { "type": "chat", "message": "...", "history": [...] } }`. Use the `resumeUrl` from the previous response on every subsequent call.
- **Final commit:** POST `/api/resume` with `{ "resumeUrl": "<currentResumeUrl>", "body": { "type": "final", "action": "approve" | "reject", "provider": "aws" | "gcp" | "azure", "plan": "" } }`.
- The proxy refuses to forward to any host outside the allowlist derived from `N8N_DEPLOY_WEBHOOK_URL` (+ optional `N8N_ALLOWED_HOSTS`). Don't try to make `/api/resume` accept arbitrary URLs.

### Credentials
- **Full setup guide:** [`docs/credentials.md`](docs/credentials.md). Read it before wiring any cloud.
- Frontend env: `N8N_DEPLOY_WEBHOOK_URL` in `.env.local` (see `.env.example`). No cloud secrets ever live on the frontend.
- n8n credentials (set in the n8n Credentials manager):
  - `Postgres account` → `Save Deployment Request`, `Update Status *`, `Fetch Active Deployments`, `Mark Deployment Unhealthy`
  - `OpenAI account` → the shared `OpenAI GPT-4.1` sub-model (used by every AI Agent)
  - AWS provisioning uses the Forge server `/api/aws/provision` route, not an n8n AWS credential. Forge signs ECS/EC2 calls with `ACCESS_KEY` / `SECRET_KEY` from `.env.local`.
  - `GCP OAuth2` → `Deploy to GCP` (also replace `PROJECT_ID` placeholder in the node URL)
  - `Azure OAuth2` → `Deploy to Azure` (also replace `SUB_ID` / `RG_NAME` placeholders in the node URL)
  - Docker Hub fetch is unauthenticated.

### Forbidden in this workflow
- ❌ Slack nodes anywhere (replaced by direct webhook chat + approval).
- ❌ Manual triggers as the main entry point (use the webhook trigger).
- ❌ SSH-based deployment steps (use the provider HTTP APIs).
- ❌ A `Merge` node before health check (the switch already guarantees a single live branch).
- ❌ Single-shot approval. The chat loop is the human-in-the-loop; never bypass it with a plain Wait node again.

---

## 4. Frontend contract

- `app/page.tsx` is the entire dashboard. It owns workflow UI state but no workflow logic.
- `app/components/PipelineCanvas.tsx` renders the agent graph; it is purely presentational.
- The n8n URL lives in `process.env.N8N_DEPLOY_WEBHOOK_URL` (server-side env). It is **never** exposed to the client and there is no user-facing override field. Configure via `.env.local` (see `.env.example`).
- **No mocks. Ever.** There are no canned advisor replies, no simulated deployments, no offline fallbacks. If n8n is unreachable, the page surfaces the real error inline — it does not pretend to work. Anyone tempted to re-add a "demo mode" should add a real status-polling endpoint instead.
- **Resume URL rotation:** after the initial submit, the page keeps a `currentResumeUrl` ref. Every chat reply from n8n carries a new `resumeUrl` that *replaces* the previous one. The final commit POST always uses the latest URL.
- All chat / final calls go through the Next.js server-side proxy (`/api/resume`). The browser never POSTs to n8n directly — see the rationale in §3 (n8n Wait nodes can't satisfy CORS preflight).
- Every n8n reply (analyzer summary, architect recommendation, cost output, chat replies, debugger output) is surfaced in **two** places: the chat panel (as a labeled bubble) and the activity log (as a labeled log entry). Never let n8n output go uncited.
- **Hydration discipline:** never call `new Date()`, `Date.now()`, or `Math.random()` while rendering. The log seed uses a stable id / empty timestamp. `formatTime("")` returns an empty string by contract.

---

## 5. House style

- Tailwind v4 (`@import "tailwindcss"`). Inline CSS variables via `bg-[var(--token)]` / `text-[var(--token)]`. Don't add another styling library.
- Component file size: keep the page render-only; extract repeated pieces into small presentational helpers at the bottom of the same file.
- Comments: only explain **why**, never narrate **what**. No `// import the module`-style noise.
- Don't introduce a state library. `useState` + local refs are fine for this scope.
- Don't introduce a fetch wrapper. Native `fetch` is enough.

---

## 6. Working with the n8n MCP

Order of operations every time you touch the workflow:

1. `get_sdk_reference` if any pattern is unclear.
2. `search_nodes` + `get_node_types` for any node you add — never guess parameter names.
3. `validate_workflow` with the full SDK code.
4. `update_workflow` with the validated code. Pass a `description` ≤ 255 chars.
5. Sanity-check the auto-assigned credentials in the response.

When the workflow grows, prefer **persisting state in Postgres** over chasing values across nodes with `nodeJson(...)` — the existing `Capture Approval` set node is the pattern to follow.
