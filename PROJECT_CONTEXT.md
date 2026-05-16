# Project Context

## What This Project Is

This repo is the Next.js frontend for an n8n-driven deployment orchestration demo.

The backend automation analyzes a Docker image, recommends a deployment architecture, saves a deployment record, pauses for human-in-the-loop chat approval via webhook, then autonomously deploys to the selected provider and runs health checks with AI-assisted recovery.

## Current Frontend Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- Bun for local install and scripts in this environment

## Current Repo State

- The old Vite project has been removed.
- A fresh Next.js app is installed in this directory.
- Git history is preserved because `.git/` was never deleted.

## What the UI Needs To Do

The frontend should act as the control panel for the n8n workflow:

- Accept a Dockerfile or deployment text input
- Start a deployment request through an API route
- Show deployment status in near real time
- Surface approval actions when the workflow pauses for human input
- Show agent output, debugging notes, and health results

## Source Workflow Summary

The current n8n flow does the following:

1. Accepts a Docker image URL via POST webhook.
2. Fetches registry metadata and extracts runtime, ports, memory, and CPU.
3. Recommends an architecture (AWS Fargate, GCP Cloud Run, or Azure Container Apps).
4. Stores the deployment in Postgres and responds to the frontend with a resume URL.
5. Pauses for multi-turn chat with a human operator via a webhook Wait node.
6. On approval: the Deploy Agent generates a provider-specific config and calls the provider REST API autonomously.
7. Extracts the real service URL from the API response (App Runner ServiceUrl / Cloud Run uri / Container Apps fqdn).
8. Runs a health check against the live endpoint; on failure the Debugger Agent diagnoses the root cause.
9. Marks deployment as deployed or failed in Postgres.
10. Runs a scheduled monitor every 5 minutes against all healthy deployments.

## Workflow architecture (current)

Providers supported: `aws`, `gcp`, `azure`. Railway and Fly.io have been removed.

The deploy pipeline is fully autonomous after a human commits:
1. `Deploy Agent` (GPT-4.1) generates a JSON config with `projectName`, `image`, `port`, `memoryMB`, `cpuLimit`, `healthCheckPath`, `region`, `envVars`, `gcpProject`.
2. `Parse Deploy Config` (Code node) safely parses the JSON string into an object.
3. `Route by Provider` (Switch) routes to the correct provider branch.
4. Each branch calls the provider REST API, then extracts the real service URL from the response:
   - AWS: `POST https://apprunner.{region}.amazonaws.com/20200525/service` → `Service.ServiceUrl`
   - GCP: `POST Cloud Run v2` → wait 45s → `GET` the service → `uri`
   - Azure: `PUT Container Apps` → `properties.configuration.ingress.fqdn`
5. `Collect Health Result` (Code node) stitches the deploymentId + URL from whichever branch ran.
6. `Health Check` → `Check Health Status` → `Update Status Success` or `Debugger Agent` → `Update Status Failed`.

## Integration Contract

Planned frontend API routes should talk to n8n and Postgres, not duplicate workflow logic:

- `POST /api/deploy` starts the workflow
- `GET /api/status/[id]` reads deployment state
- `POST /api/approve` resumes the waiting workflow
- `GET /api/logs/[id]` streams agent or workflow logs

## Environment Variables

Likely required once the integration is wired:

- `DATABASE_URL`
- `N8N_WEBHOOK_URL`
- Any provider credentials or API base URLs used by the workflow

## Recommended Implementation Order

1. Stabilize the n8n workflow entry and resume path.
2. Implement the minimal deployment/status API routes.
3. Build the dashboard UI around the status model.
4. Add approval handling.
5. Add streaming logs and richer workflow visibility.

