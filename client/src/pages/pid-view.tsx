/**
 * P&ID View Page
 *
 * Loads a P&ID diagram and displays it with real-time data.
 */

import React, { useEffect, useState } from 'react';
import { useRoute, Link } from 'wouter';
import type { PIDDiagram } from '@shared/types/pid';
import { PIDCanvas } from '../components/pid/PIDCanvas';
import { PIDDataProvider } from '../components/pid/PIDDataBinding';
import { PIDEditor } from '../components/pid/PIDEditor';

// =============================================================================
// DEMO DIAGRAM (used when no API data available)
// =============================================================================

const DEMO_DIAGRAM: any = {
  id: 'demo-1',
  name: 'Process Unit 100 — Feed System',
  drawingNumber: 'P&ID-100-001',
  revision: 'A',
  canvasSize: { width: 1400, height: 900 },
  gridSize: 20,
  symbols: [
    {
      id: 'tk-101', type: 'tank', variant: 'closed',
      position: { x: 150, y: 400 },
      transform: { position: { x: 150, y: 400 }, rotation: 0, scale: 1 },
      size: { width: 70, height: 100 },
      tagNumber: 'TK-101', label: 'Feed Tank',
      dataBinding: { tags: [{ tagId: 'TK101.LVL', property: 'level', units: '%' }] },
    } as any,
    {
      id: 'p-101', type: 'pump', variant: 'centrifugal',
      position: { x: 350, y: 400 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 350, y: 400 }, rotation: 0, scale: 1 },
      tagNumber: 'P-101', label: 'Feed Pump',
      dataBinding: { tags: [{ tagId: 'P101.RUN', property: 'state' }] },
    } as any,
    {
      id: 'v-101', type: 'valve', variant: 'globe',
      position: { x: 530, y: 400 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 530, y: 400 }, rotation: 0, scale: 1 },
      tagNumber: 'FCV-101', label: 'Flow Control',
    } as any,
    {
      id: 'e-101', type: 'heat-exchanger', exchangerType: 'shell-tube',
      position: { x: 730, y: 400 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 730, y: 400 }, rotation: 0, scale: 1 },
      tagNumber: 'E-101', label: 'Feed Preheater',
    } as any,
    {
      id: 'tk-102', type: 'tank', variant: 'pressure-vessel',
      position: { x: 1000, y: 400 },
      transform: { position: { x: 1000, y: 400 }, rotation: 0, scale: 1 },
      size: { width: 70, height: 100 },
      tagNumber: 'V-101', label: 'Reactor',
      dataBinding: { tags: [{ tagId: 'V101.LVL', property: 'level', units: '%' }] },
    } as any,
    {
      id: 'fic-101', type: 'instrument',
      functionLetters: 'FIC', loopNumber: '101',
      connectionType: 'electrical', location: 'control-room',
      position: { x: 530, y: 280 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 530, y: 280 }, rotation: 0, scale: 1 },
    } as any,
    {
      id: 'lic-101', type: 'instrument',
      functionLetters: 'LIC', loopNumber: '101',
      connectionType: 'electrical', location: 'control-room',
      position: { x: 150, y: 250 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 150, y: 250 }, rotation: 0, scale: 1 },
    } as any,
    {
      id: 'pic-101', type: 'instrument',
      functionLetters: 'PIC', loopNumber: '101',
      connectionType: 'electrical', location: 'control-room',
      position: { x: 1000, y: 250 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 1000, y: 250 }, rotation: 0, scale: 1 },
    } as any,
    {
      id: 'm-101', type: 'motor',
      position: { x: 350, y: 320 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 350, y: 320 }, rotation: 0, scale: 1 },
      tagNumber: 'M-101',
    } as any,
    {
      id: 'v-102', type: 'valve', variant: 'relief',
      position: { x: 1100, y: 300 },
      size: { width: 40, height: 40 },
      transform: { position: { x: 1100, y: 300 }, rotation: -90, scale: 1 },
      tagNumber: 'PSV-101', label: 'Relief',
    } as any,
  ],
  connections: [
    { id: 'c1', from: { symbolId: 'tk-101', portId: 'out' } as any, to: { symbolId: 'p-101', portId: 'in' } as any, showFlow: true } as any,
    { id: 'c2', from: { symbolId: 'p-101', portId: 'out' } as any, to: { symbolId: 'v-101', portId: 'in' } as any, showFlow: true } as any,
    { id: 'c3', from: { symbolId: 'v-101', portId: 'out' } as any, to: { symbolId: 'e-101', portId: 'in' } as any, showFlow: true } as any,
    { id: 'c4', from: { symbolId: 'e-101', portId: 'out' } as any, to: { symbolId: 'tk-102', portId: 'in' } as any, showFlow: true } as any,
  ],
};

// =============================================================================
// PAGE COMPONENTS
// =============================================================================

const PIDViewPage: React.FC = () => {
  const [, params] = useRoute('/pid/:id');
  const [diagram, setDiagram] = useState<PIDDiagram | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    const diagramId = params?.id;
    if (!diagramId || diagramId === 'demo') {
      setDiagram(DEMO_DIAGRAM);
      setLoading(false);
      return;
    }

    fetch(`/api/pid/diagrams/${diagramId}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load diagram');
        return res.json();
      })
      .then(data => { setDiagram(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [params?.id]);

  const handleSave = async (updated: PIDDiagram) => {
    try {
      const res = await fetch(`/api/pid/diagrams/${updated.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error('Save failed');
      setDiagram(updated);
      setEditMode(false);
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div>Loading diagram...</div>
      </div>
    );
  }

  if (error || !diagram) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16 }}>
        <div style={{ color: '#ef4444' }}>{error ?? 'Diagram not found'}</div>
        <Link href="/pid/demo" style={{ color: '#3b82f6' }}>View Demo Diagram</Link>
      </div>
    );
  }

  if (editMode) {
    return (
      <div style={{ height: '100vh' }}>
        <PIDEditor initialDiagram={diagram} onSave={handleSave} />
      </div>
    );
  }

  return (
    <PIDDataProvider diagramId={diagram.id}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', background: 'white',
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{diagram.name}</h1>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {(diagram as any).drawingNumber} {(diagram as any).revision ? `Rev. ${(diagram as any).revision}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setEditMode(true)}
              style={{
                padding: '6px 12px', background: '#f1f5f9', border: '1px solid #d1d5db',
                borderRadius: 4, cursor: 'pointer', fontSize: 13,
              }}
            >
              ✏️ Edit
            </button>
            <Link href="/" style={{
              padding: '6px 12px', background: '#f1f5f9', border: '1px solid #d1d5db',
              borderRadius: 4, textDecoration: 'none', color: 'inherit', fontSize: 13,
            }}>
              ← Back
            </Link>
          </div>
        </div>

        {/* Canvas */}
        <div style={{ flex: 1 }}>
          <PIDCanvas diagram={diagram} showGrid />
        </div>
      </div>
    </PIDDataProvider>
  );
};

export default PIDViewPage;
