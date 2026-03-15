/**
 * ChantHandler.ts — Operator interaction for the Living Fano dashboard
 *
 * Inspired by ShinVaelNoctis's chant input system. Maps keyboard/mouse
 * interactions to display mode changes:
 *
 *   Click point  → zoom into SGA class detail
 *   Hover line   → highlight integration path
 *   'r'          → reflective mode (show ghost code markers)
 *   't'          → temporal mode (historical views)
 *   'a'          → attention mode (suppress healthy, amplify anomalies)
 *   'c'          → calm mode (minimal animation)
 *   Escape       → return to default mode
 *
 * @see ADR-0025
 * @closes #391
 */

import { FanoPoint, FANO_LINES, FanoLine, linesThrough } from './FanoGeometry';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DisplayMode = 'default' | 'reflective' | 'temporal' | 'attention' | 'calm';
export type TemporalWindow = '1h' | '8h' | '24h';

export interface InteractionState {
  mode: DisplayMode;
  /** Currently hovered point index, or -1 */
  hoveredPoint: number;
  /** Currently hovered line index, or -1 */
  hoveredLine: number;
  /** Currently selected (clicked) point index, or -1 */
  selectedPoint: number;
  /** Temporal mode window */
  temporalWindow: TemporalWindow;
  /** Whether reduced motion is enabled (accessibility) */
  reducedMotion: boolean;
}

export interface ChantEvent {
  type: 'mode_change' | 'point_select' | 'point_hover' | 'line_hover' | 'temporal_change';
  state: InteractionState;
  timestamp: number;
}

export type ChantListener = (event: ChantEvent) => void;

// ─── Hit Testing ────────────────────────────────────────────────────────────

const POINT_HIT_RADIUS = 25; // px
const LINE_HIT_DISTANCE = 8; // px

function distToPoint(mx: number, my: number, px: number, py: number): number {
  return Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
}

