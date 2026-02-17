# Sublinear Algorithms — 60-Hour Curriculum

A rigorous learning tract covering streaming algorithms, sketching, property testing, distributed computing, sublinear graph algorithms, and their application to blockchain and industrial data systems.

**Total Duration:** 60 hours (6 modules × 10 hours)
**Prerequisites:** Algorithms & data structures, probability theory, basic complexity theory
**Format:** Lectures, readings, problem sets, implementation projects

---

## Module 1: Streaming Algorithms (10h)

### 1.1 The Streaming Model (2h)
- One-pass and multi-pass streaming models
- Space-time tradeoffs and communication complexity lower bounds
- Relationship to online algorithms
- **Problems:** Prove space lower bounds for exact frequency moments

### 1.2 Frequency Estimation (2.5h)
- Misra–Gries algorithm (frequent items)
- Count-Min Sketch
- Count Sketch and median trick
- Space-Saving algorithm
- **Implementation Project:** Build a Count-Min Sketch for 0xSCADA event frequency tracking

### 1.3 Distinct Element Counting (2.5h)
- Flajolet–Martin algorithm
- LogLog, SuperLogLog, HyperLogLog
- Bottom-k sketches
- **Implementation Project:** HyperLogLog for counting distinct tag IDs in a data stream

### 1.4 Frequency Moments & Norms (3h)
- AMS sketch for F₂ estimation
- Indyk's p-stable sketch for Lₚ norms
- Johnson–Lindenstrauss lemma and dimensionality reduction
- Moment estimation lower bounds (Alon–Matias–Szegedy)
- **Problem Set:** Analyze theoretical guarantees; implement AMS sketch

### Reading List
- Muthukrishnan, *Data Streams: Algorithms and Applications*
- Cormode & Garofalakis, "Sketching Streams Through the Net" (VLDB tutorial)
- Alon, Matias & Szegedy, "The Space Complexity of Approximating the Frequency Moments"

---

## Module 2: Sketching & Approximation (10h)

### 2.1 Linear Sketching Framework (2h)
- Random linear projections
- Universality of linear sketches (Li, Nguyen, Woodruff)
- Turnstile vs. cash register models
- **Problems:** Prove that linear sketches are optimal for certain problems

### 2.2 Heavy Hitters & Quantiles (2.5h)
- Hierarchical heavy hitters
- Greenwald–Khanna quantile sketch
- KLL sketch (optimal quantile approximation)
- Mergeable summaries
- **Implementation Project:** Quantile sketch for 0xSCADA tag value distribution monitoring

### 2.3 Similarity & Distance Estimation (2.5h)
- MinHash for Jaccard similarity
- SimHash for cosine similarity
- Locality-Sensitive Hashing (LSH) families
- Edit distance sketching
- **Implementation Project:** LSH-based anomaly detection for SCADA sensor vectors

### 2.4 Sampling Techniques (3h)
- Reservoir sampling (Vitter)
- Priority sampling (weighted)
- Distinct sampling
- L₂ sampling (Monemizadeh & Woodruff)
- Coordinated sampling for distributed streams
- **Problem Set:** Design a weighted sampling scheme for alarm prioritization

### Reading List
- Cormode, Garofalakis, Haas & Jermaine, *Synopses for Massive Data*
- Woodruff, "Sketching as a Tool for Numerical Linear Algebra"
- Broder, "On the Resemblance and Containment of Documents"

---

## Module 3: Property Testing (10h)

### 3.1 Foundations of Property Testing (2.5h)
- Definition: ε-testers with query complexity o(n)
- One-sided vs. two-sided error
- Adaptive vs. non-adaptive testers
- **Problems:** Prove query lower bounds using Yao's minimax principle

### 3.2 Testing Properties of Functions (2.5h)
- Linearity testing (BLR test)
- Testing monotonicity
- Testing Lipschitz continuity
- Junta testing
- **Implementation Project:** Monotonicity tester for SCADA sensor calibration curves

### 3.3 Testing Graph Properties (2.5h)
- Dense graph model (adjacency matrix)
- Sparse/bounded-degree graph model
- Testing bipartiteness, connectivity, expansion
- Testing minor-freeness
- **Problem Set:** Design testers for graph properties relevant to industrial network topologies

### 3.4 Testing Distributions (2.5h)
- Identity testing (is D = D₀?)
- Closeness testing (is D₁ ≈ D₂?)
- Uniformity testing
- Independence testing
- Optimal sample complexity (Valiant & Valiant)
- **Implementation Project:** Distribution tester for detecting sensor drift by comparing historical vs. current value distributions

### Reading List
- Goldreich, *Introduction to Property Testing*
- Ron, "Property Testing: A Learning Theory Perspective"
- Canonne, "A Survey on Distribution Testing"

---

## Module 4: Distributed Computing (10h)

