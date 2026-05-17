# Credentials & environment setup

The frontend is a thin shell. **All real-world credentials live in n8n** (and one URL lives in `.env.local`). This doc tells you exactly which credential goes on which node, and which placeholders to swap before any deploy will work.

---

## 1. Frontend env vars (`.env.local`)

Copy `.env.example` to `.env.local` and fill it in.

| Variable | Where to set it | Why |
| --- | --- | --- |
| `N8N_DEPLOY_WEBHOOK_URL` | `.env.local` (this repo) | URL of your n8n `Deployment Webhook` trigger. The `/api/deploy` route forwards Docker-image submissions to it server-side. |
| `N8N_ALLOWED_HOSTS` *(optional)* | `.env.local` | Extra hostnames that `/api/resume` is allowed to forward to. The host parsed from `N8N_DEPLOY_WEBHOOK_URL` is always allowed; add more here only if your n8n returns resume URLs on a different host. |
| `WEBSITE_URL` | `.env.local` and n8n env/variable | Public URL of this Next.js app, reachable from n8n. The AWS branch calls `${WEBSITE_URL}/api/aws/provision`. |
| `N8N_INTERNAL_API_KEY` *(recommended)* | `.env.local` and n8n env/credential | Shared secret for n8n → Forge internal calls. If set, n8n sends it as `x-forge-internal-token`. |
| `ACCESS_KEY` | `.env.local` on the Forge server | AWS IAM access key used by `/api/aws/provision` to sign ECS/EC2 API calls. |
| `SECRET_KEY` | `.env.local` on the Forge server | AWS IAM secret key paired with `ACCESS_KEY`. |
| `AWS_REGION` | `.env.local` on the Forge server | Default AWS region for ECS, e.g. `us-east-1`. |
| `AWS_SESSION_TOKEN` *(optional)* | `.env.local` on the Forge server | Required only when `ACCESS_KEY` / `SECRET_KEY` are temporary STS credentials. |
| `AWS_ECS_CLUSTER_NAME` *(optional)* | `.env.local` on the Forge server | ECS cluster name. Defaults to `forge-poc`. |
| `AWS_SUBNET_IDS` *(optional)* | `.env.local` on the Forge server | Comma-separated public subnet IDs. If omitted, the provisioner uses default VPC subnets. |
| `AWS_SECURITY_GROUP_ID` *(optional)* | `.env.local` on the Forge server | Security group with inbound access to the container port. If omitted, the provisioner creates one. |
| `AWS_ECS_TASK_EXECUTION_ROLE_ARN` *(optional for public Docker Hub)* | `.env.local` on the Forge server | ECS task execution role. Recommended if you later add CloudWatch logs or private registries. |
| `TRIVVY_API` | `.env.local` / Vercel env | Base URL of the hosted Trivy wrapper (Digital Ocean droplet). `/api/scan` tries `POST {TRIVVY_API}/scan`, `POST {TRIVVY_API}/api/scan`, `POST {TRIVVY_API}/v1/scan`, and `GET {TRIVVY_API}/scan/{image}` in that order, accepting either our `ScanResponse` shape or native Trivy JSON. |
| `TRIVVY_API_KEY` | `.env.local` / Vercel env | API key for the hosted Trivy wrapper. Sent as `Trivy-Token: <key>` (raw, **no** `Bearer` prefix). Also mirrored to `X-API-Key` as a harmless fallback. |
| `NVD_API_KEY` *(optional)* | `.env.local` / Vercel env | Used only when the hosted Trivy is unreachable and `/api/scan` falls back to NIST NVD. Lifts the NVD rate limit from 5 req/30 s to 50 req/30 s. Free at https://nvd.nist.gov/developers/request-an-api-key. |
| `TENANT_ID` | `.env.local` / Vercel env | Azure service-principal tenant ID. Used by `/api/azure/provision` to authenticate via `ClientSecretCredential`. |
| `CLIENT_ID` | `.env.local` / Vercel env | Azure service-principal app (client) ID. |
| `CLIENT_SECRET` | `.env.local` / Vercel env | Azure service-principal client secret. Treat as sensitive — never commit. |
| `AZURE_SUBSCRIPTION_ID` | `.env.local` / Vercel env | Subscription where the Container App + Managed Environment will be provisioned. |
| `AZURE_REGION` | `.env.local` / Vercel env | Default region for Azure provisioning. Example: `eastus`. Falls back to `eastus` if unset. |
| `AZURE_RESOURCE_GROUP` | `.env.local` / Vercel env | Resource group name used by `/api/azure/provision`. Example: `n8n_rg`. Created idempotently on first deploy. |
| `AZURE_CONTAINER_APP_ENV` *(optional)* | `.env.local` / Vercel env | Name of the Container App Managed Environment to reuse. Defaults to `forge-aca-env`; created on demand if missing. First-time creation can take 2-5 minutes. |

