// "Find my player in the rest of the game": after following the tagged plays,
// look in the parts of the video that weren't covered for the teammate who looks
// most like the tagged player. Sure matches are followed automatically; unsure
// ones become "Is this your player?" questions.

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

export const isIdentified = m => m.picked !== null && m.pickSource !== "auto";

// Spans of the game already covered by following.
export function coveredSpans(moments) {
  const spans = moments.filter(m => m.track && m.track.playerIndex === m.picked && m.picked !== null)
    .map(m => [Math.min(m.track.start, m.t), Math.max(m.track.end, m.t)]);
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]); else out.push([...s]);
  }
  return out;
}
export const isCoveredBy = spans => t => spans.some(([a, b]) => t >= a - 0.25 && t <= b + 0.25);

// Learn, from this video, how alike "your player" and "a teammate" usually look.
export function learnLook(moments, rejected = []) {
  const known = moments.filter(isIdentified);
  const refs = known.map(m => m.players[m.picked].desc).filter(Boolean);
  // Pick up to 40 references spread across the game.
  const step = Math.max(1, Math.floor(refs.length / 40));
  const sample = refs.filter((_, i) => i % step === 0).slice(0, 40);
  const sim = d => sample.length ? Math.max(...sample.map(r => dot(d, r))) : 0;
  const pos = [], neg = [];
  for (const m of known) {
    const self = m.players[m.picked].desc;
    const others = sample.filter(r => r !== self);
    if (others.length) pos.push(Math.max(...others.map(r => dot(self, r))));
    m.players.forEach((p, i) => { if (i !== m.picked && p.desc) neg.push(sim(p.desc)); });
  }
  // Self-check on frames where we already know who the player is: how often does the
  // look alone rank them above every teammate, and by how much do lookalikes get close?
  const leads = [];
  for (const m of known) {
    const self = m.players[m.picked].desc;
    const others = sample.filter(r => r !== self);
    if (!others.length) continue;
    const s = d => Math.max(...others.map(r => dot(d, r)));
    const mine = s(self);
    const rivals = m.players.filter((p, i) => i !== m.picked && p.desc).map(p => s(p.desc));
    if (rivals.length) leads.push(mine - Math.max(...rivals));
  }
  const enough = pos.length >= 4 && neg.length >= 6 && leads.length >= 4;
  const reliability = leads.length ? leads.filter(d => d > 0).length / leads.length : 0;
  const confusion = leads.filter(d => d < 0).map(d => -d);
  return {
    sim, rejected, reliability,
    // Follow automatically only when looks alone have proven reliable in this video,
    // and the match beats the runner-up by more than lookalikes usually get close.
    autoOK: enough && reliability >= 0.9,
    margin: Math.max(0.04, confusion.length ? quantile(confusion, 0.9) : 0.04),
    sure: enough ? Math.max(quantile(neg, 0.99) + 0.02, quantile(pos, 0.3)) : Infinity,
    ask: enough ? Math.min(quantile(neg, 0.8), quantile(pos, 0.3) - 0.02) : 0.75,
    learned: enough,
  };
}

// Best candidate in each uncovered stretch of the game.
export function candidatesInGaps(moments, look, { asked = new Set() } = {}) {
  const covered = isCoveredBy(coveredSpans(moments));
  const open = moments.filter(m => !isIdentified(m) && !covered(m.t)).sort((a, b) => a.t - b.t);
  // Group neighbouring uncovered moments (≤ 12 s apart) into gaps.
  const gaps = [];
  for (const m of open) {
    const g = gaps.at(-1);
    if (g && m.t - g.at(-1).t <= 12) g.push(m); else gaps.push([m]);
  }
  const results = [];
  for (const gap of gaps) {
    let best = null;
    for (const m of gap) {
      const scored = m.players.map((p, i) => {
        if (!p.desc || (m.rejected || []).includes(i)) return null;
        let s = look.sim(p.desc);
        // Looks like someone the user already said "no" to: count it down.
        for (const r of look.rejected) if (dot(p.desc, r) > s) s -= 0.05;
        return { i, s };
      }).filter(Boolean).sort((a, b) => b.s - a.s);
      if (!scored.length) continue;
      const margin = scored.length > 1 ? scored[0].s - scored[1].s : 0.2;
      const cand = { moment: m, playerIndex: scored[0].i, score: scored[0].s, margin,
        runnerUp: scored[1] ? scored[1].i : null, key: `${m.t}|${scored[0].i}` };
      if (asked.has(cand.key)) continue;
      if (!best || cand.score + cand.margin * 0.5 > best.score + best.margin * 0.5) best = cand;
    }
    if (best && best.score >= look.ask) results.push(best);
  }
  return results.sort((a, b) => b.score - a.score);
}

// Decide what to do with a candidate, using the jersey number when we can read it.
export function verdictFor(cand, look, number) {
  if (number === "mismatch") return "skip";
  if (number === "match") return cand.score >= look.ask ? "sure" : "ask";
  if (look.autoOK && cand.score >= look.sure && cand.margin >= look.margin) return "sure";
  return "ask";
}
