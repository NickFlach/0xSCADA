/**
 * P&ID Editor — Drag-drop editor with symbol palette
 *
 * Symbol palette sidebar, drop onto canvas, connect with pipes, set tag bindings.
 */

import React, { useState, useCallback } from 'react';
import type { PIDDiagram, PIDSymbol, PipeConnection, Point, ValveVariant, PumpVariant, TankVariant } from '@shared/types/pid';
import { PIDCanvas } from './PIDCanvas';
import { PIDDataProvider } from './PIDDataBinding';

// =============================================================================
// SYMBOL PALETTE
// =============================================================================

interface PaletteItem {
  type: PIDSymbol['type'];
  variant?: string;
  label: string;
  icon: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  { type: 'valve', variant: 'gate', label: 'Gate Valve', icon: '⧖' },
  { type: 'valve', variant: 'globe', label: 'Globe Valve', icon: '⧗' },
  { type: 'valve', variant: 'ball', label: 'Ball Valve', icon: '●' },
  { type: 'valve', variant: 'butterfly', label: 'Butterfly Valve', icon: '◎' },
  { type: 'valve', variant: 'check', label: 'Check Valve', icon: '▷' },
  { type: 'valve', variant: 'relief', label: 'Relief Valve', icon: '⇡' },
  { type: 'pump', variant: 'centrifugal', label: 'Centrifugal Pump', icon: '◉' },
  { type: 'pump', variant: 'positive-displacement', label: 'PD Pump', icon: '⊕' },
  { type: 'tank', variant: 'open', label: 'Open Tank', icon: '⊔' },
  { type: 'tank', variant: 'closed', label: 'Closed Tank', icon: '▭' },
  { type: 'tank', variant: 'pressure-vessel', label: 'Pressure Vessel', icon: '⬭' },
  { type: 'instrument', label: 'Instrument', icon: '◯' },
  { type: 'motor', label: 'Motor', icon: 'Ⓜ' },
  { type: 'heat-exchanger', label: 'Heat Exchanger', icon: '⟲' },
  { type: 'junction', variant: 'tee', label: 'Tee', icon: '⊤' },
  { type: 'junction', variant: 'elbow', label: 'Elbow', icon: '∟' },
];

