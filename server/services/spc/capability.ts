/**
 * Process Capability Indices
 * 
 * Issue #353: Statistical Process Control
 * 
 * Computes Cp, Cpk, Pp, Ppk indices for process capability analysis.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface SpecificationLimits {
  usl: number;  // Upper specification limit
  lsl: number;  // Lower specification limit
  target?: number;
}

export interface CapabilityIndices {
  /** Process Capability (short-term, within-subgroup variation) */
  cp: number;
  /** Process Capability Index (accounts for centering) */
  cpk: number;
  /** Process Performance (long-term, total variation) */
  pp: number;
  /** Process Performance Index (accounts for centering) */
  ppk: number;
  /** Process mean */
  mean: number;
  /** Within-subgroup std dev estimate */
  sigmaWithin: number;
  /** Overall std dev */
  sigmaOverall: number;
  /** Estimated % out of spec */
  estimatedDefectRate: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function overallStdDev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Approximate normal CDF using Abramowitz & Stegun */
function normalCDF(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ─── Computation ────────────────────────────────────────────────────────

/**
 * Compute capability indices from individual measurements and subgroup data.
 * 
 * @param values All individual measurements
 * @param subgroupRanges Average range per subgroup (for within-group sigma estimation)
 * @param subgroupSize Size of subgroups
 * @param specs Specification limits
 */
export function computeCapability(
  values: number[],
  subgroupRanges: number[],
  subgroupSize: number,
  specs: SpecificationLimits,
): CapabilityIndices {
  if (values.length === 0) {
    return { cp: 0, cpk: 0, pp: 0, ppk: 0, mean: 0, sigmaWithin: 0, sigmaOverall: 0, estimatedDefectRate: 1 };
  }

  // d2 constants for subgroup sizes 2–10
  const d2: Record<number, number> = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078 };
  const d2Val = d2[Math.min(10, Math.max(2, subgroupSize))] ?? 2.326;

  const m = mean(values);
  const rBar = subgroupRanges.length > 0 ? mean(subgroupRanges) : 0;
  const sigmaWithin = rBar / d2Val || overallStdDev(values);
  const sigmaTotal = overallStdDev(values);

  const spread = specs.usl - specs.lsl;

  // Cp / Cpk (short-term)
  const cp = sigmaWithin > 0 ? spread / (6 * sigmaWithin) : 0;
  const cpu = sigmaWithin > 0 ? (specs.usl - m) / (3 * sigmaWithin) : 0;
  const cpl = sigmaWithin > 0 ? (m - specs.lsl) / (3 * sigmaWithin) : 0;
  const cpk = Math.min(cpu, cpl);

  // Pp / Ppk (long-term)
  const pp = sigmaTotal > 0 ? spread / (6 * sigmaTotal) : 0;
  const ppu = sigmaTotal > 0 ? (specs.usl - m) / (3 * sigmaTotal) : 0;
  const ppl = sigmaTotal > 0 ? (m - specs.lsl) / (3 * sigmaTotal) : 0;
  const ppk = Math.min(ppu, ppl);

  // Estimated defect rate
  const zUpper = sigmaTotal > 0 ? (specs.usl - m) / sigmaTotal : Infinity;
  const zLower = sigmaTotal > 0 ? (m - specs.lsl) / sigmaTotal : Infinity;
  const defectRate = (1 - normalCDF(zUpper)) + (1 - normalCDF(zLower));

  return { cp, cpk, pp, ppk, mean: m, sigmaWithin, sigmaOverall: sigmaTotal, estimatedDefectRate: defectRate };
}
