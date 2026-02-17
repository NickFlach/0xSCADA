/**
 * ISA-5.1 Heat Exchanger Symbol
 *
 * Shell & tube style: circle with internal S-curve
 */

import React from 'react';
import type { OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface HeatExchangerProps {
  exchangerType?: 'shell-tube' | 'plate' | 'air-cooled';
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

export const HeatExchanger: React.FC<HeatExchangerProps> = ({
  exchangerType = 'shell-tube',
  x = 0, y = 0, size = 50, rotation = 0,
  state = 'running', label, tagNumber, value,
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

      {/* Shell */}
      <circle cx={0} cy={0} r={r} fill="none" stroke={color} strokeWidth={2} />

      {exchangerType === 'shell-tube' && (
        <>
          {/* Tube side S-curve */}
          <path
            d={`M${-r},${0} Q${-r * 0.3},${-r * 0.6} ${0},${0} Q${r * 0.3},${r * 0.6} ${r},${0}`}
            fill="none" stroke={color} strokeWidth={1.5}
          />
          {/* Shell side nozzles */}
          <line x1={0} y1={-r} x2={0} y2={-r - 12} stroke={color} strokeWidth={2} />
          <line x1={0} y1={r} x2={0} y2={r + 12} stroke={color} strokeWidth={2} />
        </>
      )}

      {exchangerType === 'plate' && (
        <>
          {/* Parallel lines inside */}
          <line x1={-r * 0.5} y1={-r * 0.5} x2={-r * 0.5} y2={r * 0.5} stroke={color} strokeWidth={1.5} />
          <line x1={0} y1={-r * 0.5} x2={0} y2={r * 0.5} stroke={color} strokeWidth={1.5} />
          <line x1={r * 0.5} y1={-r * 0.5} x2={r * 0.5} y2={r * 0.5} stroke={color} strokeWidth={1.5} />
        </>
      )}

      {exchangerType === 'air-cooled' && (
        /* Fan symbol on top */
        <>
          <line x1={-r * 0.4} y1={-r * 0.7} x2={r * 0.4} y2={-r * 0.3} stroke={color} strokeWidth={1.5} />
          <line x1={r * 0.4} y1={-r * 0.7} x2={-r * 0.4} y2={-r * 0.3} stroke={color} strokeWidth={1.5} />
        </>
      )}

      {/* Tube nozzles */}
      <line x1={-r - 12} y1={0} x2={-r} y2={0} stroke={color} strokeWidth={2} />
      <line x1={r} y1={0} x2={r + 12} y2={0} stroke={color} strokeWidth={2} />

      {tagNumber && (
        <text x={0} y={r + 16} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
          {tagNumber}
        </text>
      )}
      {label && (
        <text x={0} y={-r - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">{label}</text>
      )}
      {value && (
        <text x={0} y={r + 28} textAnchor="middle" fontSize={9} fill={color} fontWeight="bold">{value}</text>
      )}
    </g>
  );
};

export default HeatExchanger;
