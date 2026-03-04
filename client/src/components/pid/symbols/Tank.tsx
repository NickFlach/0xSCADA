/**
 * ISA-5.1 Tank / Vessel Symbols
 *
 * Variants: open, closed, pressure-vessel
 */

import React from 'react';
import type { TankVariant, OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface TankProps {
  variant: TankVariant;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  state?: OperationalState;
  label?: string;
  tagNumber?: string;
  level?: number; // 0-100
  value?: string;
  onClick?: () => void;
  selected?: boolean;
}

export const Tank: React.FC<TankProps> = ({
  variant,
  x = 0,
  y = 0,
  width = 60,
  height = 80,
  rotation = 0,
  state = 'running',
  label,
  tagNumber,
  level,
  value,
  onClick,
  selected,
}) => {
  const color = getStateColor(state);
  const w = width;
  const h = height;
  const hw = w / 2;
  const hh = h / 2;
  const capR = w * 0.15; // radius for dished heads

  const levelY = level != null ? hh - (h * level) / 100 : undefined;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotation})`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {selected && (
        <rect
          x={-hw - 4} y={-hh - capR - 4} width={w + 8} height={h + capR * 2 + 8}
          fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 2" rx={3}
        />
      )}

      {/* Level fill */}
      {levelY !== undefined && (
        <clipPath id={`tank-clip-${x}-${y}`}>
          <rect x={-hw} y={levelY} width={w} height={hh - levelY} />
        </clipPath>
      )}
      {levelY !== undefined && (
        <rect
          x={-hw} y={-hh} width={w} height={h}
          fill={state === 'alarm' ? '#ef444433' : '#3b82f622'}
          clipPath={`url(#tank-clip-${x}-${y})`}
          rx={(variant as any) === 'pressure-vessel' ? capR : 0}
        />
      )}

      {(variant as any) === 'open' && (
        /* Open tank: U-shape, no top */
        <path
          d={`M${-hw},${-hh} L${-hw},${hh} L${hw},${hh} L${hw},${-hh}`}
          fill="none" stroke={color} strokeWidth={2}
        />
      )}

      {(variant as any) === 'closed' && (
        /* Closed tank: rectangle with flat top */
        <rect
          x={-hw} y={-hh} width={w} height={h}
          fill="none" stroke={color} strokeWidth={2} rx={2}
        />
      )}

      {(variant as any) === 'pressure-vessel' && (
        /* Pressure vessel: rectangle with dished ends */
        <g>
          <path
            d={`M${-hw},${-hh + capR} Q${-hw},${-hh} ${-hw + capR},${-hh}
                L${hw - capR},${-hh} Q${hw},${-hh} ${hw},${-hh + capR}
                L${hw},${hh - capR} Q${hw},${hh} ${hw - capR},${hh}
                L${-hw + capR},${hh} Q${-hw},${hh} ${-hw},${hh - capR} Z`}
            fill="none" stroke={color} strokeWidth={2}
          />
        </g>
      )}

      {/* Nozzle stubs */}
      <line x1={-hw - 10} y1={0} x2={-hw} y2={0} stroke={color} strokeWidth={2} />
      <line x1={hw} y1={0} x2={hw + 10} y2={0} stroke={color} strokeWidth={2} />
      <line x1={0} y1={hh} x2={0} y2={hh + 10} stroke={color} strokeWidth={2} />

      {tagNumber && (
        <text x={0} y={hh + 22} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
          {tagNumber}
        </text>
      )}
      {label && (
        <text x={0} y={-hh - capR - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">{label}</text>
      )}
      {level !== undefined && (
        <text x={0} y={4} textAnchor="middle" fontSize={11} fill={color} fontWeight="bold">
          {level.toFixed(0)}%
        </text>
      )}
      {value && (
        <text x={0} y={hh + 34} textAnchor="middle" fontSize={9} fill={color} fontWeight="bold">{value}</text>
      )}
    </g>
  );
};

export default Tank;
