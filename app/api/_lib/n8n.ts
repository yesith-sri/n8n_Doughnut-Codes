/* Tiny helper shared by the two route handlers.
 * Keeps env handling and host allowlisting in one place. */

export function getDeployWebhookUrl(): { url: string | null; error: string | null } {
  const url = process.env.N8N_DEPLOY_WEBHOOK_URL;
  if (!url) {
    return {
      url: null,
      error:
        "N8N_DEPLOY_WEBHOOK_URL is not set on the server. Add it to .env.local (see .env.example) and restart `bun run dev`.",
    };
  }
  return { url, error: null };
}

/** Hosts the resume proxy is allowed to forward to.
 *  Derived from N8N_DEPLOY_WEBHOOK_URL plus any comma-separated overrides in
 *  N8N_ALLOWED_HOSTS. The set is intentionally small — we don't want this
 *  becoming an open relay. */
export function getAllowedHosts(): Set<string> {
  const hosts = new Set<string>();
  const deployUrl = process.env.N8N_DEPLOY_WEBHOOK_URL;
  if (deployUrl) {
    try {
      hosts.add(new URL(deployUrl).host);
    } catch {
      // Bad config — caller will see the empty set and reject the request.
    }
  }
  const extra = process.env.N8N_ALLOWED_HOSTS;
  if (extra) {
    for (const raw of extra.split(",")) {
      const h = raw.trim();
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

export function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function passthrough(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  const contentType =
    upstream.headers.get("content-type") ?? "application/json";
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
}
