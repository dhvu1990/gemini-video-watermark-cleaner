import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyLateResidualHarmonizer } from '../src/video/lateResidualHarmonizer.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width = 72, height = 72) {
  const alpha = new Float32Array(width * height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      let a = 0;
      if (d <= 9) a = 0.36;
      else if (d <= 12) a = 0.22;
      else if (d <= 15) a = 0.10;
      else if (d <= 17) a = 0.045;
      alpha[y * width + x] = a;
    }
  }
  return alpha;
}

function rgbAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}

function lumaAt(image, x, y) {
  const rgb = rgbAt(image, x, y);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

const relaxedAxis = {
  axisMinScore: 0.05,
  axisMinSamples: 1,
  axisMinCorrectedPixels: 1,
  axisMinImprovement: 0,
  axisResidualSoft: 0.01,
  axisResidualHard: 0.20,
  axisHardSceneGuard: 1.1,
  axisStrength: 0.34,
  axisMaxBlend: 0.18,
  axisMaxLumaDelta: 5,
  axisAcceptedMaxMeanBlend: 0.19,
  axisAcceptedMaxLumaDelta: 5.1,
  planeMinScore: 999,
  maxOutlineRatio: 1.5,
  sceneEdgeOptions: { minGradient: 999 }
};

test('v1.0.122 axis-adaptive finish reduces a horizontal center seam missed by body cleanup', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const image = makeImage(width, height, (x, y) => {
    const a = alpha[y * width + x] || 0;
    if (y === cy && a >= 0.045) return [108, 108, 108];
    return [100, 100, 100];
  });
  const before = lumaAt(image, cx + 5, cy);
  const result = applyLateResidualHarmonizer(image, alpha, relaxedAxis);
  const diagnostics = result.lateResidualHarmonizer;
  assert.equal(diagnostics.axisSeam.attempted, true, JSON.stringify(diagnostics.axisSeam));
  assert.equal(diagnostics.axisSeam.accepted, true, JSON.stringify(diagnostics.axisSeam));
  assert.ok(diagnostics.axisSeam.correctedPixels >= 1, JSON.stringify(diagnostics.axisSeam));
  assert.ok(lumaAt(result, cx + 5, cy) < before, `before=${before}, after=${lumaAt(result, cx + 5, cy)}`);
});

test('axis finish refuses a strong real high-contrast center line', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const image = makeImage(width, height, (x, y) => y === cy ? [232, 232, 232] : [88, 88, 88]);
  const before = rgbAt(image, cx, cy);
  const result = applyLateResidualHarmonizer(image, alpha, {
    ...relaxedAxis,
    axisMaxResidual: 14
  });
  assert.deepEqual(rgbAt(result, cx, cy), before);
});

test('bright-flat tone rematch reduces a pale diamond ghost while keeping a strong crossing line intact', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const lineX = cx + 4;
  const sampleX = cx - 5;
  const image = makeImage(width, height, (x, y) => {
    if (x === lineX) return [238, 238, 238];
    const a = alpha[y * width + x] || 0;
    return a >= 0.045 ? [197, 194, 190] : [190, 190, 190];
  });
  const ghostBefore = lumaAt(image, sampleX, cy);
  const lineBefore = rgbAt(image, lineX, cy);
  const result = applyLateResidualHarmonizer(image, alpha, {
    axisMinScore: 999,
    planeMinScore: 0.05,
    planeMinSamples: 1,
    planeMinCorrectedPixels: 1,
    planeMinImprovement: 0,
    planeResidualSoft: 0.01,
    planeResidualHard: 0.20,
    planeStrength: 0.38,
    planeMaxBlend: 0.22,
    planeMaxChannelDelta: 7,
    planeAcceptedMaxMeanShift: 2.2,
    maxOutlineRatio: 1.5
  });
  const diagnostics = result.lateResidualHarmonizer;
  assert.equal(diagnostics.referenceStats.brightSmooth, true, JSON.stringify(diagnostics.referenceStats));
  assert.equal(diagnostics.planeTone.attempted, true, JSON.stringify(diagnostics.planeTone));
  assert.equal(diagnostics.planeTone.accepted, true, JSON.stringify(diagnostics.planeTone));
  assert.ok(lumaAt(result, sampleX, cy) < ghostBefore, `before=${ghostBefore}, after=${lumaAt(result, sampleX, cy)}`);
  assert.deepEqual(rgbAt(result, lineX, cy), lineBefore, 'strong real crossing line must remain unchanged');
});

test('production late harmonizer keeps narrow caps and runs after guarded faint ghost dissolve', () => {
  const source = fs.readFileSync(new URL('../src/video/lateResidualHarmonizer.js', import.meta.url), 'utf8');
  assert.match(source, /axisMaxBlend \?\? 0\.14/);
  assert.match(source, /axisMaxLumaDelta \?\? 4\.0/);
  assert.match(source, /planeMaxBlend \?\? \(bright \? 0\.18 : 0\.085\)/);
  assert.match(source, /planeMaxChannelDelta \?\? \(bright \? 6\.0 : 3\.0\)/);
  assert.match(source, /crossingEdge\.protect && !bright/);
  assert.match(source, /candidateOutline\.score <= planeBeforeOutline\.score/);

  const wrapper = fs.readFileSync(new URL('../src/video/residualStructureContinuation.js', import.meta.url), 'utf8');
  const guardedIndex = wrapper.lastIndexOf('applyGuardedFaintGhostDissolve');
  const lateIndex = wrapper.lastIndexOf('applyLateResidualHarmonizer');
  assert.ok(guardedIndex >= 0);
  assert.ok(lateIndex > guardedIndex);
  assert.match(wrapper, /lateResidualHarmonizerAccepted/);
  assert.match(wrapper, /brightFlatToneRematchAccepted/);
});
