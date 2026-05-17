/* POST /api/scan
 *
 * Scans a Docker image for CVEs using the NIST NVD CVE API.
 *
 * Why NVD and not Trivy?
 *   The previous version shelled out to the `trivy` binary, which can't run on
 *   Vercel (50 MB function size cap, no shell tools, no Docker daemon).
 *   Docker Scout was the next obvious choice but its CVE pipeline requires
 *   `docker sbom` to extract a Software Bill of Materials from a *local*
 *   Docker daemon — also a non-starter on Vercel.
 *
 *   The NIST NVD API (`services.nvd.nist.gov/rest/json/cves/2.0`) returns real
 *   CVE data, is free, needs no auth, and works from any HTTP client. The
 *   tradeoff: NVD only matches CVEs against the *primary* application + version
 *   you ask for (via CPE — Common Platform Enumeration), not the OS-level
 *   packages inside the image layers. For deep layer scans you still need a
 *   self-hosted Trivy server; when `TRIVY_SERVER_URL` is set we delegate there
 *   first, otherwise we fall back to NVD.
 *
 * Response shape is unchanged so the frontend keeps working.
 *
 * Optional env:
 *   NVD_API_KEY        — raises rate limit from 5 req/30s to 50 req/30s.
 *   TRIVY_SERVER_URL   — if set, POST { image } there first; expects a Trivy
 *                        JSON report back.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------- Types ----------------------------------------------------------

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type VulnItem = {
  id: string;
  pkg: string;
  target: string;
  installedVersion: string;
  fixedVersion: string;
  severity: Severity;
  title: string;
};

export type ScanResponse = {
  image: string;
  scannedAt: string;
  summary: Record<Severity, number>;
  vulnerabilities: VulnItem[];
  suggestions: string[];
  rollbackStrategy: string;
  riskLevel: "safe" | "warn" | "critical";
};

// ---------- NVD response (minimal) -----------------------------------------

type NvdCvssMetric = {
  cvssData?: {
    baseScore?: number;
    baseSeverity?: Severity;
  };
};

type NvdCpeMatch = {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
};

type NvdConfigurationNode = {
  operator?: "AND" | "OR";
  cpeMatch?: NvdCpeMatch[];
};

type NvdCve = {
  id: string;
  descriptions?: { lang: string; value: string }[];
  metrics?: {
    cvssMetricV31?: NvdCvssMetric[];
    cvssMetricV30?: NvdCvssMetric[];
    cvssMetricV2?: { baseSeverity?: Severity; cvssData?: { baseScore?: number } }[];
  };
  configurations?: { nodes?: NvdConfigurationNode[] }[];
};

type NvdResponse = {
  resultsPerPage?: number;
  totalResults?: number;
  vulnerabilities?: { cve: NvdCve }[];
};

// ---------- CPE map for popular base images --------------------------------

// vendor:product pairs come from the official NVD CPE dictionary
// (https://nvd.nist.gov/products/cpe/search). Vendor names are the tricky
// part — e.g. NVD indexes nginx under `f5:nginx` (F5 acquired NGINX in 2019)
// and MySQL under `oracle:mysql` (post-acquisition). Verified non-zero CVE
// counts against the live NVD API before committing.
const CPE_MAP: Record<string, { vendor: string; product: string; label: string }> = {
  nginx: { vendor: "f5", product: "nginx", label: "nginx" },
  node: { vendor: "nodejs", product: "node.js", label: "Node.js" },
  nodejs: { vendor: "nodejs", product: "node.js", label: "Node.js" },
  python: { vendor: "python", product: "python", label: "Python" },
  redis: { vendor: "redis", product: "redis", label: "Redis" },
  postgres: { vendor: "postgresql", product: "postgresql", label: "PostgreSQL" },
  postgresql: { vendor: "postgresql", product: "postgresql", label: "PostgreSQL" },
  mysql: { vendor: "oracle", product: "mysql", label: "MySQL" },
  mariadb: { vendor: "mariadb", product: "mariadb", label: "MariaDB" },
  mongo: { vendor: "mongodb", product: "mongodb", label: "MongoDB" },
  mongodb: { vendor: "mongodb", product: "mongodb", label: "MongoDB" },
  php: { vendor: "php", product: "php", label: "PHP" },
  ruby: { vendor: "ruby-lang", product: "ruby", label: "Ruby" },
  golang: { vendor: "golang", product: "go", label: "Go" },
  go: { vendor: "golang", product: "go", label: "Go" },
  openjdk: { vendor: "oracle", product: "openjdk", label: "OpenJDK" },
  java: { vendor: "oracle", product: "openjdk", label: "OpenJDK" },
  httpd: { vendor: "apache", product: "http_server", label: "Apache HTTP Server" },
  apache: { vendor: "apache", product: "http_server", label: "Apache HTTP Server" },
  tomcat: { vendor: "apache", product: "tomcat", label: "Apache Tomcat" },
  haproxy: { vendor: "haproxy", product: "haproxy", label: "HAProxy" },
  rabbitmq: { vendor: "pivotal_software", product: "rabbitmq", label: "RabbitMQ" },
  elasticsearch: { vendor: "elastic", product: "elasticsearch", label: "Elasticsearch" },
  memcached: { vendor: "memcached", product: "memcached", label: "Memcached" },
  busybox: { vendor: "busybox", product: "busybox", label: "BusyBox" },
  influxdb: { vendor: "influxdata", product: "influxdb", label: "InfluxDB" },
  consul: { vendor: "hashicorp", product: "consul", label: "Consul" },
  vault: { vendor: "hashicorp", product: "vault", label: "Vault" },
  jenkins: { vendor: "jenkins", product: "jenkins", label: "Jenkins" },
  wordpress: { vendor: "wordpress", product: "wordpress", label: "WordPress" },
  drupal: { vendor: "drupal", product: "drupal", label: "Drupal" },
  // OS images are intentionally omitted: NVD doesn't index OS-package CVEs by
  // distro+version under the `:a:` namespace, and OS scanning is a Trivy job
  // anyway. They fall through to keyword search with a "this is approximate"
  // warning in the suggestions.
};

// ---------- Image parsing --------------------------------------------------

type ParsedImage = {
  original: string;
  repo: string;
  tag: string;
  vendor: string | null;
  product: string | null;
  label: string;
  version: string;
};

function parseImage(imageUrl: string): ParsedImage {
  let s = imageUrl.trim();

  // Strip @sha256:... digest if present
  const atIdx = s.lastIndexOf("@");
  if (atIdx > 0) s = s.slice(0, atIdx);

  // Tag separator is the last colon AFTER the last slash (avoids confusing
  // registry ports like "localhost:5000/foo" with a tag).
  const lastSlash = s.lastIndexOf("/");
  const lastColon = s.lastIndexOf(":");
  let tag = "latest";
  if (lastColon > lastSlash && lastColon !== -1) {
    tag = s.slice(lastColon + 1).trim() || "latest";
    s = s.slice(0, lastColon);
  }

  // Drop registry + namespace, keep last segment as the matcher.
  // Special-case Docker Hub's "library/" namespace for official images.
  const parts = s.split("/");
  let repo: string;
  if (parts.length === 1) {
    repo = parts[0];
  } else if (parts.length === 2 && parts[0].toLowerCase() === "library") {
    repo = parts[1];
  } else {
    repo = parts[parts.length - 1];
  }

  const key = repo.toLowerCase();
  const lookup = CPE_MAP[key] ?? null;

  return {
    original: imageUrl.trim(),
    repo,
    tag,
    vendor: lookup?.vendor ?? null,
    product: lookup?.product ?? null,
    label: lookup?.label ?? repo,
    version: parseVersion(tag),
  };
}

/** Strip distro/variant suffixes from a tag and extract a semver-ish core. */
function parseVersion(tag: string): string {
  if (!tag) return "";
  const lower = tag.toLowerCase();
  // Floating tags can't be matched against a specific CPE version.
  if (["latest", "stable", "edge", "main", "master", "current"].includes(lower)) {
    return "";
  }
  // "1.20.0-alpine3.18" -> match leading "1.20.0"
  const m = tag.match(/^(\d+(?:\.\d+){0,3})/);
  return m ? m[1] : "";
}

