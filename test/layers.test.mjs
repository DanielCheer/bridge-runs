// The module layering (docs/ARCHITECTURE.md), checked on the source: each layer imports only from
// layers below it, so the import graph stays acyclic and a reader knows where to look. No app boot.
//
//   config.js                      environment (imports guard.js only)
//   views/                         pages; config.js and other views only
//   guard db db-migrate auth mailer backup pco   infrastructure
//   lib/                           shared helpers; infrastructure, views, lib
//   engine/                        domain logic; everything above except routes
//   routes/                        HTTP surface; anything except server.js
//   server.js                      the entry; nothing imports it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers/app.mjs';

const INFRA = new Set(['guard.js', 'db.js', 'db-migrate.js', 'auth.js', 'mailer.js', 'backup.js', 'pco.js']);
const layerOf = (rel) => {
  if (rel === 'server.js') return 'server';
  if (rel === 'config.js') return 'config';
  if (INFRA.has(rel)) return 'infra';
  const top = rel.split('/')[0];
  return ['lib', 'engine', 'routes', 'views'].includes(top) ? top : null;
};
// What each layer may import (besides node builtins and packages).
const ALLOWED = {
  config: new Set(['infra']),               // guard.js, first, so the isolation check runs before any path is read
  views: new Set(['config', 'views']),
  infra: new Set(['infra', 'config', 'lib']), // pco.js shares lib/settings.js
  lib: new Set(['infra', 'config', 'views', 'lib']),
  engine: new Set(['infra', 'config', 'views', 'lib', 'engine']),
  routes: new Set(['infra', 'config', 'views', 'lib', 'engine', 'routes']),
  server: new Set(['infra', 'config', 'views', 'lib', 'engine', 'routes']),
};

function appFiles() {
  const out = [];
  for (const f of fs.readdirSync(REPO)) if (f.endsWith('.js') && layerOf(f)) out.push(f);
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  for (const d of ['lib', 'engine', 'routes', 'views']) walk(d);
  return out;
}

const specifiers = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'|import\('([^']+)'\)/g)]
  .map((m) => m[1] || m[2] || m[3]);

test('every app module imports only from the layers below it', () => {
  const violations = [];
  for (const rel of appFiles()) {
    const from = layerOf(rel);
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const spec of specifiers(src)) {
      if (!spec.startsWith('.')) continue;                       // node builtin or package
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (target.startsWith('fixtures/')) continue;              // lib/demo-world.js: demo-only fixture load
      const to = layerOf(target);
      if (to === 'server') violations.push(`${rel} imports server.js`);
      else if (!to || !ALLOWED[from].has(to)) violations.push(`${rel} (${from}) imports ${target} (${to})`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the layer check sees the whole app', () => {
  const files = appFiles();
  for (const d of ['lib/', 'engine/', 'routes/', 'views/pages/']) assert.ok(files.some((f) => f.startsWith(d)), d);
  assert.ok(files.includes('server.js') && files.includes('config.js'));
});
