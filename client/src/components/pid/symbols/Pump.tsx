/**
 * ISA-5.1 Pump Symbols
 *
 * Variants: centrifugal, positive-displacement
 */

import React from 'react';
import type { PumpVariant, OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface PumpProps {
  variant: PumpVariant;
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  state?: OperationalState;
  label?: string;
  tagNumber?: string;
  value?: string;
  onClick?: () => void;
  selected?: boolean;
}

const PUMP_SIZE = 44;

export const Pump: React.FC<PumpProps> = ({
  variant,
  x = 0,
  y = 0,
  size = PUMP_SIZE,
  rotation = 0,
  state = 'running',
  label,
  tagNumber,
  value,
  onClick,
  selected,
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
        <rect
          x={-r - 6} y={-r - 6} width={size + 12} height={size + 12}
          fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 2" rx={3}
        />
      )}

      {/* Inlet */}
      <line x1={-r - 12} y1={0} x2={-r} y2={0} stroke={color} strokeWidth={2} />
      {/* Outlet (top for centrifugal) */}
      <line x1={0} y1={-r} x2={0} y2={-r - 12} stroke={color} strokeWidth={2} />

      {/* Circle body */}
      <circle cx={0} cy={0} r={r} fill="none" stroke={color} strokeWidth={2} />

      {variant === 'centrifugal' ? (
        /* Discharge nozzle arrow */
        <polygon
          points={`${r - 2},${-r * 0.3} ${r + 6},${0} ${r - 2},${r * 0.3}`}
          fill={color}
        />
      ) : (
        /* Positive displacement: + inside circle */
        <g stroke={color} strokeWidth={2}>
          <line x1={-r * 0.4} y1={0} x2={r * 0.4} y2={0} />
          <line x1={0} y1={-r * 0.4} x2={0} y2={r * 0.4} />
        </g>
      )}

      {tagNumber && (
        <text x={0} y={r + 14} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
          {tagNumber}
        </text>
      )}
      {label && (
        <text x={0} y={-r - 8} textAnchor="middle" fontSize={9} fill="#94a3b8">{label}</text>
      )}
      {value && (
        <text x={0} y={r + 26} textAnchor="middle" fontSize={9} fill={color} fontWeight="bold">{value}</text>
      )}
    </g>
  );
};

export default Pump;
