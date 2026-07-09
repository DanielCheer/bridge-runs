// mailer.js — sends magic-link emails.
// Uses SMTP if configured (Gmail app password works great). If no SMTP env
// is set, it runs in DEV mode and just prints the link to the console so you
// can test without email set up.
import nodemailer from 'nodemailer';

const hasSMTP = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (hasSMTP) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,               // keep a warm connection so sends after the first skip the handshake
    maxConnections: 3,
    connectionTimeout: 10000, // fail loudly instead of hanging forever on a stuck server
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

export async function sendMagicLink(email, link, code = '') {
  if (!transporter) {
    console.log('\n=== DEV MODE: no SMTP configured ===');
    console.log(`Sign-in code for ${email}: ${code}`);
    console.log(`Magic link for ${email}: ${link}`);
    console.log('===================================\n');
    return { dev: true };
  }
  const codeText = code
    ? `On your phone? Open the Bridge Runs app on your Home Screen and enter this code:\n\n    ${code}\n\n(No app yet? Tap Share → Add to Home Screen first, then open it and enter the code.)\n\nOn a computer? Tap to sign in: ${link}\n\n`
    : `Tap to sign in: ${link}\n\n`;
  const codeHtml = code
    ? `<p style="font-size:15px;color:#20211c">Signing in on your phone? Open the <b>Bridge Runs</b> app on your Home Screen and enter this code:</p>
       <p style="font-size:34px;font-weight:800;letter-spacing:.28em;font-family:ui-monospace,Menlo,monospace;color:#20211c;margin:6px 0 4px">${escHtml(code)}</p>
       <p style="color:#666;font-size:13px;margin:0 0 18px">No app yet? Tap your browser's <b>Share → Add to Home Screen</b> first, then open it and enter the code above.</p>
       <p style="color:#444;font-size:13px;margin-top:18px">On a computer? Tap to sign in:</p>
       <p><a href="${link}" style="background:#E86A33;color:#111;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Sign in</a></p>`
    : `<p>Tap to sign in to <b>The Bridge Adv Runs</b>:</p>
       <p><a href="${link}" style="background:#E86A33;color:#111;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Sign in</a></p>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: code ? 'Your sign-in code — The Bridge Adv Runs' : 'Your sign-in link — The Bridge Adv Runs',
    text: codeText + `This expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `${codeHtml}
           <p style="font-size:13px;word-break:break-all;color:#666;margin-top:10px">Or copy this link: <a href="${link}" style="color:#2C6B66">${link}</a></p>
           <p style="color:#666;font-size:13px">Expires in 15 minutes. Didn't request this? Ignore it.</p>`,
  });
  return { dev: false };
}

// Escape a user-supplied string for safe interpolation into an HTML email body.
const escHtml = (s = '') => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Email an announcement to every approved player. One send with the recipients
// in BCC so nobody sees the full list. No-op (logged) when SMTP isn't set up.
export async function sendAnnouncement(recipients, body, author) {
  const list = (recipients || []).filter(Boolean);
  if (!transporter) {
    console.log('\n=== DEV MODE: no SMTP — announcement not emailed ===');
    console.log(`Would BCC ${list.length} recipient(s): ${body}`);
    console.log('===================================================\n');
    return { dev: true, sent: 0 };
  }
  if (!list.length) return { dev: false, sent: 0 };
  const safeBody = escHtml(body).replace(/\n/g, '<br>');
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    bcc: list,
    subject: 'New announcement — The Bridge Adv Runs',
    text: `${body}\n\n— The Bridge Adv Runs${author ? ` (posted by ${author})` : ''}`,
    html: `<p style="font-size:15px;line-height:1.55;color:#20211c">${safeBody}</p>
           <p style="color:#666;font-size:13px;margin-top:18px">— The Bridge Adv Runs${author ? ` · posted by ${escHtml(author)}` : ''}</p>`,
  });
  return { dev: false, sent: list.length };
}

// Email a waitlister that a floor spot opened for them and they can claim it. The
// link is a one-time claim URL (/checkin/claim/:token) that signs them in and puts
// them on the floor. `hours` is the claim window (owner-configurable). No-op (logged
// with the link, so DEV testing can follow it) when SMTP isn't set up. Reuses the
// shared transport.
export async function sendSpotOffer(email, name, runLabel, link, hours = 3, weekday = 'Friday') {
  const hourWord = `${hours} hour${Number(hours) === 1 ? '' : 's'}`;
  const day = escHtml(weekday || 'Friday');
  if (!transporter) {
    console.log('\n=== DEV MODE: no SMTP — spot offer not emailed ===');
    console.log(`Spot-offer claim link for ${email} (${runLabel}, ${hourWord} to claim):`);
    console.log(link);
    console.log('==================================================\n');
    return { dev: true };
  }
  const hi = name ? escHtml(String(name).trim().split(/\s+/)[0]) : '';
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `A spot opened for ${day}'s run — claim it`,
    text: `${name ? hi + ' — ' : ''}a spot just opened for ${day}'s Adv Run (${runLabel}).\n\n`
      + `Tap to claim it: ${link}\n\n`
      + `You have ${hourWord} before it passes to the next person on the waitlist. `
      + `If you don't claim it in time, you'll drop off the list for this week.`,
    html: `<p style="font-size:15px;line-height:1.5;color:#20211c">${name ? '<b>' + hi + '</b> — ' : ''}a spot just opened for <b>${day}'s Adv Run</b> (${escHtml(runLabel)}).</p>
           <p><a href="${link}" style="background:#E86A33;color:#111;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Claim my spot →</a></p>
           <p style="color:#444;font-size:13px;margin-top:16px">You have <b>${hourWord}</b> before it passes to the next person on the waitlist. If you don't claim it in time, you'll drop off the list for this week.</p>
           <p style="color:#444;font-size:13px;margin-top:12px">Button not working? Copy this link into your browser:</p>
           <p style="font-size:13px;word-break:break-all"><a href="${link}" style="color:#2C6B66">${link}</a></p>`,
  });
  return { dev: false };
}

export const emailConfigured = hasSMTP;
