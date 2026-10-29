import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyVeoWordmarkResidualMicroFinish } from '../src/video/veoWordmarkResidualFinish.js';

const SIZE = 67;
const BOUNDS = { x0: 12, x1: 54, y0: 35, y1: 58 };

function makeSourceAndRepaired({ originalMark = true, residual = true, checker = false } = {}) {
  const original = new Uint8ClampedArray(SIZE * SIZE * 4);
  const cleaned = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const base = 64 + Math.floor(x * 0.18 + y * 0.16) +
      ((x * 11 + y * 13) % 7) + (checker ? ((x + y) % 2) * 52 : 0);
    const mark = y >= 39 && y <= 54 && (
      (x >= 16 && x <= 22) || (x >= 31 && x <= 37) || (x >= 46 && x <= 52)
    );
    const ghost = mark && residual && (x + y) % 3 === 0 ? 20 : 0;
    for (let c = 0; c < 3; c++) {
      const channel = base - (c === 1 ? 13 : (c === 2 ? 24 : 0));
      original[i + c] = originalMark && mark ? Math.round(channel * 0.3 + 255 * 0.7) : channel;
      cleaned[i + c] = channel + ghost;
    }
    original[i + 3] = cleaned[i + 3] = 255;
  }
  return [
    { width: SIZE, height: SIZE, data: original },
    { width: SIZE, height: SIZE, data: cleaned }
  ];
}

test('v1.0.133 removes correlated white Veo pinholes after accepted base reconstruction', () => {
  const [original, cleaned] = makeSourceAndRepaired();
  const result = applyVeoWordmarkResidualMicroFinish(original, cleaned, BOUNDS);
  assert.equal(result.diagnostics.applied, true);
  assert.ok(result.diagnostics.changedPixels > 100);
  assert.ok(result.diagnostics.alignedImprovement > 1);
  assert.ok(result.diagnostics.after.aligned < result.diagnostics.initial.aligned * 0.35);
  assert.ok(result.diagnostics.maxDelta <= 41);
  assert.deepEqual(result.cleaned.data.slice(0, SIZE * 4 * 25), cleaned.data.slice(0, SIZE * 4 * 25),
    'unrelated scene outside the text footprint stays byte-identical');
});

test('v1.0.133 does not edit an already-clean smooth scene', () => {
  const [original, cleaned] = makeSourceAndRepaired({ residual: false });
  const result = applyVeoWordmarkResidualMicroFinish(original, cleaned, BOUNDS);
  assert.equal(result.diagnostics.applied, false);
  assert.equal(result.diagnostics.reason, 'no-correlated-bright-ghost');
  assert.deepEqual(result.cleaned.data, cleaned.data);
});

test('v1.0.133 does not invent glyph evidence on clean footage', () => {
  const [original, cleaned] = makeSourceAndRepaired({ originalMark: false, residual: false });
  const result = applyVeoWordmarkResidualMicroFinish(original, cleaned, BOUNDS);
  assert.equal(result.diagnostics.applied, false);
  assert.equal(result.diagnostics.reason, 'no-three-letter-residual-evidence');
  assert.deepEqual(result.cleaned.data, cleaned.data);
});

test('v1.0.133 preserves high-frequency exterior texture instead of flattening it', () => {
  const [original, cleaned] = makeSourceAndRepaired({ checker: true });
  const result = applyVeoWordmarkResidualMicroFinish(original, cleaned, BOUNDS);
  assert.equal(result.diagnostics.applied, false);
  assert.equal(result.diagnostics.reason, 'no-correlated-bright-ghost');
  assert.deepEqual(result.cleaned.data, cleaned.data);
});

test('v1.0.133 cannot run micro finish unless base Veo repair is accepted and donor is safe', () => {
  const source = fs.readFileSync(new URL('../src/video/veoWordmarkRepair.js', import.meta.url), 'utf8');
  const engine = fs.readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const alpha = fs.readFileSync(new URL('../src/video/veoWordmark.js', import.meta.url), 'utf8');
  assert.match(source, /if \(accepted && background\.fitMAE < 26\)/);
  assert.match(source, /applyVeoWordmarkResidualMicroFinish\(original, cleaned, bounds\)/);
  assert.match(source, /diagnostics\.residualMicroFinish = micro\.diagnostics/);
  assert.match(engine, /const repair = isVeoWordmarkCandidate\(detection\.candidateId\) \? repairVeoWordmarkPaddedRegion : repairPaddedRegion/);
  assert.match(engine, /const repair = wordmark \? repairVeoWordmarkPaddedRegion : repairPaddedRegion/);
  assert.match(ui, /preview\?\.veoWordmark/);
  assert.match(alpha, /export \{ repairVeoWordmarkPaddedRegion \} from '\.\/veoWordmarkRepair\.js'/);
});
