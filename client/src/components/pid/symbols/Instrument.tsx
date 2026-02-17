/**
 * ISA-5.1 Instrument Symbol
 *
 * Circle with function letters and tag number.
 * Connection types shown via line style to process.
 * Location shown via horizontal line (field vs control room).
 */

import React from 'react';
import type { InstrumentConnectionType, OperationalState } from '@shared/types/pid';
import { getStateColor } from '../PIDAnimations';

interface InstrumentProps {
  functionLetters: string;
  loopNumber?: string;
  connectionType?: InstrumentConnectionType;
  location?: 'field' | 'control-room' | 'local-panel';
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  state?: OperationalState;
  value?: string;
  onClick?: () => void;
  selected?: boolean;
}

export const Instrument: React.FC<InstrumentProps> = ({
  functionLetters,
  loopNumber,
  connectionType = 'electric',
  location = 'field',
  x = 0,
  y = 0,
  size = 36,
  rotation = 0,
  state = 'running',
  value,
  onClick,
  selected,
}) => {
  const color = getStateColor(state);
  const r = size / 2;

  // ISA-5.1: dashed line for control room, solid for field, dashed+solid for local panel
  const showDivider = location === 'control-room' || location === 'local-panel';

  // Connection line style
  const connectionDash = connectionType === 'pneumatic' ? '8 3'
    : connectionType === 'software' ? '2 2'
    : connectionType === 'capillary' ? '1 3'
    : connectionType === 'hydraulic' ? '6 2 2 2'
    : undefined;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotation})`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {selected && (
        <circle cx={0} cy={0} r={r + 5} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 2" />
      )}

      {/* Main circle — ISA balloon */}
      <circle cx={0} cy={0} r={r} fill="white" stroke={color} strokeWidth={2} />

      {/* Horizontal divider for control room instruments */}
      {showDivider && (
        <line
          x1={-r} y1={0} x2={r} y2={0}
          stroke={color} strokeWidth={1}
          strokeDasharray={location === 'control-room' ? '4 2' : undefined}
        />
      )}

      {/* Function letters (top half) */}
      <text x={0} y={showDivider ? -4 : 2} textAnchor="middle" dominantBaseline="middle"
        fontSize={r * 0.55} fill={color} fontWeight="bold" fontFamily="monospace">
        {functionLetters}
      </text>

      {/* Loop number (bottom half if divider, otherwise below letters) */}
      {loopNumber && (
        <text x={0} y={showDivider ? r * 0.5 : r * 0.55} textAnchor="middle" dominantBaseline="middle"
          fontSize={r * 0.45} fill="#64748b" fontFamily="monospace">
          {loopNumber}
        </text>
      )}

      {/* Connection line stub */}
      <line
        x1={0} y1={r} x2={0} y2={r + 14}
        stroke={color} strokeWidth={1.5}
        strokeDasharray={connectionDash}
      />

      {/* Value display */}
      {value && (
        <text x={r + 8} y={4} textAnchor="start" fontSize={10} fill={color} fontWeight="bold">
          {value}
        </text>
      )}
    </g>
  );
};

export default Instrument;
