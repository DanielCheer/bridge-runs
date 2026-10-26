// views/pages/invite.js — the invite-link claim page (self-serve pre-approval).
import { esc } from '../util.js';
import { qrBlock, codeEntryCard, installSteps, homeScreenCard } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

// ---------- INVITE (self-serve pre-approval link) ----------
export function invitePage({ invalid = false, used = false, checkEmail = false, token = '', full_name = '', phone = '', email = '', dob = '', error = '', devLink = '', devCode = '', codeError = '' } = {}) {
  if (checkEmail) {
    // Invite claimed, but the submitted email wasn't proven (no admin pre-fill match),
    // so we didn't open a session — we emailed a code + link to verify it.
    return HEAD('Check your email — The Bridge', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">Almost there</span>
      <h1>Check your email</h1>
      <p class="lead">You're approved — we just need to confirm it's you. We emailed <b>${esc(email)}</b> a 6-digit code. Expires in 15 minutes.</p>
      ${installSteps}
      ${codeEntryCard(email, '/checkin', codeError, devCode)}
      ${devLink ? `<div class="notice warn">DEV MODE link:<br><a href="${esc(devLink)}">${esc(devLink)}</a></div>` : ''}
      <div class="notice">On a computer, tap the link in the email instead. Didn't get it? Check spam, then <a href="/login">request a fresh code</a>.</div>
      ${homeScreenCard}
      <a class="btn ghost" href="/login">Back to sign in</a>
    ` + FOOT;
  }
  if (invalid) {
    return HEAD('Invite not found — The Bridge', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>That link isn't valid</h1>
      <p class="lead">This invite link doesn't exist. Double check you copied the whole link, or ask whoever sent it for a fresh one.</p>
      <a class="btn ghost" href="/login">Already have an account? Sign in</a>
    ` + FOOT;
  }
  if (used) {
    return HEAD('Invite already used — The Bridge', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>This invite's already been used</h1>
      <p class="lead">Each invite link works once. If that was you, just sign in below. If it wasn't, ask an organizer for a fresh link.</p>
      <a class="btn" href="/login">Sign in</a>
    ` + FOOT;
  }
  return HEAD("You're invited — The Bridge", '', { wall: false }) + header() + `
    <div class="rule"></div>
    <span class="eyebrow">You're pre-approved</span>
    <h1>Finish setting up your spot</h1>
    <p class="lead">An organizer's already cleared you for the Adv Run — just confirm your info and you're in, no application, no waiting.</p>
    ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
    <form method="POST" action="/invite/${esc(token)}" class="card rail">
      <label for="full_name">Full name</label>
      <input id="full_name" name="full_name" required autocomplete="name" value="${esc(full_name)}" placeholder="First Last">

      <label for="phone">Phone</label>
      <input id="phone" name="phone" required inputmode="tel" autocomplete="tel" value="${esc(phone)}" placeholder="(647) 000-0000">

      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" value="${esc(email)}" placeholder="you@email.com">
      <p class="tally-note" style="margin:6px 0 0">This is the email you'll sign in with every time — make sure it's one you check.</p>

      <label for="dob">Date of birth</label>
      <input id="dob" name="dob" type="date" required autocomplete="bday" value="${esc(dob)}">
      <p class="tally-note" style="margin:6px 0 0">Confirms your age (a safeguarding requirement).</p>

      <div class="check">
        <input id="waiver_ok" name="waiver_ok" type="checkbox" value="1" required>
        <label for="waiver_ok">I've completed (or will complete) the church waiver linked below. I understand I can't play without it.</label>
      </div>

      <div style="height:16px"></div>
      <button class="btn" type="submit">Confirm and check in →</button>
    </form>
    <script>(function(){var d=document.getElementById('dob');if(d)d.max=new Date().toISOString().slice(0,10);})();</script>

    ${qrBlock}
    <div class="foot" style="margin-top:20px">Already set up? <a href="/login">Sign in</a></div>
  ` + FOOT;
}