Restart `bun run dev` after editing `.env.local`.

> **About `/api/scan`:** the route was originally a thin wrapper around the `trivy` CLI, which can't run on Vercel (no binaries, no Docker daemon). It now calls the hosted Trivy wrapper at `TRIVVY_API` first, and falls back to the NIST NVD API if Trivy is unreachable. Both paths run server-side and return the same JSON shape.

> If your DigitalOcean box is running stock `trivy server`, expose the REST wrapper from [`docs/trivy-wrapper.md`](docs/trivy-wrapper.md). Vercel should call that wrapper, not the raw Twirp/RPC server.

> **About `/api/azure/provision`:** mirrors `/api/aws/provision`. Accepts `{ action: "create" | "status", projectName, image, port, memoryMB, cpuLimit, healthCheckPath, region, envVars, deploymentId }`. On `create` it idempotently ensures the resource group + Managed Environment exist, deploys the Container App, waits for `provisioningState === "Succeeded"`, and returns the public `serviceUrl` (`https://<appname>.<env-default-domain>`). On `status` it re-fetches the app for health-check polling. The response also exposes `clusterName` (= resource group) and `serviceName` (= container app name) so the existing AWS-shaped downstream n8n nodes keep working unchanged.

---

## 4. Required n8n workflow tweaks (apply once in the n8n UI)

Workflow id: `Co7HN1Zf7FQT6YSa` (`Agentic IDP — AWS Docker Hub ECS POC Pipeline`).

The base workflow is AWS-only. Apply these four surgical edits to make `provider="azure"` flow through the same chain. Total time in the n8n UI: ~2 minutes. **Do not** rename or move nodes — only edit the highlighted field on each.

### 4.1 `Check AWS Provider` (IF node)

Replace the single condition so both `aws` and `azure` are accepted:

- Operation: **equals** → keep
- Condition value 1: `{{ ["aws", "azure"].includes($json.provider) }}` (use the **boolean / expression** comparator), OR
- Add a second condition via the OR combinator: `={{ $json.provider }}` equals `"azure"`.

Rename the node to **`Check Supported Provider`** if you like — purely cosmetic.

### 4.2 `Capture Approval` (Set node)

Two fields to edit, both currently hardcoded to AWS:

- `provider` — change from the string `"aws"` to expression:
  `={{ $("Extract Final Decision").item.json.provider }}`
- `forgeProvisionerUrl` — change from `={{ $("Cost Estimator").item.json.forgeProvisionerUrl }}` to expression:
  `={{ $env.WEBSITE_URL + "/api/" + $("Extract Final Decision").item.json.provider }}`

That single expression resolves to `https://<your-vercel-url>/api/aws` or `.../api/azure` depending on the user's pick. The downstream `Provision AWS ECS` node already appends `/provision`, so both routes are reached correctly.

### 4.3 `Extract AWS URL` (Set node)

- `provider` — change from `"aws"` to expression:
  `={{ $("Capture Approval").item.json.provider }}`

### 4.4 `Prepare AWS Deployment` (Set node)

Change the `region` fallback to be provider-aware so Azure deploys land in `eastus` instead of `us-east-1`:

- `region` — change from `={{ $json.deployConfig.region || $env.AWS_REGION || "us-east-1" }}` to:
  `={{ $json.deployConfig.region || ($("Capture Approval").item.json.provider === "azure" ? ($env.AZURE_REGION || "eastus") : ($env.AWS_REGION || "us-east-1")) }}`