// ---------- NVD client -----------------------------------------------------

const NVD_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

function buildCpe(vendor: string, product: string, version: string): string {
  const v = version || "*";
  return `cpe:2.3:a:${vendor}:${product}:${v}:*:*:*:*:*:*:*`;
}

async function fetchFromNvd(url: string): Promise<NvdResponse> {
  const headers: Record<string, string> = {
    "user-agent": "forge-scanner/1.0 (+https://github.com/Doughnut-Codes)",
  };
  const apiKey = process.env.NVD_API_KEY?.trim();
  if (apiKey) headers["apiKey"] = apiKey;

  const ctrl = new AbortController();
  // NVD recommends ≤ 30s; we cap at 20s to fit inside Vercel hobby's 60s budget
  // (so we still have time to format + the user gets a quick response).
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`NVD HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as NvdResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function queryNvd(parsed: ParsedImage): Promise<NvdResponse> {
  // Exact CPE match — only useful when we have BOTH a known vendor/product
  // AND a real version.
  if (parsed.vendor && parsed.product && parsed.version) {
    const cpe = buildCpe(parsed.vendor, parsed.product, parsed.version);
    const url = `${NVD_BASE}?cpeName=${encodeURIComponent(cpe)}&resultsPerPage=100`;
    const r = await fetchFromNvd(url);
    if ((r.vulnerabilities?.length ?? 0) > 0) return r;
    // Fall through to virtualMatchString if cpeName yielded nothing — sometimes
    // NVD's match strings are versioned ranges, not exact versions.
  }

  // virtualMatchString matches against CPE match ranges (versionEndExcluding etc.)
  if (parsed.vendor && parsed.product) {
    const base = `cpe:2.3:a:${parsed.vendor}:${parsed.product}${parsed.version ? `:${parsed.version}` : ""}`;
    const url = `${NVD_BASE}?virtualMatchString=${encodeURIComponent(base)}&resultsPerPage=100`;
    const r = await fetchFromNvd(url);
    if ((r.vulnerabilities?.length ?? 0) > 0) return r;
  }

  // Last resort: keyword search by the product label. Only return the 25 most
  // recent CVEs to keep noise down for unmapped or generic images.
  const keyword = parsed.label.toLowerCase();
  const url = `${NVD_BASE}?keywordSearch=${encodeURIComponent(keyword)}&resultsPerPage=25`;
  return fetchFromNvd(url);
}

// ---------- NVD → VulnItem mapping -----------------------------------------

function extractSeverity(cve: NvdCve): Severity {
  const v31 = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity;
  if (v31) return v31;
  const v30 = cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity;
  if (v30) return v30;
  const v2 = cve.metrics?.cvssMetricV2?.[0]?.baseSeverity;
  if (v2) return v2;
  return "UNKNOWN";
}

function extractDescription(cve: NvdCve): string {
  const en = cve.descriptions?.find((d) => d.lang === "en")?.value;
  return (en ?? cve.id).slice(0, 240);
}

/** Walk the configuration tree and return the first matching fix version we can find. */
function extractFixedVersion(cve: NvdCve, vendor: string | null, product: string | null): string {
  if (!cve.configurations) return "";
  for (const cfg of cve.configurations) {
    for (const node of cfg.nodes ?? []) {
      for (const m of node.cpeMatch ?? []) {
        if (!m.criteria) continue;
        if (vendor && product && !cpeMentionsProduct(m.criteria, vendor, product)) continue;
        if (m.versionEndExcluding) return `< ${m.versionEndExcluding}`;
        if (m.versionEndIncluding) return `≤ ${m.versionEndIncluding}`;
      }
    }
  }
  return "";
}

function cpeMentionsProduct(criteria: string, vendor: string, product: string): boolean {
  const lower = criteria.toLowerCase();
  return lower.includes(`:${vendor.toLowerCase()}:`) && lower.includes(`:${product.toLowerCase()}:`);
}

/**
 * NVD returns every CVE that touches the product, including ones whose
 * vulnerable range doesn't include our version (e.g. an old nginx 0.5 CVE
 * still comes back when you query nginx 1.20.0). This compares our actual
 * version against the configuration ranges and keeps only the CVEs where
 * our version is genuinely vulnerable.
 *
 * Returns true if filtering can't decide — better to surface a possible CVE
 * than silently drop it.
 */
function affectsThisVersion(
  cve: NvdCve,
  vendor: string | null,
  product: string | null,
  version: string,
): boolean {
  if (!version) return true;
  if (!cve.configurations || cve.configurations.length === 0) return true;
  if (!vendor || !product) return true;

  let sawRelevantMatch = false;

  for (const cfg of cve.configurations) {
    for (const node of cfg.nodes ?? []) {
      for (const m of node.cpeMatch ?? []) {
        if (!m.criteria) continue;
        if (!cpeMentionsProduct(m.criteria, vendor, product)) continue;
        if (m.vulnerable === false) continue;

        sawRelevantMatch = true;

        // Extract the version baked into the CPE itself (5th colon-segment).
        // "cpe:2.3:a:nginx:nginx:1.18.0:*:*:*:*:*:*:*" → "1.18.0"
        const parts = m.criteria.split(":");
        const cpeVersion = parts[5] ?? "*";

        // No bounds AND a concrete CPE version: only a hit if it's our version.
        const hasBounds =
          m.versionStartIncluding ||
          m.versionStartExcluding ||
          m.versionEndIncluding ||
          m.versionEndExcluding;

        if (!hasBounds) {
          if (cpeVersion === "*" || cpeVersion === "-") return true;
          if (compareVersions(cpeVersion, version) === 0) return true;
          continue;
        }

        // Range comparison.
        if (m.versionStartIncluding && compareVersions(version, m.versionStartIncluding) < 0) continue;
        if (m.versionStartExcluding && compareVersions(version, m.versionStartExcluding) <= 0) continue;
        if (m.versionEndIncluding && compareVersions(version, m.versionEndIncluding) > 0) continue;
        if (m.versionEndExcluding && compareVersions(version, m.versionEndExcluding) >= 0) continue;

        return true;
      }
    }
  }

  // If NVD never told us *anything* about how this CVE relates to our
  // product, default to keeping it (better noisy than missing a real one).
  return !sawRelevantMatch;
}

/**
 * Compare two dotted version strings numerically segment-by-segment.
 * Non-numeric tails are compared lexically. Returns <0, 0, or >0.
 */
function compareVersions(a: string, b: string): number {
  const ap = a.split(/[.\-+]/);
  const bp = b.split(/[.\-+]/);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? "0";
    const bv = bp[i] ?? "0";
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else {
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
  }
  return 0;
}

function mapToVulnItem(cve: NvdCve, parsed: ParsedImage): VulnItem {
  return {
    id: cve.id,
    pkg: parsed.label,
    target: parsed.original,
    installedVersion: parsed.version || parsed.tag,
    fixedVersion: extractFixedVersion(cve, parsed.vendor, parsed.product),
    severity: extractSeverity(cve),
    title: extractDescription(cve),
  };
}

// ---------- Hosted Trivy API delegate --------------------------------------

/** Native Trivy JSON shape (what `trivy image --format json` emits). */
type TrivyNativeVuln = {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity: string;
  Title?: string;
  Description?: string;
};

type TrivyNativeResult = {
  Target: string;
  Type?: string;
  Vulnerabilities?: TrivyNativeVuln[];
};

type TrivyNativeReport = {
  SchemaVersion?: number;
  ArtifactName?: string;
  Results?: TrivyNativeResult[];
};

function normalizeSeverity(s: string | undefined): Severity {
  const u = (s ?? "").toUpperCase();
  if (u === "CRITICAL" || u === "HIGH" || u === "MEDIUM" || u === "LOW") return u;
  return "UNKNOWN";
}

function trivyNativeToScanResponse(
  image: string,
  report: TrivyNativeReport,
): ScanResponse {
  const flat: VulnItem[] = [];
  for (const r of report.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      flat.push({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        target: r.Target,
        installedVersion: v.InstalledVersion ?? "",
        fixedVersion: v.FixedVersion ?? "",
        severity: normalizeSeverity(v.Severity),
        title: (v.Title ?? v.Description ?? v.VulnerabilityID).slice(0, 240),
      });
    }
  }
  flat.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5),
  );

  const summary = buildSummary(flat);
  const parsed = parseImage(image);
  return {
    image,
    scannedAt: new Date().toISOString(),
    summary,
    vulnerabilities: flat.slice(0, 25),
    suggestions: generateSuggestions(
      flat,
      parsed,
      parsed.vendor ? "cpe" : "unmapped",
    ),
    rollbackStrategy: generateRollbackStrategy(summary, image),
    riskLevel: toRiskLevel(summary),
  };
}

function isOurScanResponse(data: unknown): data is ScanResponse {
  return (
    !!data &&
    typeof data === "object" &&
    "vulnerabilities" in data &&
    Array.isArray((data as { vulnerabilities: unknown }).vulnerabilities) &&
    "summary" in data
  );
}

function isTrivyNative(data: unknown): data is TrivyNativeReport {
  return (
    !!data &&
    typeof data === "object" &&
    "Results" in data &&
    Array.isArray((data as { Results: unknown }).Results)
  );
}

/**
 * Try the hosted Trivy API (TRIVVY_API + TRIVVY_API_KEY) across the common
 * endpoint shapes. Returns null on any failure so the caller can fall back.
 */
async function tryHostedTrivy(image: string): Promise<ScanResponse | null> {
  const baseRaw = (process.env.TRIVVY_API ?? process.env.TRIVY_API ?? process.env.TRIVY_SERVER_URL)?.trim();
  if (!baseRaw) return null;
  const base = baseRaw.replace(/\/+$/, "");
  const apiKey = (process.env.TRIVVY_API_KEY ?? process.env.TRIVY_API_KEY)?.trim();

  const authHeaders: Record<string, string> = {};
  if (apiKey) {
    // Send both. APIs that don't recognize one ignore it.
    authHeaders["authorization"] = `Bearer ${apiKey}`;
    authHeaders["x-api-key"] = apiKey;
  }

  const attempts: Array<{ url: string; init: RequestInit }> = [
    {
      url: `${base}/scan`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ image }),
      },
    },
    {
      url: `${base}/api/scan`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ image }),
      },
    },
    {
      url: `${base}/v1/scan`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ image }),
      },
    },
    {
      url: `${base}/scan/${encodeURIComponent(image)}`,
      init: { method: "GET", headers: { ...authHeaders } },
    },
  ];

  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        ...attempt.init,
        signal: AbortSignal.timeout(60_000),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const data: unknown = await res.json();

      if (isOurScanResponse(data)) return data;
      if (isTrivyNative(data)) return trivyNativeToScanResponse(image, data);
      // Some wrappers nest the Trivy payload under a key
      if (data && typeof data === "object") {
        const inner =
          (data as Record<string, unknown>).report ??
          (data as Record<string, unknown>).result ??
          (data as Record<string, unknown>).data;
        if (isOurScanResponse(inner)) return inner;
        if (isTrivyNative(inner)) return trivyNativeToScanResponse(image, inner);
      }
    } catch {
      // try next pattern
    }
  }

  return null;
}

// ---------- Aggregation helpers --------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4,
};

function buildSummary(vulns: VulnItem[]): Record<Severity, number> {
  const s: Record<Severity, number> = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0,
  };
  for (const v of vulns) s[v.severity] = (s[v.severity] ?? 0) + 1;
  return s;
}

function toRiskLevel(summary: Record<Severity, number>): "safe" | "warn" | "critical" {
  if (summary.CRITICAL > 0) return "critical";
  if (summary.HIGH > 0) return "warn";
  return "safe";
}

function generateSuggestions(
  vulns: VulnItem[],
  parsed: ParsedImage,
  scanMode: "cpe" | "keyword" | "unmapped",
): string[] {
  const tips: string[] = [];

  if (scanMode === "unmapped") {
    tips.push(
      `${parsed.repo} is not in the CPE map, so the scan fell back to a keyword search and may include unrelated CVEs. For accurate results, scan with Trivy/Grype in CI, or add this image to the CPE_MAP in app/api/scan/route.ts.`,
    );
  } else if (!parsed.version) {
    tips.push(
      `Tag "${parsed.tag}" is floating — pin a real version (e.g. \`${parsed.repo}:1.25.3\`) so the scanner can match CVEs against a specific CPE instead of returning recent project-wide CVEs.`,
    );
  }

  const fixable = vulns.filter((v) => v.fixedVersion);
  if (fixable.length > 0) {
    tips.push(
      `${fixable.length} of ${vulns.length} CVE${vulns.length !== 1 ? "s" : ""} have a published fix version — bump ${parsed.label} to a release past the fix window.`,
    );
  }

  const criticals = vulns.filter((v) => v.severity === "CRITICAL");
  if (criticals.length > 0) {
    tips.push(
      `${criticals.length} critical CVE${criticals.length !== 1 ? "s" : ""} present. Treat this image as blocked for production until the upstream is patched or you switch to a hardened base.`,
    );
  }

  const FAT_IMAGES = ["nginx", "node", "python", "ruby", "php", "java", "golang", "openjdk"];
  if (FAT_IMAGES.includes(parsed.repo.toLowerCase())) {
    tips.push(
      `Cut the attack surface: use a minimal variant like \`${parsed.repo}:alpine\` or a distroless image (\`gcr.io/distroless/${parsed.repo}\`). Fewer OS packages = fewer CVEs.`,
    );
  }

  tips.push(
    "Pin your base image to a specific digest (`FROM image@sha256:<digest>`) rather than a mutable tag — this prevents silent upstream changes from introducing new vulnerabilities.",
  );

  tips.push(
    "Run containers as a non-root user: add `RUN addgroup -S app && adduser -S app -G app && USER app` to your Dockerfile.",
  );

  tips.push(
    "For OS-package-level scanning (apt/apk packages inside the image), run Trivy in CI: `trivy image --exit-code 1 --severity CRITICAL <image>`. The NVD-based scan here covers the primary application only.",
  );

  return tips;
}

