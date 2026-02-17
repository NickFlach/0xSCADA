# Resonant Systems Theory — 40-Hour Curriculum

A comprehensive learning tract exploring signal processing, resonance phenomena, coupled systems, and emergent behavior — with applied labs using 0xSCADA industrial infrastructure.

**Total Duration:** 40 hours (5 modules × 8 hours)
**Prerequisites:** Linear algebra basics, introductory calculus, familiarity with Python or TypeScript
**Format:** Lectures, readings, exercises, hands-on labs

---

## Module 1: Signal Processing Fundamentals (8h)

### 1.1 Continuous & Discrete Signals (2h)
- Signal classification: deterministic vs. stochastic, periodic vs. aperiodic
- Sampling theorem (Nyquist–Shannon), aliasing
- Analog-to-digital conversion in SCADA sensors
- **Exercise:** Analyze sampling rates for different industrial sensor types

### 1.2 Fourier Analysis (2h)
- Fourier series and the Fourier transform
- Discrete Fourier Transform (DFT) and FFT algorithms
- Power spectral density estimation
- **Exercise:** Implement FFT on simulated SCADA tag data; identify dominant frequencies

### 1.3 Filtering & Windowing (2h)
- FIR and IIR filter design
- Low-pass, high-pass, band-pass, and notch filters
- Window functions (Hamming, Hanning, Blackman)
- **Exercise:** Design a noise filter for a noisy temperature sensor signal

### 1.4 Time-Frequency Analysis (2h)
- Short-Time Fourier Transform (STFT)
- Wavelet transforms (continuous and discrete)
- Spectrogram interpretation
- **Lab 1:** Build a real-time spectrogram viewer for 0xSCADA tag streams using `tags history` data

### Reading List
- Oppenheim & Willsky, *Signals and Systems* (Ch. 1–5)
- Smith, *The Scientist and Engineer's Guide to Digital Signal Processing* (free online)
- Mallat, *A Wavelet Tour of Signal Processing* (Ch. 1–3)

---

## Module 2: Resonance & Oscillation (8h)

### 2.1 Harmonic Oscillators (2h)
- Simple, damped, and driven harmonic oscillators
- Natural frequency, damping ratio, quality factor (Q)
- Mechanical and electrical analogues
- **Exercise:** Model a pressure relief valve as a damped oscillator

### 2.2 Resonance Phenomena (2h)
- Forced oscillation and resonance curves
- Amplitude and phase response
- Resonance catastrophe and structural implications
- **Exercise:** Simulate resonance in a rotating machinery bearing model

### 2.3 Parametric & Nonlinear Resonance (2h)
- Parametric oscillation (Mathieu equation)
- Duffing oscillator and jump phenomena
- Subharmonic and superharmonic resonance
- **Exercise:** Explore bifurcation diagrams for a nonlinear tank level oscillator

### 2.4 Resonance Detection in Industrial Systems (2h)
- Vibration analysis for rotating equipment
- Modal analysis techniques
- Resonance-induced failures: case studies
- **Lab 2:** Use 0xSCADA vibration tag data to detect resonance signatures; configure alarms for resonance conditions via `0xscada alarms`

### Reading List
- French, *Vibrations and Waves*
- Nayfeh & Mook, *Nonlinear Oscillations*
- Harris & Piersol, *Shock and Vibration Handbook* (selected chapters)

---

## Module 3: Coupled Systems & Synchronization (8h)

### 3.1 Coupled Oscillators (2h)
- Two coupled pendula: normal modes
- N-body coupled systems and dispersion relations
- Energy transfer between coupled modes
- **Exercise:** Simulate coupled tank levels in a cascade system

### 3.2 Synchronization Theory (2h)
- Kuramoto model of phase synchronization
- Entrainment and frequency locking
- Synchronization in biological and engineering systems
- **Exercise:** Implement a Kuramoto simulation with N=50 oscillators; visualize order parameter

### 3.3 Network Dynamics (2h)
- Oscillators on graphs: adjacency and Laplacian matrices
- Chimera states and partial synchronization
- Master stability function
- **Exercise:** Model a network of SCADA-monitored pumps with coupling through shared pipelines

