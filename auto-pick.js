// Browser-local scoring, follow tagging, and clip budgeting.
const PRE = 10, POST = 10;
const clamp01 = n => Math.max(0, Math.min(1, n));
export const isManualPick = m => m.picked !== null &&
  m.pickSource !== "auto" && m.pickSource !== "followed";

// Where the player is over time inside [start, end], from a followed track (absolute times).
function pathFor(track, start, end) {
  if (!track) return [];
  return track.boxes.filter(b => b.found && b.t >= start - 0.25 && b.t <= end + 0.25)
    .sort((a, b) => a.t - b.t)
    .map(b => ({ t: b.t, cx: (b.box[0] + b.box[2]) / 2, cy: (b.box[1] + b.box[3]) / 2, y0: b.box[1], y1: b.box[3] }));
}
const REASON_RANK = { "On the ball": 6, "Challenge": 5, "Near the ball": 4, "In the action": 3, "Followed": 2, "Picked": 1 };

export function clipsFor(moments, duration, action = null) {
  const intervals = [];
  const picked = moments.filter(m => m.picked !== null).sort((a, b) => a.t - b.t);
  const activeTracks = new Set(picked.filter(isManualPick).map(m =>
    m.track?.playerIndex === m.picked ? m.track : null).filter(Boolean));
  for (const m of picked) {
    // Dense follow picks are represented by their tapped seed's tracked clip.
    if (m.pickSource === "followed" && activeTracks.has(m.followedTrack)) continue;

    const track = m.track?.playerIndex === m.picked ? m.track : null;
    const tracked = track && track.end - track.start >= 4;
    // "Only keep my player in action": a followed play becomes its action clips.
    const act = action?.enabled && tracked && isManualPick(m) ? actionSegments(track, action, duration) : null;
    if (act?.hasData) {
      const excluded = moments.filter(x => x.autoExcluded).map(x => x.t);
      for (const s of act.segments) {
        if (excluded.some(t => t >= s.start && t <= s.end)) continue;   // the user unticked a moment in it
        intervals.push({ start: s.start, end: s.end, cxs: s.cxs, cys: s.cys, reason: s.reason,
          path: pathFor(track, s.start, s.end) });
      }
      continue;
    }
    const { start, end } = boundsFor(m, duration);
    const centers = tracked ? track.boxes.filter(b =>
      b.t >= track.start && b.t <= track.end).map(b => b.box) : [];
    const fallback = m.players[m.picked].box;
    const boxes = centers.length ? centers : [fallback];
    const c = { start, end, cxs: boxes.map(b => (b[0] + b[2]) / 2),
      cys: boxes.map(b => (b[1] + b[3]) / 2), reason: tracked ? "Followed" : "Picked",
      path: tracked ? pathFor(track, start, end) : [] };
    intervals.push(c);
  }
  const clips = [];
  for (const c of intervals.sort((a, b) => a.start - b.start)) {
    const last = clips.at(-1);
    if (last && c.start <= last.end + 0.5) {
      last.end = Math.max(last.end, c.end);
      last.cxs.push(...c.cxs); last.cys.push(...c.cys);
      last.path = [...last.path, ...c.path].sort((a, b) => a.t - b.t);
      if ((REASON_RANK[c.reason] || 0) > (REASON_RANK[last.reason] || 0)) last.reason = c.reason;
    } else clips.push({ ...c, path: [...c.path] });
  }
  const avg = a => a.reduce((s, n) => s + n, 0) / a.length;
  return clips.map(c => ({ start: c.start, end: c.end, cx: avg(c.cxs), cy: avg(c.cys),
    reason: c.reason, path: c.path }));
}

function boundsFor(moment, duration) {
  const track = moment.track?.playerIndex === moment.picked ? moment.track : null;
  const tracked = track && track.end - track.start >= 4;
  return {
    start: Math.max(0, tracked ? track.start - PRE : moment.t - PRE),
    end: Math.min(duration, tracked ? track.end + POST : moment.t + POST),
  };
}

