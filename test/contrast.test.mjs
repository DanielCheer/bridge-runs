// WCAG contrast for the main text/background pairs, measured from the tokens in
// public/styles.css by scripts/contrast-check.mjs (see that file for the pairs and the formula).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContrast, contrast, MIN } from '../scripts/contrast-check.mjs';

test('the WCAG formula matches known values', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
  assert.equal(contrast([255, 255, 255], [255, 255, 255]).toFixed(2), '1.00');
  assert.equal(contrast([118, 118, 118], [255, 255, 255]).toFixed(2), '4.54');   // #767676, the classic AA grey
});

test(`every listed text/background pair is at least ${MIN}:1`, () => {
  const low = checkContrast().filter((r) => r.ratio < MIN).map((r) => `${r.name}: ${r.ratio.toFixed(2)}:1 (${r.fg} on ${r.bg})`);
  assert.deepEqual(low, []);
});
