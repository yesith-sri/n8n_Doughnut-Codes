/* POST /api/resume
 *
 * Forwards a chat turn or final decision to an n8n Wait-node resume URL.
 * Body shape:
 *   {
 *     "resumeUrl": "https://<tenant>.app.n8n.cloud/webhook-waiting/<exec-id>",
 *     "body":      { "type": "chat" | "final", ...payload }
 *   }
 *
 * The proxy will only forward to hosts in the allowlist (derived from
 * N8N_DEPLOY_WEBHOOK_URL, plus optional comma-separated N8N_ALLOWED_HOSTS) so
 * this can't be turned into an open relay.
 */

import { getAllowedHosts, jsonError, passthrough } from "../_lib/n8n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ResumePayload = {
  resumeUrl?: unknown;
  body?: unknown;
};

export async function POST(request: Request) {
  let payload: ResumePayload;
  try {
    payload = (await request.json()) as ResumePayload;
  } catch {
    return jsonError(400, "Request body must be JSON.");
  }

  if (typeof payload.resumeUrl !== "string" || !payload.resumeUrl) {
    return jsonError(400, "Missing 'resumeUrl' string in request body.");
  }

  let target: URL;
  try {
    target = new URL(payload.resumeUrl);
  } catch {
    return jsonError(400, `Invalid resumeUrl: ${payload.resumeUrl}`);
  }

  const allowed = getAllowedHosts();
  if (allowed.size === 0) {
    return jsonError(
      500,
      "No N8N hosts are allowlisted. Set N8N_DEPLOY_WEBHOOK_URL (and optionally N8N_ALLOWED_HOSTS) in .env.local.",
    );
  }
  if (!allowed.has(target.host)) {
    return jsonError(
      403,
      `Host '${target.host}' is not allowed. Allowed hosts: ${[...allowed].join(", ")}.`,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload.body ?? {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(502, `Failed to reach n8n resume URL: ${msg}`);
  }

  return passthrough(upstream);
}
