# ADR-0025: Living Fano Plane Dashboard

**Status:** Proposed  
**Date:** 2026-03-04  
**Authors:** Kannaka  
**Bridge:** ShinVaelNoctis Sacred Geometry → 0xSCADA Phi Dashboard

## Context

The 0xSCADA Phi dashboard (ADR-0022, #332) displays process integration as a gauge with a static Fano plane mini-visualization. It works, but it's a number on a screen. Operators glance at it and move on.

The `ShinVaelNoctis` repo renders sacred geometry as living, breathing canvas animations — spiral blooms that pulse and shift in response to inputs. The geometry responds to "chants" (input parameters) that modify intensity, speed, bloom size, and glow radius.

The bridge insight: **The Fano plane IS sacred geometry — 7 points, 7 lines, perfect projective symmetry. It should breathe with the heartbeat of the plant.** A Fano plane whose points pulse with real process data isn't just a dashboard — it's an industrial mandala. Operators don't read it; they *feel* it.

## Decision

Replace the static PhiGauge Fano mini-visualization with a living ShinVaelNoctis-inspired canvas animation where the Fano plane geometry breathes with real-time process data.

### Architecture

```
    Real-time Process Data
            │
            ▼
    ┌──────────────────┐
    │  SGA Classifier   │──→ 7 SGA quadrant/triality groups
    └──────┬───────────┘     mapped to 7 Fano points
           │
           ▼
    ┌──────────────────────────────────────┐
    │         Living Fano Canvas            │
    │                                       │
    │    Point 1 ●━━━━━● Point 2           │
    │           ╲    ╱   ╲                  │
    │            ╲  ╱     ╲                 │
    │     Point 3 ●━━━━━━━● Point 4        │
    │            ╱  ╲     ╱                 │
    │           ╱    ╲   ╱                  │
    │    Point 5 ●━━━━━● Point 6           │
    │              ╲ ╱                      │
    │               ● Point 7 (center)      │
    │                                       │
    │  Each point: pulsing bloom            │
    │  Each line: energy flow               │
    │  Whole figure: breathing with Φ       │
    └──────────────────────────────────────┘
```

### Visual Language

#### Points (7 Fano Points = 7 Process Dimensions)
Each point is a **bloom** (ShinVaelNoctis spiral animation):
- **Size:** Proportional to entity count in that SGA class
- **Pulse rate:** Process variable update frequency (fast data = fast pulse)
- **Color:** Health spectrum — emerald (healthy) → amber (warning) → crimson (critical)
- **Glow radius:** Confidence/quality of readings in that class
- **Bloom style:** Spiral for normal operation, starburst for alarm, dim ember for stale data

#### Lines (7 Fano Lines = 7 Integration Paths)
Each line connects 3 collinear points:
- **Thickness:** Information flow rate between the connected classes
- **Flow animation:** Particles traveling along the line (direction = causality)
- **Color:** Bright when integrated (high mutual information), dim when disconnected
- **Pulse:** Synchronized with connected points when coherent, desynchronized when not

#### The Whole Figure
- **Breathing:** The entire figure expands/contracts with a respiratory cycle tied to Φ
  - Φ > 0.7: slow, deep breaths (4-second cycle) — the plant is calm
  - Φ 0.4-0.7: faster breathing (2-second cycle) — elevated attention
  - Φ < 0.4: rapid, shallow (1-second cycle) — the plant is stressed
- **Rotation:** Slow rotation when healthy, stops when alarms are active (attention demanded)
- **Background:** Subtle sacred geometry pattern (Flower of Life) that brightens with Φ

#### Chant Inputs (Operator Interaction)
Borrowing from ShinVaelNoctis's chant system:
- **Click a point:** Zoom into that SGA class, show detail panel
- **Hover a line:** Highlight the integration path, show mutual information metrics
- **Keyboard shortcuts:** 
  - `r` — enter "reflective mode" (show ghost code markers: correlation coefficients, prediction confidence)
  - `t` — toggle temporal mode (show how the figure looked 1h/8h/24h ago)
  - `a` — attention mode (suppress healthy points, amplify anomalies)

### Implementation

#### Technology
- **Canvas:** HTML5 Canvas with requestAnimationFrame (not SVG — needs smooth 60fps animation)
- **Rendering:** Port ShinVaelNoctis's spiral/bloom renderer, adapted for industrial palette
- **Data binding:** WebSocket subscription to `/api/geometry/phi` + `/api/geometry/classes`
- **Animation engine:** Custom frame loop with easing functions for organic movement

#### Component Structure
```
client/src/components/phi/
├── LivingFano.tsx          # Main canvas component
├── FanoGeometry.ts         # Fano plane point/line math (projective geometry)
├── BloomRenderer.ts        # Port of ShinVaelNoctis bloom/spiral animation
├── FlowRenderer.ts         # Line particle flow animation
├── BreathingController.ts  # Phi-driven respiratory cycle
├── ChantHandler.ts         # Keyboard/mouse interaction mapping
└── FanoDataBridge.ts       # WebSocket data → visual parameter mapping
```

#### Data Mapping
| Process Data | Visual Parameter |
|-------------|-----------------|
| SGA class entity count | Point bloom size |
| Process variable update rate | Point pulse frequency |
| Class health (alarms/warnings) | Point color (emerald→crimson) |
| Reading quality/confidence | Point glow radius |
| Inter-class information flow | Line thickness |
| Causal direction | Line particle flow direction |
| Mutual information | Line brightness |
| Φ (integrated information) | Breathing cycle period |
| Global alarm state | Rotation speed |

### Operator Psychology

This isn't decoration. It's **preattentive processing**.

Humans process visual motion, color, and rhythm 200ms faster than reading numbers. An operator monitoring 50 screens can't read every gauge — but they can *feel* when the Fano bloom changes its breathing. The living Fano plane leverages:

- **Change blindness resistance:** Motion changes are noticed faster than number changes
- **Peripheral vision:** Breathing/color changes visible even when not directly focused
- **Pattern recognition:** Operators develop intuition for "how the plant feels" based on the figure's gestalt
- **Stress reduction:** Organic, breathing visualizations reduce cognitive load vs. blinking red alerts

This is not unlike how experienced power plant operators describe "feeling" the plant through vibration and sound. The living Fano plane digitizes that intuition.

## Consequences

### Positive
- Operators develop intuitive feel for plant health at a glance
- Leverages human preattentive visual processing
- Beautiful — people will want to look at it (engagement > avoidance)
- Unique differentiator: no other SCADA system has anything like this
- Bridges industrial automation and consciousness research visually

### Negative
- Canvas animation is more complex than static SVG
- 60fps rendering has GPU/CPU cost (though minimal for 7 points)
- Needs careful color calibration for accessibility (colorblind operators)
- Risk of being dismissed as "pretty but useless" by traditional SCADA engineers

### Risks
- Animation could become distracting rather than informative
- Mitigation: "calm mode" toggle that reduces to slow pulse only
- Performance on low-end control room PCs
- Mitigation: graceful degradation to 30fps, then static SVG fallback

## References
- `ShinVaelNoctis/` — Sacred geometry canvas animation system
- `client/src/components/phi/PhiGauge.tsx` — Current static Fano visualization
- `server/services/geometry/` — SGA classifier and Phi computation
- ADR-0022 — Constellation Unification (parent)
- The Fano plane: https://en.wikipedia.org/wiki/Fano_plane
