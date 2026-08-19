import { classifyStructuredFootprintRisk } from './video/structuredFootprintRisk.js';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percent(value) {
  const number = finite(value);
  return number === null ? '-' : `${(number * 100).toFixed(1)}%`;
}

function fixed(value, digits = 3) {
  const number = finite(value);
  return number === null ? '-' : number.toFixed(digits);
}

function yesNo(value) {
  return typeof value === 'boolean' ? (value ? 'YES' : 'NO') : '-';
}

export function formatAntiStreakTelemetry(summary = null) {
  const donor = summary?.temporalDonor || {};
  const atlas = summary?.atlas || {};
  const structured = summary?.structured || {};
  const footprint = structured?.footprint || {};
  const footprintRisk = classifyStructuredFootprintRisk(footprint);
  const flags = Array.isArray(summary?.riskFlags) ? summary.riskFlags.filter(Boolean) : [];

  return {
    riskFlags: flags.length ? flags.join(', ') : 'none',
    donorAttempted: yesNo(donor.attempted),
    donorAccepted: yesNo(donor.accepted),
    donorReason: donor.reason || '-',
    donorGuardedRatio: percent(donor.guardedRatio),
    donorStructureMismatch: fixed(donor.meanStructureMismatch, 3),
    donorTotalRatio: fixed(donor.totalRatio, 4),
    atlasDonors: Number.isFinite(Number(atlas.donorCount)) ? String(Math.max(0, Math.round(Number(atlas.donorCount)))) : '-',
    atlasConfidence: fixed(atlas.meanConfidence, 3),
    atlasDonorSpread: fixed(atlas.meanDonorSpread, 2),
    structuredAttempted: yesNo(structured.attempted),
    structuredAccepted: yesNo(structured.accepted),
    structuredMode: structured.acceptedMode || 'none',
    structuredBefore: fixed(structured.alignedBeforeScore, 3),
    structuredAfter: fixed(structured.alignedAfterScore, 3),
    structuredDensity: percent(structured.alignedSampleDensity),
    structuredImprovement: percent(structured.alignedImprovement),
    footprintScore: fixed(footprint.score, 3),
    footprintRawScore: fixed(footprint.rawScore, 3),
    footprintCoverage: percent(footprint.coverage),
    footprintShapeDensity: percent(footprint.shapeAlignedDensity),
    footprintContinuity: percent(footprint.continuityMean),
    footprintClass: footprintRisk.level === 'insufficient' ? '-' : footprintRisk.level.toUpperCase(),
    footprintEvidence: footprintRisk.level === 'insufficient' ? '-' : percent(footprintRisk.evidence),
    footprintReason: footprintRisk.level === 'insufficient' ? footprintRisk.reason : footprintRisk.reason
  };
}

export function formatAntiStreakExportSummary(repair = null) {
  const riskFrames = Math.max(0, Math.round(finite(repair?.antiStreakRiskFrames, 0)));
  const counts = repair?.antiStreakRiskFlagCounts && typeof repair.antiStreakRiskFlagCounts === 'object'
    ? repair.antiStreakRiskFlagCounts
    : {};
  const flagEntries = Object.entries(counts)
    .filter(([name, count]) => name && finite(count, 0) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
  return {
    riskFrames,
    flags: flagEntries.length ? flagEntries.map(([name, count]) => `${name}:${Math.round(Number(count))}`).join(', ') : 'none'
  };
}
