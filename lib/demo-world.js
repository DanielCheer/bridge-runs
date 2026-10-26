// lib/demo-world.js — the synthetic world module (fixtures/world.mjs), loaded only in demo mode
// (DEMO_MODE=1, docs/DEMO.md); null in production, which never imports the fixture.
import { DEMO_MODE } from '../guard.js';

const demoWorld = DEMO_MODE ? await import('../fixtures/world.mjs') : null;

export {
  demoWorld,
};
