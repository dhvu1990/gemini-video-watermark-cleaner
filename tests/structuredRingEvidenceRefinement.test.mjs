import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredResidualRingSuppression } from '../src/video/structuredRingSuppress.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 5) alpha[y * width + x] = 0.58;
      else if (d <= 7) alpha[y * width + x] = 0.22;
      else if (d <= 9) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

function damaged(width, height, alpha) {
  return image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p] || 0;
    const base = [64 + x * 2, 82 + y, 120 + ((x + y) % 5)];
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const ring = a > 0.004 && a < 0.30 && d >= 5 && d <= 9;
    const halo = ring ? 18 : 0;
    return [base[0] - halo, base[1] - halo, base[2] - halo];
  });
}

const isolated = {
  consensus: false,
  shapeGhost: false,
  centerSeam: false,
  localToneMatch: false,
  outerHalo: false,
  microSalvage: false,
  totalThreshold: 0,
  lumaThreshold: 0
};

test('evidence refinement stays closed when score and density evidence are insufficient', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const input = damaged(width, height, alpha);
  const result = applyStructuredResidualRingSuppression(input, alpha, {
    ...isolated,
    strength: 0.08,
    evidenceRefinement: true,
    refinementMinScore: 999,
    refinementMinDensity: 1
  });

  assert.equal(result.structuredRing.refinement.enabled, true);
  assert.equal(result.structuredRing.refinement.attempted, false);
  assert.equal(result.structuredRing.refinement.accepted, false);
});

test('evidence refinement attempts only after both gates pass and rolls back unsafe candidates', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const input = damaged(width, height, alpha);
  const result = applyStructuredResidualRingSuppression(input, alpha, {
    ...isolated,
    strength: 0.08,
    evidenceRefinement: true,
    refinementMinScore: 0,
    refinementMinDensity: 0,
    refinementStrength: 0.18
  });
  const refinement = result.structuredRing.refinement;

  assert.equal(refinement.attempted, true);
  assert.ok(refinement.beforeGlobal);
  assert.ok(refinement.candidateGlobalAfter);
  assert.ok(refinement.beforeAligned);
  assert.ok(refinement.candidateAlignedAfter);
  assert.ok(refinement.candidatePixels >= 0);

  if (refinement.accepted) {
    assert.ok(refinement.candidateAlignedAfter.score <= refinement.beforeAligned.score * 0.985 + 1e-9);
    assert.ok(refinement.candidateGlobalAfter.total <= refinement.beforeGlobal.total * 1.002 + 1e-9);
    assert.ok(refinement.candidateGlobalAfter.luma <= refinement.beforeGlobal.luma * 1.004 + 1e-9);
    assert.ok(refinement.candidateGlobalAfter.chroma <= refinement.beforeGlobal.chroma * 1.004 + 1e-9);
    assert.match(result.structuredRing.acceptedMode, /evidence-refine/);
  } else {
    assert.doesNotMatch(result.structuredRing.acceptedMode, /evidence-refine/);
  }
});
