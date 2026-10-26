# Bottom-nav localizer: capture first, fix second

The fixed bottom tab bar sometimes rendered mid-screen in the installed iOS PWA. It had been
"fixed" several times, each time with a different heuristic and without a single measurement from
the device where it happens. This document describes the instrument built to end that: capture
what the device actually reports, map the capture to one mechanism, and only then change code.

Code: the client half is `__kbSync` in `views/client-app.js` (the client app script); the server
half is `POST /debug/geo` / `GET /debug/geo` in `routes/admin.js` (`mountNavLocalizer`), stored in
the `geo_reports` table (`db.js`).

---

## Taking a capture (an admin, on the phone)

1. When the nav is wrong **on screen**, **press and hold the masthead** (the top bar with the logo)
   for about a second, on any page.
2. A dark strip appears at the bottom: `geo captured · barBottom … · visibleBottom … · gap …`.
3. **Take a screenshot.** It pairs the pixels with the numbers in one artifact.
4. **If drawing that strip snaps the bar back to the bottom, note it.** That is evidence of WebKit
   stale paint (mechanism **M4**), which no JavaScript measurement can detect.
5. Tap the strip to dismiss. Two or three captures of the live bug are enough.

Captures are admin-only: the endpoint rejects everyone else, so a member's long-press writes nothing.

## Reading captures

`GET /debug/geo` (admin) returns the last 20 captures as JSON, newest first. Each carries the layout
viewport, the visual viewport, the bar's rect and computed style (including the **resolved**
`safe-area-inset-bottom` as `bar.padBottom`), an ancestor audit, PWA mode, focus/body-class state,
build and service-worker versions (the server stamps its own build at ingest, so version skew is
judged from a trusted side), and a **ring buffer of the last ~40 viewport events** with what
`__kbSync` computed each time. The sequence is what distinguishes "keyboard still open" from
"viewport stuck after dismissal" from "our own transform went stale".

Precomputed in every report: `visibleBottom = vv.offsetTop + vv.height`, `barBottom = rect.bottom`,
`gap = visibleBottom − barBottom`. **Negative gap = bar below the visible area** (behind the
keyboard). **Positive gap = bar above it**, the reported symptom.

## Decision tree: one capture should land in exactly one row

| # | Signature | Mechanism | The fix for that mechanism |
|---|---|---|---|
| **M1** | `innerHeight` ≪ `screen.height`, nothing focused, `vv.height ≈ innerHeight`, `barBottom ≈ innerHeight`, no transform, ring shows the keyboard closed a while ago | **Layout viewport stuck shrunken** after keyboard dismissal (installed-PWA resize mode) | No clean in-page fix. Force a re-layout on `focusout`, version-gated, marked `// WORKAROUND:`. An app-shell migration does NOT fix this: `100dvh` tracks the same stuck viewport |
| **M2** | `vv.height` shrunk **and** a text input is focused (keyboard genuinely open); or `vv.scale > 1` (zoom) | **Fixed anchored to the layout viewport while the visual viewport is shrunk/offset** (overlay-keyboard model, working as designed) | Keyboard: intended; the bar rides above it via the `gap < −1` branch. Zoom: decide a policy once |
| **M3** | `bar.inlineTransform` non-empty while `gap ≈ 0` (keyboard closed) | **Our own correction went stale**: an event fired after the last kick, or a kick was missed | Clear the transform whenever no text input is focused; lengthen the kick tail |
| **M4** | Every number consistent (`barBottom ≈ visibleBottom ≈ innerHeight`, no transform, no ancestor hit) **yet the screenshot shows it mid-screen**; drawing the overlay healed it | **WebKit stale paint** (compositor), invisible to `getBoundingClientRect`, which reads layout, not paint | Force one compositor invalidation on dismissal (`// WORKAROUND:` naming the WebKit behaviour), or take `position:fixed` out of the equation |
| **M5** | `ancestors[]` non-empty | **Containing-block regression**: an ancestor gained transform/filter/contain/will-change | Remove the property; pin it with a browser-level invariant test |
| **M6** | `build.clientVer` ≠ the server's `server_ver` at ingest, or a stylesheet `?v=` mismatch | **Version skew**: a stale HTML/CSS pair survived the poll-driven reload | Find which leg is stale and tighten the reload path |
| **M7** | `state.bodyClass` contains `kb-open` while `composerEngaged` is false | **Stuck `kb-open`**: the bar is `visibility:hidden`. Presents as "nav missing", not mid-screen | Fix the composer engage/reset path |

If captures land in **different** rows on different occasions, that is also an answer: several
mechanisms, which is why stacked heuristics each "worked once".

## The rule the code follows

`__kbSync` measures the gap on every viewport event and corrects **only** `gap < −1` (bar behind the
keyboard). It deliberately does **not** correct a positive gap, and there is **no repaint nudge**:
both would be guesses until a capture names the mechanism. Every computation goes into the ring
buffer, so the instrument stays live even though the actuator is frozen.

## Resolved: the first real device capture (2026-08-04)

Captured in the installed app (standalone) while the bar floated mid-page:
`innerH 873 · vvH 528 · vvTop 0 · scale 1 · activeEl BODY · composerEngaged false · inlineTransform translateY(-345px)`,
stable across the whole ring (~7 s).

**Mechanism (a new row, confirmed): the VISUAL viewport stuck at its keyboard-open height after
dismissal.** Not M1 (the layout viewport was fine at 873), not M2 (nothing focused, no keyboard),
not M3 (the transform was fresh: the watcher recomputed it every event from the stale visual
viewport), not M4 (geometry and pixels agreed). The lift branch (`fix < -1`) faithfully tracked a
lying viewport.

**Fix shipped the same day: a keyboard-plausibility gate.** A shrunken visual viewport is trusted
only when a keyboard is actually possible: an editable element is focused, the chat composer is
engaged, or the viewport is genuinely transformed (pinch scale/offset). Otherwise `fix < -1` is
forced to 0 and the bar stays at the layout bottom, which IS the visible bottom in the stuck state.
It self-heals when WebKit fires the real resize. The ring gained a `kp` (keyboard-possible) field,
and the browser geometry tests pin both sides: shrink + editable → lift; shrink + nothing → no lift.

**Positive gap (`fix > 0`) remains frozen**: this capture did not license it. The masthead
long-press stays armed for any future occurrence that lands in a different row.

## Recorded refinement (not shipped)

The gate's `editable` check is broader than "keyboard-summoning": any focused `INPUT` counts,
including checkbox/radio/button/**readonly** inputs. Concrete path: the copy button calls
`t.select()` on a readonly input (kiosk link / share fields), focusing it. If WebKit is in the
stuck-viewport state at that instant, the gate trusts the lying viewport and lifts the bar again.

**When next touching `__kbSync`, or if a capture shows `activeEl INPUT[readonly]`:** exclude
`readOnly`/`disabled` and non-text input types from `editable`. It is not shipped standalone
because it narrows `kp` and therefore widens when the correction fires, which no capture has
licensed yet.
