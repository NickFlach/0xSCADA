/**
 * P&ID Animations
 *
 * Flow animations, state-based colors, level animations.
 */

import React from 'react';
import type { OperationalState, AlarmState } from '@shared/types/pid';

// =============================================================================
// STATE COLORS
// =============================================================================

const STATE_COLORS: Record<OperationalState, string> = {
  running: '#22c55e',    // green
  stopped: '#6b7280',    // gray
  alarm: '#ef4444',      // red
  maintenance: '#f59e0b', // amber
  offline: '#9ca3af',    // light gray
};

const ALARM_COLORS: Record<AlarmState, string> = {
  normal: '#22c55e',
  low: '#f59e0b',
  high: '#f59e0b',
  'low-low': '#ef4444',
  'high-high': '#ef4444',
  alarm: '#ef4444',
  warning: '#f59e0b',
};

export function getStateColor(state: OperationalState = 'running'): string {
  return STATE_COLORS[state] ?? '#6b7280';
}

export function getAlarmColor(alarm: AlarmState = 'normal'): string {
  return ALARM_COLORS[alarm] ?? '#22c55e';
}

// =============================================================================
// CSS ANIMATIONS (inject into SVG)
// =============================================================================

export const FLOW_ANIMATION_CSS = `
  @keyframes pid-flow {
    from { stroke-dashoffset: 18; }
    to { stroke-dashoffset: 0; }
  }
  .pid-flow-line {
    animation: pid-flow 0.8s linear infinite;
  }
  @keyframes pid-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .pid-alarm-blink {
    animation: pid-blink 1s ease-in-out infinite;
  }
  @keyframes pid-level-fill {
    from { opacity: 0.3; }
    to { opacity: 0.7; }
  }
`;

// =============================================================================
// ANIMATION STYLE PROVIDER
// =============================================================================

/**
 * Injects CSS keyframe animations into an SVG <defs> block.
 * Place this inside the root <svg> element.
 */
export const PIDAnimationStyles: React.FC = () => (
  <defs>
    <style>{FLOW_ANIMATION_CSS}</style>
  </defs>
);

// =============================================================================
// ANIMATED LEVEL (for tank fill)
// =============================================================================

interface AnimatedLevelProps {
  level: number; // 0-100
  width: number;
  height: number;
  x: number;
  y: number;
  color?: string;
}

export const AnimatedLevel: React.FC<AnimatedLevelProps> = ({
  level, width, height, x, y, color = '#3b82f6',
}) => {
  const fillHeight = (height * Math.min(100, Math.max(0, level))) / 100;
  const fillY = y + height - fillHeight;

  return (
    <rect
      x={x} y={fillY}
      width={width} height={fillHeight}
      fill={color} opacity={0.25}
      style={{ transition: 'y 0.5s ease, height 0.5s ease' }}
    />
  );
};

export default PIDAnimationStyles;
