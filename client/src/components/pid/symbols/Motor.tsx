/**
 * ISA-5.1 Motor Symbol
 *
 * Circle with 'M' designation
 */

import React from 'react';
import type { OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface MotorProps {
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  state?: OperationalState;
  label?: string;
  tagNumber?: string;
  rating?: string;
  value?: string;
  onClick?: () => void;
  selected?: boolean;
}

export const Motor: React.FC<MotorProps> = ({
  x = 0, y = 0, size = 36, rotation = 0,
  state = 'running', label, tagNumber, rating, value,
  onClick, selected,
}) => {
  const color = getStateColor(state);
  const r = size / 2;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotation})`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {selected && (
        <circle cx={0} cy={0} r={r + 5} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 2" />
      )}

      <circle cx={0} cy={0} r={r} fill="white" stroke={color} strokeWidth={2} />

      <text x={0} y={2} textAnchor="middle" dominantBaseline="middle"
        fontSize={r * 0.7} fill={color} fontWeight="bold" fontFamily="sans-serif">
        M
      </text>

      {/* Connection stub */}
      <line x1={-r} y1={0} x2={-r - 12} y2={0} stroke={color} strokeWidth={2} />

      {tagNumber && (
        <text x={0} y={r + 14} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
          {tagNumber}
        </text>
      )}
      {label && (
        <text x={0} y={-r - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">{label}</text>
      )}
      {rating && (
        <text x={r + 6} y={4} textAnchor="start" fontSize={8} fill="#94a3b8">{rating}</text>
      )}
      {value && (
        <text x={0} y={r + 26} textAnchor="middle" fontSize={9} fill={color} fontWeight="bold">{value}</text>
      )}
    </g>
  );
};

export default Motor;
