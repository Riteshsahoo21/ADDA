import { createHmac } from 'node:crypto';
import { Router, type Response } from 'express';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

export const publicSafetyRoutes = Router();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · ADDA</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f7faf8;color:#172b21;margin:0}
main{max-width:700px;margin:auto;padding:32px 22px 72px}h1{font-size:2.1rem;line-height:1.2}h2{margin-top:2rem}a{color:#0e5b38}
nav{display:flex;gap:16px;flex-wrap:wrap;padding:14px 22px;background:white;border-bottom:1px solid #dce8df}
input,button{font:inherit;padding:12px;border-radius:8px}input{width:min(100%,360px);border:1px solid #63766a}
button{border:0;background:#15794b;color:white;cursor:pointer}.note{background:#e5f4e9;padding:16px;border-radius:10px}</style></head><body>
<nav><a href="/terms">Terms</a><a href="/community-guidelines">Community Guidelines</a><a href="/privacy">Privacy</a><a href="/account-deletion">Delete account</a></nav>
<main>${body}</main></body></html>`;
}

function html(response: Response, title: string, body: string) {
  response.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('Cache-Control', 'no-store');
  response.type('html').send(page(title, body));
}

publicSafetyRoutes.get('/terms', (_request, response) => html(response, 'Terms', `
<h1>ADDA Terms of Use</h1><p>Effective 20 October 2026. ADDA provides messaging, calls, and shared 3D rooms.</p>
<p>Use ADDA respectfully. Do not harass, threaten, exploit, impersonate, spam, or share illegal or sexually exploitative material. Child sexual abuse and exploitation are strictly prohibited. Do not publish another person's private information without permission.</p>
<p>You must be at least 13 and meet the minimum age required where you live to use ADDA. Only share content you have permission to share. You are responsible for your messages, media, and room activity. ADDA may investigate reports and restrict accounts or content that violate these rules.</p>
<p>By continuing in the app you agree to these terms and the <a href="/community-guidelines">Community Guidelines</a>. If you disagree, do not use ADDA. You can delete your account in Profile or <a href="/account-deletion">request deletion on the web</a>.</p>`));

publicSafetyRoutes.get('/community-guidelines', (_request, response) => html(response, 'Community Guidelines', `
<h1>ADDA Community Guidelines</h1><p>These rules apply to messages, photos, videos, voice, calls, profiles, and 3D rooms.</p>
<h2>Keep people safe</h2><p>No child sexual abuse or exploitation, grooming, sexual content involving minors, threats, violent incitement, hate, harassment, or sharing private information without consent.</p>
<h2>Respect others</h2><p>No unwanted repeated contact, impersonation, scams, spam, or content you do not have rights to share. Ask before recording or sharing another person's voice or image.</p>
<h2>Report problems</h2><p>Use Report on a user or message in the app. You can block another user to stop direct contact. Reports may include message text only if you explicitly choose to send it to moderators. We review reports and may remove content, restrict accounts, or escalate child safety concerns under applicable law.</p>
<p>For urgent danger, contact local emergency services. ADDA's in-app reporting is not an emergency service.</p>`));

publicSafetyRoutes.get('/privacy', (_request, response) => html(response, 'Privacy', `
<h1>ADDA Privacy Policy</h1><p>Effective 20 October 2026. ADDA is the provisional operator name for this testing release.</p>
<p>We process your email, name, username, profile photo, contacts you add, group membership, account and device identifiers, sessions, push tokens, and reports to provide ADDA and protect users. We use IP addresses temporarily for abuse prevention. Camera and microphone access is used when you choose calls, QR scanning, or voice chat.</p>
<p>Chat content is encrypted on your device. Encrypted messages may wait on the server until delivery is acknowledged; chat history is stored in app storage on participants' phones. Encrypted media may be held in private object storage. Calls can use relay servers when direct connections fail, and group or room media uses server forwarding. ADDA does not record calls as an app feature.</p>
<p>We use Google/Firebase for push delivery and Google sign-in, a PostgreSQL provider for account and delivery data, and private object storage for encrypted media. A report you submit may include text you choose to share with moderators. Notification titles and metadata can reveal who contacted you; message text is not sent as a notification preview.</p>
<p>You can block users, report abuse, and <a href="/account-deletion">delete your account</a>. Account deletion removes your server account and associated records, and schedules removal of encrypted media objects. Copies of messages already delivered to other people's devices are outside your account and may remain there. Deletion requests made on the web require ownership verification.</p>
<p>For privacy or child safety concerns, use the in-app Report option. A dedicated contact address will be published before public launch.</p>`));

const deletionForm = `<h1>Delete your ADDA account</h1>
<p>In the app, open Profile and tap <strong>Delete account</strong> for immediate account deletion. If you cannot access the app, submit a request below. We will verify that you own the account before deleting it.</p>
<p>Deletion removes account details, sessions, contacts, pending encrypted messages, and media stored for your account. Copies already delivered to other users' phones may remain on those devices.</p>
<form method="post" action="/account-deletion"><label for="email">Account email</label><br><input id="email" name="email" type="email" maxlength="254" required autocomplete="email">
<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true"><br><br><button type="submit">Request deletion</button></form>`;

publicSafetyRoutes.get('/account-deletion', (_request, response) => html(response, 'Delete account', deletionForm));
publicSafetyRoutes.post('/account-deletion', async (request, response, next) => {
  try {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (typeof request.body?.website === 'string' && request.body.website) {
      html(response, 'Request received', '<h1>Request received</h1><p>If this is an ADDA account, we will verify ownership before deletion.</p>'); return;
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      response.status(400); html(response, 'Invalid email', `${deletionForm}<p>Please enter a valid email address.</p>`); return;
    }
    const ipHash = createHmac('sha256', env.authSecret).update(request.ip ?? request.socket.remoteAddress ?? 'unknown').digest('hex');
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM account_deletion_request WHERE (LOWER(email) = $1 OR "ipHash" = $2)
       AND "createdAt" > now() - interval '24 hours'`, [email, ipHash]);
    if (Number(count.rows[0]?.count ?? 0) < 3) {
      await pool.query('INSERT INTO account_deletion_request (email, "ipHash") VALUES ($1, $2)', [email, ipHash]);
    }
    html(response, 'Request received', '<h1>Request received</h1><p>If this is an ADDA account, we will verify ownership before deletion.</p>');
  } catch (error) { next(error); }
});
