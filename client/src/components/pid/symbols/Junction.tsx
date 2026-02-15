/**
 * Junction Symbol — Tees, elbows, crosses, reducers
 */

import React from 'react';
import type { JunctionVariant, OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface JunctionProps {
  variant: JunctionVariant;
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  state?: OperationalState;
  selected?: boolean;
  onClick?: () => void;
}

export const Junction: React.FC<JunctionProps> = ({
  variant, x = 0, y = 0, size = 20, rotation = 0,
  state = 'running', selected, onClick,
}) => {
  const color = getStateColor(state);
  const h = size / 2;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotation})`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {selected && (
        <circle cx={0} cy={0} r={h + 4} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 2" />
      )}

      {variant === 'tee' && (
        <g stroke={color} strokeWidth={2.5} strokeLinecap="round">
          <line x1={-h} y1={0} x2={h} y2={0} />
          <line x1={0} y1={0} x2={0} y2={h} />
        </g>
      )}

      {variant === 'elbow' && (
        <path d={`M${-h},${0} Q${0},${0} ${0},${h}`} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      )}

      {variant === 'cross' && (
        <g stroke={color} strokeWidth={2.5} strokeLinecap="round">
          <line x1={-h} y1={0} x2={h} y2={0} />
          <line x1={0} y1={-h} x2={0} y2={h} />
        </g>
      )}

      {variant === 'reducer' && (
        <g stroke={color} strokeWidth={2}>
          <line x1={-h} y1={-h * 0.6} x2={h} y2={-h * 0.3} />
          <line x1={-h} y1={h * 0.6} x2={h} y2={h * 0.3} />
          <line x1={-h} y1={-h * 0.6} x2={-h} y2={h * 0.6} />
          <line x1={h} y1={-h * 0.3} x2={h} y2={h * 0.3} />
        </g>
      )}

      {/* Junction dot */}
      <circle cx={0} cy={0} r={3} fill={color} />
    </g>
  );
};

export default Junction;
