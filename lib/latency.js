// lib/latency.js
class LatencyStats {
  constructor(size = 100) {
    this.size = size;
    this.samples = [];
  }
  
  add(ms) {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }
  
  p50() { return percentile(this.samples, 50); }
  p95() { return percentile(this.samples, 95); }
  avg() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const idx = Math.ceil((p/100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length-1))];
}

function round(v) { 
  return Math.round(v); 
}

module.exports = { LatencyStats, round };

