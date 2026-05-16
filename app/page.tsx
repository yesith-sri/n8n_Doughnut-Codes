"use client";

import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import PipelineCanvas, {
  type PipelineStage,
  type StageState,
} from "./components/PipelineCanvas";

gsap.registerPlugin(useGSAP);

/* =====================================================================
   FORGE · Deployment Control — the deploying harness
   The frontend is a thin control surface for the n8n workflow.
   It:
     1. POSTs a Docker image URL to /api/deploy (server-side proxy to n8n)
     2. Renders the workflow response (architecture, costs, resume URL)
     3. Lets the user CHAT with the n8n advisor agent through /api/resume
        to fix mistakes before deploying. Each turn rotates the resume URL.
     4. Commits with a final POST { type: "final", action, provider }
        which exits the chat loop and triggers the deploy branch.
     5. Surfaces every reply, log line, and stage change from n8n.

   There are no mocks here. Every payload comes from n8n.
   Configure N8N_DEPLOY_WEBHOOK_URL in .env.local (see .env.example).
   ===================================================================== */

type Provider = "aws" | "gcp" | "azure";

type Status =
  | "idle"
  | "submitting"
  | "pending_approval"
  | "deploying"
  | "deployed"
  | "failed"
  | "rejected"
  | "unhealthy";

type DeploymentResponse = {
  deploymentId: number | string;
  status: string;
  architecture: string;
  recommendedProvider: Provider | string;
  dockerImageUrl: string;
  runtime: string;
  ports: string;
  memoryMB: number;
  cpuCores: number;
  costs: { aws: number; gcp: number; azure: number };
  resumeUrl: string;
};

type LogLevel = "info" | "success" | "warning" | "error";

type LogEntry = {
  id: string;
  ts: string;
  actor: string;
  level: LogLevel;
  message: string;
};

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: ChatRole;
  actor?: string;
  content: string;
  ts: string;
};

