/**
 * Pipe Symbol — Lines with optional flow direction arrows
 */

import React from 'react';
import type { Point, OperationalState } from '@shared/types/pid';
import { getStateColor, FLOW_ANIMATION_CSS } from '../PIDAnimations';

interface PipeProps {
  points: Point[];
  showFlow?: boolean;
  spec?: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  state?: OperationalState;
  selected?: boolean;
  onClick?: () => void;
}

export const Pipe: React.FC<PipeProps> = ({
  points,
  showFlow = false,
  spec,
  lineStyle = 'solid',
  state = 'running',
  selected,
  onClick,
}) => {
  if (points.length < 2) return null;

  const color = getStateColor(state);
  const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  const dashArray = lineStyle === 'dashed' ? '8 4' : lineStyle === 'dotted' ? '2 4' : undefined;

  // Place flow arrows at midpoints of each segment
  const arrows: React.ReactNode[] = [];
  if (showFlow && state === 'running') {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
      arrows.push(
        <polygon
          key={`arrow-${i}`}
          points="-5,-4 5,0 -5,4"
          transform={`translate(${mx},${my}) rotate(${angle})`}
          fill={color}
        />
      );
    }
  }

  // Unique ID for animated dash
  const animId = `pipe-flow-${points[0]?.x}-${points[0]?.y}`;

  return (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      {/* Selection highlight */}
      {selected && (
        <path d={pathData} fill="none" stroke="#3b82f6" strokeWidth={8} strokeLinecap="round" opacity={0.3} />
      )}

      {/* Main pipe line */}
      <path
        d={pathData}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={showFlow && state === 'running' ? '12 6' : dashArray}
        className={showFlow && state === 'running' ? 'pid-flow-line' : undefined}
      />

      {/* Flow arrows */}
      {arrows}

      {/* Spec label at midpoint */}
      {spec && points.length >= 2 && (
        <text
          x={(points[0].x + points[points.length - 1].x) / 2}
          y={(points[0].y + points[points.length - 1].y) / 2 - 8}
          textAnchor="middle" fontSize={8} fill="#94a3b8"
        >
          {spec}
        </text>
      )}
    </g>
  );
};

export default Pipe;
