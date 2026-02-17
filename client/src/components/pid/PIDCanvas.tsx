/**
 * P&ID Canvas — SVG rendering engine with pan/zoom
 *
 * Renders a P&ID diagram from a JSON scene graph.
 * Custom pan/zoom implementation using pointer events + wheel.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PIDDiagram, PIDSymbol, PipeConnection, OperationalState } from '@shared/types/pid';
import { PIDAnimationStyles } from './PIDAnimations';
import { usePIDData } from './PIDDataBinding';
import { Valve, Pump, Tank, Instrument, Motor, HeatExchanger, Pipe, Junction } from './symbols';

// =============================================================================
// TYPES
// =============================================================================

interface PIDCanvasProps {
  diagram: PIDDiagram;
  /** Currently selected symbol ID */
  selectedId?: string | null;
  /** Callback when a symbol is clicked */
  onSymbolClick?: (symbolId: string) => void;
  /** Callback when canvas background is clicked */
  onCanvasClick?: () => void;
  /** Show grid */
  showGrid?: boolean;
  /** Interactive mode (pan/zoom enabled) */
  interactive?: boolean;
  /** Class name */
  className?: string;
}

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

// =============================================================================
// GRID
// =============================================================================

const Grid: React.FC<{ size: number; canvasWidth: number; canvasHeight: number }> = ({
  size, canvasWidth, canvasHeight,
}) => {
  const lines: React.ReactNode[] = [];
  for (let x = 0; x <= canvasWidth; x += size) {
    lines.push(
      <line key={`v${x}`} x1={x} y1={0} x2={x} y2={canvasHeight}
        stroke="#e2e8f0" strokeWidth={0.5} />
    );
  }
  for (let y = 0; y <= canvasHeight; y += size) {
    lines.push(
      <line key={`h${y}`} x1={0} y1={y} x2={canvasWidth} y2={y}
        stroke="#e2e8f0" strokeWidth={0.5} />
    );
  }
  return <g className="pid-grid">{lines}</g>;
};

// =============================================================================
// SYMBOL RENDERER
// =============================================================================

function getOperationalState(symbol: PIDSymbol, values: Record<string, any>): OperationalState {
  const binding = symbol.dataBinding?.tags?.find(t => t.property === 'state');
  if (binding && values[binding.tagId]) {
    const v = values[binding.tagId];
    if (v.alarmState === 'alarm' || v.alarmState === 'high-high' || v.alarmState === 'low-low') return 'alarm';
    if (v.alarmState === 'warning' || v.alarmState === 'high' || v.alarmState === 'low') return 'maintenance';
    if (v.value === false || v.value === 0 || v.value === 'stopped') return 'stopped';
  }
  return 'running';
}

function getDisplayValue(symbol: PIDSymbol, values: Record<string, any>): string | undefined {
  const binding = symbol.dataBinding?.tags?.find(t => t.property === 'value');
  if (!binding || !values[binding.tagId]) return undefined;
  const v = values[binding.tagId];
  const num = typeof v.value === 'number' ? v.value.toFixed(1) : String(v.value);
  return binding.units ? `${num} ${binding.units}` : num;
}

function getLevelValue(symbol: PIDSymbol, values: Record<string, any>): number | undefined {
  const binding = symbol.dataBinding?.tags?.find(t => t.property === 'level');
  if (!binding || !values[binding.tagId]) return undefined;
  return typeof values[binding.tagId].value === 'number' ? values[binding.tagId].value : undefined;
}

const SymbolRenderer: React.FC<{
  symbol: PIDSymbol;
  selected: boolean;
  onClick?: () => void;
  values: Record<string, any>;
}> = ({ symbol, selected, onClick, values }) => {
  const state = getOperationalState(symbol, values);
  const displayValue = getDisplayValue(symbol, values);
  const { position, rotation, scale } = symbol.transform;

  const common = {
    x: position.x,
    y: position.y,
    rotation: rotation ?? 0,
    state,
    label: symbol.label,
    tagNumber: symbol.tagNumber,
    value: displayValue,
    onClick,
    selected,
  };

  switch (symbol.type) {
    case 'valve':
      return <Valve {...common} variant={symbol.variant} size={symbol.size?.width ?? 40} />;
    case 'pump':
      return <Pump {...common} variant={symbol.variant} size={symbol.size?.width ?? 44} />;
    case 'tank': {
      const level = getLevelValue(symbol, values);
      return <Tank {...common} variant={symbol.variant}
        width={symbol.size?.width ?? 60} height={symbol.size?.height ?? 80}
        level={level} />;
    }
    case 'instrument':
      return <Instrument {...common}
        functionLetters={symbol.functionLetters}
        loopNumber={symbol.loopNumber}
        connectionType={symbol.connectionType}
        location={symbol.location}
        size={symbol.size?.width ?? 36} />;
    case 'motor':
      return <Motor {...common} rating={symbol.rating} size={symbol.size?.width ?? 36} />;
    case 'heat-exchanger':
      return <HeatExchanger {...common} exchangerType={symbol.exchangerType} size={symbol.size?.width ?? 50} />;
    case 'pipe':
      return <Pipe points={symbol.points} showFlow={symbol.showFlow} spec={symbol.spec}
        state={state} selected={selected} onClick={onClick} />;
    case 'junction':
      return <Junction {...common} variant={symbol.variant} size={symbol.size?.width ?? 20} />;
    default:
      return null;
  }
};

// =============================================================================
// CONNECTION RENDERER
// =============================================================================