// ---------- "Only keep my player in action" ----------
// Turns a followed track into short clips of the moments the player is on or near
// the ball (or in a challenge), instead of the whole time they were followed.
export const CLOSENESS = { tight: 1.0, normal: 1.5, loose: 2.5 };
const LEAD = 2, TAIL = 1.5, MERGE_GAP = 2.5, MAX_BALL_GAP = 1.5;
const segmentCache = new WeakMap();

// How each position changes what counts as "in action". Gentle nudges only:
//  reach  — how far from the ball still counts (× the "How close to the ball" setting)
//  burst  — how sudden a movement must be to count as a challenge (× the player's average speed)
//  alone  — a burst counts even with nobody nearby (a goalie's dive or rush out)
//  crowd  — players nearby that make it "in the action" when the ball can't be seen
export const POSITION_STYLE = {
  goalie:     { reach: 1.6,  burst: 1.5, alone: true,  crowd: 2 },
  defender:   { reach: 1.15, burst: 1.6, alone: false, crowd: 3 },
  midfielder: { reach: 1.0,  burst: 2.0, alone: false, crowd: 3 },
  striker:    { reach: 1.1,  burst: 1.8, alone: false, crowd: 2 },
  "":         { reach: 1.0,  burst: 2.0, alone: false, crowd: 3 },
};

// Specific positions use the closest of the styles above.
export const POSITION_GROUP = {
  centerback: "defender", fullback: "defender", dmid: "defender",
  wingback: "midfielder", cmid: "midfielder", widemid: "midfielder",
  amid: "striker", winger: "striker",
};

export function actionSegments(track, action, duration = Infinity) {
  const pos = action?.position || "";
  const style = POSITION_STYLE[POSITION_GROUP[pos] || pos] || POSITION_STYLE[""];
  const limit = (CLOSENESS[action?.closeness] ?? CLOSENESS.normal) * style.reach;
  const key = `${limit}|${duration}|${action?.position || ""}`;
  const cached = segmentCache.get(track);
  if (cached?.key === key) return cached.result;

  const steps = track.boxes.filter(b => b.found && b.t >= track.start && b.t <= track.end)
    .sort((a, b) => a.t - b.t);
  const result = { segments: [], ballRatio: 0, fallback: false, hasData: steps.some(s => "near" in s) };
  if (!steps.length || !result.hasData) {
    segmentCache.set(track, { key, result });
    return result;
  }

  // Ball distance per step; fill gaps of up to 1.5 s by sliding between the two sightings.
  const dist = steps.map(s => s.ball ? s.ball.d : null);
  const seen = dist.filter(d => d !== null).length;
  result.ballRatio = seen / steps.length;
  for (let i = 0; i < steps.length; i++) {
    if (dist[i] !== null) continue;
    let p = i - 1, n = i + 1;
    while (p >= 0 && !steps[p].ball) p--;
    while (n < steps.length && !steps[n].ball) n++;
    if (p < 0 || n >= steps.length || !steps[p].ball || steps[n].t - steps[p].t > MAX_BALL_GAP) continue;
    const f = (steps[i].t - steps[p].t) / (steps[n].t - steps[p].t);
    const bx = steps[p].ball.x + (steps[n].ball.x - steps[p].ball.x) * f;
    const by = steps[p].ball.y + (steps[n].ball.y - steps[p].ball.y) * f;
    const [x0, y0, x1, y1] = steps[i].box, h = (y1 - y0) || 1e-6;
    dist[i] = Math.hypot(Math.max(x0 - bx, 0, bx - x1) * (action?.aspect || 1), Math.max(y0 - by, 0, by - y1)) / h;
  }

  // Speed in player-heights per second, to spot sudden bursts (tackles, sprints to the ball).
  const speed = steps.map((s, i) => {
    const q = steps[i ? i - 1 : Math.min(1, steps.length - 1)];
    const dt = Math.abs(s.t - q.t) || 1;
    const h = (s.box[3] - s.box[1]) || 1e-6;
    const dx = ((s.box[0] + s.box[2]) - (q.box[0] + q.box[2])) / 2 * (action?.aspect || 1);
    const dy = ((s.box[1] + s.box[3]) - (q.box[1] + q.box[3])) / 2;
    return Math.hypot(dx, dy) / h / dt;
  });
  const avgSpeed = speed.reduce((a, b) => a + b, 0) / speed.length || 0;

  result.fallback = result.ballRatio < 0.15;
  const reasons = steps.map((s, i) => {
    const challenge = (style.alone || s.near >= 1) && speed[i] > Math.max(style.burst * avgSpeed, 0.5);
    if (!result.fallback && dist[i] !== null && dist[i] <= Math.min(0.3, limit)) return "On the ball";
    if (!result.fallback && dist[i] !== null && dist[i] <= limit) return "Near the ball";
    if (challenge) return "Challenge";
    if (result.fallback && s.cluster >= style.crowd) return "In the action";
    return null;
  });

  // Group involved steps into runs, merge close runs, then add a lead-in and follow-through.
  const RANK = { "On the ball": 4, "Challenge": 3, "Near the ball": 2, "In the action": 1 };
  let runs = [];
  for (let i = 0; i < steps.length; i++) {
    if (!reasons[i]) continue;
    const last = runs.at(-1);
    if (last && steps[i].t - last.end <= 0.75) { last.end = steps[i].t; last.idx.push(i); }
    else runs.push({ start: steps[i].t, end: steps[i].t, idx: [i] });
  }
  const merged = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run.start - last.end < MERGE_GAP) { last.end = run.end; last.idx.push(...run.idx); }
    else merged.push(run);
  }
  for (const run of merged) {
    const best = run.idx.map(i => reasons[i]).sort((a, b) => RANK[b] - RANK[a])[0];
    if (run.end - run.start + 0.5 < 1 && best !== "On the ball" && best !== "Challenge") continue;   // too brief to matter
    const boxes = run.idx.map(i => steps[i].box);
    result.segments.push({
      start: Math.max(0, run.start - LEAD), end: Math.min(duration, run.end + TAIL),
      reason: best,
      cxs: boxes.map(b => (b[0] + b[2]) / 2), cys: boxes.map(b => (b[1] + b[3]) / 2),
    });
  }
  // Padding can make neighbours touch; join them so clips never overlap.
  result.segments = result.segments.reduce((out, s) => {
    const last = out.at(-1);
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end); last.cxs.push(...s.cxs); last.cys.push(...s.cys);
      if (RANK[s.reason] > RANK[last.reason]) last.reason = s.reason;
    } else out.push(s);
    return out;
  }, []);
  segmentCache.set(track, { key, result });
  return result;
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

