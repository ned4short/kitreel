// Browser-local scoring, follow tagging, and clip budgeting.
const PRE = 10, POST = 10;
const clamp01 = n => Math.max(0, Math.min(1, n));
export const isManualPick = m => m.picked !== null &&
  m.pickSource !== "auto" && m.pickSource !== "followed";

export function clipsFor(moments, duration) {
  const intervals = [];
  const picked = moments.filter(m => m.picked !== null).sort((a, b) => a.t - b.t);
  const activeTracks = new Set(picked.filter(isManualPick).map(m =>
    m.track?.playerIndex === m.picked ? m.track : null).filter(Boolean));
  for (const m of picked) {
    // Dense follow picks are represented by their tapped seed's tracked clip.
    if (m.pickSource === "followed" && activeTracks.has(m.followedTrack)) continue;

    const track = m.track?.playerIndex === m.picked ? m.track : null;
    const tracked = track && track.end - track.start >= 4;
    const { start, end } = boundsFor(m, duration);
    const centers = tracked ? track.boxes.filter(b =>
      b.t >= track.start && b.t <= track.end).map(b => b.box) : [];
    const fallback = m.players[m.picked].box;
    const boxes = centers.length ? centers : [fallback];
    const c = { start, end, cxs: boxes.map(b => (b[0] + b[2]) / 2),
      cys: boxes.map(b => (b[1] + b[3]) / 2) };
    intervals.push(c);
  }
  const clips = [];
  for (const c of intervals.sort((a, b) => a.start - b.start)) {
    const last = clips.at(-1);
    if (last && c.start <= last.end + 0.5) {
      last.end = Math.max(last.end, c.end);
      last.cxs.push(...c.cxs); last.cys.push(...c.cys);
    } else clips.push(c);
  }
  const avg = a => a.reduce((s, n) => s + n, 0) / a.length;
  return clips.map(c => ({ start: c.start, end: c.end, cx: avg(c.cxs), cy: avg(c.cys) }));
}

function boundsFor(moment, duration) {
  const track = moment.track?.playerIndex === moment.picked ? moment.track : null;
  const tracked = track && track.end - track.start >= 4;
  return {
    start: Math.max(0, tracked ? track.start - PRE : moment.t - PRE),
    end: Math.min(duration, tracked ? track.end + POST : moment.t + POST),
  };
}

export const clipSeconds = clips => clips.reduce((s, c) => s + c.end - c.start, 0);

export function isCameraCut(a, b) {
  if (!a.sig?.length || a.sig.length !== b.sig?.length) return false;
  return a.sig.reduce((sum, value, i) => sum + Math.abs(value - b.sig[i]), 0) / a.sig.length > 40;
}

export function ballCloseness(moment, player, aspect = 1) {
  const [x0, y0, x1, y1] = player.box, height = y1 - y0;
  if (!height || !moment.balls?.length) return 0;
  const distance = Math.min(...moment.balls.map(b => Math.hypot(
    Math.max(x0 - b.x, 0, b.x - x1) * aspect, Math.max(y0 - b.y, 0, b.y - y1),
  ))) / height;
  return clamp01((4 - distance) / 3);
}

export function scoreHighlight(moment, index, loudness = null, aspect = 1) {
  const player = moment.players[index];
  const ball = ballCloseness(moment, player, aspect);
  const height = player.box[3] - player.box[1];
  const crowd = clamp01(loudness?.[Math.floor(moment.t)] || 0);
  const closeness = clamp01(height / 0.5);
  return { ball, crowd, closeness,
    score: clamp01(0.4 * ball + 0.3 * crowd + 0.2 * closeness + 0.1) };
}

export function applyFollowedTracks(moments, tracks, { loudness, aspect, duration = Infinity } = {}) {
  clearAutomatic(moments);
  const spans = new Map(moments.filter(isManualPick).filter(m =>
    m.track?.playerIndex === m.picked).map(m =>
    [m.track, boundsFor(m, duration)]));
  for (const moment of moments) {
    moment.followedTrack = null;
    if (isManualPick(moment) || moment.autoExcluded) continue;
    const choices = [];
    for (const track of tracks) {
      if (moment.t < track.start || moment.t > track.end) continue;
      const span = spans.get(track);
      if (span && (moment.t < span.start || moment.t > span.end)) continue;
      const actual = track.boxes.filter(item => item.t >= track.start && item.t <= track.end);
      if (!actual.length) continue;
      const nearest = actual.reduce((best, item) =>
        Math.abs(item.t - moment.t) < Math.abs(best.t - moment.t) ? item : best);
      const target = nearest.box;
      moment.players.forEach((player, index) => {
        const distance = boxCenterDistance(player.box, target, aspect);
        choices.push({ index, track, distance });
      });
    }
    choices.sort((a, b) => a.distance - b.distance);
    const choice = choices[0];
    if (!choice) continue;
    moment.picked = choice.index;
    moment.pickSource = "followed";
    moment.followedTrack = choice.track;
    moment.autoInfo = scoreHighlight(moment, choice.index, loudness, aspect);
    moment.highlightScore = moment.autoInfo.score;
  }
}

export function budgetTracks(moments, { duration, maxSeconds }) {
  for (const moment of moments) moment.trackClip = null;
  const seconds = () => clipSeconds(clipsFor(moments, duration));
  const total = seconds();
  return { seconds: total, fits: total <= maxSeconds };
}

function boxCenterDistance(a, b, aspect = 1) {
  const dx = (a[0] + a[2] - b[0] - b[2]) / 2 * aspect;
  const dy = (a[1] + a[3] - b[1] - b[3]) / 2;
  return Math.hypot(dx, dy);
}

export function clearAutomatic(moments) {
  for (const m of moments) if (m.pickSource === "auto" || m.pickSource === "followed") {
    m.picked = null;
    m.pickSource = null;
    m.followedTrack = null;
    m.autoInfo = null;
    m.highlightScore = 0;
  }
}
