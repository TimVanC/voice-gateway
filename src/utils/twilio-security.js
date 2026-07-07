/**
 * Twilio webhook signature validation.
 *
 * Twilio signs every webhook request with X-Twilio-Signature (HMAC-SHA1 over
 * the exact request URL + sorted POST params, keyed by the account auth
 * token). Without validation, anyone who discovers the webhook URLs can open
 * media streams that burn OpenAI minutes or make the transfer endpoint dial
 * out. This middleware FAILS CLOSED: missing signature, signature mismatch,
 * or missing auth token all reject with 403.
 *
 * Extracted to a module (server-rse.js binds the port on require) so the
 * real middleware is directly testable.
 */

const twilio = require('twilio');

/**
 * Candidate public URLs for signature validation. Twilio signs the URL it
 * requested; behind Railway's proxy the app can't see that URL directly, so
 * we try (a) the configured public base URL and (b) the proxy-forwarded
 * origin. Accepting either does not weaken validation — forging a signature
 * for ANY url requires the auth token.
 * @param {object} req - Express request
 * @param {string} [baseUrl] - configured public origin (PUBLIC_BASE_URL)
 */
function candidateUrls(req, baseUrl) {
  const urls = new Set();
  if (baseUrl) {
    urls.add(`${String(baseUrl).replace(/\/+$/, '')}${req.originalUrl}`);
  }
  const host = req.headers && req.headers.host;
  if (host) {
    const forwarded = String((req.headers['x-forwarded-proto'] || '')).split(',')[0].trim();
    const proto = forwarded || (host.includes('localhost') ? 'http' : 'https');
    urls.add(`${proto}://${host}${req.originalUrl}`);
  }
  return [...urls];
}

/**
 * @param {object} options
 * @param {string} options.authToken - Twilio account auth token
 * @param {string} [options.baseUrl] - configured public origin for URL reconstruction
 * @returns Express middleware that rejects requests without a valid signature
 */
function createTwilioSignatureValidator({ authToken, baseUrl } = {}) {
  if (!authToken) {
    console.error('🚨 TWILIO_AUTH_TOKEN is not set — ALL Twilio webhook requests will be REJECTED (fail-closed)');
  }
  return function validateTwilioSignature(req, res, next) {
    const signature = req.headers && req.headers['x-twilio-signature'];
    if (!authToken || !signature) {
      const reason = !authToken ? 'no auth token configured' : 'missing X-Twilio-Signature header';
      console.warn(`⛔ Twilio webhook REJECTED (${reason}): ${req.method} ${req.originalUrl}`);
      return res.status(403).type('text/plain').send('Forbidden');
    }
    const params = req.body || {};
    const valid = candidateUrls(req, baseUrl).some((url) => {
      try {
        return twilio.validateRequest(authToken, signature, url, params);
      } catch (err) {
        console.error(`❌ Twilio signature check error for ${url}: ${err.message}`);
        return false; // fail closed on validator errors too
      }
    });
    if (!valid) {
      console.warn(`⛔ Twilio webhook REJECTED (signature mismatch): ${req.method} ${req.originalUrl}`);
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return next();
  };
}

module.exports = { createTwilioSignatureValidator, candidateUrls };
