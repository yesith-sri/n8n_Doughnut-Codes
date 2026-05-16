/* POST /api/deploy
 *
 * The browser calls this instead of n8n directly. The route forwards the
 * Docker image payload server-side to the configured n8n Deployment Webhook,
 * which sidesteps the browser's CORS preflight (n8n Wait nodes can't set
 * Allowed Origins, so a direct browser POST would always be blocked).
 *
 * Configure with:
 *   N8N_DEPLOY_WEBHOOK_URL  e.g. https://<tenant>.app.n8n.cloud/webhook/deploy
 */

import { getDeployWebhookUrl, jsonError, passthrough } from "../_lib/n8n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { url, error } = getDeployWebhookUrl();
  if (!url) return jsonError(500, error ?? "Missing webhook URL");

  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(502, `Failed to reach n8n at ${url}: ${msg}`);
  }

  return passthrough(upstream);
}