### 3.4 Synchronization in Distributed SCADA (2h)
- Time synchronization (PTP, NTP) in industrial networks
- Clock drift and its effect on event correlation
- Consensus protocols as synchronization
- **Lab 3:** Use 0xSCADA gateway data to analyze time synchronization quality across gateways; measure clock skew using `0xscada gateway list` and event timestamps

### Reading List
- Strogatz, *Sync: How Order Emerges from Chaos*
- Pikovsky, Rosenblum & Kurths, *Synchronization: A Universal Concept in Nonlinear Sciences*
- Strogatz, *Nonlinear Dynamics and Chaos* (Ch. 8)

---

## Module 4: Emergence in Complex Systems (8h)

### 4.1 Complex Adaptive Systems (2h)
- Definitions: complexity, emergence, self-organization
- Agent-based models and cellular automata
- Edge of chaos and criticality
- **Exercise:** Build a cellular automaton that models alarm propagation through an industrial plant

### 4.2 Phase Transitions & Critical Phenomena (2h)
- Order parameters and phase transitions
- Percolation theory
- Scale-free networks and power laws
- **Exercise:** Analyze alarm frequency distributions in 0xSCADA for power-law signatures

### 4.3 Information Theory & Emergence (2h)
- Shannon entropy and mutual information
- Transfer entropy for causal inference
- Integrated Information Theory (IIT) basics
- **Exercise:** Compute transfer entropy between correlated SCADA tags to infer causal relationships

### 4.4 Emergent Behavior in Industrial Systems (2h)
- Cascading failures and systemic risk
- Resilience engineering principles
- Digital twins as complexity observatories
- **Lab 4:** Build a cascading failure model using 0xSCADA's digital twin architecture; inject faults and observe emergent alarm patterns

### Reading List
- Mitchell, *Complexity: A Guided Tour*
- Holland, *Emergence: From Chaos to Order*
- Bar-Yam, *Dynamics of Complex Systems* (selected chapters)
- Cover & Thomas, *Elements of Information Theory* (Ch. 1–2)

---

## Module 5: Applied Resonance in SCADA/Industrial (8h)

### 5.1 Vibration Monitoring & Predictive Maintenance (2h)
- ISO 10816 vibration severity standards
- Envelope analysis and bearing fault detection
- Order tracking for variable-speed machinery
- **Exercise:** Design a predictive maintenance alarm pipeline using 0xSCADA tags and alarms

### 5.2 Process Resonance & Control Loop Oscillation (2h)
- Control loop oscillation detection
- Stiction, tuning, and interaction-induced oscillations
- Plant-wide oscillation propagation
- **Exercise:** Identify oscillating control loops from 0xSCADA tag history data

### 5.3 Acoustic & Structural Resonance (2h)
- Acoustic emission monitoring
- Structural health monitoring (SHM)
- Fluid-structure interaction resonance (water hammer, vortex shedding)
- **Exercise:** Design an SHM monitoring dashboard using 0xSCADA blueprints

### 5.4 Capstone Lab: Resonance Detection System (2h)
- **Lab 5:** End-to-end project: deploy a resonance detection and alerting system on 0xSCADA
  1. Configure gateway and tags for vibration sensors
  2. Implement FFT-based resonance detection in a processing pipeline
  3. Set alarm thresholds based on resonance amplitude
  4. Anchor critical resonance events to blockchain for audit trail
  5. Build a monitoring dashboard with `0xscada watch`

### Reading List
- Randall, *Vibration-based Condition Monitoring*
- Hägglund, *Industrial Process Control* (oscillation chapters)
- Brincker & Ventura, *Introduction to Operational Modal Analysis*

---

## Assessment

| Component | Weight |
|---|---|
| Module exercises (5 × 3 exercises) | 30% |
| Lab reports (5 labs) | 40% |
| Capstone project (Lab 5) | 20% |
| Reading reflections | 10% |

## Tools & Software

- **0xSCADA CLI** (`0xscada`) — tag reading, alarm management, gateway monitoring
- **Python** (NumPy, SciPy, Matplotlib) — signal processing and simulation
- **TypeScript** — 0xSCADA extension development
- **Jupyter Notebooks** — interactive analysis
- **0xSCADA Web UI** — dashboard and visualization
