/* POST /api/azure/provision
 *
 * Azure Container Apps provisioner. Mirrors the contract of
 * /api/aws/provision so the n8n workflow only has to swap the URL.
 *
 *   action: "create"  → ensure resource group + managed environment exist,
 *                       create/update the Container App, wait for it to be
 *                       ready, and return the public FQDN.
 *   action: "status"  → fetch the Container App's latest state + URL.
 *
 * The response also exposes `clusterName` (= resource group) and
 * `serviceName` (= container app name) so the AWS-shaped downstream
 * n8n nodes ("Wait for ECS Ready", "Extract AWS URL", "Health Check")
 * keep working without renames.
 *
 * Required env (set in .env.local AND Vercel):
 *   TENANT_ID, CLIENT_ID, CLIENT_SECRET   — Azure service principal
 *   AZURE_SUBSCRIPTION_ID                 — target subscription
 *   AZURE_REGION                          — default region (e.g. "eastus")
 *   AZURE_RESOURCE_GROUP                  — RG to create/use (e.g. "n8n_rg")
 *
 * Optional env:
 *   AZURE_CONTAINER_APP_ENV   — name of the Managed Environment to reuse
 *                                (default: "forge-aca-env"; created on demand).
 *   N8N_INTERNAL_API_KEY      — when set, n8n must send the same value as
 *                                `x-forge-internal-token` to call this route.
 */

import { ClientSecretCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import {
  ContainerAppsAPIClient,
  type ContainerApp,
  type ManagedEnvironment,
} from "@azure/arm-appcontainers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Container App + environment provisioning can take 2-5 min on cold create.
// Vercel hobby caps at 60s; bump to 300s where the plan allows.
export const maxDuration = 300;

// ---------- Types ----------------------------------------------------------

type ProvisionPayload = {
  action?: "create" | "status";
  deploymentId?: number;
  projectName?: string;
  image?: string;
  port?: number | string;
  memoryMB?: number;
  cpuLimit?: number;
  healthCheckPath?: string;
  region?: string;
  envVars?: Record<string, string | number | boolean>;
  // Aliases — both styles supported so n8n needs no rename.
  resourceGroup?: string;
  containerAppName?: string;
  clusterName?: string;
  serviceName?: string;
};

type AzureConfig = {
  credential: ClientSecretCredential;
  subscriptionId: string;
  region: string;
  resourceGroup: string;
  environmentName: string;
};

// ---------- Helpers --------------------------------------------------------

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function azureError(action: string, err: unknown, details: Record<string, unknown> = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  const authFailed =
    lower.includes("invalid_client") ||
    lower.includes("aadsts") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authorization");

  const quotaIssue =
    lower.includes("quota") || lower.includes("subscriptionnotfound");

  let blocker = "Azure provisioning failed.";
  let fix = "Check the Azure portal for the exact error and retry.";

  if (authFailed) {
    blocker = "Azure service principal authentication or RBAC is wrong.";
    fix =
      "Confirm TENANT_ID, CLIENT_ID, CLIENT_SECRET, and AZURE_SUBSCRIPTION_ID, and grant the SP the Contributor role on the resource group (or subscription) via the Azure portal → IAM.";
  } else if (quotaIssue) {
    blocker = "Azure subscription quota or scope issue.";
    fix =
      "Verify AZURE_SUBSCRIPTION_ID is valid and the chosen region has Container Apps capacity.";
  }

  return json(authFailed ? 403 : 502, {
    ok: false,
    action,
    error: message,
    blocker,
    fix,
    ...details,
  });
}

function getAzureConfig(payloadRegion?: string): AzureConfig | { error: string } {
  const tenantId = process.env.TENANT_ID ?? process.env.AZURE_TENANT_ID;
  const clientId = process.env.CLIENT_ID ?? process.env.AZURE_CLIENT_ID;
  const clientSecret =
    process.env.CLIENT_SECRET ?? process.env.AZURE_CLIENT_SECRET;
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const region =
    payloadRegion ??
    process.env.AZURE_REGION ??
    process.env.AZURE_LOCATION ??
    "eastus";
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP ?? "n8n_rg";
  const environmentName =
    process.env.AZURE_CONTAINER_APP_ENV ?? "forge-aca-env";

  const missing: string[] = [];
  if (!tenantId) missing.push("TENANT_ID");
  if (!clientId) missing.push("CLIENT_ID");
  if (!clientSecret) missing.push("CLIENT_SECRET");
  if (!subscriptionId) missing.push("AZURE_SUBSCRIPTION_ID");

  if (missing.length) {
    return {
      error: `Missing Azure env: ${missing.join(", ")}. Set them in .env.local AND in Vercel project settings.`,
    };
  }

  return {
    credential: new ClientSecretCredential(tenantId!, clientId!, clientSecret!),
    subscriptionId: subscriptionId!,
    region,
    resourceGroup,
    environmentName,
  };
}

function authError(request: Request) {
  const expected = process.env.N8N_INTERNAL_API_KEY;
  if (!expected) return null;
  const actual = request.headers.get("x-forge-internal-token");
  if (actual === expected) return null;
  return json(401, { ok: false, error: "Unauthorized Azure provisioner call." });
}

/**
 * Container app names: lowercase, 2-32 chars, alphanumeric + hyphens,
 * cannot start/end with hyphen.
 */
function containerAppNameFor(name: string | undefined, deploymentId?: number) {
  const base = (name || `forge-${deploymentId || "demo"}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const fallback = base.length >= 2 ? base : `forge-${base}`;
  const withId = deploymentId ? `${fallback}-${deploymentId}` : fallback;
  return withId.slice(0, 32).replace(/-$/g, "") || "forge-app";
}

function toEnvVars(envVars: ProvisionPayload["envVars"]) {
  if (!envVars) return [];
  return Object.entries(envVars).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

function pickClient(cfg: AzureConfig) {
  return {
    resources: new ResourceManagementClient(cfg.credential, cfg.subscriptionId),
    apps: new ContainerAppsAPIClient(cfg.credential, cfg.subscriptionId),
  };
}

async function ensureResourceGroup(
  resources: ResourceManagementClient,
  resourceGroup: string,
  region: string,
) {
  try {
    const existing = await resources.resourceGroups.get(resourceGroup);
    if (existing?.id) return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the service principal only has Contributor on the RG (not subscription
    // scope), even reading/updating the RG metadata can be denied. Continue and
    // let the Container Apps calls prove whether it can manage resources inside
    // the group. This avoids requiring subscription-level permissions for demos.
    if (/authorization|forbidden|does not have authorization/i.test(message)) return;
    if (!/not.?found|ResourceGroupNotFound|ResourceNotFound/i.test(message)) throw err;
  }

  try {
    await resources.resourceGroups.createOrUpdate(resourceGroup, {
      location: region,
      tags: { managedBy: "forge-mvp" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Existing resource groups have an immutable location. Azure can still
    // create regional resources (like Container Apps) inside the group, so do
    // not fail just because the RG lives in eastus and the app is southeastasia.
    if (/resource group already exists in location/i.test(message)) return;
    throw err;
  }
}

async function ensureProviderRegistered(
  resources: ResourceManagementClient,
  namespace: string,
) {
  try {
    const current = await resources.providers.get(namespace);
    if (current.registrationState === "Registered") return;

    await resources.providers.register(namespace);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/authorization|forbidden|does not have authorization/i.test(message)) {
      throw new Error(
        `Azure subscription is not registered for ${namespace}, and this service principal cannot register it. In Azure Portal, go to Subscription → Resource providers → ${namespace} → Register, then retry. Original error: ${message}`,
      );
    }
    throw err;
  }
}

async function ensureManagedEnvironment(
  apps: ContainerAppsAPIClient,
  resourceGroup: string,
  envName: string,
  region: string,
) {
  try {
    const existing = await apps.managedEnvironments.get(resourceGroup, envName);
    if (existing?.id) return existing;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Any "not found" goes through to create; anything else re-throws.
    if (!/not.?found|ResourceNotFound/i.test(msg)) throw err;
  }

  const envBody: ManagedEnvironment = {
    location: region,
    // Default workload profile + no log analytics — cheapest viable POC env.
    workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
  };
  return apps.managedEnvironments.beginCreateOrUpdateAndWait(
    resourceGroup,
    envName,
    envBody,
  );
}

function buildContainerApp(
  envId: string,
  region: string,
  image: string,
  port: number,
  cpu: number,
  memoryMB: number,
  envVars: ProvisionPayload["envVars"],
): ContainerApp {
  // Container Apps require CPU in cores (e.g. 0.25, 0.5, 1) paired with an
  // accepted memory string ("0.5Gi", "1Gi", "2Gi"). Clamp to the supported
  // grid so the create call doesn't fail validation.
  const cores = cpu <= 0.25 ? 0.25 : cpu <= 0.5 ? 0.5 : cpu <= 0.75 ? 0.75 : 1;
  const memGi = cores === 0.25 ? "0.5Gi" : cores === 0.5 ? "1Gi" : cores === 0.75 ? "1.5Gi" : "2Gi";
  // Honour memoryMB only when it's larger than the cpu-implied minimum.
  const memoryString =
    memoryMB && memoryMB >= 2048 && cores >= 1 ? "2Gi" : memGi;

  return {
    location: region,
    managedEnvironmentId: envId,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: {
        external: true,
        targetPort: port,
        transport: "auto",
        allowInsecure: false,
        traffic: [{ latestRevision: true, weight: 100 }],
      },
    },
    template: {
      containers: [
        {
          name: "app",
          image,
          resources: { cpu: cores, memory: memoryString },
          env: toEnvVars(envVars),
        },
      ],
      scale: { minReplicas: 0, maxReplicas: 2 },
    },
  };
}

function publicUrlOf(app: ContainerApp | undefined): string {
  const fqdn =
    app?.configuration?.ingress?.fqdn ??
    app?.latestRevisionFqdn ??
    "";
  return fqdn ? `https://${fqdn}` : "";
}

// ---------- Actions --------------------------------------------------------

async function readPayload(request: Request): Promise<ProvisionPayload | null> {
  try {
    return (await request.json()) as ProvisionPayload;
  } catch {
    return null;
  }
}

async function createApp(payload: ProvisionPayload) {
  const image = payload.image?.trim();
  if (!image) {
    return json(400, { ok: false, error: "Missing Docker image identifier." });
  }
  if (image.includes("://")) {
    return json(400, {
      ok: false,
      error: "Docker image must be an image reference, not a URL.",
    });
  }

  const cfgOrErr = getAzureConfig(payload.region);
  if ("error" in cfgOrErr) return json(500, { ok: false, error: cfgOrErr.error });
  const cfg = cfgOrErr;

  const { resources, apps } = pickClient(cfg);
  const port = Number(payload.port || 80);
  const containerAppName = containerAppNameFor(
    payload.projectName ?? payload.serviceName,
    payload.deploymentId,
  );

  try {
    await ensureProviderRegistered(resources, "Microsoft.App");
    await ensureResourceGroup(resources, cfg.resourceGroup, cfg.region);
    const env = await ensureManagedEnvironment(
      apps,
      cfg.resourceGroup,
      cfg.environmentName,
      cfg.region,
    );

    if (!env.id) {
      throw new Error(
        `Managed environment ${cfg.environmentName} has no resource id after create.`,
      );
    }

    const appBody = buildContainerApp(
      env.id,
      cfg.region,
      image,
      port,
      payload.cpuLimit ?? 0.25,
      payload.memoryMB ?? 512,
      payload.envVars,
    );

    const result = await apps.containerApps.beginCreateOrUpdateAndWait(
      cfg.resourceGroup,
      containerAppName,
      appBody,
    );

    const serviceUrl = publicUrlOf(result);

    return json(200, {
      ok: true,
      action: "create",
      ready: Boolean(serviceUrl),
      status: result.provisioningState ?? "ACTIVE",
      // Azure-native identifiers
      resourceGroup: cfg.resourceGroup,
      containerAppName,
      environmentName: cfg.environmentName,
      // AWS-shaped aliases so the existing n8n flow keeps working
      clusterName: cfg.resourceGroup,
      serviceName: containerAppName,
      serviceArn: result.id,
      serviceUrl,
      region: cfg.region,
      healthCheckPath: payload.healthCheckPath || "/",
      port,
    });
  } catch (err) {
    return azureError("create", err, {
      region: cfg.region,
      resourceGroup: cfg.resourceGroup,
      containerAppName,
    });
  }
}

async function describeApp(payload: ProvisionPayload) {
  const cfgOrErr = getAzureConfig(payload.region);
  if ("error" in cfgOrErr) return json(500, { ok: false, error: cfgOrErr.error });
  const cfg = cfgOrErr;

  const resourceGroup =
    payload.resourceGroup ?? payload.clusterName ?? cfg.resourceGroup;
  const containerAppName = payload.containerAppName ?? payload.serviceName;
  if (!containerAppName) {
    return json(400, {
      ok: false,
      error: "Missing containerAppName (or serviceName) for Azure status check.",
    });
  }

  const { apps } = pickClient(cfg);

  try {
    const app = await apps.containerApps.get(resourceGroup, containerAppName);
    const serviceUrl = publicUrlOf(app);
    return json(200, {
      ok: true,
      action: "status",
      ready:
        app.provisioningState === "Succeeded" && Boolean(serviceUrl),
      status: app.provisioningState ?? "Unknown",
      resourceGroup,
      containerAppName,
      clusterName: resourceGroup,
      serviceName: containerAppName,
      serviceArn: app.id,
      serviceUrl,
      region: cfg.region,
      healthCheckPath: payload.healthCheckPath || "/",
      port: Number(payload.port || 80),
    });
  } catch (err) {
    return azureError("status", err, { resourceGroup, containerAppName });
  }
}

export async function POST(request: Request) {
  const blocked = authError(request);
  if (blocked) return blocked;

  const payload = await readPayload(request);
  if (!payload) return json(400, { ok: false, error: "Request body must be JSON." });

  if (payload.action === "status") return describeApp(payload);
  return createApp(payload);
}
