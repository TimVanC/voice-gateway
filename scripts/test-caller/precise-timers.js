/**
 * Drift-correcting setInterval for Windows.
 *
 * On Windows, Node's timers tick at the system's 15.6 ms granularity, so
 * `setInterval(fn, 20)` fires about 33 times a second instead of 50. Every
 * 20 ms audio pacer then runs at two thirds speed: Ava's local pump, the
 * harness's caller pacer and the fake Twilio playout. Railway (Linux) is not
 * affected, so this is a test-environment problem, not an Ava bug.
 *
 * This replaces the global setInterval with one that schedules each firing
 * at `start + n * ms` and, when it wakes up late, runs the callback as many
 * times as it is behind (capped), so the average rate is exact and the worst
 * jitter is one system tick. Loaded with `node --require` for the spawned
 * Ava and required at the top of run.js. A no-op on other platforms.
 */

if (process.platform === 'win32' && !global.__preciseTimersInstalled) {
  global.__preciseTimersInstalled = true;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const MAX_CATCH_UP = 5;

  class PreciseInterval {
    constructor(fn, ms, args) {
      this.fn = fn;
      this.ms = Math.max(1, ms || 1);
      this.args = args;
      this.n = 0;
      this.start = performance.now();
      this.timer = null;
      this.stopped = false;
      this.schedule();
    }
    schedule() {
      const due = this.start + (this.n + 1) * this.ms;
      const wait = Math.max(0, due - performance.now());
      this.timer = realSetTimeout(() => this.fire(), wait);
    }
    fire() {
      if (this.stopped) return;
      let runs = 0;
      while (!this.stopped && performance.now() >= this.start + (this.n + 1) * this.ms && runs < MAX_CATCH_UP) {
        this.n++;
        runs++;
        try {
          this.fn(...this.args);
        } catch (err) {
          // Same as a thrown interval callback: surface it, keep the loop alive.
          process.nextTick(() => { throw err; });
        }
      }
      if (runs === MAX_CATCH_UP) {
        // Hopelessly behind (the process was paused): drop the backlog.
        this.start = performance.now();
        this.n = 0;
      }
      if (!this.stopped) this.schedule();
    }
    stop() {
      this.stopped = true;
      if (this.timer) realClearTimeout(this.timer);
    }
    // Node Timeout compatibility used by common code.
    unref() { if (this.timer && this.timer.unref) this.timer.unref(); return this; }
    ref() { if (this.timer && this.timer.ref) this.timer.ref(); return this; }
    hasRef() { return this.timer && this.timer.hasRef ? this.timer.hasRef() : true; }
    refresh() { this.start = performance.now(); this.n = 0; return this; }
    [Symbol.toPrimitive]() { return this.timer ? Number(this.timer) : 0; }
  }

  global.setInterval = function preciseSetInterval(fn, ms, ...args) {
    return new PreciseInterval(fn, ms, args);
  };
  global.clearInterval = function preciseClearInterval(handle) {
    if (handle instanceof PreciseInterval) handle.stop();
    else if (handle != null) realClearTimeout(handle);
  };
}
