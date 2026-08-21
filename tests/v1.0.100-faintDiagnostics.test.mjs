import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFaintDetectionDiagnostics } from '../src/faintDetectionDiagnosticsUI.js';

test('diagnostics exposes the true faint calibration rejection reason', () => {
  const d = deriveFaintDetectionDiagnostics({
    detected: false,
    safeToClean: false,
    reason: 'low-confidence',
    detectionSource: 'catalog-anchor',
    candidateId: 'veo-portrait-1080-inset@0,-2',
    rawConfidence: 0.0414,
    maxConfidence: 0.048,
    faintAnchorSafety: {
      safe: true,
      probeOnly: true,
      ultraFaint: true,
      reason: 'ultra-faint-exact-anchor-probe',
      signature: { supportRatio: 0.42, gradientRatio: 0.50, spatialRatio: 0.33 }
    },
    calibration: {
      bodyGain: 0.24,
      improvement: 0.031,
      baselineScore: 10,
      residualScore: 9.69,
      lowGainSearch: true,
      baselineMode: 'no-cleanup'
    }
  });

  assert.equal(d.gateReason, 'faint-anchor-probe-no-strong-improvement');
  assert.equal(d.probeOnly, true);
  assert.equal(d.bodyGain, 0.24);
  assert.equal(d.improvement, 0.031);
  assert.equal(Number(d.residualRatio.toFixed(3)), 0.969);
});

test('diagnostics exposes pre-calibration faint gate failure when probe never runs', () => {
  const d = deriveFaintDetectionDiagnostics({
    safeToClean: false,
    reason: 'low-confidence',
    candidateId: 'veo-portrait-1080-inset@0,-2',
    confidence: 0.041,
    maxConfidence: 0.043,
    faintAnchorSafety: {
      safe: false,
      reason: 'probe-signature-too-weak',
      signature: { supportRatio: 0.16, gradientRatio: 0.25, spatialRatio: 0.08 }
    }
  });

  assert.equal(d.gateReason, 'probe-signature-too-weak');
  assert.equal(d.bodyGain, null);
  assert.equal(d.improvement, null);
  assert.equal(d.residualRatio, null);
});