// =============================================================================
// HELPERS
// =============================================================================

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${nextId++}`;
}

function createSymbol(item: PaletteItem, position: Point): PIDSymbol {
  const base = {
    id: genId(item.type),
    transform: { position },
    label: item.label,
    ports: [],
  };

  switch (item.type) {
    case 'valve':
      return { ...base, type: 'valve', variant: (item.variant ?? 'gate') as ValveVariant };
    case 'pump':
      return { ...base, type: 'pump', variant: (item.variant ?? 'centrifugal') as PumpVariant };
    case 'tank':
      return { ...base, type: 'tank', variant: (item.variant ?? 'closed') as TankVariant, size: { width: 60, height: 80 } };
    case 'instrument':
      return { ...base, type: 'instrument', functionLetters: 'FIC', loopNumber: '100', connectionType: 'electric', location: 'field' };
    case 'motor':
      return { ...base, type: 'motor' };
    case 'heat-exchanger':
      return { ...base, type: 'heat-exchanger' };
    case 'junction':
      return { ...base, type: 'junction', variant: (item.variant ?? 'tee') as any };
    default:
      return { ...base, type: 'valve', variant: 'gate' } as any;
  }
}

// =============================================================================
// PROPERTY PANEL
// =============================================================================

const PropertyPanel: React.FC<{
  symbol: PIDSymbol | null;
  onUpdate: (updated: PIDSymbol) => void;
  onDelete: (id: string) => void;
}> = ({ symbol, onUpdate, onDelete }) => {
  if (!symbol) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
        Select a symbol to edit properties
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontSize: 13 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Properties</h3>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>Label</span>
        <input
          type="text"
          value={symbol.label ?? ''}
          onChange={e => onUpdate({ ...symbol, label: e.target.value })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>Tag Number</span>
        <input
          type="text"
          value={symbol.tagNumber ?? ''}
          onChange={e => onUpdate({ ...symbol, tagNumber: e.target.value })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>X</span>
        <input
          type="number"
          value={symbol.transform.position.x}
          onChange={e => onUpdate({ ...symbol, transform: { ...symbol.transform, position: { ...symbol.transform.position, x: Number(e.target.value) } } })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>Y</span>
        <input
          type="number"
          value={symbol.transform.position.y}
          onChange={e => onUpdate({ ...symbol, transform: { ...symbol.transform, position: { ...symbol.transform.position, y: Number(e.target.value) } } })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>Rotation</span>
        <input
          type="number" step={15}
          value={symbol.transform.rotation ?? 0}
          onChange={e => onUpdate({ ...symbol, transform: { ...symbol.transform, rotation: Number(e.target.value) } })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 12 }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>Tag Binding (Tag ID)</span>
        <input
          type="text"
          value={symbol.dataBinding?.tags?.[0]?.tagId ?? ''}
          onChange={e => onUpdate({
            ...symbol,
            dataBinding: {
              tags: [{ tagId: e.target.value, property: 'value' }],
            },
          })}
          style={{ display: 'block', width: '100%', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, marginTop: 2 }}
          placeholder="e.g., FIC-101.PV"
        />
      </label>

      <button
        onClick={() => onDelete(symbol.id)}
        style={{
          padding: '6px 12px', background: '#ef4444', color: 'white',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
        }}
      >
        Delete Symbol
      </button>
    </div>
  );
};

// =============================================================================
// EDITOR
// =============================================================================

interface PIDEditorProps {
  initialDiagram?: PIDDiagram;
  onSave?: (diagram: PIDDiagram) => void;
}

const DEFAULT_DIAGRAM: PIDDiagram = {
  id: 'new',
  name: 'Untitled P&ID',
  canvasSize: { width: 1200, height: 800 },
  gridSize: 20,
  symbols: [],
  connections: [],
};

export const PIDEditor: React.FC<PIDEditorProps> = ({
  initialDiagram,
  onSave,
}) => {
  const [diagram, setDiagram] = useState<PIDDiagram>(initialDiagram ?? DEFAULT_DIAGRAM);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragItem, setDragItem] = useState<PaletteItem | null>(null);

  const selectedSymbol = diagram.symbols.find(s => s.id === selectedId) ?? null;

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!dragItem) return;

    const svgEl = e.currentTarget.querySelector('svg');
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    const symbol = createSymbol(dragItem, { x, y });
    setDiagram(d => ({ ...d, symbols: [...d.symbols, symbol] }));
    setDragItem(null);
  }, [dragItem]);

  const handleUpdateSymbol = useCallback((updated: PIDSymbol) => {
    setDiagram(d => ({
      ...d,
      symbols: d.symbols.map(s => s.id === updated.id ? updated : s),
    }));
  }, []);

  const handleDeleteSymbol = useCallback((id: string) => {
    setDiagram(d => ({
      ...d,
      symbols: d.symbols.filter(s => s.id !== id),
      connections: d.connections.filter(c => c.from.symbolId !== id && c.to.symbolId !== id),
    }));
    setSelectedId(null);
  }, []);

  return (
    <PIDDataProvider>
      <div style={{ display: 'flex', height: '100%', fontFamily: 'system-ui, sans-serif' }}>
        {/* Palette sidebar */}
        <div style={{
          width: 200, borderRight: '1px solid #e2e8f0', background: 'white',
          overflowY: 'auto', flexShrink: 0,
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: 14 }}>
            Symbol Palette
          </div>
          {PALETTE_ITEMS.map((item, i) => (
            <div
              key={i}
              draggable
              onDragStart={() => setDragItem(item)}
              style={{
                padding: '8px 16px', cursor: 'grab', display: 'flex', alignItems: 'center', gap: 8,
                borderBottom: '1px solid #f1f5f9', fontSize: 13,
              }}
            >
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>

        {/* Canvas area */}
        <div
          style={{ flex: 1, position: 'relative' }}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          {/* Toolbar */}
          <div style={{
            position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 8,
          }}>
            <input
              type="text"
              value={diagram.name}
              onChange={e => setDiagram(d => ({ ...d, name: e.target.value }))}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
            />
            <button
              onClick={() => onSave?.(diagram)}
              style={{
                padding: '4px 12px', background: '#3b82f6', color: 'white',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
              }}
            >
              Save
            </button>
          </div>

          <PIDCanvas
            diagram={diagram}
            selectedId={selectedId}
            onSymbolClick={setSelectedId}
            onCanvasClick={() => setSelectedId(null)}
            className="pid-editor-canvas"
          />
        </div>

        {/* Property panel */}
        <div style={{
          width: 240, borderLeft: '1px solid #e2e8f0', background: 'white',
          overflowY: 'auto', flexShrink: 0,
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: 14 }}>
            Properties
          </div>
          <PropertyPanel
            symbol={selectedSymbol}
            onUpdate={handleUpdateSymbol}
            onDelete={handleDeleteSymbol}
          />
        </div>
      </div>
    </PIDDataProvider>
  );
};

export default PIDEditor;
