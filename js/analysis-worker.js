// Onset detection and peak envelope.
// in:  {id, channels: Float32Array[], sampleRate}
// out: {id, onsets: Float32Array (seconds), peaks: Float32Array (0..1, PEAK_BINS long)}

const PEAK_BINS = 1600;

self.onmessage = e => {
  const { id, channels, sampleRate } = e.data;
  const len = channels[0].length;

  // 10ms energy frames, all channels summed
  const hop = Math.round(sampleRate * 0.01);
  const nHops = Math.floor(len / hop);
  const energy = new Float32Array(nHops);
  for (const data of channels) {
    for (let i = 0; i < nHops; i++) {
      let s = 0;
      const off = i * hop;
      for (let j = 0; j < hop; j++) { const v = data[off + j]; s += v * v; }
      energy[i] += s;
    }
  }

  // positive log-energy flux
  const flux = new Float32Array(nHops);
  for (let i = 1; i < nHops; i++) {
    const d = Math.log(energy[i] + 1e-9) - Math.log(energy[i - 1] + 1e-9);
    flux[i] = d > 0 ? d : 0;
  }

  // peaks above an adaptive local mean (sliding window sum)
  const w = 30, times = [];
  let winSum = 0, lo = 0, hi = 0;
  for (let i = 1; i < nHops - 1; i++) {
    const a = Math.max(0, i - w), b = Math.min(nHops, i + w);
    while (hi < b) winSum += flux[hi++];
    while (lo < a) winSum -= flux[lo++];
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const mean = winSum / (b - a);
    if (flux[i] > mean * 2 + 0.05 && (times.length === 0 || i * 0.01 - times[times.length - 1] > 0.08)) {
      times.push(i * 0.01);
    }
  }

  // waveform envelope from the RMS frames
  const peaks = new Float32Array(PEAK_BINS);
  const per = nHops / PEAK_BINS;
  let max = 1e-9;
  for (let b = 0; b < PEAK_BINS; b++) {
    const s = Math.floor(b * per), t = Math.max(s + 1, Math.floor((b + 1) * per));
    let m = 0;
    for (let i = s; i < t && i < nHops; i++) if (energy[i] > m) m = energy[i];
    peaks[b] = Math.sqrt(m);
    if (peaks[b] > max) max = peaks[b];
  }
  for (let b = 0; b < PEAK_BINS; b++) peaks[b] /= max;

  const onsets = Float32Array.from(times);
  self.postMessage({ id, onsets, peaks }, [onsets.buffer, peaks.buffer]);
};
