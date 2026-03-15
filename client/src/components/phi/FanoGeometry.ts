/**
 * FanoGeometry.ts — Fano plane PG(2,2) mathematics and layout
 *
 * The Fano plane has 7 points and 7 lines, each line through exactly 3 points,
 * each point on exactly 3 lines. This module provides the combinatorial structure
 * and canvas-ready coordinates for rendering.
 */

export interface FanoPoint {
  index: number;
  x: number;
  y: number;
  label: string;
}

export interface FanoLine {
  index: number;
  points: [number, number, number];
}

/**
 * The 7 lines of PG(2,2) — the unique Steiner triple system S(2,3,7).
 */
export const FANO_LINES: FanoLine[] = [
  { index: 0, points: [0, 1, 3] },
  { index: 1, points: [1, 2, 4] },
  { index: 2, points: [2, 3, 5] },
  { index: 3, points: [3, 4, 6] },
  { index: 4, points: [4, 5, 0] },
  { index: 5, points: [5, 6, 1] },
  { index: 6, points: [6, 0, 2] },
];

/**
 * Layout 7 Fano points: 0-5 on hexagon, 6 at center.
 * Returns normalized [0,1] coordinates.
 */
export function computeFanoLayout(
  centerX = 0.5,
  centerY = 0.5,
  radius = 0.35
): FanoPoint[] {
  const labels = [
    'Quadrant-A', 'Quadrant-B', 'Quadrant-C',
    'Triality-A', 'Triality-B', 'Triality-C',
    'ClassIndex',
  ];
  const points: FanoPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((i * 60) - 90) * (Math.PI / 180);
    points.push({
      index: i,
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
      label: labels[i],
    });
  }
  points.push({ index: 6, x: centerX, y: centerY, label: labels[6] });
  return points;
}

export function linesThrough(pointIndex: number): FanoLine[] {
  return FANO_LINES.filter((l) => l.points.includes(pointIndex));
}

export function interpolateOnLine(
  points: FanoPoint[],
  fromIdx: number,
  toIdx: number,
  t: number
): { x: number; y: number } {
  const a = points[fromIdx];
  const b = points[toIdx];
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}
