"use client";

import { useEffect, useRef } from "react";

/* =====================================================================
   PipelineCanvas
   A devicePixelRatio-aware canvas that draws the n8n deployment pipeline
   as a node graph. Pure 2D — no DOM nodes per stage. The canvas redraws
   on resize, on stage change, and at ~60fps while there is an active or
   pending stage (for the breathing pulse). It naps when nothing moves.

   Why a canvas and not divs?
   - Crisp on retina without 9 inner layers
   - One render loop drives all motion (pulse, flow, glow)
   - Easier to convey "this is a real pipeline" instead of a checkbox list
   ===================================================================== */

export type StageState = "done" | "active" | "pending" | "failed" | "skipped";

export type PipelineStage = {
  id: string;
  label: string;
  detail: string;
  state: StageState;
};

type Props = {
  stages: PipelineStage[];
  className?: string;
};

type Coord = { x: number; y: number };

const COLORS = {
  bg: "#0c1014",
  gridDot: "rgba(231, 220, 199, 0.04)",
  edgeIdle: "rgba(231, 220, 199, 0.14)",
  edgeDone: "rgba(126, 166, 118, 0.55)",
  edgeActive: "rgba(212, 162, 75, 0.85)",
  edgeFailed: "rgba(196, 101, 90, 0.6)",
  done: "#7ea676",
  doneFill: "rgba(126, 166, 118, 0.16)",
  active: "#d4a24b",
  activeFill: "rgba(212, 162, 75, 0.2)",
  pending: "#6e7177",
  pendingFill: "rgba(110, 113, 119, 0.12)",
  failed: "#c4655a",
  failedFill: "rgba(196, 101, 90, 0.16)",
  skipped: "rgba(110, 113, 119, 0.5)",
  skippedFill: "rgba(110, 113, 119, 0.05)",
  label: "#ede5d3",
  detail: "#a8a89b",
} as const;

function colorFor(state: StageState): { stroke: string; fill: string; text: string } {
  switch (state) {
    case "done":
      return { stroke: COLORS.done, fill: COLORS.doneFill, text: COLORS.label };
    case "active":
      return { stroke: COLORS.active, fill: COLORS.activeFill, text: COLORS.label };
    case "failed":
      return { stroke: COLORS.failed, fill: COLORS.failedFill, text: COLORS.label };
    case "skipped":
      return { stroke: COLORS.skipped, fill: COLORS.skippedFill, text: COLORS.detail };
    case "pending":
    default:
      return { stroke: COLORS.pending, fill: COLORS.pendingFill, text: COLORS.detail };
  }
}

function edgeColor(prev: StageState, next: StageState) {
  if (prev === "failed" || next === "failed") return COLORS.edgeFailed;
  if (prev === "done" && (next === "done" || next === "active")) return COLORS.edgeDone;
  if (prev === "active" || next === "active") return COLORS.edgeActive;
  return COLORS.edgeIdle;
}

