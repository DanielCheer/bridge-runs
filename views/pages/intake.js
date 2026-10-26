// views/pages/intake.js — the public application form (/).
import { esc } from '../util.js';
import { qrBlock, locationBlock } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

// ---------- INTAKE FORM (public application → council votes) ----------
export function intakePage({ submitted = false, error = '', alreadyApproved = false } = {}) {
  if (alreadyApproved) {
    return HEAD('Already approved — The Bridge', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">You're already in</span>
      <h1>You're already approved</h1>
      <p class="lead">This email is already cleared for the Adv Run — no need to re-apply. Just sign in with it to check in for the next run.</p>
      <a class="btn" href="/login">Sign in →</a>
    ` + FOOT;
  }
  if (submitted) {
    return HEAD('Applied — The Bridge', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">You're in the queue</span>
      <h1>Application received</h1>
      <p class="lead">Thanks — the organizers have your info. Next step: come play on Mondays at our recreational open runs, 7–10PM. That's the tryout — they'll watch you play and decide on Adv spots from there. If you're approved, they'll send you the check-in link directly.</p>
      <div class="notice warn">Haven't signed the waiver yet? Do it now — you can't step on the floor without it.</div>
      ${qrBlock}
      <a class="btn ghost" href="/">Back</a>
    ` + FOOT;
  }
  return HEAD('Apply — The Bridge', '', { wall: false }) + header() + `
    <div class="rule"></div>
    <span class="eyebrow">Faith · Ball · Community</span>
    <h1>Faith. Ball. Community.</h1>
    <p class="lead">Hey — I'm Daniel, and I host the Advanced basketball runs at The Bridge. I first came here through the recreational Monday runs myself, and that's what led me to start exploring my faith. I started this run to build a community of Christ-like people who bond over basketball — and to open that same door for others. We play competitive ball and sometimes pause for a devotional; you don't have to share our faith to play, but it's part of who we are.</p>
    <p class="lead" style="margin-top:10px">The Advanced Run is the competitive run, and it's invite-based. Fill this out, then come to the <b>Monday recreational run</b> — that's the tryout. The organizers watch you play there and decide from there.</p>

    <div class="notice" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <span>Already applied or approved?</span>
      <a class="btn ghost sm" href="/login" style="width:auto">Sign in →</a>
    </div>

    ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}

    <form method="POST" action="/apply" class="card rail">
      <label for="full_name">Full name</label>
      <input id="full_name" name="full_name" required autocomplete="name" placeholder="First Last">

      <label for="phone">Phone</label>
      <input id="phone" name="phone" required inputmode="tel" autocomplete="tel" placeholder="(647) 000-0000">

      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@email.com">

      <label for="dob">Date of birth</label>
      <input id="dob" name="dob" type="date" required autocomplete="bday">
      <p class="tally-note" style="margin:4px 0 0">Used to confirm your age (a safeguarding requirement).</p>

      <label>What level of basketball have you played? <span style="text-transform:none;font-weight:400;color:var(--muted)">(pick all that apply)</span></label>
      <div class="levels">
        <label class="lvl"><input type="checkbox" name="levels" value="Pickup / rec only"> Pickup / rec only</label>
        <label class="lvl"><input type="checkbox" name="levels" value="House league"> House league</label>
        <label class="lvl"><input type="checkbox" name="levels" value="High school"> High school</label>
        <label class="lvl"><input type="checkbox" name="levels" value="Men's league"> Men's league</label>
        <label class="lvl"><input type="checkbox" name="levels" value="College / semi-pro"> College / semi-pro</label>
        <label class="lvl"><input type="checkbox" name="levels" value="Other" id="lvlOther"> Other</label>
      </div>
      <input id="otherText" name="levels_other" placeholder="Tell us the other level…" style="display:none;margin-top:8px">

      <div class="check">
        <input id="waiver_ok" name="waiver_ok" type="checkbox" value="1" required>
        <label for="waiver_ok">I've completed (or will complete) the church waiver linked below. I understand I can't play without it.</label>
      </div>

      <p class="tally-note" style="margin:14px 0 0">By submitting, you agree to our <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>, <a href="/terms" target="_blank" rel="noopener">Terms of Use</a>, and <a href="/conduct" target="_blank" rel="noopener">Code of Conduct</a>.</p>
      <div style="height:14px"></div>
      <button class="btn" type="submit">Submit application</button>
    </form>

    <script>
      (function(){
        var other=document.getElementById('lvlOther'), otherText=document.getElementById('otherText');
        if(other){other.addEventListener('change',function(){otherText.style.display=other.checked?'block':'none';if(!other.checked)otherText.value='';});}
        var dobEl=document.getElementById('dob'); if(dobEl){dobEl.max=new Date().toISOString().slice(0,10);}
        var form=document.querySelector('form[action="/apply"]');
        if(form){form.addEventListener('submit',function(e){
          var any=form.querySelectorAll('input[name="levels"]:checked').length>0;
          if(!any){e.preventDefault();alert('Pick at least one level of basketball you\\'ve played.');}
        });}
      })();
    </script>

    ${qrBlock}
    ${locationBlock}
    <div class="foot" style="margin-top:20px">Already approved? <a href="/login">Sign in to check in →</a></div>
  ` + FOOT;
}
