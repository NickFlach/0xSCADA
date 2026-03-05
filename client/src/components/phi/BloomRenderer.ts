/**
 * BloomRenderer.ts — Renders Fano points as pulsing bloom/spiral animations.
 *
 * Each point is a living bloom:
 *   - Size proportional to entity count in SGA class
 *   - Pulse rate driven by update frequency
 *   - Color: emerald (healthy) → amber (warning) → crimson (critical)
 *   - Glow radius from reading quality
 *   - Styles: spiral (normal), starburst (alarm), dim ember (stale)
 */

export type BloomStyle = 'spiral' | 'starburst' | 'ember';

export interface BloomParams {
  size: number;
  pulseHz: number;
  health: number;
  glow: number;
  style: BloomStyle;
}

export const DEFAULT_BLOOM: BloomParams = {
  size: 0.3, pulseHz: 0.5, health: 1, glow: 0.5, style: 'spiral',
};

export function healthColor(health: number): string {
  const h = Math.max(0, Math.min(1, health));
  if (h > 0.5) {
    const t = (h - 0.5) * 2;
    return lerpColor(0xea, 0xb3, 0x08, 0x22, 0xc5, 0x5e, t);
  }
  const t = h * 2;
  return lerpColor(0xef, 0x44, 0x44, 0xea, 0xb3, 0x08, t);
}

function lerpColor(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number, t: number
): string {
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

function rgba(color: string, alpha: number): string {
  const m = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha.toFixed(3)})`;
  return color;
}

export function renderBloom(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  params: BloomParams, time: number, breathFactor: number
): void {
  const baseRadius = 8 + params.size * 30;
  const pulse = Math.sin(time * params.pulseHz * 2 * Math.PI);
  const radius = baseRadius * (0.85 + 0.15 * pulse) * (0.9 + 0.1 * breathFactor);
  const color = healthColor(params.health);

  ctx.save();

  // Glow halo
  if (params.glow > 0.05) {
    const gr = radius * (1.5 + params.glow);
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, gr);
    grad.addColorStop(0, rgba(color, 0.4 * params.glow));
    grad.addColorStop(1, rgba(color, 0));
    ctx.beginPath();
    ctx.arc(cx, cy, gr, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  switch (params.style) {
    case 'spiral': drawSpiral(ctx, cx, cy, radius, time, color, params.pulseHz); break;
    case 'starburst': drawStarburst(ctx, cx, cy, radius, time, color); break;
    case 'ember': drawEmber(ctx, cx, cy, radius, time, color); break;
  }

  // Core dot
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.25, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawSpiral(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  time: number, color: string, pulseHz: number
): void {
  const arms = 3;
  const rotSpeed = 0.3 + pulseHz * 0.1;
  ctx.strokeStyle = rgba(color, 0.6);
  ctx.lineWidth = 1.5;
  for (let a = 0; a < arms; a++) {
    const baseAngle = (a * 2 * Math.PI) / arms + time * rotSpeed;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const r = radius * t;
      const angle = baseAngle + t * 3;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawStarburst(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  time: number, color: string
): void {
  ctx.strokeStyle = rgba(color, 0.8);
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const angle = (i * 2 * Math.PI) / 12 + time * 0.5;
    const flicker = 0.7 + 0.3 * Math.sin(time * 8 + i * 1.7);
    const len = radius * flicker;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + len * Math.cos(angle), cy + len * Math.sin(angle));
    ctx.stroke();
  }
}

function drawEmber(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  time: number, color: string
): void {
  const dimAlpha = 0.15 + 0.1 * Math.sin(time * 0.8);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.6, 0, 2 * Math.PI);
  ctx.fillStyle = rgba(color, dimAlpha);
  ctx.fill();
}
