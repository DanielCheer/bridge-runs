// The route table: every Express layer (routes and middleware) in registration order, with each
// route's handler chain. Moving routes between files must not change which routes exist, the order
// Express tries them in, or the guards in front of them. Compared to test/snapshots/routes.txt;
// after an intended route change, regenerate it with UPDATE_SNAPSHOTS=1 npm test and review the diff.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, REPO, ADMIN } from './helpers/app.mjs';

const SNAPSHOT = path.join(REPO, 'test', 'snapshots', 'routes.txt');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

test('the route table matches the committed snapshot', async () => {
  const r = await app.get('/admin/test/routes', { as: ADMIN });
  assert.equal(r.status, 200);
  const live = await r.text();
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, live);
  }
  assert.equal(live, fs.readFileSync(SNAPSHOT, 'utf8'));
});

test('the route dump needs an admin', async () => {
  const r = await app.get('/admin/test/routes', { as: 'player01@test.local' });
  assert.notEqual(r.status, 200);
});