### 4.1 Communication Complexity (2.5h)
- Deterministic, randomized, and nondeterministic models
- Rectangle methods and discrepancy
- Information complexity
- **Problems:** Prove communication lower bounds for set disjointness

### 4.2 Distributed Streaming (2.5h)
- Continuous distributed monitoring
- Functional monitoring problem
- Distributed heavy hitters
- Coordinator model and message complexity
- **Implementation Project:** Distributed Count-Min Sketch across 0xSCADA gateways

### 4.3 MapReduce & Massively Parallel Computation (2.5h)
- MPC model and round complexity
- Filtering and graph connectivity in MPC
- Composable coresets
- **Problem Set:** Design MPC algorithms for industrial data aggregation

### 4.4 Consensus & Sublinear Verification (2.5h)
- Interactive proofs and streaming verification
- Annotated data streams (Chakrabarti et al.)
- Arthur-Merlin streaming
- Connection to blockchain verification
- **Implementation Project:** Streaming verification protocol for 0xSCADA blockchain anchor integrity

### Reading List
- Kushilevitz & Nisan, *Communication Complexity*
- Cormode, "The Continuous Distributed Monitoring Model"
- Roughgarden, "Communication Complexity (for Algorithm Designers)"

---

## Module 5: Sublinear Graph Algorithms (10h)

### 5.1 Sublinear-Time Graph Algorithms (2.5h)
- Query models: adjacency matrix, adjacency list, incidence
- Approximating average degree, number of edges
- Connected component estimation
- **Problems:** Analyze query complexity for graph parameter estimation

### 5.2 Graph Sparsification (2.5h)
- Spectral sparsifiers (Spielman & Teng)
- Cut sparsifiers (Benczúr & Karger)
- Spanners
- **Implementation Project:** Graph sparsifier for 0xSCADA network topology visualization

### 5.3 Streaming Graph Algorithms (2.5h)
- Semi-streaming model (Ο̃(n) space)
- Connectivity and spanning forests in streams
- Graph sketching (AGM sketch)
- Matchings and vertex cover in streams
- **Problem Set:** Design streaming algorithms for monitoring industrial network connectivity

### 5.4 Local Computation Algorithms (2.5h)
- LCA model and probe complexity
- Local algorithms for maximal independent set
- Local graph partitioning (Spielman & Teng, Andersen et al.)
- Distributed local algorithms (LOCAL model)
- **Implementation Project:** Local graph clustering for identifying related alarm groups in 0xSCADA event graphs

### Reading List
- Goldreich & Ron, "Property Testing in Bounded Degree Graphs"
- McGregor, "Graph Stream Algorithms: A Survey"
- Rubinfeld & Shapira, "Sublinear Time Algorithms"

---

## Module 6: Applied Sublinear Methods in Blockchain (10h)

### 6.1 Bloom Filters & Authenticated Data Structures (2.5h)
- Bloom filters, counting Bloom filters, cuckoo filters
- Merkle trees and authenticated dictionaries
- Accumulator schemes
- **Implementation Project:** Cuckoo filter for 0xSCADA tag deduplication in anchor batches

### 6.2 Succinct Proofs & Verification (2.5h)
- Probabilistically Checkable Proofs (PCPs)
- SNARKs and STARKs: sublinear verification
- Recursive composition
- **Exercise:** Analyze verification complexity of 0xSCADA anchor proofs

### 6.3 Light Client Protocols (2.5h)
- SPV and light client verification
- Superblock protocols (NiPoPoW)
- Flyweight blockchain verification
- Sublinear sync protocols
- **Implementation Project:** Design a light verification protocol for 0xSCADA blockchain anchors

### 6.4 Capstone: Sublinear Industrial Data Pipeline (2.5h)
- **Capstone Project:** Build an end-to-end sublinear data pipeline for 0xSCADA:
  1. Streaming frequency estimation on incoming tag data
  2. HyperLogLog cardinality tracking per gateway
  3. Distribution testing for anomaly detection
  4. Sketch-based aggregation across distributed gateways
  5. Blockchain anchor verification with sublinear proofs
  6. Performance benchmarks: compare exact vs. sketch-based approaches

### Reading List
- Narayanan et al., *Bitcoin and Cryptocurrency Technologies* (Ch. 1)
- Ben-Sasson et al., "SNARKs for C" / "Scalable Zero Knowledge"
- Kiayias, Miller & Zindros, "Non-Interactive Proofs of Proof-of-Work"

---

## Assessment

| Component | Weight |
|---|---|
| Problem sets (4 sets) | 25% |
| Implementation projects (8 projects) | 45% |
| Capstone project | 20% |
| Reading reflections | 10% |

## Tools & Software

- **TypeScript / Node.js** — Primary implementation language (0xSCADA ecosystem)
- **Python** (NumPy, SciPy) — Prototyping and analysis
- **0xSCADA CLI** — Data source and verification target
- **Solidity / Hardhat** — Smart contract experiments
- **Jupyter Notebooks** — Interactive exploration
