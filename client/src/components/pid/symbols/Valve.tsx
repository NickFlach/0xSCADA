/**
 * ISA-5.1 Valve Symbols
 *
 * Variants: gate, globe, ball, butterfly, check, relief
 * Standard proportions per ISA-5.1
 */

import React from 'react';
import type { ValveVariant, OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface ValveProps {
  variant: ValveVariant;
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

const VALVE_SIZE = 40;

/** Two-triangle gate valve body */
function GateValveBody({ s }: { s: number }) {
  const h = s / 2;
  return (
    <g>
      {/* Left triangle */}
      <polygon
        points={`${-h},${-h} ${-h},${h} ${0},${0}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      {/* Right triangle */}
      <polygon
        points={`${h},${-h} ${h},${h} ${0},${0}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
    </g>
  );
}

/** Globe valve — gate valve + horizontal bar */
function GlobeValveBody({ s }: { s: number }) {
  const h = s / 2;
  return (
    <g>
      <GateValveBody s={s} />
      <line x1={-h * 0.6} y1={0} x2={h * 0.6} y2={0} stroke="currentColor" strokeWidth={2} />
    </g>
  );
}

/** Ball valve — gate valve body with filled circle */
function BallValveBody({ s }: { s: number }) {
  return (
    <g>
      <GateValveBody s={s} />
      <circle cx={0} cy={0} r={s * 0.15} fill="currentColor" />
    </g>
  );
}

/** Butterfly valve — circle with line through center */
function ButterflyValveBody({ s }: { s: number }) {
  const r = s / 2;
  return (
    <g>
      <circle cx={0} cy={0} r={r} fill="none" stroke="currentColor" strokeWidth={2} />
      <line x1={0} y1={-r} x2={0} y2={r} stroke="currentColor" strokeWidth={2} />
    </g>
  );
}

/** Check valve — gate body with one triangle filled */
function CheckValveBody({ s }: { s: number }) {
  const h = s / 2;
  return (
    <g>
      <polygon
        points={`${-h},${-h} ${-h},${h} ${0},${0}`}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={2}
        opacity={0.3}
      />
      <polygon
        points={`${h},${-h} ${h},${h} ${0},${0}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      {/* Check direction arrow */}
      <line x1={h * 0.3} y1={-h * 0.6} x2={h * 0.3} y2={h * 0.6} stroke="currentColor" strokeWidth={2} />
    </g>
  );
}

/** Relief/Safety valve — spring loaded */
function ReliefValveBody({ s }: { s: number }) {
  const h = s / 2;
  return (
    <g>
      <GateValveBody s={s} />
      {/* Spring symbol on top */}
      <polyline
        points={`${0},${-h} ${-h * 0.3},${-h - 4} ${h * 0.3},${-h - 8} ${-h * 0.3},${-h - 12} ${0},${-h - 16}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      {/* Arrow pointing up */}
      <polygon
        points={`${0},${-h - 20} ${-3},${-h - 16} ${3},${-h - 16}`}
        fill="currentColor"
      />
    </g>
  );
}

const BODY_MAP: any = {
  gate: GateValveBody,
  globe: GlobeValveBody,
  ball: BallValveBody,
  butterfly: ButterflyValveBody,
  check: CheckValveBody,
  relief: ReliefValveBody,
};

export const Valve: React.FC<ValveProps> = ({
  variant,
  x = 0,
  y = 0,
  size = VALVE_SIZE,
  rotation = 0,
  state = 'running',
  label,
  tagNumber,
  value,
  onClick,
  selected,
}) => {
  const Body = BODY_MAP[variant];
  const color = getStateColor(state);
  const h = size / 2;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotation})`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', color }}
    >
      {/* Selection highlight */}
      {selected && (
        <rect
          x={-h - 4}
          y={-h - 4}
          width={size + 8}
          height={size + 8}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeDasharray="4 2"
          rx={3}
        />
      )}

      {/* Connection stubs */}
      <line x1={-h - 10} y1={0} x2={-h} y2={0} stroke={color} strokeWidth={2} />
      <line x1={h} y1={0} x2={h + 10} y2={0} stroke={color} strokeWidth={2} />

      {/* Valve body */}
      <Body s={size} />

      {/* Tag number */}
      {tagNumber && (
        <text x={0} y={h + 14} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
          {tagNumber}
        </text>
      )}

      {/* Label */}
      {label && (
        <text x={0} y={-h - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
          {label}
        </text>
      )}

      {/* Live value */}
      {value && (
        <text x={0} y={h + 26} textAnchor="middle" fontSize={9} fill={color} fontWeight="bold">
          {value}
        </text>
      )}
    </g>
  );
};

export default Valve;
