export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: Request) {
  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return json(400, { ok: false, error: "Request body must be JSON." });
  }

  if (typeof body.url !== "string" || !body.url.trim()) {
    return json(400, { ok: false, error: "Missing url." });
  }

  let target: URL;
  try {
    target = new URL(body.url);
  } catch {
    return json(400, { ok: false, error: "Invalid url." });
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return json(400, { ok: false, error: "Only http/https health checks are allowed." });
  }

  try {
    const res = await fetch(target.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });

    return json(200, {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      url: target.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(200, {
      ok: false,
      status: 0,
      url: target.toString(),
      error: message,
    });
  }
}
