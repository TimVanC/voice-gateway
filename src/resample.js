// resample.js - Simple resamplers for telephony use
// Input: Int16Array pcm at srcRate
// Output: Int16Array at dstRate (target 8000)

function lowpassMovingAvg(int16, win) {
  const out = new Int16Array(int16.length);
  let acc = 0;
  for (let i = 0; i < int16.length; i++) {
    acc += int16[i];
    if (i >= win) acc -= int16[i - win];
    const denom = i < win ? (i + 1) : win;
    out[i] = (acc / denom) | 0;
  }
  return out;
}

// 24k -> 8k: simple decimation - pick every 3rd sample (no filter)
function decimate3(int16) {
  const N = Math.floor(int16.length / 3);
  const out = new Int16Array(N);
  for (let i = 0, j = 0; j < N; i += 3, j++) {
    out[j] = int16[i];
  }
  return out;
}

// 16k -> 8k: prefilter then pick every 2nd sample
function decimate2(int16) {
  const pre = lowpassMovingAvg(int16, 7);
  const N = Math.floor(pre.length / 2);
  const out = new Int16Array(N);
  for (let i = 0, j = 0; j < N; i += 2, j++) out[j] = pre[i];
  return out;
}

// Generic linear resample (srcRate -> dstRate)
function linearResample(int16, srcRate, dstRate) {
  const ratio = dstRate / srcRate;
  const outLen = Math.floor(int16.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, int16.length - 1);
    const t = srcPos - i0;
    const s = (1 - t) * int16[i0] + t * int16[i1];
    out[i] = s | 0;
  }
  return out;
}

function downsampleTo8k(int16, srcRate) {
  if (srcRate === 8000) return int16;
  if (srcRate === 24000) return decimate3(int16);
  if (srcRate === 16000) return decimate2(int16);
  return linearResample(int16, srcRate, 8000);
}

// 8k -> 24k: linear interpolation for smoother upsampling
function upsample8kTo24k(int16) {
  const out = new Int16Array(int16.length * 3);
  for (let i = 0; i < int16.length - 1; i++) {
    const curr = int16[i];
    const next = int16[i + 1];
    out[i * 3] = curr;
    out[i * 3 + 1] = Math.round(curr * 0.67 + next * 0.33);
    out[i * 3 + 2] = Math.round(curr * 0.33 + next * 0.67);
  }
  // Last sample
  if (int16.length > 0) {
    out[int16.length * 3 - 3] = int16[int16.length - 1];
    out[int16.length * 3 - 2] = int16[int16.length - 1];
    out[int16.length * 3 - 1] = int16[int16.length - 1];
  }
  return out;
}

module.exports = { downsampleTo8k, upsample8kTo24k };