export function applyFollowedTracks(moments, tracks, { loudness, aspect, duration = Infinity, action = null } = {}) {
  clearAutomatic(moments);
  const segmentsOf = new Map(action?.enabled ? tracks.map(tr =>
    [tr, actionSegments(tr, action, duration)]) : []);
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
      let reason = null;
      if (action?.enabled && segmentsOf.get(track)?.hasData) {
        const seg = segmentsOf.get(track).segments.find(s => moment.t >= s.start && moment.t <= s.end);
        if (!seg) continue;            // player not in action at this moment
        reason = seg.reason;
      }
      const actual = track.boxes.filter(item => item.t >= track.start && item.t <= track.end);
      if (!actual.length) continue;
      const nearest = actual.reduce((best, item) =>
        Math.abs(item.t - moment.t) < Math.abs(best.t - moment.t) ? item : best);
      const target = nearest.box;
      moment.players.forEach((player, index) => {
        const distance = boxCenterDistance(player.box, target, aspect);
        choices.push({ index, track, distance, reason });
      });
    }
    choices.sort((a, b) => a.distance - b.distance);
    const choice = choices[0];
    if (!choice) continue;
    moment.picked = choice.index;
    moment.pickSource = "followed";
    moment.followedTrack = choice.track;
    moment.autoInfo = { ...scoreHighlight(moment, choice.index, loudness, aspect), reason: choice.reason };
    moment.highlightScore = moment.autoInfo.score;
  }
}

export function budgetTracks(moments, { duration, maxSeconds, action = null }) {
  for (const moment of moments) moment.trackClip = null;
  const seconds = () => clipSeconds(clipsFor(moments, duration, action));
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