function distToLineSegment(
  mx: number, my: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distToPoint(mx, my, x1, y1);

  let t = ((mx - x1) * dx + (my - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return distToPoint(mx, my, projX, projY);
}

// ─── Chant Handler ──────────────────────────────────────────────────────────

export class ChantHandler {
  private state: InteractionState;
  private listeners: ChantListener[] = [];
  private points: FanoPoint[] = [];
  private canvasWidth = 400;
  private canvasHeight = 400;

  /** Keyboard handler bound reference (for cleanup) */
  private boundKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    this.state = {
      mode: 'default',
      hoveredPoint: -1,
      hoveredLine: -1,
      selectedPoint: -1,
      temporalWindow: '1h',
      reducedMotion: false,
    };
  }

  // ─── Setup / Teardown ───────────────────────────────────────────

  /**
   * Attach to a canvas element. Registers keyboard and mouse listeners.
   */
  attach(
    canvas: HTMLCanvasElement,
    points: FanoPoint[],
    width: number,
    height: number,
  ): void {
    this.points = points;
    this.canvasWidth = width;
    this.canvasHeight = height;

    // Check prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    canvas.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('click', this.handleClick);
    canvas.addEventListener('mouseleave', this.handleMouseLeave);

    // Touch support for control room touchscreens
    canvas.addEventListener('touchstart', this.handleTouch, { passive: true });

    this.boundKeyHandler = this.handleKeydown;
    document.addEventListener('keydown', this.boundKeyHandler);
  }

  /**
   * Detach all listeners. Call on component unmount.
   */
  detach(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener('mousemove', this.handleMouseMove);
    canvas.removeEventListener('click', this.handleClick);
    canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    canvas.removeEventListener('touchstart', this.handleTouch);

    if (this.boundKeyHandler) {
      document.removeEventListener('keydown', this.boundKeyHandler);
      this.boundKeyHandler = null;
    }
  }

  // ─── Event Handlers ─────────────────────────────────────────────

  private handleMouseMove = (e: MouseEvent): void => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Hit test points
    const hitPoint = this.hitTestPoint(mx, my);
    // Hit test lines
    const hitLine = hitPoint === -1 ? this.hitTestLine(mx, my) : -1;

    let changed = false;

    if (hitPoint !== this.state.hoveredPoint) {
      this.state.hoveredPoint = hitPoint;
      changed = true;
      if (hitPoint >= 0) {
        this.emit({ type: 'point_hover', state: this.getState(), timestamp: Date.now() });
      }
    }

    if (hitLine !== this.state.hoveredLine) {
      this.state.hoveredLine = hitLine;
      changed = true;
      if (hitLine >= 0) {
        this.emit({ type: 'line_hover', state: this.getState(), timestamp: Date.now() });
      }
    }

    // Update cursor
    if (changed) {
      (e.target as HTMLCanvasElement).style.cursor = hitPoint >= 0 ? 'pointer' : 'default';
    }
  };

  private handleClick = (e: MouseEvent): void => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hitPoint = this.hitTestPoint(mx, my);

    if (hitPoint >= 0) {
      // Toggle selection: click same point again to deselect
      this.state.selectedPoint = this.state.selectedPoint === hitPoint ? -1 : hitPoint;
      this.emit({ type: 'point_select', state: this.getState(), timestamp: Date.now() });
    } else {
      // Click empty space: deselect
      if (this.state.selectedPoint >= 0) {
        this.state.selectedPoint = -1;
        this.emit({ type: 'point_select', state: this.getState(), timestamp: Date.now() });
      }
    }
  };

  private handleMouseLeave = (): void => {
    this.state.hoveredPoint = -1;
    this.state.hoveredLine = -1;
  };

  private handleTouch = (e: TouchEvent): void => {
    if (e.touches.length === 0) return;
    const touch = e.touches[0];
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = touch.clientX - rect.left;
    const my = touch.clientY - rect.top;

    const hitPoint = this.hitTestPoint(mx, my);
    if (hitPoint >= 0) {
      this.state.selectedPoint = this.state.selectedPoint === hitPoint ? -1 : hitPoint;
      this.emit({ type: 'point_select', state: this.getState(), timestamp: Date.now() });
    }
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    // Don't capture when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key.toLowerCase()) {
      case 'r':
        this.setMode(this.state.mode === 'reflective' ? 'default' : 'reflective');
        break;
      case 't':
        if (this.state.mode === 'temporal') {
          // Cycle through temporal windows
          this.cycleTemporalWindow();
        } else {
          this.setMode('temporal');
        }
        break;
      case 'a':
        this.setMode(this.state.mode === 'attention' ? 'default' : 'attention');
        break;
      case 'c':
        this.setMode(this.state.mode === 'calm' ? 'default' : 'calm');
        break;
      case 'escape':
        this.setMode('default');
        this.state.selectedPoint = -1;
        break;
      default:
        return; // Don't prevent default for unhandled keys
    }

    e.preventDefault();
  };

  // ─── Mode Management ────────────────────────────────────────────

  setMode(mode: DisplayMode): void {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.emit({ type: 'mode_change', state: this.getState(), timestamp: Date.now() });
  }

  private cycleTemporalWindow(): void {
    const windows: TemporalWindow[] = ['1h', '8h', '24h'];
    const idx = windows.indexOf(this.state.temporalWindow);
    this.state.temporalWindow = windows[(idx + 1) % windows.length];
    this.emit({ type: 'temporal_change', state: this.getState(), timestamp: Date.now() });
  }

  // ─── Hit Testing ────────────────────────────────────────────────

  private hitTestPoint(mx: number, my: number): number {
    for (let i = 0; i < this.points.length; i++) {
      const px = this.points[i].x * this.canvasWidth;
      const py = this.points[i].y * this.canvasHeight;
      if (distToPoint(mx, my, px, py) < POINT_HIT_RADIUS) return i;
    }
    return -1;
  }

  private hitTestLine(mx: number, my: number): number {
    for (let li = 0; li < FANO_LINES.length; li++) {
      const [a, b, c] = FANO_LINES[li].points;
      const ax = this.points[a].x * this.canvasWidth;
      const ay = this.points[a].y * this.canvasHeight;
      const bx = this.points[b].x * this.canvasWidth;
      const by = this.points[b].y * this.canvasHeight;
      const cx = this.points[c].x * this.canvasWidth;
      const cy = this.points[c].y * this.canvasHeight;

      // Check distance to both segments of the line (a→b and b→c)
      const d1 = distToLineSegment(mx, my, ax, ay, bx, by);
      const d2 = distToLineSegment(mx, my, bx, by, cx, cy);
      if (Math.min(d1, d2) < LINE_HIT_DISTANCE) return li;
    }
    return -1;
  }

  // ─── Visual Modifiers ───────────────────────────────────────────

  /**
   * Get visual modifiers for the current interaction state.
   * The rendering loop reads these to adjust visuals.
   */
  getVisualModifiers(): {
    pointOpacity: number[];
    pointScale: number[];
    lineOpacity: number[];
    lineHighlight: number[];
    showGhostMarkers: boolean;
    animationSpeed: number;
    showTemporalOverlay: boolean;
    temporalWindow: TemporalWindow;
  } {
    const pointOpacity = new Array(7).fill(1);
    const pointScale = new Array(7).fill(1);
    const lineOpacity = new Array(7).fill(1);
    const lineHighlight = new Array(7).fill(0);

    // Mode-specific modifiers
    switch (this.state.mode) {
      case 'attention':
        // Suppress healthy, amplify anomalies — handled by renderer reading bloom health
        for (let i = 0; i < 7; i++) {
          pointOpacity[i] = 0.3; // Dim everything, renderer will boost anomalies
        }
        break;

      case 'calm':
        // Minimal animation
        break;

      case 'reflective':
        // Show ghost code markers (correlation coefficients, prediction confidence)
        break;
    }

    // Hover highlights
    if (this.state.hoveredPoint >= 0) {
      pointScale[this.state.hoveredPoint] = 1.3;
      // Highlight lines through this point
      const lines = linesThrough(this.state.hoveredPoint);
      for (const line of lines) {
        lineHighlight[line.index] = 1;
      }
    }

    if (this.state.hoveredLine >= 0) {
      lineHighlight[this.state.hoveredLine] = 1;
      // Highlight points on this line
      const [a, b, c] = FANO_LINES[this.state.hoveredLine].points;
      pointScale[a] = 1.2;
      pointScale[b] = 1.2;
      pointScale[c] = 1.2;
    }

    // Selected point: strong highlight
    if (this.state.selectedPoint >= 0) {
      pointScale[this.state.selectedPoint] = 1.5;
      pointOpacity[this.state.selectedPoint] = 1;
    }

    return {
      pointOpacity,
      pointScale,
      lineOpacity,
      lineHighlight,
      showGhostMarkers: this.state.mode === 'reflective',
      animationSpeed: this.state.mode === 'calm' ? 0.2 : this.state.reducedMotion ? 0.3 : 1.0,
      showTemporalOverlay: this.state.mode === 'temporal',
      temporalWindow: this.state.temporalWindow,
    };
  }

  // ─── Listeners ──────────────────────────────────────────────────

  onChant(listener: ChantListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: ChantEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ─── State Access ───────────────────────────────────────────────

  getState(): InteractionState {
    return { ...this.state };
  }

  getMode(): DisplayMode {
    return this.state.mode;
  }

  getSelectedPoint(): number {
    return this.state.selectedPoint;
  }

  getHoveredPoint(): number {
    return this.state.hoveredPoint;
  }

  getHoveredLine(): number {
    return this.state.hoveredLine;
  }
}
