// run-demo.mjs — run the public demo (docs/DEMO.md): a supervisor that keeps one demo server alive
// and gives it a clean world every time it starts.
//
//   npm run demo                                   # http://localhost:3100, data under the OS temp dir
//   node scripts/run-demo.mjs --port 3100 --data <dir>
//
// Loop: wipe the data folder (database, backups + key, uploads, avatars, banners) → start
// `node server.js` with DEMO_MODE=1 and every path inside that folder → wait for it to exit.
// The server seeds the synthetic world on its empty database and exits on its own after
// DEMO_RESET_HOURS (default 6) or when the organizer persona presses Reset; either way the next
// lap starts from nothing. guard.js refuses the demo outright if any path points at the app
// directory (the live database, backups or backup key), so the supervisor cannot be aimed at them.
//
// Each boot gets a fresh random SESSION_SECRET, so a reset also signs everyone out. Nothing
// reaches outside: no SMTP (sign-in codes show on screen), Planning Center pointed at a closed
// local port, and only the parent's non-app environment is passed through.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PERSONAS } from '../fixtures/world.mjs';
import { withoutAppEnv } from './app-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { port: { type: 'string' }, data: { type: 'string' } } });
const port = Number(values.port || process.env.PORT || 3100);
if (!Number.isInteger(port) || port <= 0) { console.error(`[demo] invalid port "${values.port || process.env.PORT}"`); process.exit(2); }
const root = path.resolve(values.data || process.env.DEMO_DATA_DIR || path.join(os.tmpdir(), 'bridge-runs-demo'));

// The data folder is emptied on every start, so the supervisor only ever empties a folder it owns:
// one that is empty, or that carries its marker file from an earlier run. Anything else is refused
// rather than deleted.
const MARK = '.bridge-runs-demo';
function claimRoot() {
  fs.mkdirSync(root, { recursive: true });
  const entries = fs.readdirSync(root);
  if (entries.length && !entries.includes(MARK)) {
    console.error(`[demo] ${root} is not empty and was not created by run-demo.mjs; refusing to wipe it. Pass --data <empty or new folder>.`);
    process.exit(2);
  }
  fs.writeFileSync(path.join(root, MARK), 'Scratch data for scripts/run-demo.mjs. Everything here is deleted on every demo start.\n');
}
function wipe() {
  for (const e of fs.readdirSync(root)) {
    if (e !== MARK) fs.rmSync(path.join(root, e), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// The parent's environment minus anything the app reads (so a developer's exported SMTP or PCO
// settings can never reach the demo), plus the demo's own. DEMO_RESET_* pass through as tuning.
function demoEnv() {
  const env = withoutAppEnv(process.env);
  for (const k of ['DEMO_RESET_HOURS', 'DEMO_RESET_COOLDOWN_S']) if (process.env[k]) env[k] = process.env[k];
  return {
    ...env,
    DEMO_MODE: '1',
    PORT: String(port),
    DB_PATH: path.join(root, 'app.db'),
    BACKUP_DIR: path.join(root, 'backups'),
    BACKUP_KEY_FILE: path.join(root, 'backup.key'),
    CHAT_MEDIA_DIR: path.join(root, 'media'),
    AVATARS_DIR: path.join(root, 'avatars'),
    BANNER_DIR: path.join(root, 'banners'),
    PCO_API_BASE: 'http://127.0.0.1:1',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_EMAILS: PERSONAS.admin,
  };
}

// Stopping the supervisor stops the server. Ctrl+C (SIGINT), SIGTERM (docker stop, kill), Ctrl+Break
// on Windows (SIGBREAK) and a closed terminal or console window (SIGHUP) all end the loop and pass
// the stop on to the child; the loop then exits once the child has. The exit hook covers every
// other way out (a crash-loop give-up, an uncaught error): a server must never outlive its
// supervisor and keep the port. A hard kill of the supervisor itself (SIGKILL, taskkill /F) can't
// be caught by any process; run it under a service manager or Docker for that case.
let child = null, stopping = false;
const stop = () => { stopping = true; if (child) child.kill(); else process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, stop);
process.on('exit', () => { if (child && child.exitCode === null) child.kill(); });

claimRoot();
const crashes = [];
for (;;) {
  wipe();
  console.log(`[demo] starting a clean demo on http://localhost:${port} (data: ${root})`);
  child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: demoEnv(), stdio: 'inherit' });
  const code = await new Promise((resolve) => child.once('exit', (c, signal) => resolve(c ?? signal)));
  child = null;
  if (stopping) break;
  if (code === 90) { console.error('[demo] the isolation guard refused to start the demo (see above).'); process.exit(90); }
  if (code === 0) { console.log('[demo] reset: wiping the world and starting again'); continue; }
  const now = Date.now();
  crashes.push(now);
  if (crashes.filter((t) => t > now - 60_000).length >= 5) {
    console.error(`[demo] the server crashed 5 times within a minute (last exit: ${code}); giving up.`);
    process.exit(1);
  }
  console.error(`[demo] the server exited unexpectedly (${code}); restarting on a clean world in 5 s`);
  await new Promise((r) => setTimeout(r, 5000));
}
process.exit(0);
