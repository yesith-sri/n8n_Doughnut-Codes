# Credentials & environment setup

The frontend is a thin shell. **All real-world credentials live in n8n** (and one URL lives in `.env.local`). This doc tells you exactly which credential goes on which node, and which placeholders to swap before any deploy will work.

---

## 1. Frontend env vars (`.env.local`)

Copy `.env.example` to `.env.local` and fill it in.

| Variable | Where to set it | Why |
| --- | --- | --- |
| `N8N_DEPLOY_WEBHOOK_URL` | `.env.local` (this repo) | URL of your n8n `Deployment Webhook` trigger. The `/api/deploy` route forwards Docker-image submissions to it server-side. |
| `N8N_ALLOWED_HOSTS` *(optional)* | `.env.local` | Extra hostnames that `/api/resume` is allowed to forward to. The host parsed from `N8N_DEPLOY_WEBHOOK_URL` is always allowed; add more here only if your n8n returns resume URLs on a different host. |

Restart `bun run dev` after editing `.env.local`.

> The frontend never holds AWS / GCP / Azure secrets. It only knows how to talk to n8n; n8n holds the keys.

---

## 2. n8n credentials (one place: n8n's Credentials manager)

Open n8n → **Credentials** → **New**. Names below must match exactly so the workflow can resolve them. The workflow id is `Co7HN1Zf7FQT6YSa` (`agentic-idp`).

### 2.1 Postgres — `Postgres account`

| Field | Value |
| --- | --- |
| **Used by** | `Save Deployment Request`, `Update Status Approved`, `Update Status Success`, `Update Status Failed`, `Update Status Rejected`, `Fetch Active Deployments`, `Mark Deployment Unhealthy` |
| **n8n credential type** | `Postgres` |
| **Host / port / db / user / password** | Your Postgres instance |

Then create the table once:

```sql
CREATE TABLE IF NOT EXISTS deployments (
  id               SERIAL PRIMARY KEY,
  status           TEXT NOT NULL,
  provider         TEXT,
  runtime          TEXT,
  ports            TEXT,
  architecture     TEXT,
  docker_image_url TEXT,
  deployment_url   TEXT,
  aws_cost         NUMERIC,
  gcp_cost         NUMERIC,
  azure_cost       NUMERIC,
  health_status    TEXT,
  error_log        TEXT,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ
);
```

### 2.2 OpenAI — `OpenAI account`

| Field | Value |
| --- | --- |
| **Used by** | `OpenAI GPT-4.1` shared model (Analyzer Agent, Architect Agent, Deployment Chat Agent, Deploy Agent, Debugger Agent) |
| **n8n credential type** | `OpenAI` |
| **API key** | Your `sk-...` key from <https://platform.openai.com/api-keys> |

The model is `gpt-4.1` by default. Lower it to `gpt-4o-mini` if cost is a concern — just edit the shared model node.

### 2.3 AWS — `AWS API Auth` (HTTP Header Auth)

| Field | Value |
| --- | --- |
| **Used by** | `Deploy to AWS` (the App Runner POST) |
| **n8n credential type** | `Header Auth` |
| **Header Name** | `Authorization` |
| **Header Value** | `AWS4-HMAC-SHA256 ...` (a fully-signed SigV4 header) |

**Important caveat.** AWS services require SigV4-signed requests; a static `Header Auth` won't be accepted by `apprunner.amazonaws.com` directly. You have two realistic paths:

1. **Recommended for production:** swap the `Deploy to AWS` HTTP Request node's auth from `Header Auth` to one that the n8n MCP can render as `aws` (the built-in AWS credential that signs requests for you). Set its access key id / secret / region in n8n's AWS credential type. The node URL stays the same.
2. **Demo path:** put an AWS API Gateway in front of App Runner that accepts a static API key in `Authorization`. The static `Header Auth` credential then maps onto that gateway. Useful when you don't want to wire SigV4 just to test the flow.

If you choose path 1 and want me to rewrite the workflow node, ask.

### 2.4 GCP — `GCP OAuth2` (OAuth2 API)

| Field | Value |
| --- | --- |
| **Used by** | `Deploy to GCP` (the Cloud Run admin POST) |
| **n8n credential type** | `OAuth2 API` |
| **Grant Type** | `Authorization Code` |
| **Authorization URL** | `https://accounts.google.com/o/oauth2/v2/auth` |
| **Access Token URL** | `https://oauth2.googleapis.com/token` |
| **Client ID / Client Secret** | From Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID |
| **Scope** | `https://www.googleapis.com/auth/cloud-platform` |
| **Auth URI Query Parameters** | `access_type=offline` |

