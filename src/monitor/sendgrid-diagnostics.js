/**
 * SendGrid delivery diagnostics (read-only)
 *
 * Answers "SendGrid returned 202, so why did no email arrive?". A 202 only
 * means SendGrid queued the message; it can still bounce, be blocked, or be
 * dropped later (for example once the recipient lands on the bounce
 * suppression list, every later send is accepted and silently dropped).
 *
 * Prints: per-day stats (requests / delivered / bounces / drops), every
 * suppression-list entry with the reason SendGrid recorded, sender
 * authentication status, and remaining credits. Email addresses are masked
 * because GitHub Actions logs on a public repo are public.
 *
 * Needs SENDGRID_API_KEY with read access to stats, suppressions and sender
 * authentication; a key with only "mail.send" prints HTTP 403 for those
 * sections, which is itself the answer (make a read-only key in SendGrid).
 *
 * Run: node src/monitor/sendgrid-diagnostics.js [days-back, default 14]
 */

require('dotenv').config();
const https = require('https');

const KEY = process.env.SENDGRID_API_KEY;
if (!KEY) {
  console.error('Missing SENDGRID_API_KEY');
  process.exit(1);
}
const DAYS = Number(process.argv[2]) || 14;

function get(path) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: 'api.sendgrid.com', path, method: 'GET', headers: { Authorization: `Bearer ${KEY}` } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let body;
          try { body = JSON.parse(raw); } catch (e) { body = raw; }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', (err) => resolve({ status: 0, body: String(err) }));
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.end();
  });
}

const mask = (email) => (typeof email === 'string' ? email.replace(/^(.)[^@]*(@.*)$/, '$1***$2') : String(email));
const ymd = (d) => d.toISOString().slice(0, 10);
const brief = (body) => JSON.stringify(body).slice(0, 400);

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  console.log(`SendGrid diagnostics, last ${DAYS} days (since ${ymd(since)}); EMAIL_FROM=${mask(process.env.EMAIL_FROM)}\n`);

  // 1. Per-day stats. "requests" is what we sent; "delivered" is what the
  //    recipient's mail server accepted; the rest explains the gap.
  const stats = await get(`/v3/stats?start_date=${ymd(since)}&end_date=${ymd(new Date())}&aggregated_by=day`);
  console.log(`== Per-day stats (HTTP ${stats.status}) ==`);
  if (Array.isArray(stats.body)) {
    const cols = ['requests', 'processed', 'delivered', 'deferred', 'bounces', 'blocks', 'bounce_drops', 'spam_report_drops', 'unsubscribe_drops', 'invalid_emails'];
    console.log(['date      ', ...cols.map((c) => c.padStart(c.length + 2))].join(''));
    for (const day of stats.body) {
      const m = (day.stats && day.stats[0] && day.stats[0].metrics) || {};
      console.log([day.date, ...cols.map((c) => String(m[c] == null ? '-' : m[c]).padStart(c.length + 2))].join(''));
    }
  } else {
    console.log(brief(stats.body));
  }

  // 2. Suppression lists: once an address is here, SendGrid accepts (202) and
  //    then drops every message to it until the entry is deleted.
  const lists = [
    ['Bounces', '/v3/suppression/bounces'],
    ['Blocks', '/v3/suppression/blocks'],
    ['Spam reports', '/v3/suppression/spam_reports'],
    ['Invalid emails', '/v3/suppression/invalid_emails'],
    ['Global unsubscribes', '/v3/suppression/unsubscribes'],
  ];
  for (const [name, path] of lists) {
    const r = await get(`${path}?start_time=${Math.floor(since.getTime() / 1000)}`);
    console.log(`\n== ${name} (HTTP ${r.status}) ==`);
    if (Array.isArray(r.body)) {
      if (!r.body.length) console.log('(none)');
      for (const e of r.body) {
        const when = e.created ? new Date(e.created * 1000).toISOString() : '';
        console.log(`${when}  ${mask(e.email)}  ${e.status || ''}  ${e.reason || ''}`);
      }
    } else {
      console.log(brief(r.body));
    }
  }

  // 3. Sender authentication. An unauthenticated or broken domain gets mail
  //    rejected by Gmail/Outlook, which shows up above as bounces or blocks.
  const domains = await get('/v3/whitelabel/domains');
  console.log(`\n== Authenticated domains (HTTP ${domains.status}) ==`);
  if (Array.isArray(domains.body)) {
    if (!domains.body.length) console.log('(none)');
    for (const d of domains.body) {
      const dns = d.dns || {};
      const v = (rec) => (dns[rec] ? dns[rec].valid : '?');
      console.log(`${d.domain}  valid=${d.valid}  default=${d.default}  mail_cname=${v('mail_cname')}  dkim1=${v('dkim1')}  dkim2=${v('dkim2')}`);
    }
  } else {
    console.log(brief(domains.body));
  }

  const senders = await get('/v3/verified_senders');
  console.log(`\n== Verified single senders (HTTP ${senders.status}) ==`);
  const results = senders.body && senders.body.results;
  if (Array.isArray(results)) {
    if (!results.length) console.log('(none)');
    for (const s of results) console.log(`${mask(s.from_email)}  verified=${s.verified}  locked=${s.locked}`);
  } else {
    console.log(brief(senders.body));
  }

  // 4. Credits / plan limits.
  const credits = await get('/v3/user/credits');
  console.log(`\n== Credits (HTTP ${credits.status}) ==`);
  console.log(brief(credits.body));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
