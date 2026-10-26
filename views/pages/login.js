// views/pages/login.js — sign-in: email for a magic link, or the 6-digit code; the demo persona picker.
import { esc } from '../util.js';
import { codeEntryCard, installSteps } from '../components.js';
import { HEAD, FOOT, header, demoPersonaPicker } from '../shell.js';

// ---------- LOGIN ----------
export function loginPage({ sent = false, email = '', next = '', devLink = '', devCode = '', codeError = '', error = '' } = {}) {
  if (sent) {
    return HEAD('Check your email', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>Check your email</h1>
      <p class="lead">We emailed <b>${esc(email)}</b> a 6-digit code. Expires in 15 minutes.</p>
      ${installSteps}
      ${codeEntryCard(email, next, codeError, devCode)}
      ${devLink ? `<div class="notice warn">DEV MODE link:<br><a href="${esc(devLink)}">${esc(devLink)}</a></div>` : ''}
      <div class="notice">On a computer? Tap the link in the email instead. Didn't get it? Check spam, then <a href="/login${next ? '?next=' + encodeURIComponent(next) : ''}">request a fresh code</a>.</div>
      <a class="btn ghost" href="/checkin">Back</a>
    ` + FOOT;
  }
  return HEAD('Sign in — The Bridge', '', { wall: false }) + header() + `
    <div class="rule"></div>${demoPersonaPicker()}
    <span class="eyebrow">Approved players</span>
    <h1>Sign in to check in</h1>
    <p class="lead">Enter the email you applied with — we'll email you a 6-digit code (no password). You do this <b>once</b> on this device, then you're signed in for good — no more codes.</p>
    ${error ? `<div class="notice warn">${esc(error)}</div>` : ''}
    <form method="POST" action="/login" class="card rail">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@email.com">
      <p class="tally-note" style="margin:8px 0 0">Use the exact email you applied with, or we won't recognize you.</p>
      <div style="height:14px"></div>
      <button class="btn" type="submit" id="sendbtn"><span class="spin" aria-hidden="true"></span><span class="btnlabel">Email my code</span></button>
    </form>
    <div class="foot" style="margin-top:20px">Not on the list yet? <a href="/">Apply here →</a></div>
    <script>
      (function(){
        var form = document.querySelector('form[action="/login"]');
        if(!form) return;
        form.addEventListener('submit', function(){
          var b = document.getElementById('sendbtn');
          if(!b) return;
          b.classList.add('sending');
          b.disabled = true;
          var lbl = b.querySelector('.btnlabel');
          if(lbl) lbl.textContent = 'Sending…';
        });
      })();
    </script>
  ` + FOOT;
}