Then **replace the `PROJECT_ID` placeholder** in the `Deploy to GCP` URL:

```
https://run.googleapis.com/v2/projects/PROJECT_ID/locations/{{ $json.deploymentConfig.region || "us-central1" }}/services
```

Edit that node and swap `PROJECT_ID` for your actual project, e.g. `forge-prod-481923`.

### 2.5 Azure — `Azure OAuth2` (OAuth2 API)

| Field | Value |
| --- | --- |
| **Used by** | `Deploy to Azure` (the Azure Container Apps PUT) |
| **n8n credential type** | `OAuth2 API` |
| **Grant Type** | `Client Credentials` |
| **Access Token URL** | `https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token` |
| **Client ID / Client Secret** | From Microsoft Entra ID → App registrations → your app → Certificates & secrets |
| **Scope** | `https://management.azure.com/.default` |

Then **replace the `SUB_ID` and `RG_NAME` placeholders** in the `Deploy to Azure` URL:

```
https://management.azure.com/subscriptions/SUB_ID/resourceGroups/RG_NAME/providers/Microsoft.App/containerApps/{{ $json.deploymentConfig.projectName }}?api-version=2024-03-01
```

`SUB_ID` is your Azure subscription GUID. `RG_NAME` is the resource group that will hold the container app (create it once in the Azure portal or via `az group create`).

### 2.6 Docker Hub — no credential needed

`Fetch Docker Image Metadata` calls the public Docker Hub registry. No auth required. (If you ever switch to ghcr.io or a private registry, add a credential there.)

---

## 3. Quick credential checklist

Tick these off in order:

- [ ] `.env.local` has `N8N_DEPLOY_WEBHOOK_URL` and you restarted dev
- [ ] n8n Postgres credential `Postgres account` is connected, table created
- [ ] n8n OpenAI credential `OpenAI account` is connected and the GPT-4.1 model node uses it
- [ ] n8n `AWS API Auth` credential exists *and* `Deploy to AWS` either uses it via header auth (gateway) or has been rewritten to use AWS SigV4 auth
- [ ] n8n `GCP OAuth2` credential exists, `Deploy to GCP` URL has your real `PROJECT_ID`
- [ ] n8n `Azure OAuth2` credential exists, `Deploy to Azure` URL has your real `SUB_ID` and `RG_NAME`
- [ ] You only need credentials for the providers you actually plan to deploy to — leave others unattached until you do

---

## 4. Where to confirm in n8n

Open the workflow (`agentic-idp`, id `Co7HN1Zf7FQT6YSa`). The nodes that consume credentials are:

| Node name | Credential the node expects |
| --- | --- |
| `Save Deployment Request` | `Postgres account` |
| `Update Status Approved` | `Postgres account` |
| `Update Status Success` | `Postgres account` |
| `Update Status Failed` | `Postgres account` |
| `Update Status Rejected` | `Postgres account` |
| `Fetch Active Deployments` | `Postgres account` |
| `Mark Deployment Unhealthy` | `Postgres account` |
| `OpenAI GPT-4.1` (shared sub-model) | `OpenAI account` |
| `Deploy to AWS` | `AWS API Auth` (or AWS SigV4 if you swap auth) |
| `Deploy to GCP` | `GCP OAuth2` |
| `Deploy to Azure` | `Azure OAuth2` |

Click each node → Credentials → pick the matching entry → Save. The Postgres + OpenAI + Docker Hub paths must work end-to-end before the chat loop starts returning real advisor replies. The AWS / GCP / Azure credentials are only consumed once you click a *Deploy to {provider}* button in the chat panel, so you can stage the rollout one cloud at a time.

---

## 5. n8n MCP auto-assignment

When the workflow was pushed via MCP, the response noted:

> HTTP Request nodes (Fetch Docker Image Metadata, Deploy to AWS, Health Check, Deploy to GCP, Deploy to Azure, Monitor Health) were skipped during credential auto-assignment. Their credentials must be configured manually.

That's why this doc exists — those six HTTP Request nodes have to be wired by hand the first time. Postgres and OpenAI are auto-assignable.
