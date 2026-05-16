/* POST /api/scan
 *
 * Scans a Docker image for CVEs using the Trivy CLI (Aqua Security).
 * Trivy must be installed on the server — see docs/credentials.md or
 * https://trivy.dev/latest/getting-started/installation/
 *
 * Returns a structured report:
 *   { image, scannedAt, summary, vulnerabilities, suggestions, rollbackStrategy, riskLevel }
 *
 * riskLevel:
 *   "safe"     — zero critical/high CVEs
 *   "warn"     — high CVEs present, no critical
 *   "critical" — one or more critical CVEs
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- Types ----------------------------------------------------------

type TrivySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

type TrivyVuln = {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: TrivySeverity;
  Title?: string;
};

type TrivyResult = {
  Target: string;
  Type?: string;
  Vulnerabilities?: TrivyVuln[];
};

type TrivyOutput = {
  SchemaVersion?: number;
  ArtifactName?: string;
  Results?: TrivyResult[];
};

export type VulnItem = {
  id: string;
  pkg: string;
  target: string;
  installedVersion: string;
  fixedVersion: string;
  severity: TrivySeverity;
  title: string;
};

export type ScanResponse = {
  image: string;
  scannedAt: string;
  summary: Record<TrivySeverity, number>;
  vulnerabilities: VulnItem[];
  suggestions: string[];
  rollbackStrategy: string;
  riskLevel: "safe" | "warn" | "critical";
};

// ---------- Trivy discovery ------------------------------------------------

const TRIVY_CANDIDATES = [
  "trivy",
  "/opt/homebrew/bin/trivy",   // macOS Homebrew (Apple Silicon)
  "/usr/local/bin/trivy",      // macOS Homebrew (Intel) / manual install
  "/usr/bin/trivy",            // Linux system package
  "/snap/bin/trivy",           // Linux snap
];

async function findTrivy(): Promise<string | null> {
  for (const path of TRIVY_CANDIDATES) {
    try {
      await execFileAsync(path, ["--version"], { timeout: 5_000 });
      return path;
    } catch {
      // not at this path
    }
  }
  return null;
}

// ---------- Analysis helpers -----------------------------------------------

const SEVERITY_RANK: Record<TrivySeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4,
};

function buildSummary(vulns: VulnItem[]): Record<TrivySeverity, number> {
  const s: Record<TrivySeverity, number> = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0,
  };
  for (const v of vulns) s[v.severity] = (s[v.severity] ?? 0) + 1;
  return s;
}

function toRiskLevel(summary: Record<TrivySeverity, number>): "safe" | "warn" | "critical" {
  if (summary.CRITICAL > 0) return "critical";
  if (summary.HIGH > 0) return "warn";
  return "safe";
}

function generateSuggestions(vulns: VulnItem[], image: string): string[] {
  const tips: string[] = [];

  const fixable = vulns.filter((v) => v.fixedVersion);
  if (fixable.length > 0) {
    tips.push(
      `${fixable.length} of ${vulns.length} CVE${vulns.length !== 1 ? "s" : ""} have a published fix — update the affected package(s) or rebuild from a newer base image.`,
    );
  }

  const criticals = vulns.filter((v) => v.severity === "CRITICAL");
  if (criticals.length > 0) {
    const pkgs = [...new Set(criticals.map((v) => v.pkg))].slice(0, 3).join(", ");
    tips.push(
      `Critical packages: ${pkgs}. Patch immediately — consider \`RUN apt-get update && apt-get upgrade -y\` in your Dockerfile as a short-term mitigation.`,
    );
  }

  // Base-image suggestion based on image name
  const baseName = image.split(":")[0].split("/").pop() ?? "";
  const FAT_IMAGES = ["nginx", "node", "python", "ruby", "php", "java", "golang"];
  if (FAT_IMAGES.includes(baseName)) {
    tips.push(
      `Switch to a minimal variant to cut the attack surface: \`${baseName}:alpine\` or \`gcr.io/distroless/${baseName}\`. Fewer OS packages = fewer CVEs.`,
    );
  }

  tips.push(
    "Pin your base image to a specific digest (\`FROM nginx@sha256:<digest>\`) rather than a mutable tag — this prevents silent upstream changes from introducing new vulnerabilities.",
  );

  tips.push(
    "Run containers as a non-root user: add \`RUN addgroup -S app && adduser -S app -G app && USER app\` to your Dockerfile.",
  );

  tips.push(
    "Add Trivy (or Grype) to your CI pipeline so every image build is gated on a security scan: \`trivy image --exit-code 1 --severity CRITICAL <image>\`.",
  );

  return tips;
}

function generateRollbackStrategy(
  summary: Record<TrivySeverity, number>,
  image: string,
): string {
  const repo = image.includes(":") ? image.split(":")[0] : image;

  if (summary.CRITICAL > 0) {
    return (
      `BLOCK DEPLOYMENT — ${summary.CRITICAL} critical CVE(s) detected. ` +
      `Rollback plan: (1) Do not push this image to production. ` +
      `(2) Identify the last clean digest via \`docker pull ${repo}@sha256:<last-good-digest>\` or your registry's vulnerability scan history. ` +
      `(3) Rebuild with an updated base image, re-scan, and promote only when CRITICAL count is zero. ` +
      `(4) If already deployed in an earlier window, immediately swap image and perform a rolling restart.`
    );
  }

  if (summary.HIGH > 0) {
    return (
      `PROCEED WITH CAUTION — ${summary.HIGH} high-severity CVE(s) detected. ` +
      `Rollback plan: (1) Deploy behind a WAF and restrict public exposure until patched. ` +
      `(2) Tag the current deployment image as \`${repo}:stable-<date>\` before promoting a fix. ` +
      `(3) If post-deploy issues surface, run \`kubectl rollout undo deployment/<name>\` or equivalent provider rollback command within your SLA window.`
    );
  }

  if (summary.MEDIUM > 0 || summary.LOW > 0) {
    return (
      `SAFE TO DEPLOY — only medium/low CVEs. ` +
      `Rollback plan: maintain the previous image tag (\`${repo}:prev\`) for at least 7 days. ` +
      `Schedule a base-image refresh in the next sprint. ` +
      `No emergency procedure required, but track CVEs via your registry's continuous scanning.`
    );
  }

  return (
    `CLEAN IMAGE — no CVEs detected. ` +
    `Keep the current digest pinned in your deployment manifests for reproducibility. ` +
    `Re-scan weekly or on every Dockerfile change; the vulnerability database is updated daily.`
  );
}

// ---------- Route handler --------------------------------------------------

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: { dockerImageUrl?: unknown };
  try {
    body = (await request.json()) as { dockerImageUrl?: unknown };
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }

  const image =
    typeof body.dockerImageUrl === "string" ? body.dockerImageUrl.trim() : "";
  if (!image) {
    return jsonError(400, "Missing or empty 'dockerImageUrl' in request body.");
  }

  const trivyPath = await findTrivy();
  if (!trivyPath) {
    return jsonError(
      503,
      "Trivy is not installed on this server. " +
        "Install it with `brew install trivy` (macOS) or " +
        "`apt-get install -y trivy` (Debian/Ubuntu). " +
        "Full guide: https://trivy.dev/latest/getting-started/installation/",
    );
  }

  let stdout = "";
  let stderr = "";

  try {
    const result = await execFileAsync(
      trivyPath,
      [
        "image",
        "--format", "json",
        "--no-progress",
        "--quiet",
        "--timeout", "120s",
        image,
      ],
      {
        // 130 s hard kill — 10 s more than Trivy's own timeout
        timeout: 130_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // Trivy exits 0 by default (no --exit-code 1 flag), so an error here is real
    const detail = e.message ?? "unknown error";
    const stderrSnippet = (e.stderr ?? "").slice(0, 400);
    return jsonError(
      500,
      `Trivy scan failed: ${detail}${stderrSnippet ? `. stderr: ${stderrSnippet}` : ""}`,
    );
  }

  let trivyOutput: TrivyOutput;
  try {
    trivyOutput = JSON.parse(stdout) as TrivyOutput;
  } catch {
    return jsonError(
      500,
      `Trivy returned non-JSON output. stderr: ${stderr.slice(0, 400)}`,
    );
  }

  // Flatten all vulnerabilities across all scan targets
  const allVulns: VulnItem[] = [];
  for (const result of trivyOutput.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      allVulns.push({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        target: result.Target,
        installedVersion: v.InstalledVersion,
        fixedVersion: v.FixedVersion ?? "",
        severity: v.Severity as TrivySeverity,
        title: v.Title ?? v.VulnerabilityID,
      });
    }
  }

  // Sort: most severe first
  allVulns.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5),
  );

  const summary = buildSummary(allVulns);
  const riskLevel = toRiskLevel(summary);
  const suggestions = generateSuggestions(allVulns, image);
  const rollbackStrategy = generateRollbackStrategy(summary, image);

  const response: ScanResponse = {
    image,
    scannedAt: new Date().toISOString(),
    summary,
    vulnerabilities: allVulns.slice(0, 25), // top 25 most severe
    suggestions,
    rollbackStrategy,
    riskLevel,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
