// ffmpeg emits little-endian signed 16-bit PCM at 1000 samples per second.
export function crowdScores(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rms = [];
  for (let start = 0; start + 1 < bytes.length; start += 2000) {
    const end = Math.min(start + 2000, bytes.length - bytes.length % 2);
    let square = 0, count = 0;
    for (let i = start; i < end; i += 2) {
      const sample = data.getInt16(i, true) / 32768;
      square += sample * sample;
      count++;
    }
    rms.push(Math.sqrt(square / count));
  }
  if (!rms.length) return [];
  const mean = rms.reduce((s, n) => s + n, 0) / rms.length;
  const sd = Math.sqrt(rms.reduce((s, n) => s + (n - mean) ** 2, 0) / rms.length);
  return rms.map(n => sd > 1e-9 ? Math.max(0, Math.min(1, (n - mean) / sd)) : 0);
}

// The caller serializes access to the shared editor. Cancellation terminates only
// this task's worker, so a manual build can start immediately on a fresh editor.
export function createCrowdTask({ getEditor, mountInput, releaseInput, resetEditor, onReady, onSkip,
  timeout = 120000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let cancelled = false, ff = null, timer;
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    if (ff) resetEditor(ff);
    onSkip();
    stop();
  }
  timer = setTimer(cancel, timeout);
  async function execute() {
    let input;
    try {
      ff = await getEditor();
      if (cancelled) { ff = null; return; }
      input = await mountInput(ff);
      if (cancelled) return;
      const code = await ff.exec(["-i", input, "-vn", "-ac", "1", "-ar", "1000", "-f", "s16le", "audio.raw"], timeout);
      if (cancelled || code !== 0) return;
      const bytes = await ff.readFile("audio.raw");
      const scores = crowdScores(bytes);
      if (!cancelled && scores.length) onReady(scores);
    } catch {
      // No audio, unsupported codec, limited memory: optional analysis only.
    } finally {
      if (ff && !cancelled) {
        try { await ff.deleteFile("audio.raw"); } catch {}
        if (input) await releaseInput(ff, input);
      }
    }
  }
  return {
    cancel,
    async run() {
      let ready = false;
      const readyCallback = onReady;
      onReady = scores => { ready = true; readyCallback(scores); };
      try { if (!cancelled) await Promise.race([execute(), stopped]); }
      finally {
        clearTimer(timer);
        if (!ready && !cancelled) onSkip();
      }
    },
  };
}
