/**
 * LivingFano.tsx — Living Fano Plane dashboard canvas component.
 *
 * 60fps HTML5 Canvas animation: 7 Fano points as pulsing blooms,
 * 7 lines with flowing particles, breathing with Φ, Flower of Life background.
 *
 * ADR-0025 Wave 1: closes #389, closes #390
 */

import { useEffect, useRef, useCallback } from 'react';
import { computeFanoLayout, FanoPoint } from './FanoGeometry';
import { BloomParams, DEFAULT_BLOOM, renderBloom } from './BloomRenderer';
import { FlowRenderer } from './FlowRenderer';
import { BreathingController } from './BreathingController';
import { FanoDataBridge, FanoVisualState } from './FanoDataBridge';

export interface LivingFanoProps {
  width?: number;
  height?: number;
  pollIntervalMs?: number;
  phi?: number;
  alarmActive?: boolean;
  blooms?: BloomParams[];
}

function drawFlowerOfLife(
  ctx: CanvasRenderingContext2D, w: number, h: number, brightness: number
): void {
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.12;
  ctx.strokeStyle = `rgba(100,200,160,${(brightness * 0.15).toFixed(3)})`;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i * 60) * (Math.PI / 180);
    ctx.beginPath(); ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), r, 0, 2 * Math.PI); ctx.stroke();
  }
}

export function LivingFano({
  width = 400, height = 400, pollIntervalMs = 5000,
  phi: overridePhi, alarmActive: overrideAlarm, blooms: overrideBlooms,
}: LivingFanoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const breathRef = useRef(new BreathingController());
  const flowRef = useRef(new FlowRenderer());
  const bridgeRef = useRef(new FanoDataBridge());
  const stateRef = useRef<FanoVisualState | null>(null);
  const lastTimeRef = useRef<number>(0);
  const rotationRef = useRef(0);
  const points = useRef<FanoPoint[]>(computeFanoLayout());

  const render = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dt = Math.min(lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 1 / 60, 0.1);
    lastTimeRef.current = timestamp;
    const time = timestamp / 1000;

    const vs = stateRef.current ?? bridgeRef.current.getState();
    const currentPhi = overridePhi ?? vs.phi;
    const currentBlooms = overrideBlooms ?? vs.blooms;
    const hasAlarm = overrideAlarm ?? vs.hasAlarm;

    breathRef.current.setPhi(currentPhi);
    const breathFactor = breathRef.current.update(dt);

    rotationRef.current += (hasAlarm ? 0 : 0.05 + currentPhi * 0.1) * dt;

    flowRef.current.setAllFlows(vs.flows);
    flowRef.current.update(dt);

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, w, h);

    drawFlowerOfLife(ctx, w, h, vs.backgroundBrightness);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rotationRef.current);
    ctx.translate(-w / 2, -h / 2);

    flowRef.current.render(ctx, points.current, w, h, time);

    const pts = points.current;
    for (let i = 0; i < 7; i++) {
      renderBloom(ctx, pts[i].x * w, pts[i].y * h, currentBlooms[i] ?? DEFAULT_BLOOM, time, breathFactor);
    }

    ctx.restore();
    animRef.current = requestAnimationFrame(render);
  }, [overridePhi, overrideAlarm, overrideBlooms]);

  useEffect(() => {
    bridgeRef.current.start(pollIntervalMs, (state) => { stateRef.current = state; });
    animRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animRef.current);
      bridgeRef.current.stop();
      breathRef.current.reset();
    };
  }, [render, pollIntervalMs]);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  return (
    <canvas
      ref={canvasRef}
      width={width * dpr}
      height={height * dpr}
      style={{ width, height, borderRadius: 8, border: '1px solid #1e293b', background: '#0a0f1a' }}
    />
  );
}

export default LivingFano;