function generateRollbackStrategy(
  summary: Record<Severity, number>,
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
    `CLEAN IMAGE — no CVEs detected for this product/version. ` +
    `Keep the current digest pinned in your deployment manifests for reproducibility. ` +
    `Re-scan weekly or on every Dockerfile change; the NVD database is updated daily.`
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

  // Preferred: delegate to the hosted Trivy API (TRIVVY_API + TRIVVY_API_KEY).
  // Falls through silently to NVD on any failure so the scan never dies on
  // a Trivy outage.
  const trivyReport = await tryHostedTrivy(image);
  if (trivyReport) {
    return new Response(JSON.stringify(trivyReport), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-forge-scan-source": "trivy",
      },
    });
  }

  const parsed = parseImage(image);

  let nvd: NvdResponse;
  try {
    nvd = await queryNvd(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(
      502,
      `Vulnerability lookup failed against NVD: ${msg}. ` +
        `If this persists, set NVD_API_KEY (free at https://nvd.nist.gov/developers/request-an-api-key) to lift the rate limit.`,
    );
  }

  const scanMode: "cpe" | "keyword" | "unmapped" =
    parsed.vendor && parsed.product && parsed.version
      ? "cpe"
      : parsed.vendor && parsed.product
        ? "keyword"
        : "unmapped";

  const rawCves = (nvd.vulnerabilities ?? []).map((v) => v.cve);
  const filteredCves = rawCves.filter((cve) =>
    affectsThisVersion(cve, parsed.vendor, parsed.product, parsed.version),
  );

  const vulns: VulnItem[] = filteredCves
    .map((cve) => mapToVulnItem(cve, parsed))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5),
    );

  const summary = buildSummary(vulns);
  const riskLevel = toRiskLevel(summary);
  const suggestions = generateSuggestions(vulns, parsed, scanMode);
  const rollbackStrategy = generateRollbackStrategy(summary, image);

  const response: ScanResponse = {
    image,
    scannedAt: new Date().toISOString(),
    summary,
    vulnerabilities: vulns.slice(0, 25),
    suggestions,
    rollbackStrategy,
    riskLevel,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-forge-scan-source": "nvd",
    },
  });
}
