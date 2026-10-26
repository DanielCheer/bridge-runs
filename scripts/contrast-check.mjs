// contrast-check.mjs — WCAG 2.x contrast for the app's main text/background pairs, read from the
// real tokens in public/styles.css (so the check can't drift from the stylesheet).
//
//   node scripts/contrast-check.mjs        prints every pair; exits 1 if any is under 4.5:1
//
// test/contrast.test.mjs runs the same check inside `npm test`.
//
// Contrast is (L1 + 0.05) / (L2 + 0.05) over WCAG relative luminance:
//   L = 0.2126 R + 0.7152 G + 0.0722 B, each channel c = s/255 linearised as
//   c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4.
//
// Buttons sit on a vertical gradient (--solid), so their label is checked against the gradient
// colour (interpolated in sRGB, as browsers paint it) at 40%, 50% and 60% of the button's height:
// a centred single-line uppercase label in a .btn (52px tall, 14px text) or .btn.sm (44px, 12px)
// has its glyphs inside that band.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 4.5;

// --name:value pairs declared in the first block whose selector is exactly `selector`.
function tokens(css, selector) {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`));
  if (!m) throw new Error(`no ${selector}{…} block in styles.css`);
  const out = {};
  for (const [, k, v] of m[2].matchAll(/--([\w-]+):\s*([^;]+);?/g)) out[k] = v.trim();
  return out;
}
// The declarations of the first rule for `selector` (exact selector text).
function rule(css, selector) {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`));
  if (!m) throw new Error(`no ${selector}{…} rule in styles.css`);
  return Object.fromEntries([...m[2].matchAll(/([\w-]+):([^;]+)/g)].map(([, k, v]) => [k.trim(), v.trim()]));
}

const hex = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) throw new Error(`not a hex colour: ${h}`);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The colour of `linear-gradient(<angle>, c0 [p0%], c1 [p1%], …)` at `at` (0..1).
function gradientAt(grad, at) {
  const inner = grad.replace(/^linear-gradient\(/, '').replace(/\)$/, '');
  const parts = inner.split(',').map((s) => s.trim()).filter((s) => !/deg$/.test(s));
  const stops = parts.map((p, i) => {
    const [c, pos] = p.split(/\s+/);
    return { c: hex(c), p: pos ? parseFloat(pos) / 100 : i === 0 ? 0 : i === parts.length - 1 ? 1 : NaN };
  });
  if (stops.some((s) => Number.isNaN(s.p))) throw new Error(`unpositioned middle stop in ${grad}`);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (at <= b.p) {
      const t = b.p === a.p ? 0 : (at - a.p) / (b.p - a.p);
      return a.c.map((v, k) => Math.round(v + (b.c[k] - v) * t));
    }
  }
  return stops[stops.length - 1].c;
}

// Resolve `var(--x)` (one level, against the theme's tokens then :root's) or a literal hex.
const resolve = (v, theme) => {
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  if (!m) return v;
  const t = theme[m[1]];
  if (!t) throw new Error(`token --${m[1]} not defined`);
  return resolve(t, theme);
};

export function checkContrast(css = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8')) {
  const root = tokens(css, ':root');
  const themes = { base: root, pk: { ...root, ...tokens(css, 'body.pk') }, vb: { ...root, ...tokens(css, 'body.vb') } };
  const results = [];
  const pair = (name, fg, bg) => results.push({ name, ratio: contrast(hex(fg), hex(bg)), fg, bg });
  const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  // The rules this check is about must still use the tokens it measures.
  const eyebrow = rule(css, '.eyebrow'), btn = rule(css, '.btn'), label = rule(css, 'label');
  const expect = (cond, msg) => { if (!cond) throw new Error(`styles.css: ${msg}`); };
  expect(eyebrow.color === 'var(--orange-deep)', '.eyebrow color is no longer var(--orange-deep)');
  expect(btn.background === 'var(--solid)' && btn.color === '#fff', '.btn is no longer white text on var(--solid)');
  expect(label.color === 'var(--muted)', 'label color is no longer var(--muted)');

  for (const [t, tok] of Object.entries(themes)) {
    const bg = resolve('var(--bg)', tok), card = resolve('var(--card)', tok);
    // body text, muted text (labels, hints), links and the eyebrow (pk/vb re-colour it teal)
    pair(`${t}: ink on bg`, resolve('var(--ink)', tok), bg);
    pair(`${t}: muted (labels) on bg`, resolve('var(--muted)', tok), bg);
    pair(`${t}: muted (labels) on card`, resolve('var(--muted)', tok), card);
    // pk/vb re-colour the eyebrow and links: pk with its darker text teal, vb with --teal.
    const eyebrowColor = t === 'base' ? resolve(eyebrow.color, tok) : resolve(rule(css, `body.${t} .eyebrow`).color, tok);
    pair(`${t}: eyebrow on bg`, eyebrowColor, bg);
    pair(`${t}: eyebrow on card`, eyebrowColor, card);
    if (t === 'base') {
      pair('base: link on bg', resolve('var(--link)', tok), bg);
      pair('base: link on card', resolve('var(--link)', tok), card);
    }
    // the button label on its gradient (white on orange; dark accent ink on the pk/vb cream)
    const btnFg = t === 'base' ? '#FFFFFF' : resolve('var(--accent-ink)', tok);
    for (const at of [0.4, 0.5, 0.6]) {
      pair(`${t}: .btn label on --solid at ${at * 100}%`, btnFg, toHex(gradientAt(resolve('var(--solid)', tok), at)));
    }
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const results = checkContrast();
  let bad = 0;
  for (const r of results) {
    const ok = r.ratio >= MIN;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(5)}:1  ${r.name}  (${r.fg} on ${r.bg})`);
  }
  console.log(bad ? `\n${bad} pair(s) under ${MIN}:1` : `\nall ${results.length} pairs >= ${MIN}:1`);
  process.exit(bad ? 1 : 0);
}

export { MIN };
