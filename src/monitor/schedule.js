/**
 * Daily check scheduler
 *
 * Runs the daily health check (src/monitor/daily-check.js) inside the
 * long-running server at fixed wall-clock times in a fixed time zone
 * (default 8:00 AM and 4:00 PM America/New_York), every day, DST-aware.
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
const { BASE_URL } = require('../config/baseUrl');

const DEFAULT_TIME_ZONE = 'America/New_York';
const DEFAULT_TIMES = [{ hour: 8, minute: 0 }, { hour: 16, minute: 0 }];
const MINUTE_MS = 60 * 1000;

/** Parse "08:00,16:00" into [{ hour, minute }]. Throws on malformed input. */
function parseTimes(spec) {
  const times = String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      const hour = m ? Number(m[1]) : NaN;
      const minute = m ? Number(m[2]) : NaN;
      if (!m || hour > 23 || minute > 59) throw new Error(`Bad time "${s}" (expected HH:MM, 24-hour)`);
      return { hour, minute };
    });
  if (!times.length) throw new Error('No times given (expected e.g. "08:00,16:00")');
  return times;
}

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

/**
 * Earliest epoch millis strictly after `nowMs` at which `timeZone` reads one
 * of `times`. Looks at today and tomorrow in the zone's calendar, which always
 * yields a candidate in the future.
 */
function nextRunAt(nowMs, { times = DEFAULT_TIMES, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const today = wallClock(nowMs, timeZone);
  let best = Infinity;
  for (const { hour, minute } of times) {
    for (const dayOffset of [0, 1]) {
      const at = zonedTimeToUtc({ year: today.year, month: today.month, day: today.day + dayOffset, hour, minute }, timeZone);
      if (at > nowMs && at < best) best = at;
    }
  }
  return best;
}

function formatInZone(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));
}

const formatTime = ({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/**
 * The public URL the in-server check probes. Railway injects
 * RAILWAY_PUBLIC_DOMAIN, which is exactly the address callers reach; BASE_URL
 * covers other hosts. MONITOR_HEALTH_URL overrides both.
 */
function defaultHealthUrl() {
  if (process.env.MONITOR_HEALTH_URL) return process.env.MONITOR_HEALTH_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`;
  return `${BASE_URL}/health`;
}

/**
 * Start the schedule. Returns { stop(), nextRunAt() }.
 *
 * A crashing check is logged and the next slot is still armed, so the voice
 * server is never affected. The timer is unref'd so it never keeps a
 * shutting-down process alive.
 */
function startDailyCheckSchedule({
  times = DEFAULT_TIMES,
  timeZone = DEFAULT_TIME_ZONE,
  run = () => runDailyCheck({ healthUrl: defaultHealthUrl() }),
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
    nextAt = nextRunAt(now(), { times, timeZone });
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
      logger.error('❌ Daily check crashed (next slot still scheduled):', err);
    } finally {
      running = false;
      arm();
    }
  };

  logger.log(`🗓️ Daily check times: ${times.map(formatTime).join(', ')} ${timeZone}`);
  arm();
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    nextRunAt() { return nextAt; },
  };
}

module.exports = {
  startDailyCheckSchedule,
  parseTimes,
  nextRunAt,
  zonedTimeToUtc,
  wallClock,
  defaultHealthUrl,
  DEFAULT_TIME_ZONE,
  DEFAULT_TIMES,
};