const ConnectionRenderer: React.FC<{
  connection: PipeConnection;
  symbols: PIDSymbol[];
  values: Record<string, any>;
}> = ({ connection, symbols, values }) => {
  const fromSymbol = symbols.find(s => s.id === connection.from.symbolId);
  const toSymbol = symbols.find(s => s.id === connection.to.symbolId);
  if (!fromSymbol || !toSymbol) return null;

  // Build point list from source → waypoints → target
  const points = [
    fromSymbol.transform.position,
    ...(connection.waypoints ?? []),
    toSymbol.transform.position,
  ];

  return (
    <Pipe
      points={points}
      showFlow={connection.showFlow}
      spec={connection.spec}
      lineStyle={connection.lineStyle}
      state="running"
    />
  );
};

// =============================================================================
// CANVAS
// =============================================================================

export const PIDCanvas: React.FC<PIDCanvasProps> = ({
  diagram,
  selectedId,
  onSymbolClick,
  onCanvasClick,
  showGrid = true,
  interactive = true,
  className,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  const { values } = usePIDData();

  // Subscribe to all tags in the diagram
  const { subscribe, unsubscribe } = usePIDData();
  useEffect(() => {
    const tagIds = new Set<string>();
    diagram.symbols.forEach(s => {
      s.dataBinding?.tags?.forEach(t => tagIds.add(t.tagId));
    });
    diagram.connections.forEach(c => {
      c.dataBinding?.tags?.forEach(t => tagIds.add(t.tagId));
    });
    const tags = Array.from(tagIds);
    if (tags.length > 0) subscribe(tags);
    return () => { if (tags.length > 0) unsubscribe(tags); };
  }, [diagram, subscribe, unsubscribe]);

  // Pan handlers
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!interactive || e.button !== 0) return;
    // Only pan if clicking on canvas background
    if ((e.target as Element).closest('.pid-symbol')) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [interactive, view.x, view.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning) return;
    setView(v => ({
      ...v,
      x: panStart.current.vx + (e.clientX - panStart.current.x),
      y: panStart.current.vy + (e.clientY - panStart.current.y),
    }));
  }, [isPanning]);

  const handlePointerUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Zoom handler
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!interactive) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setView(v => {
      const newScale = Math.max(0.1, Math.min(5, v.scale * delta));
      // Zoom toward cursor
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { ...v, scale: newScale };
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      return {
        x: cx - (cx - v.x) * (newScale / v.scale),
        y: cy - (cy - v.y) * (newScale / v.scale),
        scale: newScale,
      };
    });
  }, [interactive]);

  // Fit diagram
  const fitToView = useCallback(() => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = rect.width / diagram.canvasSize.width;
    const scaleY = rect.height / diagram.canvasSize.height;
    const scale = Math.min(scaleX, scaleY) * 0.9;
    setView({
      x: (rect.width - diagram.canvasSize.width * scale) / 2,
      y: (rect.height - diagram.canvasSize.height * scale) / 2,
      scale,
    });
  }, [diagram.canvasSize]);

  // Fit on first render
  useEffect(() => { fitToView(); }, [fitToView]);

  // Sort symbols by zIndex
  const sortedSymbols = [...diagram.symbols].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  return (
    <svg
      ref={svgRef}
      className={className}
      width="100%"
      height="100%"
      style={{ background: '#fafafa', cursor: isPanning ? 'grabbing' : 'grab' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onClick={(e) => {
        if (!(e.target as Element).closest('.pid-symbol')) {
          onCanvasClick?.();
        }
      }}
    >
      <PIDAnimationStyles />

      <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
        {/* Grid */}
        {showGrid && (
          <Grid
            size={diagram.gridSize ?? 20}
            canvasWidth={diagram.canvasSize.width}
            canvasHeight={diagram.canvasSize.height}
          />
        )}

        {/* Connections (pipes between symbols) */}
        {diagram.connections.map(conn => (
          <ConnectionRenderer
            key={conn.id}
            connection={conn}
            symbols={diagram.symbols}
            values={values}
          />
        ))}

        {/* Symbols */}
        {sortedSymbols.map(symbol => (
          <g key={symbol.id} className="pid-symbol">
            <SymbolRenderer
              symbol={symbol}
              selected={selectedId === symbol.id}
              onClick={() => onSymbolClick?.(symbol.id)}
              values={values}
            />
          </g>
        ))}
      </g>

      {/* Zoom controls */}
      {interactive && (
        <g transform="translate(10, 10)">
          <g onClick={() => setView(v => ({ ...v, scale: Math.min(5, v.scale * 1.2) }))}
            style={{ cursor: 'pointer' }}>
            <rect width={28} height={28} rx={4} fill="white" stroke="#d1d5db" />
            <text x={14} y={18} textAnchor="middle" fontSize={16} fill="#374151">+</text>
          </g>
          <g transform="translate(0, 32)"
            onClick={() => setView(v => ({ ...v, scale: Math.max(0.1, v.scale * 0.8) }))}
            style={{ cursor: 'pointer' }}>
            <rect width={28} height={28} rx={4} fill="white" stroke="#d1d5db" />
            <text x={14} y={18} textAnchor="middle" fontSize={16} fill="#374151">−</text>
          </g>
          <g transform="translate(0, 64)" onClick={fitToView} style={{ cursor: 'pointer' }}>
            <rect width={28} height={28} rx={4} fill="white" stroke="#d1d5db" />
            <text x={14} y={17} textAnchor="middle" fontSize={11} fill="#374151">⊡</text>
          </g>
        </g>
      )}
    </svg>
  );
};

export default PIDCanvas;
