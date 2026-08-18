import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combineCalibrationArtifactScore,
  rerankCalibrationCandidates
} from '../src/video/calibrationRerank.js';

test('artifact contribution stays lightly bounded relative to the base calibration score', () => {
  const base = 10;
  const combined = combineCalibrationArtifactScore(base, { score: 100, coverage: 1 }, {
    artifactWeight: 0.20,
    maxRelativePenalty: 0.10
  });
  assert.equal(combined, 11);
});

test('zero coverage leaves the base calibration score unchanged', () => {
  const base = 4.25;
  assert.equal(combineCalibrationArtifactScore(base, { score: 12, coverage: 0 }), base);
});

test('top-N reranking evaluates only the small leading candidate subset and can prefer a cleaner near-tie', async () => {
  const candidates = [
    { id: 'a', selectionScore: 10.00 },
    { id: 'b', selectionScore: 10.03 },
    { id: 'c', selectionScore: 10.08 },
    { id: 'd', selectionScore: 10.50 },
    { id: 'e', selectionScore: 11.00 }
  ];
  const calls = [];
  const artifacts = {
    a: { score: 8, coverage: 1 },
    b: { score: 0.4, coverage: 1 },
    c: { score: 3, coverage: 0.8 }
  };
  const result = await rerankCalibrationCandidates(candidates, async (candidate) => {
    calls.push(candidate.id);
    return artifacts[candidate.id] || { score: 0, coverage: 0 };
  }, {
    topN: 3,
    artifactWeight: 0.055,
    maxRelativePenalty: 0.10
  });

  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(result.topN, 3);
  assert.equal(result.evaluated.length, 3);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.excludedByGap, 2);
  assert.equal(result.selected.id, 'b');
  assert.ok(result.selected.finalScore < result.evaluated.find((item) => item.id === 'a').finalScore);
});

test('duplicate calibration identities do not consume top-N artifact evaluation slots', async () => {
  const candidates = [
    {
      id: 'coarse-best', selectionScore: 5.00, profile: '96-20260520', shapeScale: 1,
      edgeBoost: 0.03, edgeGain: 1, offsetX: 0, offsetY: 0, bodyGain: 1
    },
    {
      id: 'subpixel-center-duplicate', selectionScore: 5.00, profile: '96-20260520', shapeScale: 1,
      edgeBoost: 0.03, edgeGain: 1, offsetX: 0, offsetY: 0, bodyGain: 1
    },
    {
      id: 'offset-left', selectionScore: 5.02, profile: '96-20260520', shapeScale: 1,
      edgeBoost: 0.03, edgeGain: 1, offsetX: -0.4, offsetY: 0, bodyGain: 1
    },
    {
      id: 'offset-right', selectionScore: 5.03, profile: '96-20260520', shapeScale: 1,
      edgeBoost: 0.03, edgeGain: 1, offsetX: 0.4, offsetY: 0, bodyGain: 1
    }
  ];
  const calls = [];
  const result = await rerankCalibrationCandidates(candidates, async (candidate) => {
    calls.push(candidate.id);
    return { score: 0, coverage: 0 };
  }, { topN: 3 });

  assert.deepEqual(calls, ['coarse-best', 'offset-left', 'offset-right']);
  assert.equal(result.inputCount, 4);
  assert.equal(result.uniqueCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.topN, 3);
});

test('clearly worse base candidates are excluded from artifact reranking', async () => {
  const candidates = [
    { id: 'base-winner', selectionScore: 10.00 },
    { id: 'clear-loser', selectionScore: 10.30 }
  ];
  const calls = [];
  const result = await rerankCalibrationCandidates(candidates, async (candidate) => {
    calls.push(candidate.id);
    return candidate.id === 'base-winner'
      ? { score: 100, coverage: 1 }
      : { score: 0, coverage: 1 };
  });

  assert.deepEqual(calls, ['base-winner']);
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.excludedByGap, 1);
  assert.equal(result.topN, 1);
  assert.equal(result.selected.id, 'base-winner');
  assert.equal(result.maxRelativeGap, 0.02);
  assert.equal(result.maxAbsoluteGap, 0.20);
});
