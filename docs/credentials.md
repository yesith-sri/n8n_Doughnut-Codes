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
| `NVD_API_KEY` *(optional)* | `.env.local` / Vercel env | Lifts the NIST NVD rate limit on `/api/scan` from 5 req/30 s to 50 req/30 s. Free at https://nvd.nist.gov/developers/request-an-api-key. Without it, scans still work but the page may show "NVD HTTP 403/429" if hit rapidly. |
| `TRIVY_SERVER_URL` *(optional)* | `.env.local` / Vercel env | If set, `/api/scan` posts `{ image }` here first and returns the response verbatim. Use this when you self-host Trivy and want layer-level OS-package CVEs instead of the NVD CPE-based scan. Endpoint must speak the same JSON shape as `/api/scan` (`{ image, scannedAt, summary, vulnerabilities, suggestions, rollbackStrategy, riskLevel }`). |

Restart `bun run dev` after editing `.env.local`.

> **About `/api/scan`:** the route was originally a thin wrapper around the `trivy` CLI, which can't run on Vercel (no binaries, no Docker daemon). It now calls the NIST NVD API directly to fetch CVEs for the image's primary application + version (e.g. `nginx 1.20.0`). For OS-package-layer CVEs you need a real Trivy — point `TRIVY_SERVER_URL` at one and the scan will delegate.

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
