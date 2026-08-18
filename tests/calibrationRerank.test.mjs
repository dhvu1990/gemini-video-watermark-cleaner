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
  assert.equal(result.selected.id, 'b');
  assert.ok(result.selected.finalScore < result.evaluated.find((item) => item.id === 'a').finalScore);
});
