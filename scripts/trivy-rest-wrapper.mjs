#!/usr/bin/env node
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8081);
const TRIVY_BIN = process.env.TRIVY_BIN || "trivy";
const TRIVY_SERVER = process.env.TRIVY_SERVER || "http://127.0.0.1:8080";
const TRIVY_TOKEN = process.env.TRIVY_TOKEN || process.env.TRIVVY_API_KEY || "";
const PUBLIC_TOKEN = process.env.PUBLIC_TOKEN || process.env.TRIVVY_API_KEY || "";

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function isAuthorized(req) {
  if (!PUBLIC_TOKEN) return true;
  const token =
    req.headers["trivy-token"] ||
    req.headers["x-api-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return token === PUBLIC_TOKEN;
}

function imageFromRequest(req, body) {
  if (req.method === "GET" && req.url?.startsWith("/scan/")) {
    return decodeURIComponent(req.url.slice("/scan/".length)).trim();
  }

  if (req.method !== "POST") return "";
  const data = body ? JSON.parse(body) : {};
  return String(data.image || data.dockerImageUrl || data.target || "").trim();
}

async function scanImage(image) {
  const args = [
    "image",
    "--server",
    TRIVY_SERVER,
    "--format",
    "json",
    "--no-progress",
    "--quiet",
    "--timeout",
    "5m",
  ];

  if (TRIVY_TOKEN) {
    args.push("--token", TRIVY_TOKEN);
    args.push("--token-header", "Trivy-Token");
  }

  args.push(image);

  const { stdout, stderr } = await execFileAsync(TRIVY_BIN, args, {
    timeout: 330_000,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (!stdout.trim()) {
    throw new Error(`Trivy returned empty output${stderr ? `: ${stderr}` : ""}`);
  }

  return JSON.parse(stdout);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      return send(res, 200, { ok: true });
    }

    if (!isAuthorized(req)) {
      return send(res, 401, { ok: false, error: "Unauthorized." });
    }

    if (
      !(
        (req.method === "POST" &&
          (req.url === "/scan" || req.url === "/api/scan" || req.url === "/v1/scan")) ||
        (req.method === "GET" && req.url?.startsWith("/scan/"))
      )
    ) {
      return send(res, 404, { ok: false, error: "Not found." });
    }

    const body = req.method === "POST" ? await readBody(req) : "";
    const image = imageFromRequest(req, body);
    if (!image || image.includes("://")) {
      return send(res, 400, {
        ok: false,
        error: "Pass a Docker image reference as { image }, e.g. nginx:latest.",
      });
    }

    const report = await scanImage(image);
    return send(res, 200, report, { "x-trivy-wrapper": "1" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(res, 500, {
      ok: false,
      error: message,
      fix:
        "Confirm trivy is installed, the local trivy server is reachable, and TRIVY_TOKEN/TRIVVY_API_KEY matches the server token.",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trivy REST wrapper listening on :${PORT}`);
  console.log(`Forwarding scans to ${TRIVY_SERVER}`);
});
