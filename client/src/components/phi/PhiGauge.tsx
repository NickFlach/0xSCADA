/**
 * Phi (Φ) Dashboard Widget (#332)
 * 
 * Displays process integration score as a gauge with:
 * - Color coding: green (>0.7), yellow (0.4-0.7), red (<0.4)
 * - Class distribution breakdown
 * - Fano plane mini-visualization
 */

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api-credential";

interface PhiData {
  phi: number;
  level: string;
  integration: number;
  differentiation: number;
  density: number;
  scale: number;
  partitions: {
    quadrant: { classes: number; crossRatio: number };
    triality: { classes: number; crossRatio: number };
    classIndex: { classes: number; crossRatio: number };
  };
  entities: number;
  links: number;
  fanoLinks: number;
  geometricBonus: number;
}

function phiColor(phi: number): string {
  if (phi > 0.7) return "#22c55e"; // green
  if (phi > 0.4) return "#eab308"; // yellow
  return "#ef4444"; // red
}

function phiLabel(phi: number): string {
  if (phi > 0.7) return "Healthy";
  if (phi > 0.4) return "Degraded";
  return "Critical";
}

/** SVG gauge arc */
function GaugeArc({ value, size = 120 }: { value: number; size?: number }) {
  const r = (size - 12) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = -210;
  const endAngle = 30;
  const range = endAngle - startAngle;
  const angle = startAngle + range * Math.min(value, 1);
  const rad = (a: number) => (a * Math.PI) / 180;

  const bgPath = describeArc(cx, cy, r, startAngle, endAngle);
  const fgPath = describeArc(cx, cy, r, startAngle, angle);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={bgPath} fill="none" stroke="#334155" strokeWidth="8" strokeLinecap="round" />
      <path d={fgPath} fill="none" stroke={phiColor(value)} strokeWidth="8" strokeLinecap="round" />
      <text x={cx} y={cy - 4} textAnchor="middle" fill={phiColor(value)} fontSize="24" fontWeight="bold">
        {(value * 100).toFixed(0)}%
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fill="#94a3b8" fontSize="11">
        Φ {phiLabel(value)}
      </text>
    </svg>
  );
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg));
  const y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(endDeg));
  const y2 = cy + r * Math.sin(rad(endDeg));
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/** Mini Fano plane visualization */
function FanoMini({ populatedPoints }: { populatedPoints: Set<number> }) {
  // 7 points arranged in a circle + center
  const size = 80;
  const cx = size / 2;
  const cy = size / 2;
  const r = 28;
  const points: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60 - 90) * (Math.PI / 180);
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  points.push([cx, cy]); // point 7 at center

  const LINES: [number, number, number][] = [
    [0, 1, 3], [1, 2, 4], [2, 3, 5], [3, 4, 6], [4, 5, 0], [5, 6, 1], [6, 0, 2],
  ];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {LINES.map(([a, b, c], i) => (
        <g key={i} opacity={0.3}>
          <line x1={points[a][0]} y1={points[a][1]} x2={points[b][0]} y2={points[b][1]} stroke="#64748b" strokeWidth="1" />
          <line x1={points[b][0]} y1={points[b][1]} x2={points[c][0]} y2={points[c][1]} stroke="#64748b" strokeWidth="1" />
        </g>
      ))}
      {points.map(([px, py], i) => (
        <circle
          key={i}
          cx={px}
          cy={py}
          r={4}
          fill={populatedPoints.has(i + 1) ? "#22c55e" : "#334155"}
          stroke="#64748b"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

/**
 * Derive populated Fano plane points from partition data.
 * The 7 points of PG(2,2) map to: 3 quadrant axes (1-3), 3 triality axes (4-6),
 * and the central classIndex point (7). Points are populated when the corresponding
 * partition class count meets threshold (>0 for axes, >0 for center).
 */
function deriveFanoPoints(data: PhiData): Set<number> {
  const points = new Set<number>();
  const q = data.partitions?.quadrant;
  const t = data.partitions?.triality;
  const c = data.partitions?.classIndex;

  // Quadrant partition populates points 1, 2, 3 (one per class present, up to 4 classes → 3 outer points)
  if (q) {
    if (q.classes >= 1) points.add(1);
    if (q.classes >= 2) points.add(2);
    if (q.classes >= 3) points.add(4); // Point 4 (0-indexed 3) — Fano collinear with 1,2
  }
  // Triality partition populates points 3, 5, 6
  if (t) {
    if (t.classes >= 1) points.add(3);
    if (t.classes >= 2) points.add(5);
    if (t.classes >= 3) points.add(6);
  }
  // ClassIndex populates center point 7
  if (c && c.classes > 0) {
    points.add(7);
  }

  return points;
}

export function PhiGauge({ refreshMs = 10000 }: { refreshMs?: number }) {
  const [data, setData] = useState<PhiData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchPhi = async () => {
      try {
        const res = await apiFetch("/api/geometry/phi");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) { setData(json); setError(null); }
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    fetchPhi();
    const timer = setInterval(fetchPhi, refreshMs);
    return () => { active = false; clearInterval(timer); };
  }, [refreshMs]);

  if (error) {
    return (
      <div style={{ padding: 16, color: "#ef4444", fontSize: 12 }}>
        Φ unavailable: {error}
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: 16, color: "#64748b" }}>Loading Φ…</div>;
  }

  return (
    <div style={{ padding: 12, background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b", minWidth: 200 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <GaugeArc value={data.phi} />
        <FanoMini populatedPoints={deriveFanoPoints(data)} />
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
        <div>Level: <strong style={{ color: phiColor(data.phi) }}>{data.level}</strong></div>
        <div>Entities: {data.entities} · Links: {data.links} · Fano: {data.fanoLinks}</div>
        <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
          <span>Int: {(data.integration * 100).toFixed(0)}%</span>
          <span>Diff: {(data.differentiation * 100).toFixed(0)}%</span>
          <span>Den: {(data.density * 100).toFixed(0)}%</span>
        </div>
        <div style={{ marginTop: 4 }}>
          Q: {data.partitions.quadrant.classes}/4 ·
          T: {data.partitions.triality.classes}/3 ·
          C: {data.partitions.classIndex.classes}/96
        </div>
      </div>
    </div>
  );
}

export default PhiGauge;
