# n8n Workflow Map · `agentic-idp`

The single source of truth lives in n8n (workflow id `Co7HN1Zf7FQT6YSa`). This document describes the shape that backs the Forge frontend so future agents can reason about it without round-tripping to the n8n UI.

## High-level flow

1. The frontend POSTs a Docker image URL to the `Deployment Webhook`.
2. The Docker Hub registry is hit for image metadata.
3. The Analyzer Agent extracts runtime, ports, memory, and CPU.
4. The Architect Agent recommends one of `AWS Fargate`, `GCP Cloud Run`, or `Azure Container Apps`.
5. Costs for all three providers are estimated and the deployment row is saved to Postgres.
6. The `Respond to Frontend` node returns the deployment summary + the first resume URL to the browser.
7. The workflow pauses on the `Chat Wait` webhook.
8. The frontend chats with the **Deployment Chat Agent** by POSTing `{ type: "chat", message, history }` to the current resume URL. Each reply contains a new `resumeUrl`. The loop continues until the user commits.
9. The frontend commits with `{ type: "final", action, provider, plan }`. The workflow exits the chat loop.
10. On `approve`: the Deploy Agent generates a provider-specific JSON config. `Parse Deploy Config` safely parses the JSON string (guarding against LLM preamble). The Switch routes to AWS / GCP / Azure. Each branch:
    - calls the provider REST API autonomously,
    - extracts the real service URL from the API response,
    - feeds it through `Collect Health Result` to stitch the deploymentId + URL for the shared health check.
11. `Health Check` GETs the live endpoint; success → `Update Status Success` (saves `deployment_url`); failure → Debugger Agent → `Update Status Failed`.
12. On `reject`: `Update Status Rejected` flips the row to `rejected`.
13. A separate Monitoring Schedule trigger runs every 5 minutes, marking previously-healthy deployments as `unhealthy` if their endpoint stops responding.

## Triggers

| Node | Type | Purpose |
| --- | --- | --- |
| `Deployment Webhook` | `n8n-nodes-base.webhook` v2.1 (POST `/deploy`, `responseMode: responseNode`) | Frontend entry point |
| `Monitoring Schedule` | `n8n-nodes-base.scheduleTrigger` v1.3 (every 5 min) | Continuous health monitor |

The original Manual Trigger has been removed.

## Main pipeline nodes (in order)

1. `Deployment Webhook` (trigger)
2. `Normalize Input` — splits the Docker image URL into repo + tag, normalizes inputs.
3. `Fetch Docker Image Metadata` — `GET https://hub.docker.com/v2/repositories/{repo}/` (best-effort; `neverError: true`).
4. `Compose App Spec` — builds a single `specText` string for the analyzer from the registry metadata + any provided Dockerfile.
5. `Analyzer Agent` — Information Extractor with `gpt-4.1`, returns `{ runtime, ports, estimatedMemoryMB, estimatedCPU }`.
6. `Architect Agent` — AI Agent with `gpt-4.1`, returns exactly one of `AWS Fargate | GCP Cloud Run | Azure Container Apps`.
7. `Cost Estimator` — derives `awsCost`, `gcpCost`, `azureCost`, and a `recommendedProvider` from the architect's label.
8. `Save Deployment Request` — `INSERT ... RETURNING id` against the `deployments` table.
9. `Respond to Frontend` — JSON response (see `frontend-contract.md`). Includes the **first** resume URL pointing at `Chat Wait`.
10. `Chat Wait` — `resume: webhook`, `httpMethod: POST`, CORS headers wide open so a browser can POST directly. **Has two incoming edges**: from `Respond to Frontend` (initial entry) and from `Respond Chat Reply` (loop back).
11. `Is Final Decision?` — IF on `body.type === "final"`.

### Chat loop (`Is Final Decision?` ▸ `onFalse`)

12. `Build Chat History` — Code node. Reads `body.history` (sent by the client), appends `{ role: 'user', content: body.message }`, returns `{ history, userMessage }`.
13. `Deployment Chat Agent` — AI Agent with `gpt-4.1`. The prompt rebuilds the conversation from `history` (`role: content` lines). The system message embeds the deployment context (image, recommended architecture, runtime, costs) so every turn is grounded in the same numbers.
14. `Append AI Response` — Code node. Appends `{ role: 'assistant', content: <agent output> }` to the history.
15. `Respond Chat Reply` — Respond-to-Webhook. Returns `{ type, reply, history, resumeUrl: $execution.resumeUrl, deploymentId }`. The `resumeUrl` here is for the **next** Chat Wait suspension. The frontend must use it on the next request.
16. The branch ends with an edge back to `Chat Wait`, suspending the workflow until the frontend posts again.

### Final branch (`Is Final Decision?` ▸ `onTrue`)

17. `Extract Final Decision` — Set node. Lifts `action`, `provider`, `plan` out of the body. Falls back to the architect's recommended provider if the body omits it.
18. `Respond Final Decision` — Respond-to-Webhook. Returns `{ type: "final", status: "deploying" | "rejected", action, provider, plan }` synchronously.
19. `Check Final Approval` — IF on `action === "approve"`.

### Approved branch (`Check Final Approval` ▸ `onTrue`)

