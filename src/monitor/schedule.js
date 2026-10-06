/**
 * Daily check scheduler
 *
 * Runs the daily health check (src/monitor/daily-check.js) inside the
 * long-running server at a fixed wall-clock time in a fixed time zone
 * (default 8:00 AM America/New_York), every day, DST-aware.
 *
 * Why here and not GitHub Actions: GitHub's cron scheduler has been starting
 * this repo's scheduled runs 3-9 hours late every day, and GitHub-hosted
 * runners call out from a different Azure IP/country each day, which Twilio's
 * fraud detection treats as a stolen Auth Token. The server on Railway is
 * already up 24/7 with every credential the check needs.
 *
 * No dependencies: next-run math uses Intl.DateTimeFormat, which Node ships
 * with full ICU, so IANA zone names work.
 */

const { runDailyCheck } = require('./daily-check');

const DEFAULT_TIME_ZONE = 'America/New_York';
const MINUTE_MS = 60 * 1000;

/** Wall-clock date/time of `ms` (epoch millis) in `timeZone`. */
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/**
 * Epoch millis at which the wall clock in `timeZone` reads the given local
 * date/time. `day` may overflow (e.g. 32) and is normalised like Date.UTC.
 * Iterates because the zone's UTC offset at the target can differ from the
 * offset at the first guess (DST).
 */
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess, timeZone);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    if (seen === target) break;
    guess += target - seen;
  }
  return guess;
}

/** Next epoch millis strictly after `nowMs` at which `timeZone` reads hour:minute. */
function nextRunAt(nowMs, { hour, minute, timeZone }) {
  const today = wallClock(nowMs, timeZone);
  let at = zonedTimeToUtc({ ...today, hour, minute }, timeZone);
  if (at <= nowMs) {
    at = zonedTimeToUtc({ ...today, day: today.day + 1, hour, minute }, timeZone);
  }
  return at;
}

function formatInZone(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));
}

/**
 * Start the daily schedule. Returns { stop(), nextRunAt() }.
 *
 * A crashing check is logged and tomorrow is still armed, so the voice server
 * is never affected. The timer is unref'd so it never keeps a shutting-down
 * process alive.
 */
function startDailyCheckSchedule({
  hour = 8,
  minute = 0,
  timeZone = DEFAULT_TIME_ZONE,
  run = runDailyCheck,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  let nextAt = null;

  const schedule = (delayMs, fn) => {
    timer = setTimeout(fn, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const arm = () => {
    if (stopped) return;
    nextAt = nextRunAt(now(), { hour, minute, timeZone });
    const delay = Math.max(1000, nextAt - now());
    logger.log(`🗓️ Daily check scheduled for ${formatInZone(nextAt, timeZone)} (in ${Math.round(delay / MINUTE_MS)} min)`);
    schedule(delay, fire);
  };

  const fire = async () => {
    timer = null;
    if (stopped) return;
    // If the wall clock was stepped backwards (NTP) the timer can fire before
    // the target time; wait out the remainder rather than run twice.
    const early = nextAt - now();
    if (early > 0) { schedule(early, fire); return; }
    if (running) { arm(); return; }
    running = true;
    try {
      await run();
    } catch (err) {
      logger.error('❌ Daily check crashed (will try again tomorrow):', err);
    } finally {
      running = false;
      arm();
    }
  };

  arm();
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    nextRunAt() { return nextAt; },
  };
}

module.exports = { startDailyCheckSchedule, nextRunAt, zonedTimeToUtc, wallClock, DEFAULT_TIME_ZONE };
