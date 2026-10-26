// The waiver QR/link comes only from WAIVER_URL. Without it the section is not rendered and
// /waiver-qr.svg is a 404: no organization's real form is ever a built-in default.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';

const URL_SET = 'https://forms.example.test/waiver/123';
let bare, configured;
before(async () => {
  [bare, configured] = await Promise.all([startApp(), startApp({ env: { WAIVER_URL: URL_SET } })]);
});
after(async () => { await Promise.all([bare?.stop(), configured?.stop()]); });

test('without WAIVER_URL there is no waiver QR section and no QR image', async () => {
  const html = await (await bare.get('/')).text();
  assert.doesNotMatch(html, /waiver-qr\.svg|Sign the waiver/);
  assert.doesNotMatch(html, /churchcenter/);
  assert.equal((await bare.get('/waiver-qr.svg')).status, 404);
});

test('with WAIVER_URL the section links to it and the QR encodes it', async () => {
  const html = await (await configured.get('/')).text();
  assert.match(html, /<img src="\/waiver-qr\.svg"/);
  assert.ok(html.includes(`href="${URL_SET}"`), 'the link beside the QR is WAIVER_URL');
  const svg = await configured.get('/waiver-qr.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await svg.text(), /^<svg/);
});
