// Dense, browser-local player tracking from an explicitly tapped player.
const STEP = 0.5, MAX_MISSES = 3;

export async function trackPlayer({
  moment, playerIndex, duration, target, threshold, aspect,
  seek, drawFrame, detectPeople, torsoMatch, normalizeBox, describe,
  frameSignature, isCameraCut, waitUntilVisible, seekAndDrawFrame, onStep = () => {},
}) {
  const seed = moment.players[playerIndex];
  if (!seed) throw new Error("Choose a player before following them.");
  const boxes = [{ t: moment.t, box: seed.box, found: true }];
  const ends = [moment.t];
  const directions = [1, -1];
  const readFrame = seekAndDrawFrame || (async (t) => {
    await waitUntilVisible();
    await seek(t);
    await drawFrame();
    return { t, sig: frameSignature() };
  });

  for (const direction of directions) {
    let previousBox = seed.box;
    let velocity = [0, 0, 0, 0];
    let previousSignature = { sig: moment.sig, t: moment.t };
    let misses = 0;

    for (let n = 1; ; n++) {
      const t = Math.round((moment.t + direction * n * STEP) * 100) / 100;
      if (t < 0 || t >= duration) break;
      const predicted = clampBox(previousBox.map((v, i) => v + velocity[i]));
      let found = null;
      let signature = null;
      let nextSignature = previousSignature;

      try {
        signature = await readFrame(t, previousSignature);
        if (!signature) throw new Error("Frame unavailable");
        nextSignature = signature;
        if (isCameraCut(previousSignature, signature)) {
          const probeTime = Math.round((t + direction * 0.25) * 100) / 100;
          let confirmedCut = false;
          nextSignature = previousSignature;
          if (probeTime >= 0 && probeTime < duration) {
            try {
              const probe = await readFrame(probeTime, signature);
              confirmedCut = Boolean(probe && isCameraCut(previousSignature, probe));
              if (probe && !confirmedCut) nextSignature = probe;
            } catch {} // A failed confirmation cannot establish a camera cut.
          }
          if (confirmedCut) {
            onStep(t, direction, false, true);
            break;
          }
          // The extra check moved the video; restore this half-second sample.
          signature = await readFrame(t, previousSignature);
          if (!signature) throw new Error("Frame unavailable");
        }
      } catch {
        boxes.push({ t, box: predicted, found: false });
        previousBox = predicted;
        misses++;
        onStep(t, direction, false);
        if (misses >= MAX_MISSES) break;
        continue;
      }

      // A transient pan must not become the baseline and look like a new cut
      // when the following normal frame returns.
      previousSignature = nextSignature;

      const detections = await detectPeople();
      const candidates = detections.map(raw => {
        if (torsoMatch(raw, target) < threshold / 2) return null;
        const box = normalizeBox(raw);
        const height = box[3] - box[1], priorHeight = previousBox[3] - previousBox[1];
        const overlap = iou(box, predicted);
        const centerDistance = boxCenterDistance(box, predicted, aspect);
        const heightRatio = height / (priorHeight || 1);
        const smallPlayer = priorHeight < 0.1;
        const closeEnough = centerDistance <= (smallPlayer ? 1 : 0.6) * priorHeight &&
          heightRatio >= 0.75 && heightRatio <= 1.33;
        if (overlap < (smallPlayer ? 0.1 : 0.2) && !closeEnough) return null;
        return { box, overlap, appearance: similarity(describe(raw), seed.desc) };
      }).filter(Boolean).sort((a, b) =>
        b.overlap - a.overlap || b.appearance - a.appearance);

      found = candidates[0] || null;
      if (found) {
        boxes.push({ t, box: found.box, found: true });
        velocity = found.box.map((v, i) => v - previousBox[i]);
        previousBox = found.box;
        ends.push(t);
        misses = 0;
      } else {
        boxes.push({ t, box: predicted, found: false });
        previousBox = predicted;
        misses++;
      }
      onStep(t, direction, Boolean(found));
      if (misses >= MAX_MISSES) break;
    }
  }

  boxes.sort((a, b) => a.t - b.t);
  return {
    start: Math.min(...ends),
    end: Math.max(...ends),
    boxes,
    playerIndex,
  };
}

function similarity(a, b) {
  if (!a?.length || a.length !== b?.length) return -1;
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

function boxCenterDistance(a, b, aspect) {
  const dx = ((a[0] + a[2]) - (b[0] + b[2])) / 2 * aspect;
  const dy = ((a[1] + a[3]) - (b[1] + b[3])) / 2;
  return Math.hypot(dx, dy);
}

function iou(a, b) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return intersection / (areaA + areaB - intersection || 1);
}

function clampBox(box) {
  const x0 = Math.max(0, Math.min(1, box[0]));
  const y0 = Math.max(0, Math.min(1, box[1]));
  const x1 = Math.max(x0, Math.min(1, box[2]));
  const y1 = Math.max(y0, Math.min(1, box[3]));
  return [x0, y0, x1, y1];
}
