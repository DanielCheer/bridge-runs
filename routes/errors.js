// routes/errors.js — the terminal error handler: any throw in a route (or an async reject passed
// to next) is logged and answered with a friendly 500, never Express's stack-trace page.
// registerTerminalError(app) must be the last app.use at boot; programs mounted later re-append
// it (see mountPendingPrograms).

// Terminal error handler — registered LAST (after every inline + mounted route) so a sync throw
// (or a forwarded async reject via next(e)) in ANY route lands here with a friendly 500 instead of
// a hung socket OR Express's stack-trace-leaking default handler. Must be the last app.use (4-arg).
function terminalError(err, req, res, next) {
  console.error(`[route-error] ${req.method} ${req.originalUrl}: ${(err && err.stack) || err}`);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong on our end. Please try again in a moment.');
}
let TERMINAL_REGISTERED = false;

export function registerTerminalError(app) {
  app.use(terminalError);
  TERMINAL_REGISTERED = true;
}

export {
  terminalError, TERMINAL_REGISTERED,
};