After those four edits, save the workflow (it's already activated). The chat → final → deploy chain now supports both AWS and Azure with no other changes.

### Optional: rename for clarity

If the AWS-named nodes annoy you visually, you can rename:

- `Check AWS Provider` → `Check Supported Provider`
- `Prepare AWS Deployment` → `Prepare Deployment`
- `Provision AWS ECS` → `Provision Container Service`
- `Wait for ECS Ready` → `Wait for Service Ready`
- `Describe AWS ECS` → `Describe Service`
- `Extract AWS URL` → `Extract Service URL`

Don't change the connections — n8n picks them up by id, not name.

> The browser never holds AWS / GCP / Azure secrets. For the AWS POC, AWS keys live on the Forge server and are used only by the server-side `/api/aws/provision` route; n8n remains the brain that decides when to call it.

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

### 2.3 AWS POC — ECS Fargate from Docker Hub

The AWS branch provisions an **ECS Fargate** service from a **public Docker Hub image**. n8n does not call AWS APIs directly; it calls the Forge server's signed provisioner endpoint:

```
POST ${WEBSITE_URL}/api/aws/provision
```

The endpoint creates/uses an ECS cluster, registers a Fargate task definition, creates a public Fargate service, waits are handled in n8n, and the same endpoint resolves the task public IP after the wait. This avoids n8n's SigV4 limitation and avoids SSH entirely.

Required AWS-side setup:

- `ACCESS_KEY` and `SECRET_KEY` must belong to an IAM principal allowed to create ECS/Fargate resources and the EC2 networking resources listed below.
- The Docker image can be a public Docker Hub image, e.g. `nginx:latest` or `username/app:tag`.
- `WEBSITE_URL` must be reachable by n8n. If n8n is cloud-hosted, localhost will not work; use a deployed Forge URL or a tunnel for the demo.
- The AWS account must have a default VPC with public subnets, or you must set `AWS_SUBNET_IDS` and `AWS_SECURITY_GROUP_ID`.
- The security group must allow inbound traffic to the container port from n8n/the browser. If no security group is provided, the provisioner creates one and opens that port to `0.0.0.0/0` for the POC.

Minimal IAM policy shape for the `ACCESS_KEY` principal:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:CreateCluster",
        "ecs:RegisterTaskDefinition",
        "ecs:CreateService",
        "ecs:DescribeServices",
        "ecs:ListTasks",
        "ecs:DescribeTasks",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:DescribeNetworkInterfaces",
        "iam:CreateServiceLinkedRole"
      ],
      "Resource": "*"
    }
  ]
}
```

If you set `AWS_ECS_TASK_EXECUTION_ROLE_ARN`, add `iam:PassRole` for that role.

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

### 2.6 Azure — `Azure OAuth2` (OAuth2 API)

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
- [ ] AWS POC image is public on Docker Hub, e.g. `nginx:latest`
- [ ] Forge server `.env.local` has `ACCESS_KEY`, `SECRET_KEY`, `AWS_REGION=us-east-1`, and `WEBSITE_URL`
- [ ] n8n can reach `${WEBSITE_URL}/api/aws/provision`
- [ ] AWS has a default VPC with public subnets, or `.env.local` has `AWS_SUBNET_IDS` and `AWS_SECURITY_GROUP_ID`
- [ ] If `N8N_INTERNAL_API_KEY` is set, the n8n AWS HTTP nodes send it as `x-forge-internal-token`
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
| `Provision AWS ECS` / `Describe AWS ECS` | No n8n AWS credential; calls Forge `/api/aws/provision` |
| `Deploy to GCP` | `GCP OAuth2` |
| `Deploy to Azure` | `Azure OAuth2` |

Click each node → Credentials → pick the matching entry → Save. The Postgres + OpenAI + Docker Hub paths must work end-to-end before the chat loop starts returning real advisor replies. The AWS / GCP / Azure credentials are only consumed once you click a *Deploy to {provider}* button in the chat panel, so you can stage the rollout one cloud at a time.

---

## 5. n8n MCP auto-assignment

When the workflow was pushed via MCP, the response noted:

> HTTP Request nodes (Fetch Docker Image Metadata, Provision AWS ECS, Describe AWS ECS, Health Check, Monitor Health) were skipped during credential auto-assignment. They do not need n8n AWS credentials because Forge signs the AWS calls.

That's why this doc exists — those six HTTP Request nodes have to be wired by hand the first time. Postgres and OpenAI are auto-assignable.