const SAMPLE_IMAGE = "nginx:latest";
const SAMPLE_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]`;

const PROVIDERS: { id: Provider; label: string; tag: string }[] = [
  { id: "aws", label: "AWS Fargate", tag: "us-east-1" },
  { id: "gcp", label: "GCP Cloud Run", tag: "us-central1" },
  { id: "azure", label: "Azure Container Apps", tag: "eastus" },
];

const PIPELINE_LABELS: { id: string; label: string; detail: string }[] = [
  { id: "ingest", label: "Ingest", detail: "Read Docker image URL" },
  { id: "inspect", label: "Inspect", detail: "Pull registry metadata" },
  { id: "analyze", label: "Analyze", detail: "Extract runtime + needs" },
  { id: "architect", label: "Architect", detail: "Recommend cloud target" },
  { id: "advise", label: "Advise", detail: "Chat to refine the plan" },
  { id: "deploy", label: "Deploy", detail: "Push to chosen provider" },
  { id: "verify", label: "Verify", detail: "Run health check" },
  { id: "heal", label: "Heal", detail: "Debugger agent on failure" },
];

const STATUS_META: Record<
  Status,
  { label: string; tone: string; description: string }
> = {
  idle: {
    label: "Ready",
    tone: "border-[var(--line-medium)] bg-[var(--bg-raised)] text-[var(--ink-primary)]",
    description: "Waiting for a Docker image to forge",
  },
  submitting: {
    label: "Submitting",
    tone: "border-[color:var(--status-active)]/40 bg-[color:var(--status-active-soft)] text-[var(--ink-primary)]",
    description: "Sending request to the n8n webhook",
  },
  pending_approval: {
    label: "Advising",
    tone: "border-[color:var(--status-pending)]/40 bg-[color:var(--status-pending-soft)] text-[var(--ink-primary)]",
    description: "Chat with the advisor, then commit a final decision",
  },
  deploying: {
    label: "Deploying",
    tone: "border-[color:var(--status-active)]/40 bg-[color:var(--status-active-soft)] text-[var(--ink-primary)]",
    description: "n8n is running the deploy branch — watch the n8n execution for completion",
  },
  deployed: {
    label: "Healthy",
    tone: "border-[color:var(--status-ok)]/40 bg-[color:var(--status-ok-soft)] text-[var(--ink-primary)]",
    description: "Health check passed",
  },
  failed: {
    label: "Failed",
    tone: "border-[color:var(--status-error)]/40 bg-[color:var(--status-error-soft)] text-[var(--ink-primary)]",
    description: "Deployment or health failed",
  },
  rejected: {
    label: "Rejected",
    tone: "border-[var(--line-medium)] bg-[var(--bg-raised)] text-[var(--ink-secondary)]",
    description: "Reviewer rejected the deployment",
  },
  unhealthy: {
    label: "Unhealthy",
    tone: "border-[color:var(--status-warn)]/40 bg-[color:var(--status-warn-soft)] text-[var(--ink-primary)]",
    description: "Monitor noticed a regression",
  },
};

const LOG_TONE: Record<LogLevel, { ring: string; label: string }> = {
  info: { ring: "border-[color:var(--accent)]/30 bg-[color:var(--accent-soft)]", label: "info" },
  success: { ring: "border-[color:var(--status-ok)]/30 bg-[color:var(--status-ok-soft)]", label: "ok" },
  warning: { ring: "border-[color:var(--status-pending)]/30 bg-[color:var(--status-pending-soft)]", label: "warn" },
  error: { ring: "border-[color:var(--status-error)]/30 bg-[color:var(--status-error-soft)]", label: "error" },
};

function randomId(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function makeLog(actor: string, level: LogLevel, message: string): LogEntry {
  return { id: randomId("log"), ts: new Date().toISOString(), actor, level, message };
}

function makeMessage(
  role: ChatRole,
  actor: string,
  content: string,
): ChatMessage {
  return {
    id: randomId("msg"),
    role,
    actor,
    content,
    ts: new Date().toISOString(),
  };
}

function formatTime(ts: string) {
  if (!ts) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));
  } catch {
    return ts;
  }
}

function pipelineFromStatus(
  status: Status,
  selectedProvider: Provider | null,
): PipelineStage[] {
  // Pure mapping: Status enum -> per-stage state. PipelineCanvas stays declarative.
  const order: StageState[] = PIPELINE_LABELS.map(() => "pending");

  function setUntil(idx: number, state: StageState) {
    for (let i = 0; i <= idx; i += 1) order[i] = state;
  }

  switch (status) {
    case "idle":
      break;
    case "submitting":
      order[0] = "active";
      break;
    case "pending_approval":
      setUntil(3, "done");
      order[4] = "active"; // advise
      break;
    case "deploying":
      setUntil(4, "done");
      order[5] = "active"; // deploy
      break;
    case "deployed":
      setUntil(6, "done");
      order[7] = "skipped"; // heal not needed
      break;
    case "failed":
    case "unhealthy":
      setUntil(5, "done");
      order[6] = "failed";
      order[7] = "active";
      break;
    case "rejected":
      setUntil(3, "done");
      order[4] = "failed"; // user said no
      order[5] = "skipped";
      order[6] = "skipped";
      order[7] = "skipped";
      break;
  }

  return PIPELINE_LABELS.map((p, i) => ({
    id: p.id,
    label: p.label,
    detail:
      p.id === "deploy" && selectedProvider
        ? `${p.detail} (${selectedProvider.toUpperCase()})`
        : p.detail,
    state: order[i],
  }));
}

export default function Home() {
  // -- input state --
  const [dockerImage, setDockerImage] = useState(SAMPLE_IMAGE);
  const [dockerfileContent, setDockerfileContent] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // -- workflow state --
  const [status, setStatus] = useState<Status>("idle");
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  // Seed log uses a stable id + empty timestamp so server and client render
  // identical HTML — no hydration mismatch.
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    {
      id: "log-welcome",
      ts: "",
      actor: "System",
      level: "info",
      message:
        "Forge ready. Paste a Docker image and submit to begin the workflow.",
    },
  ]);
  const [error, setError] = useState<string | null>(null);

  // -- chat state --
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  // currentResumeUrl rotates with every chat turn — each Wait resumption
  // hands us back a fresh URL we have to use for the next message.
  const [currentResumeUrl, setCurrentResumeUrl] = useState<string | null>(null);

  // -- refs --
  const rootRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  function pushLog(entry: LogEntry) {
    setLogs((prev) => [...prev, entry]);
  }

  // ------------------------------------------------------------------
  // GSAP entrance choreography. Scoped to the root.
  // ------------------------------------------------------------------
  useGSAP(
    () => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".reveal-hero", {
        y: 24,
        opacity: 0,
        duration: 0.8,
        stagger: 0.06,
      });
      tl.from(
        ".reveal-stat",
        { y: 18, opacity: 0, duration: 0.55, stagger: 0.07 },
        "-=0.55",
      );
      tl.from(
        ".reveal-panel",
        { y: 20, opacity: 0, duration: 0.6, stagger: 0.08 },
        "-=0.45",
      );
    },
    { scope: rootRef },
  );

  // Faint orbiting glow accents that drift forever.
  useGSAP(
    () => {
      gsap.to(".orb-a", {
        x: "+=40",
        y: "+=24",
        duration: 12,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
      gsap.to(".orb-b", {
        x: "-=36",
        y: "-=18",
        duration: 14,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
      gsap.to(".orb-c", {
        x: "+=28",
        y: "-=22",
        duration: 16,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    },
    { scope: rootRef },
  );

  // ------------------------------------------------------------------
  // Submit the Docker image to n8n via the /api/deploy proxy.
  // ------------------------------------------------------------------
  async function submitDeploy() {
    setError(null);
    setStatus("submitting");
    setSelectedProvider(null);
    setDeployment(null);
    setMessages([]);
    setCurrentResumeUrl(null);
    pushLog(makeLog("Frontend", "info", `Submitting ${dockerImage} to n8n.`));

    let res: Response;
    try {
      res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerImageUrl: dockerImage.trim(),
          dockerfileContent: dockerfileContent.trim() || undefined,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Network error reaching /api/deploy: ${msg}`);
      setStatus("idle");
      pushLog(makeLog("Frontend", "error", `Submit failed: ${msg}`));
      return;
    }

    const raw = await res.text();
    if (!res.ok) {
      const message = extractErrorMessage(raw, res.status, res.statusText);
      setError(message);
      setStatus("idle");
      pushLog(makeLog("Frontend", "error", message));
      return;
    }

    let data: DeploymentResponse;
    try {
      data = JSON.parse(raw) as DeploymentResponse;
    } catch {
      const message = `n8n returned non-JSON (status ${res.status}). First 200 chars: ${raw.slice(0, 200)}`;
      setError(message);
      setStatus("idle");
      pushLog(makeLog("Frontend", "error", message));
      return;
    }

    if (!data.resumeUrl) {
      const message =
        "n8n response missing resumeUrl. Check that the Deployment Webhook uses responseMode: responseNode and Respond to Frontend exposes $execution.resumeUrl.";
      setError(message);
      setStatus("idle");
      pushLog(makeLog("Frontend", "error", message));
      return;
    }

    setDeployment(data);
    setStatus("pending_approval");
    setCurrentResumeUrl(data.resumeUrl);

    pushLog(
      makeLog(
        "Analyzer",
        "success",
        `Detected ${data.runtime} on ports ${data.ports}, ${data.memoryMB}MB / ${data.cpuCores} CPU.`,
      ),
    );
    pushLog(
      makeLog(
        "Architect",
        "success",
        `Recommended ${data.architecture}. Resume URL captured.`,
      ),
    );

    seedAdvisorIntro(data);
  }

  // Seed the chat panel with the agent outputs so the user can see what n8n
  // already said before they start typing.
  function seedAdvisorIntro(data: DeploymentResponse) {
    const provider = (data.recommendedProvider as string).toUpperCase();
    setMessages([
      makeMessage(
        "assistant",
        "Analyzer",
        `Detected a ${data.runtime} workload on port(s) ${data.ports}. Estimated load: ${data.memoryMB} MB / ${data.cpuCores} cores.`,
      ),
      makeMessage(
        "assistant",
        "Architect",
        `Recommended target: ${data.architecture} on ${provider}.`,
      ),
      makeMessage(
        "assistant",
        "Cost",
        `Monthly estimates — AWS Fargate $${data.costs.aws}, GCP Cloud Run $${data.costs.gcp}, Azure Container Apps $${data.costs.azure}.`,
      ),
      makeMessage(
        "assistant",
        "Advisor",
        `Ask me anything before you ship — cost, scaling, region, lock-in, health checks. Or pick a provider from the buttons below to commit.`,
      ),
    ]);
  }

  // ------------------------------------------------------------------
  // CHAT — back-and-forth with the n8n Deployment Chat Agent.
  // Posts via /api/resume so the request is server-side (browser CORS is
  // not satisfiable on n8n Wait resume URLs).
  // Each n8n reply contains a NEW resumeUrl — must replace currentResumeUrl.
  // ------------------------------------------------------------------
  async function sendChatMessage(textOverride?: string) {
    if (!currentResumeUrl || isChatting) return;
    const text = (textOverride ?? chatInput).trim();
    if (!text) return;
    setError(null);

    if (textOverride === undefined) setChatInput("");
    const userMsg = makeMessage("user", "You", text);
    const wireHistory = [...messages, userMsg].map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
    setMessages((prev) => [...prev, userMsg]);
    setIsChatting(true);
    pushLog(makeLog("You", "info", text));

    let res: Response;
    try {
      res = await fetch("/api/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeUrl: currentResumeUrl,
          body: {
            type: "chat",
            message: text,
            history: wireHistory,
          },
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      surfaceChatError(`Network error reaching /api/resume: ${msg}`);
      return;
    }

    const raw = await res.text();
    if (!res.ok) {
      surfaceChatError(extractErrorMessage(raw, res.status, res.statusText));
      return;
    }

    let data: {
      type?: string;
      reply?: string;
      history?: { role: string; content: string }[];
      resumeUrl?: string;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      surfaceChatError(
        `n8n returned non-JSON (status ${res.status}). First 200 chars: ${raw.slice(0, 200)}`,
      );
      return;
    }

    const replyText = (data.reply ?? "").trim() || "(no reply from advisor)";
    setMessages((prev) => [
      ...prev,
      makeMessage("assistant", "Advisor", replyText),
    ]);
    if (data.resumeUrl) setCurrentResumeUrl(data.resumeUrl);
    pushLog(makeLog("Advisor", "success", replyText));
    setIsChatting(false);
  }

  function surfaceChatError(msg: string) {
    setError(msg);
    pushLog(makeLog("Workflow", "error", msg));
    setMessages((prev) => [
      ...prev,
      makeMessage("assistant", "Error", msg),
    ]);
    setIsChatting(false);
  }

  // ------------------------------------------------------------------
  // FINAL — commit the conversation.
  // POST { type: 'final', action, provider, plan } via /api/resume.
  // n8n exits the chat loop and runs the deploy or rejection branch.
  // ------------------------------------------------------------------
  async function sendFinal(action: "approve" | "reject", provider?: Provider) {
    if (!currentResumeUrl || isChatting) return;
    setError(null);
    const chosen =
      provider ?? (deployment?.recommendedProvider as Provider | undefined) ?? "gcp";
    setSelectedProvider(action === "approve" ? chosen : null);
    setIsChatting(true);

    const summaryText =
      action === "approve"
        ? `Final decision: deploy to ${chosen.toUpperCase()}.`
        : "Final decision: reject deployment.";
    setMessages((prev) => [...prev, makeMessage("user", "You", summaryText)]);
    pushLog(
      makeLog(
        "Human",
        action === "approve" ? "success" : "warning",
        action === "approve"
          ? `Approved deployment to ${chosen.toUpperCase()}.`
          : "Rejected at advisor stage.",
      ),
    );

    let res: Response;
    try {
      res = await fetch("/api/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeUrl: currentResumeUrl,
          body: {
            type: "final",
            action,
            provider: chosen,
            plan: "",
          },
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      surfaceChatError(`Network error reaching /api/resume: ${msg}`);
      return;
    }

    const raw = await res.text();
    if (!res.ok) {
      surfaceChatError(extractErrorMessage(raw, res.status, res.statusText));
      return;
    }

    let data: {
      type?: string;
      status?: string;
      action?: string;
      provider?: string;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      surfaceChatError(
        `n8n returned non-JSON (status ${res.status}). First 200 chars: ${raw.slice(0, 200)}`,
      );
      return;
    }

    if (data.status === "deploying") {
      setStatus("deploying");
      setMessages((prev) => [
        ...prev,
        makeMessage(
          "assistant",
          "Workflow",
          `Acknowledged. Deploy Agent is generating the ${chosen.toUpperCase()} configuration now. Watch the n8n execution for the deploy outcome — the frontend will reflect the next status once a /status endpoint is wired.`,
        ),
      ]);
      pushLog(
        makeLog(
          "Workflow",
          "info",
          `Resume webhook acknowledged. ${chosen.toUpperCase()} branch is live.`,
        ),
      );
    } else if (data.status === "rejected") {
      setStatus("rejected");
      setMessages((prev) => [
        ...prev,
        makeMessage("assistant", "Workflow", "Rejection recorded."),
      ]);
      pushLog(
        makeLog("Workflow", "info", "Rejection recorded in n8n."),
      );
    } else {
      pushLog(
        makeLog(
          "Workflow",
          "warning",
          `Unexpected final status from n8n: ${data.status ?? "(none)"}.`,
        ),
      );
    }

    // Resume URL is spent after a final.
    setCurrentResumeUrl(null);
    setIsChatting(false);
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((content) => setDockerfileContent(content));
  }

  function loadSampleDockerfile() {
    setDockerfileContent(SAMPLE_DOCKERFILE);
  }

  function onChatKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  }

  // ------------------------------------------------------------------
  // Derived view models
  // ------------------------------------------------------------------
  const statusMeta = STATUS_META[status];
  const stages = useMemo(
    () => pipelineFromStatus(status, selectedProvider),
    [status, selectedProvider],
  );

  // When no n8n response yet, show "—" everywhere a real value would go.
  const costs = deployment?.costs ?? { aws: 0, gcp: 0, azure: 0 };
  const cheapestEntry = (Object.entries(costs) as [Provider, number][]).reduce<
    [Provider, number] | null
  >((best, cur) => {
    if (cur[1] <= 0) return best;
    if (best === null || cur[1] < best[1]) return cur;
    return best;
  }, null);
  const cheapest = cheapestEntry?.[0];
  const recommended =
    (deployment?.recommendedProvider as Provider | undefined) ?? null;

  const isSubmitting = status === "submitting";
  const isAdvising = status === "pending_approval";
  const canSendChat = isAdvising && !isChatting && chatInput.trim().length > 0;
  const canSendFinal = isAdvising && !isChatting;

  return (
    <main ref={rootRef} className="relative min-h-screen overflow-hidden">
      {/* Drifting background accents — soft, three-light "lit room" feel */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="orb-a absolute -left-32 -top-32 h-[26rem] w-[26rem] rounded-full bg-[var(--brand)]/10 blur-[120px]" />
        <div className="orb-b absolute -right-24 top-24 h-[24rem] w-[24rem] rounded-full bg-[var(--accent)]/12 blur-[120px]" />
        <div className="orb-c absolute -bottom-32 left-1/3 h-[26rem] w-[26rem] rounded-full bg-[color:var(--status-ok)]/8 blur-[140px]" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1340px] flex-col gap-6 px-4 py-6 sm:px-8 lg:py-10">
        {/* ============== HEADER ============== */}
        <header className="reveal reveal-hero panel p-6 lg:p-8">
          <div className="flex flex-col gap-7 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-2xl">
              <div className="flex items-center gap-3">
                <BrandMark />
                <span className="font-display text-sm font-semibold uppercase tracking-[0.32em] text-[var(--brand)]">
                  Forge
                </span>
              </div>

              <h1 className="reveal reveal-hero mt-5 font-display text-[2.6rem] font-semibold leading-[1.06] tracking-tight text-[var(--ink-primary)] sm:text-[3.1rem]">
                A deploying harness for{" "}
                <span className="text-[var(--brand)]">human + agent crews.</span>
              </h1>

              <p className="reveal reveal-hero mt-5 max-w-xl text-[15px] leading-7 text-[var(--ink-secondary)]">
                Hand Forge a Docker image. The n8n agents analyze it, pick a
                cloud, and stand by. Chat with the advisor to catch mistakes
                before anything ships — then commit one final decision and the
                Deploy Agent pushes it to AWS, GCP, or Azure with a debugger
                agent on standby.
              </p>
            </div>

            <div className="grid w-full gap-3 sm:grid-cols-2 xl:w-[420px]">
              <StatCard
                label="Status"
                value={statusMeta.label}
                hint={statusMeta.description}
                tone={statusMeta.tone}
              />
              <StatCard
                label="Recommended"
                value={(deployment?.architecture ?? "—")}
                hint={(recommended ?? "—").toString().toUpperCase()}
              />
              <StatCard
                label="Runtime"
                value={deployment?.runtime ?? "—"}
                hint={`${deployment?.memoryMB ?? "—"} MB`}
              />
              <StatCard
                label="Ports"
                value={deployment?.ports ?? "—"}
                hint={`${deployment?.cpuCores ?? "—"} CPU`}
              />
            </div>
          </div>
        </header>

        {/* ============== PIPELINE CANVAS ============== */}
        <section className="reveal reveal-panel panel p-5 lg:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="eyebrow">Live pipeline</p>
              <h2 className="mt-1 font-display text-xl font-semibold text-[var(--ink-primary)]">
                Agent workflow
              </h2>
            </div>
            <div className="hidden items-center gap-4 text-[12px] text-[var(--ink-tertiary)] sm:flex">
              <LegendDot color="var(--status-ok)" label="done" />
              <LegendDot color="var(--brand)" label="active" />
              <LegendDot color="var(--ink-tertiary)" label="pending" />
              <LegendDot color="var(--status-error)" label="failed" />
            </div>
          </div>
          <PipelineCanvas stages={stages} className="h-[340px] w-full" />
        </section>

        {/* ============== TWO-COLUMN MAIN ============== */}
        <section className="grid gap-6 xl:grid-cols-12">
          {/* ====== LEFT COLUMN ====== */}
          <div className="flex flex-col gap-6 xl:col-span-7">
            {/* INTAKE */}
            <Panel eyebrow="Request" title="Deployment intake">
              <div className="space-y-5">
                <div className="space-y-2">
                  <label className="eyebrow flex items-center justify-between">
                    <span>Docker image URL</span>
                    <span className="text-[10px] tracking-[0.2em] text-[var(--ink-tertiary)]">
                      required
                    </span>
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      type="text"
                      value={dockerImage}
                      onChange={(e) => setDockerImage(e.target.value)}
                      placeholder="e.g. nginx:latest or ghcr.io/owner/app:v1.2.3"
                      className="flex-1 rounded-xl border border-[var(--line-medium)] bg-[var(--bg-input)] px-4 py-3 font-mono text-[14px] text-[var(--ink-primary)] outline-none transition focus:border-[var(--brand)]/60 focus:ring-2 focus:ring-[var(--brand)]/20"
                    />
                    <button
                      type="button"
                      onClick={submitDeploy}
                      disabled={isSubmitting || !dockerImage.trim()}
                      className="btn-primary"
                    >
                      {isSubmitting ? "Forging..." : "Forge deployment"}
                    </button>
                  </div>
                  {error ? (
                    <p className="rounded-lg border border-[color:var(--status-error)]/30 bg-[color:var(--status-error-soft)] px-3 py-2 text-[12px] text-[var(--ink-primary)]">
                      {error}
                    </p>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="text-[12px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)] transition hover:text-[var(--ink-secondary)]"
                >
                  {showAdvanced ? "Hide" : "Show"} advanced ·{" "}
                  <span className="text-[var(--ink-secondary)]">
                    Dockerfile
                  </span>
                </button>

                {showAdvanced ? (
                  <div className="space-y-4 border-t border-[var(--line-soft)] pt-5">
                    <div className="space-y-2">
                      <p className="text-[12px] leading-6 text-[var(--ink-tertiary)]">
                        The n8n webhook URL is server-side. Set{" "}
                        <code className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
                          N8N_DEPLOY_WEBHOOK_URL
                        </code>{" "}
                        in <span className="text-[var(--ink-secondary)]">.env.local</span>{" "}
                        (see <span className="text-[var(--ink-secondary)]">.env.example</span>)
                        and restart <span className="text-[var(--ink-secondary)]">bun run dev</span>.
                        The frontend proxies through <span className="text-[var(--ink-secondary)]">/api/deploy</span> and <span className="text-[var(--ink-secondary)]">/api/resume</span> — n8n Wait nodes can&apos;t set CORS headers, so server-side is the only way.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="eyebrow flex items-center justify-between">
                        <span>Dockerfile (optional)</span>
                        <span className="text-[10px] tracking-[0.2em] text-[var(--ink-tertiary)]">
                          improves analysis
                        </span>
                      </label>
                      <textarea
                        value={dockerfileContent}
                        onChange={(e) => setDockerfileContent(e.target.value)}
                        rows={10}
                        placeholder="Paste Dockerfile contents to help the Analyzer Agent..."
                        className="w-full rounded-xl border border-[var(--line-medium)] bg-[var(--bg-input)] px-4 py-3 font-mono text-[13px] leading-6 text-[var(--ink-primary)] outline-none transition focus:border-[var(--accent)]/60 focus:ring-2 focus:ring-[var(--accent)]/20"
                      />
                      <div className="flex flex-wrap gap-2">
                        <label className="btn-ghost cursor-pointer text-[12px]">
                          Upload file
                          <input
                            type="file"
                            accept=".dockerfile,.txt,text/plain"
                            className="hidden"
                            onChange={handleFile}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={loadSampleDockerfile}
                          className="btn-ghost text-[12px]"
                        >
                          Load sample
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </Panel>

            {/* DEPLOYMENT SNAPSHOT */}
            <Panel eyebrow="Snapshot" title="Deployment record">
              <div className="grid gap-3 md:grid-cols-3">
                <InfoCard
                  label="Deployment ID"
                  value={deployment?.deploymentId.toString() ?? "—"}
                />
                <InfoCard
                  label="Selected provider"
                  value={selectedProvider?.toUpperCase() ?? "not chosen"}
                />
                <InfoCard
                  label="n8n linked"
                  value={deployment ? "yes" : "no"}
                  hint={deployment ? "live response captured" : "no submit yet"}
                />
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <MetricChip
                  label="Architecture"
                  value={deployment?.architecture ?? "—"}
                />
                <MetricChip
                  label="Memory"
                  value={deployment ? `${deployment.memoryMB} MB` : "—"}
                />
                <MetricChip
                  label="CPU"
                  value={deployment ? `${deployment.cpuCores} cores` : "—"}
                />
              </div>
              <div className="mt-4 panel-raised p-4">
                <p className="eyebrow">Active resume URL</p>
                <p className="mt-2 break-all font-mono text-[12px] text-[var(--ink-secondary)]">
                  {currentResumeUrl ?? deployment?.resumeUrl ?? "—"}
                </p>
                <p className="mt-3 text-[12px] leading-6 text-[var(--ink-tertiary)]">
                  Chat turns POST{" "}
                  <code className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
                    {"{ type: 'chat', message, history }"}
                  </code>{" "}
                  to this URL (via{" "}
                  <code className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
                    /api/resume
                  </code>
                  ). n8n replies with a fresh URL for the next turn. The final
                  commit sends{" "}
                  <code className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
                    {"{ type: 'final', action, provider }"}
                  </code>
                  .
                </p>
              </div>
            </Panel>

            {/* WORKFLOW STAGES list (text mirror of canvas) */}
            <Panel eyebrow="Execution" title="Workflow timeline">
              <div className="space-y-2">
                {stages.map((s, i) => (
                  <TimelineRow key={s.id} stage={s} index={i} />
                ))}
              </div>
            </Panel>
          </div>

          {/* ====== RIGHT COLUMN ====== */}
          <div className="flex flex-col gap-6 xl:col-span-5">
            {/* ADVISOR CHAT */}
            <Panel
              eyebrow="Human in the loop"
              title="Chat with the deploy advisor"
            >
              {!deployment ? (
                <div className="rounded-2xl border border-[var(--line-soft)] bg-[var(--bg-raised)] p-5 text-[13px] leading-7 text-[var(--ink-secondary)]">
                  Forge a deployment to start the conversation. The advisor
                  will help you choose a provider and catch mistakes before
                  anything ships.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div
                    ref={chatScrollRef}
                    className="flex max-h-[460px] min-h-[280px] flex-col gap-3 overflow-auto rounded-2xl border border-[var(--line-soft)] bg-[var(--bg-raised)] p-4"
                  >
                    {messages.length === 0 ? (
                      <p className="text-[13px] text-[var(--ink-tertiary)]">
                        No messages yet.
                      </p>
                    ) : (
                      messages.map((m) => (
                        <ChatBubble key={m.id} message={m} />
                      ))
                    )}
                    {isChatting ? (
                      <ChatBubble
                        pulsing
                        message={{
                          id: "pending",
                          role: "assistant",
                          actor: "Advisor",
                          content: "Thinking...",
                          ts: "",
                        }}
                      />
                    ) : null}
                  </div>

                  {isAdvising ? (
                    <>
                      <div className="flex items-end gap-2">
                        <textarea
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={onChatKeyDown}
                          rows={2}
                          placeholder="Ask about cost, scaling, region, lock-in… (Enter to send, Shift+Enter for newline)"
                          className="flex-1 rounded-xl border border-[var(--line-medium)] bg-[var(--bg-input)] px-4 py-3 font-body text-[14px] leading-6 text-[var(--ink-primary)] outline-none transition focus:border-[var(--accent)]/60 focus:ring-2 focus:ring-[var(--accent)]/20"
                        />
                        <button
                          type="button"
                          onClick={() => sendChatMessage()}
                          disabled={!canSendChat}
                          className="btn-primary self-stretch"
                        >
                          Send
                        </button>
                      </div>

                      <div className="rounded-xl border border-[var(--line-soft)] bg-[var(--bg-input)]/40 p-3">
                        <p className="eyebrow mb-2">Commit a final decision</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {PROVIDERS.map((p) => (
                            <FinalActionButton
                              key={p.id}
                              label={`Deploy to ${p.label}`}
                              sub={`${p.tag} · $${costs[p.id] || "—"}/mo`}
                              tone={recommended === p.id ? "brand" : "neutral"}
                              disabled={!canSendFinal}
                              onClick={() => sendFinal("approve", p.id)}
                            />
                          ))}
                          <FinalActionButton
                            label="Reject deployment"
                            sub="Mark this request as not shipped"
                            tone="danger"
                            disabled={!canSendFinal}
                            onClick={() => sendFinal("reject")}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3">
                      <StatusBanner status={status} />
                      {status === "rejected" || status === "deployed" ? (
                        <button
                          type="button"
                          onClick={submitDeploy}
                          className="btn-primary w-full"
                        >
                          Forge another deployment
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </Panel>

            {/* COST */}
            <Panel eyebrow="Routing" title="Cost comparison">
              <div className="space-y-3">
                {PROVIDERS.map((p) => {
                  const cost = costs[p.id];
                  const isRecommended = recommended === p.id;
                  const isCheapest = cheapest === p.id;
                  return (
                    <div
                      key={p.id}
                      className={[
                        "flex items-center justify-between rounded-xl border p-4 transition",
                        isRecommended
                          ? "border-[color:var(--brand)]/30 bg-[color:var(--brand-soft)]"
                          : "border-[var(--line-soft)] bg-[var(--bg-raised)]",
                      ].join(" ")}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-display text-sm font-semibold text-[var(--ink-primary)]">
                            {p.label}
                          </p>
                          {isRecommended ? (
                            <Flag label="recommended" tone="brand" />
                          ) : null}
                          {isCheapest && !isRecommended ? (
                            <Flag label="cheapest" tone="ok" />
                          ) : null}
                        </div>
                        <p className="mt-1 text-[12px] text-[var(--ink-tertiary)]">
                          Region {p.tag} · monthly estimate
                        </p>
                      </div>
                      <p className="numerals text-xl font-semibold text-[var(--ink-primary)]">
                        {cost > 0 ? `$${cost}` : "—"}
                        <span className="ml-0.5 text-[12px] font-normal text-[var(--ink-tertiary)]">
                          /mo
                        </span>
                      </p>
                    </div>
                  );
                })}
              </div>
            </Panel>

            {/* LOGS */}
            <Panel eyebrow="Logs" title="Live activity">
              <div className="space-y-2 max-h-[420px] overflow-auto pr-1">
                {[...logs].reverse().map((entry) => {
                  const tone = LOG_TONE[entry.level];
                  return (
                    <div
                      key={entry.id}
                      className={`rounded-xl border p-3 ${tone.ring}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="font-display text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--ink-primary)]">
                            {entry.actor}
                          </span>
                          <span className="rounded-full border border-[var(--line-medium)] bg-[var(--bg-input)] px-2 py-0.5 font-display text-[9.5px] uppercase tracking-[0.24em] text-[var(--ink-tertiary)]">
                            {tone.label}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                          {formatTime(entry.ts)}
                        </span>
                      </div>
                      <p className="mt-2 text-[13px] leading-6 text-[var(--ink-secondary)]">
                        {entry.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </section>

        <footer className="reveal reveal-panel mt-2 flex flex-col items-start justify-between gap-3 border-t border-[var(--line-soft)] pt-6 text-[12px] text-[var(--ink-tertiary)] sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <BrandMark />
            <span>
              Forge · Agentic IDP control plane · n8n + Next.js
            </span>
          </div>
          <div className="font-mono">
            Workflow: <span className="text-[var(--ink-secondary)]">agentic-idp</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

/* =====================================================================
   PRESENTATIONAL HELPERS
   ===================================================================== */

function extractErrorMessage(raw: string, status: number, statusText: string) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return `n8n call failed (${status} ${statusText}): ${parsed.error}`;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
      return `n8n call failed (${status} ${statusText}): ${parsed.message}`;
    }
  } catch {
    // not JSON
  }
  const trimmed = raw.trim().slice(0, 240);
  return `n8n call failed (${status} ${statusText})${trimmed ? `: ${trimmed}` : ""}`;
}

function Panel({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="reveal reveal-panel panel p-5 sm:p-6">
      <div className="mb-4">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-[var(--ink-primary)]">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: string;
}) {
  return (
    <div
      className={[
        "reveal-stat rounded-xl border p-4",
        tone ?? "border-[var(--line-soft)] bg-[var(--bg-raised)]",
      ].join(" ")}
    >
      <p className="eyebrow">{label}</p>
      <p className="mt-2 numerals text-lg font-semibold text-[var(--ink-primary)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[12px] text-[var(--ink-tertiary)]">{hint}</p>
      ) : null}
    </div>
  );
}

function InfoCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="panel-raised p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 break-all font-display text-[15px] font-semibold text-[var(--ink-primary)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] text-[var(--ink-tertiary)]">{hint}</p>
      ) : null}
    </div>
  );
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-raised p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 numerals text-[14px] font-semibold text-[var(--ink-primary)]">
        {value}
      </p>
    </div>
  );
}

function StatusBanner({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <div className={`rounded-2xl border p-4 ${meta.tone}`}>
      <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] opacity-80">
        {meta.label}
      </p>
      <p className="mt-2 text-[13px] leading-6">{meta.description}</p>
    </div>
  );
}

function Flag({ label, tone }: { label: string; tone: "brand" | "ok" }) {
  const cls =
    tone === "brand"
      ? "border-[color:var(--brand)]/40 bg-[color:var(--brand-soft)] text-[var(--brand-strong)]"
      : "border-[color:var(--status-ok)]/40 bg-[color:var(--status-ok-soft)] text-[var(--status-ok)]";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-display text-[9.5px] uppercase tracking-[0.24em] ${cls}`}
    >
      {label}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span className="font-display uppercase tracking-[0.2em]">{label}</span>
    </span>
  );
}

function BrandMark() {
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[color:var(--brand)]/30 bg-[color:var(--brand-soft)]">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
      >
        <path
          d="M5 19V8.5a3.5 3.5 0 0 1 3.5-3.5h7A3.5 3.5 0 0 1 19 8.5V19"
          stroke="var(--brand)"
          strokeWidth="1.6"
        />
        <path
          d="M9 19v-7m6 7v-7M5 12h14"
          stroke="var(--brand)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function ChatBubble({
  message,
  pulsing,
}: {
  message: ChatMessage;
  pulsing?: boolean;
}) {
  const isUser = message.role === "user";
  const actor = message.actor ?? (isUser ? "You" : "Advisor");
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[88%] rounded-2xl border px-4 py-3 text-[13px] leading-6",
          isUser
            ? "border-[color:var(--brand)]/30 bg-[color:var(--brand-soft)] text-[var(--ink-primary)]"
            : "border-[var(--line-soft)] bg-[var(--bg-elevated)] text-[var(--ink-secondary)]",
          pulsing ? "animate-pulse" : "",
        ].join(" ")}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="font-display text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ink-tertiary)]">
            {actor}
          </span>
          {message.ts ? (
            <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
              {formatTime(message.ts)}
            </span>
          ) : null}
        </div>
        <p className="whitespace-pre-wrap font-body text-[var(--ink-primary)]">
          {message.content}
        </p>
      </div>
    </div>
  );
}

function FinalActionButton({
  label,
  sub,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  sub: string;
  tone: "brand" | "neutral" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "brand"
      ? "border-[color:var(--brand)]/40 bg-[color:var(--brand-soft)] hover:brightness-110"
      : tone === "danger"
        ? "border-[color:var(--status-error)]/40 bg-[color:var(--status-error-soft)] hover:brightness-110"
        : "border-[var(--line-medium)] bg-[var(--bg-raised)] hover:border-[color:var(--accent)]/40 hover:bg-[color:var(--accent-soft)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "group flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition disabled:opacity-40",
        toneClass,
      ].join(" ")}
    >
      <span className="font-display text-[13px] font-semibold text-[var(--ink-primary)]">
        {label}
      </span>
      <span className="text-[11px] text-[var(--ink-tertiary)]">{sub}</span>
    </button>
  );
}

function TimelineRow({
  stage,
  index,
}: {
  stage: PipelineStage;
  index: number;
}) {
  const tone =
    stage.state === "done"
      ? "border-[color:var(--status-ok)]/30 text-[var(--status-ok)]"
      : stage.state === "active"
        ? "border-[color:var(--brand)]/40 text-[var(--brand-strong)] animate-pulse"
        : stage.state === "failed"
          ? "border-[color:var(--status-error)]/40 text-[var(--status-error)]"
          : stage.state === "skipped"
            ? "border-[var(--line-soft)] text-[var(--ink-tertiary)]"
            : "border-[var(--line-medium)] text-[var(--ink-tertiary)]";

  return (
    <div className="flex items-start gap-4 rounded-xl border border-[var(--line-soft)] bg-[var(--bg-raised)] p-3.5">
      <div
        className={`numerals flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-[var(--bg-input)] text-[12px] font-semibold ${tone}`}
      >
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-[14px] font-semibold text-[var(--ink-primary)]">
            {stage.label}
          </h3>
          <span className="font-display text-[10px] uppercase tracking-[0.24em] text-[var(--ink-tertiary)]">
            {stage.state}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-6 text-[var(--ink-secondary)]">
          {stage.detail}
        </p>
      </div>
    </div>
  );
}
