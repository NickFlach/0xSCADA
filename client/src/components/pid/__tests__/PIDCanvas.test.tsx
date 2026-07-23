/**
 * P&ID Canvas Tests
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PIDCanvas } from '../PIDCanvas';
import { PIDDataProvider } from '../PIDDataBinding';
import type { PIDDiagram } from '@shared/types/pid';

// Mock WebSocket — must be a constructor (PIDDataBinding calls `new WebSocket(...)`)
vi.stubGlobal('WebSocket', class {
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev?: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = 1;
});

const MOCK_DIAGRAM: PIDDiagram = {
  id: 'test-1',
  name: 'Test Diagram',
  canvasSize: { width: 800, height: 600 },
  gridSize: 20,
  symbols: [
    {
      id: 'v1',
      type: 'valve',
      variant: 'gate',
      transform: { position: { x: 100, y: 200 } },
      tagNumber: 'FV-101',
      label: 'Test Valve',
    },
    {
      id: 'p1',
      type: 'pump',
      variant: 'centrifugal',
      transform: { position: { x: 300, y: 200 } },
      tagNumber: 'P-101',
    },
    {
      id: 'tk1',
      type: 'tank',
      variant: 'closed',
      transform: { position: { x: 500, y: 200 } },
      size: { width: 60, height: 80 },
      tagNumber: 'TK-101',
    },
    {
      id: 'i1',
      type: 'instrument',
      functionLetters: 'FIC',
      loopNumber: '101',
      connectionType: 'electric',
      location: 'control-room',
      transform: { position: { x: 100, y: 100 } },
    },
  ],
  connections: [
    {
      id: 'c1',
      from: { symbolId: 'v1', portId: 'out' },
      to: { symbolId: 'p1', portId: 'in' },
      showFlow: true,
    },
  ],
};

function renderCanvas(props: Partial<React.ComponentProps<typeof PIDCanvas>> = {}) {
  return render(
    <PIDDataProvider>
      <PIDCanvas diagram={MOCK_DIAGRAM} {...props} />
    </PIDDataProvider>
  );
}

describe('PIDCanvas', () => {
  it('renders without crashing', () => {
    const { container } = renderCanvas();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders all symbols', () => {
    const { container } = renderCanvas();
    const symbolGroups = container.querySelectorAll('.pid-symbol');
    expect(symbolGroups.length).toBe(MOCK_DIAGRAM.symbols.length);
  });

  it('shows tag numbers', () => {
    const { container } = renderCanvas();
    const texts = container.querySelectorAll('text');
    const tagTexts = Array.from(texts).map(t => t.textContent);
    expect(tagTexts).toContain('FV-101');
    expect(tagTexts).toContain('P-101');
    expect(tagTexts).toContain('TK-101');
  });

  it('shows instrument function letters', () => {
    const { container } = renderCanvas();
    const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
    expect(texts).toContain('FIC');
  });

  it('calls onSymbolClick when a symbol is clicked', () => {
    const handleClick = vi.fn();
    const { container } = renderCanvas({ onSymbolClick: handleClick });
    const symbols = container.querySelectorAll('.pid-symbol');
    fireEvent.click(symbols[0]);
    expect(handleClick).toHaveBeenCalledWith('v1');
  });

  it('shows selection highlight', () => {
    const { container } = renderCanvas({ selectedId: 'v1' });
    // Gate valve selection is a dashed rect
    const dashedRects = container.querySelectorAll('rect[stroke-dasharray]');
    expect(dashedRects.length).toBeGreaterThan(0);
  });

  it('renders zoom controls when interactive', () => {
    const { container } = renderCanvas({ interactive: true });
    const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
    expect(texts).toContain('+');
    expect(texts).toContain('−');
  });

  it('hides grid when showGrid is false', () => {
    const { container } = renderCanvas({ showGrid: false });
    const gridGroup = container.querySelector('.pid-grid');
    expect(gridGroup).toBeNull();
  });

  it('renders flow animation class on pipes with showFlow', () => {
    const { container } = renderCanvas();
    const flowLines = container.querySelectorAll('.pid-flow-line');
    expect(flowLines.length).toBeGreaterThan(0);
  });
});