20. `Capture Approval` — pulls deployment metadata + provider from previous nodes; persists the user's `plan` note from `Extract Final Decision`.
21. `Update Status Approved` — sets `status='deploying'`, `provider=<choice>`.
22. `Deploy Agent` — AI Agent (GPT-4.1) that generates a JSON string: `{ projectName, image, port, memoryMB, cpuLimit, healthCheckPath, region, envVars, gcpProject }`.
23. `Parse Deploy Config` — Code node. Safely parses the JSON string from `Deploy Agent`. Falls back to regex-extraction if the LLM prepends text. Merges with `Capture Approval` data.
24. `Route by Provider` — Switch on `provider`, cases `aws | gcp | azure`.
25. `Prepare {AWS|GCP|Azure} Deployment` — Set nodes that accept the parsed `deployConfig` object, pull `region` / `gcpProject` to the top level.
26. `Deploy to {AWS|GCP|Azure}` — HTTP Request to the provider's REST API:
    - AWS: `POST https://apprunner.{region}.amazonaws.com/20200525/service` (correct regional endpoint). Response: `{ Service: { ServiceUrl } }`.
    - GCP: `POST https://run.googleapis.com/v2/projects/{gcpProject}/locations/{region}/services`. Async — returns an Operation.
    - Azure: `PUT https://management.azure.com/subscriptions/SUB_ID/resourceGroups/RG_NAME/providers/Microsoft.App/containerApps/{name}?api-version=2024-03-01`. Response: `{ properties.configuration.ingress.fqdn }`.
27. **GCP only**: `Wait for GCP Ready` (45 s time-interval) → `Get GCP Service URL` (GET the service resource) → `Extract GCP URL`.
28. `Extract {AWS|GCP|Azure} URL` — Set nodes that pull the real service URL from the provider response and carry `deploymentId` + `healthCheckPath` forward.
29. `Health Check` — `GET {deploymentUrl}{healthCheckPath}` with `neverError: true`. All three provider branches fan in here.
30. `Collect Health Result` — Code node. Uses try-catch to read from whichever `Extract * URL` node ran, stitching `deploymentUrl`, `deploymentId`, and `provider` for the IF below.
31. `Check Health Status` — IF on `statusCode === 200`.

### Health outcomes

- `onTrue`: `Update Status Success` — saves `status='deployed', health_status='healthy', deployment_url=<real URL from provider response>`.
- `onFalse`: `Debugger Agent` → `Update Status Failed` — saves `status='failed', health_status='unhealthy', error_log=<JSON analysis from Debugger Agent>`.

### Rejected branch (`Check Final Approval` ▸ `onFalse`)

- `Update Status Rejected` (`status='rejected'`).

### Monitoring branch

`Monitoring Schedule → Fetch Active Deployments → Monitor Health → Check Monitor Status (statusCode !== 200) → Mark Deployment Unhealthy`.

## Deployment lifecycle states

The frontend renders around these values from the `deployments` table:

- `pending_approval`
- `deploying`
- `deployed`
- `failed`
- `rejected`
- `unhealthy`

## Required Postgres schema (excerpt)

```sql
CREATE TABLE deployments (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL,
  provider TEXT,
  runtime TEXT,
  ports TEXT,
  architecture TEXT,
  docker_image_url TEXT,
  deployment_url TEXT,
  aws_cost NUMERIC,
  gcp_cost NUMERIC,
  azure_cost NUMERIC,
  health_status TEXT,
  error_log TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

## Credentials

| Credential | Used by | Notes |
| --- | --- | --- |
| `Postgres account` | All Postgres nodes | Auto-assigned by the MCP. |
| `OpenAI account` | `OpenAI GPT-4.1` model node | Shared by Analyzer / Architect / Deploy / Debugger. |
| `AWS API Auth` (HTTP header) | `Deploy to AWS` | Configure with an `Authorization: AWS4-HMAC-SHA256 ...` header or signed proxy. |
| `GCP OAuth2` | `Deploy to GCP` | Cloud Run admin scope. |
| `Azure OAuth2` | `Deploy to Azure` | Azure Resource Manager scope; replace `SUB_ID` and `RG_NAME` placeholders in the URL. |

## What was removed / replaced across all revisions

- All Slack nodes (`Notify Team for Approval`, `Alert Team`, `Notify Rejected`, `Notify Success`).
- The Manual Trigger entry point.
- The SSH-based `Install via SSH` nodes.
- The 3-input `Merge Deployments` node that could stall when only one provider ran.
- The Railway provider branch (replaced by GCP Cloud Run — Railway is gone for good).
- The single-shot `Wait for Human Approval` + `Check Approval` pair (replaced with the chat loop).
- The broken `Prepare * Deployment` nodes that treated `$json.output` (a string) as an object — replaced by `Parse Deploy Config` code node that safely parses the JSON.
- The wrong AWS endpoint `api.amazonaws.com/v1/apprunner/services` — replaced with the correct regional endpoint `apprunner.{region}.amazonaws.com/20200525/service`.
- The data loss at `Health Check` where `deploymentUrl` and `deploymentId` disappeared after the provider HTTP calls — fixed by `Extract {Provider} URL` Set nodes + `Collect Health Result` Code node.
- The `Update Status Success` bug where `deployment_url` was set to `architecture` instead of the actual service URL.

## Why a chat loop instead of a single approval

The frontend needs to be a real **deploying harness** — a place where humans can question the agents and fix mistakes before anything ships. The chat loop:

- Lets the user surface concerns (cost, region, scaling, lock-in) and get a grounded response.
- Keeps the same execution context across turns (`Cost Estimator`, `Save Deployment Request` etc. remain accessible via `$('node').item.json`).
- Rotates the resume URL per turn naturally because each `Chat Wait` resumption mints a fresh one — and the new URL is always handed back inside the chat reply.
- Compresses to a single round-trip when the user already knows what they want: just POST `{ type: "final", action, provider }` on the first call and the loop is skipped entirely.