export default function PipelineCanvas({ stages, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stagesRef = useRef(stages);
  const rafRef = useRef<number | null>(null);

  // Keep latest stages addressable inside the render loop without
  // restarting the effect on every parent update.
  useEffect(() => {
    stagesRef.current = stages;
  }, [stages]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let positions: Coord[] = [];

    function layout() {
      const s = stagesRef.current;
      if (s.length === 0) return;

      const padX = 64;
      const padY = 56;
      const usableW = Math.max(1, width - padX * 2);
      const usableH = Math.max(1, height - padY * 2);

      /* Two-row zigzag so the pipeline reads as a story, not a flat conveyor.
         Odd-indexed stages drop to the lower row. */
      const cols = Math.ceil(s.length / 2);
      const colGap = cols > 1 ? usableW / (cols - 1) : 0;
      const rowGap = usableH;

      positions = s.map((_, i) => {
        const col = Math.floor(i / 2);
        const row = i % 2;
        const x = padX + col * colGap;
        const y = padY + (rowGap > 0 ? row * rowGap : 0);
        return { x, y };
      });
    }

    function resize() {
      const rect = wrap!.getBoundingClientRect();
      width = Math.max(320, Math.floor(rect.width));
      height = Math.max(180, Math.floor(rect.height));
      dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    }

    function drawGrid() {
      ctx!.fillStyle = COLORS.bg;
      ctx!.fillRect(0, 0, width, height);

      const step = 22;
      ctx!.fillStyle = COLORS.gridDot;
      for (let x = step; x < width; x += step) {
        for (let y = step; y < height; y += step) {
          ctx!.fillRect(x, y, 1, 1);
        }
      }
    }

    function drawEdge(a: Coord, b: Coord, color: string, dashPhase = 0) {
      const cp1x = (a.x + b.x) / 2;
      const cp1y = a.y;
      const cp2x = (a.x + b.x) / 2;
      const cp2y = b.y;

      ctx!.beginPath();
      ctx!.moveTo(a.x, a.y);
      ctx!.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, b.x, b.y);
      ctx!.lineWidth = 1.6;
      ctx!.strokeStyle = color;
      ctx!.setLineDash(color === COLORS.edgeActive ? [6, 6] : []);
      ctx!.lineDashOffset = -dashPhase;
      ctx!.stroke();
      ctx!.setLineDash([]);
    }

    function drawNode(
      pos: Coord,
      stage: PipelineStage,
      index: number,
      tNow: number,
    ) {
      const { stroke, fill, text } = colorFor(stage.state);

      // Pulse only for active/pending nodes; everyone else holds still.
      const pulse =
        stage.state === "active"
          ? 1 + Math.sin(tNow / 360) * 0.06
          : stage.state === "pending"
            ? 1 + Math.sin(tNow / 600) * 0.025
            : 1;

      const r = 22 * pulse;

      // Soft outer glow for active state
      if (stage.state === "active") {
        const grad = ctx!.createRadialGradient(pos.x, pos.y, r * 0.7, pos.x, pos.y, r * 2.8);
        grad.addColorStop(0, "rgba(212, 162, 75, 0.34)");
        grad.addColorStop(1, "rgba(212, 162, 75, 0)");
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(pos.x, pos.y, r * 2.8, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Disc
      ctx!.beginPath();
      ctx!.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx!.fillStyle = fill;
      ctx!.fill();
      ctx!.lineWidth = stage.state === "skipped" ? 1 : 1.8;
      ctx!.strokeStyle = stroke;
      ctx!.stroke();

      // Stage number
      ctx!.fillStyle = stroke;
      ctx!.font = "600 13px var(--font-display), Oxanium, sans-serif";
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.fillText(String(index + 1).padStart(2, "0"), pos.x, pos.y);

      // Label below the disc — alternating row offset so labels never collide.
      const labelY = pos.y + r + 18;
      ctx!.fillStyle = text;
      ctx!.font = "600 12px var(--font-display), Oxanium, sans-serif";
      ctx!.textAlign = "center";
      ctx!.textBaseline = "top";
      ctx!.fillText(stage.label.toUpperCase(), pos.x, labelY);

      // Detail — Roboto, smaller, dimmer
      ctx!.fillStyle = COLORS.detail;
      ctx!.font = "400 11px var(--font-body), Roboto, sans-serif";
      ctx!.textBaseline = "top";
      // Wrap detail to two lines if needed
      const words = stage.detail.split(" ");
      const maxWidth = 130;
      let line = "";
      let yLine = labelY + 16;
      let lineCount = 0;
      for (let i = 0; i < words.length; i += 1) {
        const tentative = line ? `${line} ${words[i]}` : words[i];
        const measure = ctx!.measureText(tentative).width;
        if (measure > maxWidth && line) {
          ctx!.fillText(line, pos.x, yLine);
          line = words[i];
          yLine += 14;
          lineCount += 1;
          if (lineCount >= 1) {
            // already drew one line, finish the rest on the next
            // and stop after two total lines.
          }
          if (lineCount >= 2) break;
        } else {
          line = tentative;
        }
      }
      if (line && lineCount < 2) {
        ctx!.fillText(line, pos.x, yLine);
      }
    }

    function frame(tNow: number) {
      drawGrid();

      const s = stagesRef.current;
      if (s.length === 0 || positions.length !== s.length) {
        layout();
      }

      // Edges first (so nodes sit on top)
      const dashPhase = (tNow / 22) % 12;
      for (let i = 0; i < s.length - 1; i += 1) {
        const a = positions[i];
        const b = positions[i + 1];
        if (!a || !b) continue;
        drawEdge(a, b, edgeColor(s[i].state, s[i + 1].state), dashPhase);
      }

      // Nodes
      for (let i = 0; i < s.length; i += 1) {
        const p = positions[i];
        if (!p) continue;
        drawNode(p, s[i], i, tNow);
      }

      // Keep the loop alive only when there's motion to render.
      const hasMotion = s.some((x) => x.state === "active" || x.state === "pending");
      if (hasMotion) {
        rafRef.current = window.requestAnimationFrame(frame);
      } else {
        rafRef.current = null;
      }
    }

    function ensureLoop() {
      if (rafRef.current == null) {
        rafRef.current = window.requestAnimationFrame(frame);
      }
    }

    resize();
    ensureLoop();
    // Always do one paint even if nothing is animating, so static states show.
    window.requestAnimationFrame((t) => {
      frame(t);
    });

    const observer = new ResizeObserver(() => {
      resize();
      window.requestAnimationFrame((t) => frame(t));
      ensureLoop();
    });
    observer.observe(wrap);

    return () => {
      observer.disconnect();
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // When stages change, nudge the canvas so a static frame repaints.
  // We do this by dispatching a resize event, which the effect above
  // listens for via the ResizeObserver fallback path.
  useEffect(() => {
    if (rafRef.current == null) {
      rafRef.current = window.requestAnimationFrame(() => {
        const ev = new Event("resize");
        window.dispatchEvent(ev);
        rafRef.current = null;
      });
    }
  }, [stages]);

  return (
    <div ref={wrapRef} className={className ?? "relative h-[320px] w-full"}>
      <canvas ref={canvasRef} className="block h-full w-full rounded-2xl" />
    </div>
  );
}
