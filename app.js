// KitReel browser app (free version). Everything runs on the user's device:
// a player detector (TensorFlow.js) finds people in the chosen kit color,
// the user taps their player, and ffmpeg.wasm cuts the reel.
import { createWorkSession } from "/work-session.js";
import { actionSegments, applyFollowedTracks, budgetTracks, clearAutomatic, clipsFor, isCameraCut, isManualPick } from "/auto-pick.js?v=3";
import { createCrowdTask } from "/crowd-noise.js";
import { trackPlayer } from "/tracker.js?v=4";
import { cameraFor, cropFilter, spotlightFor, drawRing, drawCard, silentWav } from "/reel-fx.js?v=1";
import { learnLook, candidatesInGaps, verdictFor, coveredSpans, isCoveredBy } from "/refind.js?v=1";
import { numberVerdict } from "/jersey-ocr.js?v=1";

const $ = (id) => document.getElementById(id);
const PAGE = 30;            // moments shown per "Show more"
const state = {
  file: null, url: null, duration: 0, width: 0, height: 0,
  limits: { maxVideoMB: 4096, maxVideoMinutes: 101, touchMaxVideoMB: 500, touchMaxVideoMinutes: 20,
    maxReelSeconds: 600, maxMoments: 900, reelTtlHours: 24 },
  model: null, modelPromise: null, videoSelection: 0, firstFrameChecked: false, lastDrawnFrame: null,
  teamChosen: false,
  moments: [], shown: PAGE, reelBlob: null, reelUrl: null, ffmpeg: null, ffmpegPromise: null,
  loudness: null, cancelCrowd: null, editorQueue: Promise.resolve(), followRan: false, scanInterval: 3,
  action: { enabled: true, closeness: "normal" },   // "Only keep my player in action"
  clipEdits: {},          // per-clip trims/removals, keyed by the clip's original start–end
  clipBlobs: [],          // finished single clips, for "Download clips one by one"
  questions: [],          // "Is this your player?" candidates
  askedKeys: new Set(),   // candidates already answered or skipped
  rejectedDescs: [],      // looks of players the user said "no" to
  refindFound: 0,
};
const actionOpts = () => ({ ...state.action, aspect: state.width / state.height || 16 / 9 });

// Hidden helpers for grabbing frames
const grabber = document.createElement("video");
grabber.muted = true; grabber.playsInline = true; grabber.preload = "auto";
grabber.setAttribute("playsinline", "");
grabber.setAttribute("muted", "");
grabber.style.cssText = "position:fixed;left:-10px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
document.body.appendChild(grabber);
const frameCv = document.createElement("canvas");
const frameCtx = frameCv.getContext("2d", { willReadFrequently: true });
const tmpCv = document.createElement("canvas");
const tmpCtx = tmpCv.getContext("2d", { willReadFrequently: true });
let resumeTimer = null;
const workSession = createWorkSession({ document, window, navigator, onResume: showResumeNotice, pauseWhenHidden: isTouchDevice });

init();

async function init() {
  if (isTouchDevice()) {
    // Phones: reels up to 3 minutes (memory and build time); computers go up to 10.
    $("max-len").querySelectorAll("[data-computer-only]").forEach(o => o.remove());
    $("max-len").value = "60";
    try {
      $("device-tip").hidden = window.localStorage.getItem("kitreel-device-tip-dismissed") === "1";
    } catch {
      $("device-tip").hidden = false;
    }
  }
  $("dismiss-device-tip").addEventListener("click", () => {
    $("device-tip").hidden = true;
    try {
      window.localStorage.setItem("kitreel-device-tip-dismissed", "1");
    } catch {}
  });
  $("file").addEventListener("change", onFile);
  setupDropZone();
  $("preview").addEventListener("click", sampleColorFromClick);
  $("find-teams").addEventListener("click", () => run(findTeams, "scan-error"));
  $("kit-color").addEventListener("input", () => setKitColor($("kit-color").value));
  $("kit-color").addEventListener("change", () => setKitColor($("kit-color").value));
  $("scan").addEventListener("click", () => run(scan, "scan-error"));
  $("sort").addEventListener("change", () => { state.shown = PAGE; renderMoments(); });
  $("auto-pick").addEventListener("click", () => run(followPlayer, "review-error"));
  $("clear-auto").addEventListener("click", clearAutoPicks);
  $("clip-preview").addEventListener("timeupdate", () => {
    if (clipPreviewEnd !== null && $("clip-preview").currentTime >= clipPreviewEnd) { $("clip-preview").pause(); clipPreviewEnd = null; }
  });
  $("fx-title").addEventListener("change", () => { $("fx-title-fields").hidden = !$("fx-title").checked; });
  try { $("fx-date").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); } catch {}
  const onActionChange = () => {
    state.action.enabled = $("action-only").checked;
    state.action.closeness = $("closeness").value;
    $("closeness-wrap").hidden = !state.action.enabled;
    if (workSession.running) return;
    updatePickInfo(); renderMoments(); updateAutoResult();
  };
  $("action-only").addEventListener("change", onActionChange);
  $("closeness").addEventListener("change", onActionChange);
  $("more").addEventListener("click", () => { state.shown += PAGE; renderMoments(); });
  $("build").addEventListener("click", () => run(buildReel, "review-error"));
  $("share").addEventListener("click", () => run(shareReel, "share-info"));
  $("clear").addEventListener("click", clearAll);
  $("max-len").addEventListener("change", () => { updatePickInfo(); renderMoments(); updateAutoResult(); });
  $("interval").addEventListener("change", updateScanEstimate);
  updateLimitsDisplay();
  // A native label can open the picker even before this module has loaded.
  if ($("file").files?.length) void onFile({ target: $("file") });
  // GitHub version: limits are fixed in state.limits (there's no server to ask).
  $("share").hidden = !canShareFiles();
}

async function run(fn, errId) {
  if (workSession.running) return;
  if (fn === findTeams || fn === scan || fn === buildReel || fn === followPlayer) cancelCrowdNoise();
  $(errId).textContent = "";
  setBusy(true);
  const protectWork = fn === findTeams || fn === scan || fn === buildReel || fn === followPlayer || fn.protectWork;
  try {
    if (protectWork) workSession.start();
    await fn();
  } catch (e) {
    console.error(e);
    $(errId).textContent = e.message || String(e);
    hideProgress();
  } finally {
    if (protectWork) {
      await workSession.finish();
      clearTimeout(resumeTimer);
      $("resume-notice").hidden = true;
    }
    setBusy(false);
  }
}
function isTouchDevice() {
  try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}
function videoLimits() {
  return isTouchDevice() ?
    { maxVideoMB: state.limits.touchMaxVideoMB, maxVideoMinutes: state.limits.touchMaxVideoMinutes } :
    { maxVideoMB: state.limits.maxVideoMB, maxVideoMinutes: state.limits.maxVideoMinutes };
}
function updateLimitsDisplay() {
  const { maxVideoMB, maxVideoMinutes } = videoLimits();
  const size = formatVideoSize(maxVideoMB);
  $("lim-mb").textContent = size.value;
  $("lim-unit").textContent = size.unit;
  $("lim-min").textContent = maxVideoMinutes;
  $("drop-limits").textContent = `MP4 · up to ${size.value} ${size.unit} · up to ${maxVideoMinutes} minutes`;
}
function formatVideoSize(maxVideoMB) {
  if (maxVideoMB >= 1024) {
    return { value: String(Number((maxVideoMB / 1024).toFixed(1))), unit: "GB" };
  }
  return { value: String(maxVideoMB), unit: "MB" };
}
function updateScanEstimate() {
  const interval = Number($("interval").value) || 3;
  const minutes = Math.max(1, Math.ceil(state.duration / interval / (isTouchDevice() ? 0.5 : 2) / 60));
  $("scan-estimate").textContent = state.duration ? `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} for this video.` : "";
}
function showResumeNotice() {
  $("resume-notice").textContent = "Paused while you were away. Picking up where you left off.";
  $("resume-notice").hidden = false;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => { $("resume-notice").hidden = true; }, 5000);
}
function setBusy(b) {
  for (const id of ["scan", "share", "find-teams", "file"]) $(id).disabled = b;
  $("drop-zone").setAttribute("aria-disabled", String(b));
  $("change-video").disabled = b;
  if (b) $("drop-zone").classList.remove("is-dragover");
  $("build").disabled = b || !pickedMoments().length;
  $("auto-pick").disabled = b || !state.moments.some(isManualPick);
  $("clear-auto").disabled = b;
  $("max-len").disabled = b;
  $("kit-color").disabled = b;
  document.querySelectorAll(".player").forEach(button => { button.disabled = b; });
  updateTeamChoice(b);
}
function updateTeamChoice(busy = workSession.running) {
  $("scan").disabled = busy || !state.teamChosen;
  $("team-hint").hidden = state.teamChosen;
}

// ---------- Step 1: load + check the video ----------
function setupDropZone() {
  const zone = $("drop-zone");
  const input = $("file");
  const chooseFile = () => {
    if (input.disabled) return;
    input.value = ""; // Selecting the same file again must still fire change.
    input.click();
  };
  // Let the label's native activation open the picker (including before init).
  zone.addEventListener("click", (event) => {
    if (input.disabled) { event.preventDefault(); return; }
    input.value = "";
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseFile();
    }
  });
  $("change-video").addEventListener("click", chooseFile);
  for (const name of ["dragenter", "dragover"]) {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      if (input.disabled) return;
      zone.classList.add("is-dragover");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
  }
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove("is-dragover");
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragover");
    if (input.disabled) return;
    const file = event.dataTransfer?.files[0];
    if (file) void onFile(file);
  });
}

function isVideoFile(file) {
  return file.type?.startsWith("video/") ||
    ((!file.type || file.type === "application/octet-stream") &&
      /\.(mp4|m4v|mov|webm|ogv|avi|wmv|mkv|mpeg|mpg|3gp|3g2|ts|mts|m2ts)$/i.test(file.name || ""));
}

async function onFile(input) {
  const file = input?.target ? input.target.files[0] : input;
  const selection = ++state.videoSelection;
  cancelCrowdNoise();
  state.loudness = null;
  $("detector-status").textContent = "";
  $("detector-status").hidden = true;
  $("file-error").textContent = "";
  hide("step-player", "step-options", "step-review", "step-reel");
  if (!file) return;
  if (!isVideoFile(file)) {
    $("file-error").textContent = "That doesn't look like a video file.";
    return;
  }
  const { maxVideoMB, maxVideoMinutes } = videoLimits();
  if (file.size > maxVideoMB * 1024 * 1024) {
    const sizeLimit = formatVideoSize(maxVideoMB);
    $("file-error").textContent = isTouchDevice() ?
      "That's too big for a phone. Try it on a computer (up to 4 GB / 101 minutes)." :
      `That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${sizeLimit.value} ${sizeLimit.unit} — try a shorter clip or a lower-quality export.`;
    return;
  }
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.firstFrameChecked = false;
  state.lastDrawnFrame = null;
  state.url = URL.createObjectURL(file);
  grabber.src = state.url;
  try {
    const metadata = once(grabber, "loadedmetadata", 15000);
    grabber.load();
    await metadata;
  }
  catch { $("file-error").textContent = "Your browser can't read this video format. Try an MP4 in Chrome, Edge or Safari."; return; }
  if (selection !== state.videoSelection) return;

  state.duration = grabber.duration; state.width = grabber.videoWidth; state.height = grabber.videoHeight;
  if (!isFinite(state.duration) || state.duration > maxVideoMinutes * 60 + 1) {
    $("file-error").textContent = isTouchDevice() ?
      "That's too big for a phone. Try it on a computer (up to 4 GB / 101 minutes)." :
      `That video is ${fmt(state.duration)} long. The limit is ${maxVideoMinutes} minutes.`;
    return;
  }
  const p = $("preview"); p.src = state.url; p.hidden = false;
  $("drop-title").textContent = file.name;
  $("drop-subtitle").hidden = true;
  $("change-video").hidden = false;
  $("drop-zone").setAttribute("aria-label", `${file.name}. Choose a different video`);
  $("video-info").textContent = `${fmt(state.duration)} · ${state.width}×${state.height} · ${(file.size / 1048576).toFixed(0)} MB`;
  document.dispatchEvent(new Event("kitreel:video-loaded"));
  $("detector-status").hidden = false;
  $("detector-status").textContent = "Getting the player detector ready…";
  void getModel().then(() => {
    if (selection === state.videoSelection) {
      $("detector-status").textContent = "Player detector ready ✓";
    }
  }).catch(() => {
    if (selection === state.videoSelection) {
      $("detector-status").textContent = "";
      $("detector-status").hidden = true;
    }
  });
  $("teams").innerHTML = "";
  state.teamChosen = false;
  updateTeamChoice();
  $("interval").value = state.duration > 30 * 60 ? "5" : "3";
  updateScanEstimate();
  show("step-player", "step-options");
}

// ---------- Step 2: team color ----------
function sampleColorFromClick(e) {
  const v = $("preview");
  if (!v.videoWidth) return;
  v.pause();
  const r = v.getBoundingClientRect();
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);   // letterboxing
  const ox = (r.width - v.videoWidth * scale) / 2, oy = (r.height - v.videoHeight * scale) / 2;
  const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale;
  if (x < 0 || y < 0 || x >= v.videoWidth || y >= v.videoHeight) return;
  tmpCv.width = v.videoWidth; tmpCv.height = v.videoHeight;
  tmpCtx.drawImage(v, 0, 0);
  const s = 3, d = tmpCtx.getImageData(Math.max(0, x - s), Math.max(0, y - s), s * 2 + 1, s * 2 + 1).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  setKitColor(rgbToHex(R / n, G / n, B / n));
  e.preventDefault();
}
function setKitColor(hex) {
  state.teamChosen = true;
  $("kit-color").value = hex;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("selected", c.dataset.hex === hex));
  updateTeamChoice();
}

// Free team-color finder: detect players in a few frames and group their shirt colors.
async function findTeams() {
  state.teamChosen = false;
  updateTeamChoice();
  showProgress("Finding team colors…");
  $("teams").innerHTML = '<span class="hint">Looking at the players…</span>';
  const model = await getModel((t) => {
    $("teams").innerHTML = `<span class="hint">${t}</span>`;
    setProgress(0, t);
  });
  const colors = [];
  const trySeek = forgivingFrameSeeker();
  const estimate = workSession.startEstimate();
  let previousFrame = null;
  for (let k = 1; k <= 8; k++) {
    const frame = await seekDrawFrame((k / 9) * state.duration, previousFrame, trySeek);
    if (frame) {
      previousFrame = frame;
      for (const b of await detectPeople(model)) {
        const c = torsoColor(b);
        if (c) colors.push(c);
      }
    }
    setProgress(k / 8 * 100, `Looking at players · ${k} of 8`, estimate(k, 8));
  }
  hideProgress();
  $("teams").innerHTML = "";
  if (colors.length < 3) { $("teams").innerHTML = '<span class="hint">Couldn\'t spot enough players — click a jersey in the video instead.</span>'; return; }
  const clusters = mergeSimilarTeamColors(
    kmeans(colors, Math.min(4, colors.length)).filter((c) => c.size >= colors.length * 0.1),
  );
  for (const c of clusters) {
    const hex = rgbToHex(...c.center);
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.hex = hex;
    b.innerHTML = `<span class="swatch" style="background:${hex}"></span>${colorName(hex)} shirts`;
    b.onclick = () => setKitColor(hex);
    $("teams").appendChild(b);
  }
}

// ---------- Step 3: find moments ----------
async function scan() {
  const interval = Number($("interval").value);
  state.scanInterval = interval;
  state.loudness = null;
  state.followRan = false;
  const target = hexToHsv($("kit-color").value);
  hide("step-review", "step-reel");
  showProgress("Finding players…");
  const model = await getModel((t) => setProgress(0, t));

  // Pass 1: quick color check on small frames
  const times = [];
  for (let t = Math.min(1, state.duration / 2); t < state.duration - 0.2; t += interval) times.push(t);
  let candidates = [];
  const trySeek = forgivingFrameSeeker();
  let previousFrame = null;
  const colorEstimate = workSession.startEstimate();
  for (let i = 0; i < times.length; i++) {
    const frame = await seekDrawFrame(times[i], previousFrame, trySeek);
    if (frame) {
      previousFrame = frame;
      if (await kitScore(target) >= 0.002) candidates.push(times[i]);
    }
    if (i === 0 || (i + 1) % 5 === 0 || i === times.length - 1) {
      setProgress(((i + 1) / times.length) * 30, `Checking colors · ${fmt(times[i])} of ${fmt(state.duration)}`,
        colorEstimate(i + 1, times.length));
    }
  }
  if (!candidates.length) throw new Error("I couldn't find that shirt color anywhere. Try clicking a jersey in the video to grab its exact color.");
  const cap = state.limits.maxMoments;
  if (candidates.length > cap) {
    const step = candidates.length / cap;
    candidates = Array.from({ length: cap }, (_, k) => candidates[Math.floor(k * step)]);
  }

  // Pass 2: find the players in that kit
  const moments = [];
  const playerEstimate = workSession.startEstimate();
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const players = [];
    let balls = [], sig = [];
    const frame = await seekDrawFrame(t, previousFrame, trySeek);
    if (frame) {
      previousFrame = frame;
      const detections = await detectPeople(model);
      balls = detections.balls || [];
      sig = frame.sig;
      for (const box of detections) {
        if (torsoMatch(box, target) < (target.s < 0.4 ? 0.3 : 0.2)) continue;
        players.push({ box: normBox(box), crop: cropImage(box), desc: describe(box) });
      }
    }
    if (players.length) {
      players.sort((a, b) => a.box[0] - b.box[0]);   // left to right, matching the frame tags
      moments.push({ t, players, balls, sig, thumb: frameThumb(players), picked: null,
        pickSource: null, autoExcluded: false, highlightScore: 0 });
    }
    setProgress(30 + ((i + 1) / candidates.length) * 70, `Finding players · ${i + 1} of ${candidates.length} · ${moments.length} moments`,
      playerEstimate(i + 1, candidates.length));
  }
  hideProgress();
  if (!moments.length) throw new Error("I couldn't pick out any players in that color. Try a different shirt color or check the video every 2 seconds.");

  state.moments = moments;
  state.shown = PAGE;
  $("sort").value = "time";
  $("sort").querySelector('[value="match"]').disabled = true;
  const num = $("kit-number").value.trim();
  $("review-help").textContent = `In each moment, tag your player${num ? ` (#${num})` : ""}. Skip moments they're not in. Tap again to undo.`;
  renderMoments();
  updatePickInfo();
  show("step-review");
  $("auto-result").hidden = true;
  $("clear-auto").hidden = true;
  startCrowdNoise();
  $("step-review").scrollIntoView({ behavior: "smooth" });
}

function getModel(onStatus) {
  if (!state.model) onStatus?.("Loading the player detector (about 18 MB, first time only)…");
  if (!state.modelPromise) {
    state.modelPromise = (async () => {
      if (typeof tf === "undefined") await loadScript("/vendor/tf/tf.min.js");
      if (typeof cocoSsd === "undefined") await loadScript("/vendor/cocossd/coco-ssd.min.js");
      try { await tf.setBackend("webgl"); } catch {}
      await tf.ready();
      state.model = await cocoSsd.load({ base: "mobilenet_v2", modelUrl: "/models/coco-ssd/model.json" });
      return state.model;
    })().catch((error) => {
      state.modelPromise = null;
      throw error;
    });
  }
  return state.modelPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error("Couldn't load the player detector. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
}

async function createEditor() {
  const { FFmpeg } = await import("/vendor/ffmpeg/index.js");
  return new FFmpeg();
}

function getEditor() {
  if (!state.ffmpegPromise) {
    let ff;
    state.ffmpegPromise = (async () => {
      ff = await createEditor();
      await ff.load({ coreURL: "/vendor/core/ffmpeg-core.js", wasmURL: "/vendor/core/ffmpeg-core.wasm" });
      state.ffmpeg = ff;
      return ff;
    })().catch((error) => {
      try { ff.terminate(); } catch {}
      state.ffmpegPromise = null;
      throw error;
    });
  }
  return state.ffmpegPromise;
}
function queueEditor(task) {
  const result = state.editorQueue.then(task, task);
  state.editorQueue = result.catch(() => {});
  return result;
}
function resetEditor(ff) {
  try { ff.terminate(); } catch {}
  if (state.ffmpeg === ff) {
    state.ffmpeg = null;
    state.ffmpegPromise = null;
  }
}
function cancelCrowdNoise() {
  state.cancelCrowd?.();
  state.cancelCrowd = null;
}
function startCrowdNoise() {
  cancelCrowdNoise();
  const selection = state.videoSelection;
  $("crowd-status").textContent = "Listening for crowd noise…";
  $("crowd-status").hidden = false;
  const task = createCrowdTask({
    getEditor, mountInput, releaseInput, resetEditor,
    onReady(scores) {
      if (selection !== state.videoSelection || !scores.length) return;
      state.loudness = scores;
      $("crowd-status").textContent = "Crowd noise ready ✓";
    },
    onSkip() {
      if (selection === state.videoSelection) $("crowd-status").hidden = true;
    },
  });
  state.cancelCrowd = task.cancel;
  void queueEditor(() => task.run()).finally(() => {
    if (state.cancelCrowd === task.cancel) state.cancelCrowd = null;
  });
}

// Draw the current frame (max 1280 wide) into frameCv
async function drawFrame() {
  const w = Math.min(1280, state.width), h = Math.round(w * state.height / state.width);
  frameCv.width = w; frameCv.height = h;
  await grabFrame(frameCtx, w, h);
}
async function grabFrame(context, width, height) {
  await workSession.waitUntilVisible();
  context.drawImage(grabber, 0, 0, width, height);
  if (state.firstFrameChecked) return;
  state.firstFrameChecked = true;
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] || pixels[i + 1] || pixels[i + 2]) return;
  }
  try { await grabber.play(); } catch {}
  finally { grabber.pause(); }
  await workSession.waitUntilVisible();
  context.drawImage(grabber, 0, 0, width, height);
}

// Detect people. Wide frames are split into two overlapping squares so
// far-away players are big enough for the detector to see.
async function detectPeople(model) {
  const W = frameCv.width, H = frameCv.height;
  const tiles = W / H > 1.4 ? [[0, H], [W - H, H]].map(([x]) => ({ x, w: H })) : [{ x: 0, w: W }];
  let boxes = [], balls = [];
  for (const tile of tiles) {
    tmpCv.width = tile.w; tmpCv.height = H;
    tmpCtx.drawImage(frameCv, tile.x, 0, tile.w, H, 0, 0, tile.w, H);
    const dets = await model.detect(tmpCv, 40, 0.3);
    for (const d of dets) {
      const [x, y, w, h] = d.bbox;
      if (d.class === "person") boxes.push({ x: x + tile.x, y, w, h, score: d.score });
      else if (d.class === "sports ball" && d.score >= 0.3) {
        const center = { x: (x + tile.x + w / 2) / W, y: (y + h / 2) / H };
        if (!balls.some(b => Math.hypot(b.x - center.x, b.y - center.y) < 0.01)) balls.push(center);
      }
    }
  }
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of boxes) if (b.h >= 24 && !kept.some((k) => iou(k, b) > 0.45 || overlapOfSmaller(k, b) > 0.6)) kept.push(b);
  kept.balls = balls;
  return kept;
}
// Look for the ball close to one player. The ball is tiny in wide game footage, so
// crop a square about 4 player-heights wide around them and scale it up first.
async function detectBallNear(model, box) {
  const W = frameCv.width, H = frameCv.height;
  const ph = (box[3] - box[1]) * H;
  const side = Math.min(Math.max(ph * 4, 160), W, H);
  const cx = (box[0] + box[2]) / 2 * W, cy = (box[1] + box[3]) / 2 * H;
  const x = Math.round(clamp(cx - side / 2, 0, W - side)), y = Math.round(clamp(cy - side / 2, 0, H - side));
  const S = 640;
  tmpCv.width = S; tmpCv.height = S;
  tmpCtx.drawImage(frameCv, x, y, side, side, 0, 0, S, S);
  const dets = await model.detect(tmpCv, 20, 0.2);
  return dets.filter(d => d.class === "sports ball" && d.score >= 0.25).map(d => {
    const [bx, by, bw, bh] = d.bbox;
    return { x: (x + (bx + bw / 2) * side / S) / W, y: (y + (by + bh / 2) * side / S) / H };
  });
}
function frameSignature() {
  tmpCv.width = 16; tmpCv.height = 9;
  tmpCtx.drawImage(frameCv, 0, 0, 16, 9);
  const d = tmpCtx.getImageData(0, 0, 16, 9).data;
  return Array.from({ length: 144 }, (_, i) => Math.round(
    0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2],
  ));
}

function torsoRegion(b) {
  return { x: Math.round(b.x + b.w * 0.25), y: Math.round(b.y + b.h * 0.18), w: Math.max(2, Math.round(b.w * 0.5)), h: Math.max(2, Math.round(b.h * 0.32)) };
}
function torsoMatch(b, target) {
  const r = torsoRegion(b);
  const d = frameCtx.getImageData(r.x, r.y, r.w, r.h).data;
  let m = 0;
  for (let i = 0; i < d.length; i += 4) if (colorMatches(rgbToHsv(d[i], d[i + 1], d[i + 2]), target)) m++;
  return m / (d.length / 4);
}
function torsoColor(b) {
  const r = torsoRegion(b);
  if (r.w < 3 || r.h < 3) return null;
  const d = frameCtx.getImageData(r.x, r.y, r.w, r.h).data;
  const ch = [[], [], []];
  for (let i = 0; i < d.length; i += 4) { ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); }
  return ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
}
function normBox(b) {
  const W = frameCv.width, H = frameCv.height;
  return [b.x / W, b.y / H, (b.x + b.w) / W, (b.y + b.h) / H];
}
function paddedBox(b) {
  const px = b.w * 0.15, py = b.h * 0.08;
  const x = Math.max(0, b.x - px), y = Math.max(0, b.y - py);
  return { x, y, w: Math.min(frameCv.width - x, b.w + px * 2), h: Math.min(frameCv.height - y, b.h + py * 2) };
}
function cropImage(b) {
  const p = paddedBox(b);
  const h = 180, w = Math.max(60, Math.round(h * p.w / p.h));
  tmpCv.width = w; tmpCv.height = h;
  tmpCtx.imageSmoothingQuality = "high";
  tmpCtx.drawImage(frameCv, p.x, p.y, p.w, p.h, 0, 0, w, h);
  return tmpCv.toDataURL("image/jpeg", 0.82);
}
// A tiny "look" fingerprint of a player (hair, skin, shirt, shorts, socks)
// used to sort similar-looking players to the top.
function describe(b) {
  const p = paddedBox(b);
  tmpCv.width = 6; tmpCv.height = 12;
  tmpCtx.drawImage(frameCv, p.x, p.y, p.w, p.h, 0, 0, 6, 12);
  const d = tmpCtx.getImageData(0, 0, 6, 12).data;
  const v = [];
  for (let i = 0; i < d.length; i += 4) v.push(d[i], d[i + 1], d[i + 2]);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const c = v.map((x) => x - mean);
  const n = Math.hypot(...c) || 1;
  return c.map((x) => x / n);
}
function frameThumb(players) {
  const w = 320, h = Math.round(320 * frameCv.height / frameCv.width), sx = w / frameCv.width;
  tmpCv.width = w; tmpCv.height = h;
  tmpCtx.drawImage(frameCv, 0, 0, w, h);
  tmpCtx.lineWidth = 2; tmpCtx.font = "bold 12px system-ui"; tmpCtx.textBaseline = "top";
  players.forEach((pl, i) => {
    const [x0, y0, x1, y1] = pl.box.map((v, k) => v * (k % 2 ? frameCv.height : frameCv.width) * sx);
    tmpCtx.strokeStyle = "#3ddc84"; tmpCtx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    tmpCtx.fillStyle = "#3ddc84"; tmpCtx.fillRect(x0, Math.max(0, y0 - 14), 14, 14);
    tmpCtx.fillStyle = "#062611"; tmpCtx.fillText(String(i + 1), x0 + 3, Math.max(0, y0 - 13));
  });
  return tmpCv.toDataURL("image/jpeg", 0.75);
}

async function kitScore(target) {
  const w = 160, h = Math.round(160 * state.height / state.width) || 90;
  tmpCv.width = w; tmpCv.height = h;
  tmpCtx.drawImage(frameCv, 0, 0, w, h);
  const d = tmpCtx.getImageData(0, 0, w, h).data;
  let match = 0;
  for (let i = 0; i < d.length; i += 4) if (colorMatches(rgbToHsv(d[i], d[i + 1], d[i + 2]), target)) match++;
  return match / (w * h);
}
function colorMatches(p, t) {
  if (t.s < 0.18) {                        // white / grey / black kits
    if (t.v > 0.7) return p.s < 0.2 && p.v > 0.72;
    if (t.v < 0.25) return p.v < 0.18;
    return p.s < 0.2 && Math.abs(p.v - t.v) < 0.15;
  }
  // colored kits, including dark ones like navy or maroon: brightness is judged
  // relative to the kit so shade and floodlights don't knock it out
  const dh = Math.min(Math.abs(p.h - t.h), 360 - Math.abs(p.h - t.h));
  const pale = t.s < 0.4;
  return dh < (pale ? 14 : 24) && (!pale || Math.abs(p.s - t.s) <= 0.15) &&
    p.s > Math.max(0.2, t.s * 0.5) && p.v > Math.max(0.07, t.v * 0.45) && p.v < Math.min(1, t.v * 1.9 + 0.1);
}

// ---------- Step 4: tap to pick ----------
function pickedMoments() { return state.moments.filter((m) => m.picked !== null); }

function sortedMoments() {
  if ($("sort").value === "best") return [...state.moments].sort((a, b) =>
    (isManualPick(b) ? 1 : b.highlightScore || 0) - (isManualPick(a) ? 1 : a.highlightScore || 0) || a.t - b.t);
  if ($("sort").value !== "match") return [...state.moments].sort((a, b) => a.t - b.t);
  const refs = pickedMoments().map((m) => m.players[m.picked].desc);
  const score = (m) => m.picked !== null ? 2 : Math.max(...m.players.map((p) => Math.max(...refs.map((r) => dot(p.desc, r)))));
  for (const m of state.moments) m.score = score(m);
  return [...state.moments].sort((a, b) => b.score - a.score || a.t - b.t);
}

function renderMoments() {
  const list = sortedMoments();
  const box = $("moments");
  box.innerHTML = "";
  for (const m of list.slice(0, state.shown)) box.appendChild(momentCard(m));
  $("more").hidden = state.shown >= list.length;
  $("more").textContent = `Show more moments (${list.length - Math.min(state.shown, list.length)} left)`;
}

const REASON_ICON = { "On the ball": "⚽", "Near the ball": "⚽", "Challenge": "💥", "In the action": "🏃" };
function momentCard(m) {
  const card = document.createElement("div");
  card.className = "moment" + (m.picked !== null ? " picked" : "");
  card.innerHTML = `<div class="frame"><img src="${m.thumb}" alt="" /><span>${fmt(m.t)}</span></div><div class="moment-content"><div class="players"></div></div>`;
  const row = card.querySelector(".players");
  m.players.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "player" + (m.picked === i ? " on" : "");
    b.innerHTML = `<img src="${p.crop}" alt="Player ${i + 1}" /><span class="tag">${i + 1}</span>`;
    if (m.picked === i && (m.pickSource === "auto" || m.pickSource === "followed")) {
      const tag = document.createElement("span");
      tag.className = "auto-tag";
      tag.textContent = m.autoInfo?.reason ? `${REASON_ICON[m.autoInfo.reason] || ""} ${m.autoInfo.reason}`
        : `${m.pickSource === "followed" ? "Followed" : "Auto"}${m.autoInfo?.ball >= 0.5 ? " ⚽" : ""}${m.autoInfo?.crowd >= 0.6 ? " 📣" : ""}`;
      b.appendChild(tag);
    }
    if (m.picked === i && (m.pickSource === "matched" || m.pickSource === "confirmed")) {
      const tag = document.createElement("span");
      tag.className = "auto-tag";
      tag.textContent = m.pickSource === "matched" ? "🔎 Found" : "✓ Confirmed";
      b.appendChild(tag);
    }
    b.onclick = () => togglePick(m, i, card);
    row.appendChild(b);
  });
  if (m.track && m.track.playerIndex === m.picked && isManualPick(m)) {
    const note = document.createElement("p");
    note.className = "follow-note";
    const followedSeconds = m.track.end - m.track.start;
    const act = state.action.enabled && followedSeconds >= 4 ? actionSegments(m.track, actionOpts(), state.duration) : null;
    note.textContent = followedSeconds < 4
      ? "Couldn't follow — keeping up to 20s around this moment"
      : act?.hasData
        ? `Followed ${fmt(m.track.start)}–${fmt(m.track.end)} · ${act.segments.length} action clip${act.segments.length === 1 ? "" : "s"} (${Math.round(act.segments.reduce((s, c) => s + c.end - c.start, 0))}s)`
        : `Followed ${fmt(m.track.start)}–${fmt(m.track.end)} (${Math.round(followedSeconds)}s)`;
    card.querySelector(".moment-content").appendChild(note);
  }
  return card;
}

function togglePick(m, i, card) {
  if (workSession.running) return;
  $("review-error").textContent = "";
  const before = m.picked;
  m.picked = m.picked === i ? null : i;
  const max = Number($("max-len").value);
  if (m.picked !== null && reelSeconds() > max) {
    m.picked = before;
    $("review-error").textContent = `Your reel is full (${fmt(max)}). Untick a moment or raise the max reel length.`;
    return;
  }
  card.classList.toggle("picked", m.picked !== null);
  m.pickSource = m.picked === null ? null : "manual";
  m.followedTrack = null;
  m.autoExcluded = m.picked === null;
  m.highlightScore = m.picked !== null ? 1 : m.autoInfo?.score || 0;
  card.querySelectorAll(".auto-tag").forEach(el => el.remove());
  card.querySelectorAll(".player").forEach((el, k) => el.classList.toggle("on", m.picked === k));
  const opt = $("sort").querySelector('[value="match"]');
  if (opt.disabled && pickedMoments().length) {
    opt.disabled = false;
    $("review-help").textContent += " Tip: after a few picks, switch to “Best matches first” to see similar-looking players at the top.";
  }
  updatePickInfo();
  updateAutoResult();
  renderMoments();
}

const clipKey = c => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`;
function makeClips({ includeRemoved = false } = {}) {
  return clipsFor(state.moments, state.duration, actionOpts()).map(c => {
    const key = clipKey(c), e = state.clipEdits[key] || {};
    const start = clamp(c.start + (e.dStart || 0), 0, c.end - 1);
    const end = clamp(c.end + (e.dEnd || 0), start + 1, state.duration);
    return { ...c, key, start, end, removed: Boolean(e.removed) };
  }).filter(c => includeRemoved || !c.removed);
}
function reelSeconds() { return makeClips().reduce((s, c) => s + c.end - c.start, 0); }
function updatePickInfo() {
  fitFollowedClips();
  const n = pickedMoments().length, secs = reelSeconds(), max = Number($("max-len").value);
  $("pick-count").textContent = `${n} picked · ${fmt(secs)} of ${fmt(max)}`;
  $("build").disabled = !n;
  $("build-hint").textContent = n ? `${state.moments.length} moments found. Your reel will be ${fmt(secs)}.` : "Pick at least one moment.";
  $("auto-pick").disabled = state.moments.filter(isManualPick).length < 1;
  $("auto-hint").hidden = !$("auto-pick").disabled;
  renderClipList();
}

// ---------- "Your clips": preview, trim and remove before making the reel ----------
const CLIP_ICON = { "On the ball": "⚽", "Near the ball": "⚽", "Challenge": "💥", "In the action": "🏃", "Followed": "👟", "Picked": "📍" };
let clipPreviewEnd = null;
function renderClipList() {
  const clips = makeClips({ includeRemoved: true });
  const list = $("clip-list");
  $("clip-panel").hidden = !clips.length;
  list.innerHTML = "";
  clips.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "clip-row" + (c.removed ? " removed" : "");
    const len = Math.round(c.end - c.start);
    li.innerHTML = `<div class="clip-meta"><b>Clip ${i + 1}</b> <span>${fmt(c.start)}–${fmt(c.end)} · ${len}s</span>
      <span class="clip-reason">${CLIP_ICON[c.reason] || ""} ${c.reason || ""}</span></div>
      <div class="clip-actions">
        <button type="button" class="ghost small" data-act="play" ${c.removed ? "disabled" : ""}>▶ Play</button>
        <span class="trim" aria-label="Start time"><span>Start</span>
          <button type="button" class="ghost small" data-act="s-" aria-label="Start 1 second earlier" ${c.removed ? "disabled" : ""}>−1s</button>
          <button type="button" class="ghost small" data-act="s+" aria-label="Start 1 second later" ${c.removed ? "disabled" : ""}>+1s</button></span>
        <span class="trim" aria-label="End time"><span>End</span>
          <button type="button" class="ghost small" data-act="e-" aria-label="End 1 second earlier" ${c.removed ? "disabled" : ""}>−1s</button>
          <button type="button" class="ghost small" data-act="e+" aria-label="End 1 second later" ${c.removed ? "disabled" : ""}>+1s</button></span>
        <button type="button" class="ghost small" data-act="rm">${c.removed ? "Put back" : "Remove"}</button>
      </div>`;
    li.querySelectorAll("button").forEach(b => b.addEventListener("click", () => clipAction(c, b.dataset.act)));
    list.appendChild(li);
  });
}
function clipAction(c, act) {
  if (workSession.running) return;
  if (act === "play") return playClip(c);
  const e = state.clipEdits[c.key] || (state.clipEdits[c.key] = { dStart: 0, dEnd: 0, removed: false });
  if (act === "s-") e.dStart = Math.max(-5, e.dStart - 1);
  if (act === "s+") e.dStart = e.dStart + 1;
  if (act === "e-") e.dEnd = e.dEnd - 1;
  if (act === "e+") e.dEnd = Math.min(5, e.dEnd + 1);
  if (act === "rm") e.removed = !e.removed;
  $("review-error").textContent = "";
  updatePickInfo();
  if (act !== "rm" && !e.removed) playClip(makeClips().find(x => x.key === c.key) || c);
}
function playClip(c) {
  const v = $("clip-preview");
  if (v.src !== state.url) v.src = state.url;
  v.hidden = false;
  clipPreviewEnd = c.end;
  v.currentTime = c.start;
  v.play().catch(() => {});
  v.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function updateAutoResult() {
  if (!state.followRan) return;
  const count = state.moments.filter(m => m.pickSource === "followed").length;
  const plays = state.moments.filter(m => isManualPick(m) &&
    m.track?.playerIndex === m.picked && m.track.end - m.track.start >= 4).length;
  const tracks = state.moments.filter(m => isManualPick(m) && m.track?.playerIndex === m.picked &&
    m.track.end - m.track.start >= 4).map(m => actionSegments(m.track, actionOpts(), state.duration));
  const withData = tracks.filter(r => r.hasData);
  if (state.action.enabled && withData.length) {
    const clips = withData.reduce((n, r) => n + r.segments.length, 0);
    const hardToSee = withData.some(r => r.fallback);
    $("auto-result").textContent = `Followed your player through ${plays} play${plays === 1 ? "" : "s"}` +
      (state.refindFound ? ` (${state.refindFound} found by KitReel in the rest of the game)` : "") +
      ` and kept ${clips} action clip${clips === 1 ? "" : "s"} (${fmt(reelSeconds())} total). Untick any tagged moment to drop that clip.` +
      (hardToSee ? " The ball is hard to see in this video, so clips are based on where the action is. A steadier, closer video gives better results." : "");
  } else {
    $("auto-result").textContent = `Followed your player through ${plays} plays (${fmt(reelSeconds())} total). Check the tagged moments and untick any that aren't them.`;
  }
  $("auto-result").hidden = false;
  $("clear-auto").hidden = !count;
}
async function followPlayer() {
  const taps = state.moments.filter(isManualPick);
  if (!taps.length) return;
  showProgress("Following your player and finding ball touches…");
  await followSeeds(taps);
  if ($("refind").checked) await refindRounds();
  finishFollow();
}

// Follow each seed moment forward and backward (cached when nothing changed).
async function followSeeds(seeds, { label = "Following your player and finding ball touches", stopAtCovered = false } = {}) {
  const target = hexToHsv($("kit-color").value);
  const kitColor = $("kit-color").value;
  const usualThreshold = target.s < 0.4 ? 0.3 : 0.2;
  const aspect = state.width / state.height;
  const estimate = workSession.startEstimate();
  const plannedSteps = seeds.map(moment => {
    if (moment.track?.playerIndex === moment.picked && moment.track?.kitColor === kitColor) return 0;
    const forward = Math.max(0, Math.ceil((state.duration - moment.t) * 2) - 1);
    const backward = Math.floor(moment.t * 2);
    return forward + backward;
  });
  const remainingSteps = [...plannedSteps];
  let completedFrames = 0;
  for (let i = 0; i < seeds.length; i++) {
    await workSession.waitUntilVisible();
    const moment = seeds[i];
    let completedSteps = 0;
    const progress = (step = 0, total = 1) => {
      const fraction = Math.min(1, step / total);
      setProgress(((i + fraction) / seeds.length) * 100,
        `${label} · play ${i + 1} of ${seeds.length}`,
        estimate(completedFrames, completedFrames + remainingSteps.reduce((sum, n) => sum + n, 0)));
    };
    progress();
    if (moment.track?.playerIndex !== moment.picked || moment.track?.kitColor !== kitColor) {
      // Re-found players stop when they run into a stretch that's already followed.
      const covered = stopAtCovered ? isCoveredBy(coveredSpans(state.moments.filter(m => m !== moment))) : null;
      moment.track = await trackPlayer({
        moment, playerIndex: moment.picked, duration: state.duration, target,
        threshold: usualThreshold, aspect,
        seek, drawFrame, detectPeople: () => detectPeople(state.model),
        torsoMatch, normalizeBox: normBox, describe, frameSignature, isCameraCut,
        waitUntilVisible: () => workSession.waitUntilVisible(),
        seekAndDrawFrame: (t, previous) => seekDrawFrame(t, previous),
        detectBallNear: (box) => detectBallNear(state.model, box),
        isCovered: covered,
        onStep: () => {
          completedFrames++;
          remainingSteps[i] = Math.max(0, remainingSteps[i] - 1);
          progress(++completedSteps, plannedSteps[i] || 1);
        },
      });
      moment.track.kitColor = kitColor;
    }
    remainingSteps[i] = 0;
    progress(1, 1);
  }
  state.followRan = true;
  fitFollowedClips();     // tag the moments inside each follow, so they teach the look
}

// ---------- Find my player in the rest of the game ----------
async function refindRounds() {
  const wanted = $("kit-number").value.trim();
  for (let round = 0; round < 15; round++) {
    await workSession.waitUntilVisible();
    setProgress(100, "Looking for your player in the rest of the game…");
    const look = learnLook(state.moments, state.rejectedDescs);
    const cands = candidatesInGaps(state.moments, look, { asked: state.askedKeys }).slice(0, 12);
    const sure = [], ask = [];
    for (const c of cands) {
      const crop = c.moment.players[c.playerIndex].crop;
      let num = wanted ? await numberVerdict(crop, wanted) : "unknown";
      if (num === "mismatch" && c.runnerUp !== null) {
        // The best lookalike shows a different number; the runner-up might be them.
        const alt = await numberVerdict(c.moment.players[c.runnerUp].crop, wanted);
        if (alt === "match") { c.playerIndex = c.runnerUp; c.key = `${c.moment.t}|${c.runnerUp}`; num = "match"; }
      }
      const v = verdictFor(c, look, num);
      if (v === "sure") sure.push(c); else if (v === "ask") ask.push({ ...c, numberMatch: num === "match" });
    }
    state.questions = ask;
    if (!sure.length) break;
    for (const c of sure) { c.moment.picked = c.playerIndex; c.moment.pickSource = "matched"; state.refindFound++; }
    await followSeeds(sure.map(c => c.moment), { label: "Following your player in the rest of the game", stopAtCovered: true });
  }
}

function finishFollow() {
  $("review-error").textContent = "";
  updatePickInfo();
  renderMoments();
  updateAutoResult();
  renderQuestions();
  $("clear-auto").hidden = !state.moments.some(m => m.pickSource === "followed" || m.pickSource === "matched");
  hideProgress();
}

function renderQuestions() {
  const qs = state.questions.filter(q => !state.askedKeys.has(q.key));
  $("refind-panel").hidden = !qs.length;
  const list = $("refind-list");
  list.innerHTML = "";
  const refs = state.moments.filter(m => isManualPick(m) && m.pickSource === "manual").slice(0, 3)
    .map(m => m.players[m.picked].crop);
  $("refind-refs").innerHTML = refs.map(src => `<img src="${src}" alt="Your tagged player" />`).join("");
  for (const q of qs.slice(0, 8)) {
    const card = document.createElement("div");
    card.className = "q-card";
    const p = q.moment.players[q.playerIndex];
    card.innerHTML = `<div class="q-imgs"><img class="q-player" src="${p.crop}" alt="Possible match" /><img class="q-frame" src="${q.moment.thumb}" alt="" /></div>
      <p class="q-time">${fmt(q.moment.t)} · player ${q.playerIndex + 1} in this frame${q.numberMatch ? " · number matches" : ""}</p>
      <div class="row q-actions"><button type="button" class="primary small" data-a="yes">Yes, that's them</button>
      <button type="button" class="secondary small" data-a="no">No</button>
      <button type="button" class="ghost small" data-a="skip">Not sure</button></div>`;
    card.querySelectorAll("button").forEach(b => b.addEventListener("click", () => answerQuestion(q, b.dataset.a)));
    list.appendChild(card);
  }
  $("refind-more").textContent = qs.length > 8 ? `${qs.length - 8} more after these.` : "";
}

function answerQuestion(q, answer) {
  if (workSession.running) return;
  state.askedKeys.add(q.key);
  const m = q.moment, p = m.players[q.playerIndex];
  if (answer === "no") {
    m.rejected = [...(m.rejected || []), q.playerIndex];
    if (p.desc) state.rejectedDescs.push(p.desc);
  }
  if (answer === "yes") {
    m.picked = q.playerIndex; m.pickSource = "confirmed";
    const job = async () => {
      showProgress("Following your player from that moment…");
      await followSeeds([m], { label: "Following your player", stopAtCovered: true });
      await refindRounds();
      finishFollow();
    };
    job.protectWork = true;
    return run(job, "review-error");
  }
  state.questions = state.questions.filter(x => !state.askedKeys.has(x.key));
  if (!state.questions.length && answer === "no") {
    // A "no" can make a better lookalike stand out: look again (quick, no following).
    const job = async () => { showProgress("Looking for your player again…"); await refindRounds(); finishFollow(); };
    job.protectWork = true;
    return run(job, "review-error");
  }
  renderQuestions();
}

function clearAutoPicks() {
  if (workSession.running) return;
  clearAutomatic(state.moments);
  for (const m of state.moments) if (m.pickSource === "matched") { m.picked = null; m.pickSource = null; m.track = null; }
  state.questions = []; state.askedKeys = new Set(); state.rejectedDescs = []; state.refindFound = 0;
  $("refind-panel").hidden = true;
  state.followRan = false;
  $("clear-auto").hidden = true;
  $("auto-result").hidden = true;
  renderMoments();
  updatePickInfo();
}

function fitFollowedClips() {
  const max = Number($("max-len").value);
  if (state.followRan) clearAutomatic(state.moments);
  const result = budgetTracks(state.moments, {
    duration: state.duration, maxSeconds: max, loudness: state.loudness, aspect: state.width / state.height,
    action: actionOpts(),
  });
  if (state.followRan) applyFollowedTracks(state.moments,
    state.moments.filter(m => isManualPick(m) && m.track?.playerIndex === m.picked)
      .map(m => m.track), {
      duration: state.duration, loudness: state.loudness, aspect: state.width / state.height,
      action: actionOpts(),
    });
  const errorText = "Your picks add up to more than the max reel length. Raise it, remove some clips, or untick some moments.";
  if (result.fits || reelSeconds() <= max) {
    if ($("review-error").textContent === errorText) $("review-error").textContent = "";
    return true;
  }
  $("review-error").textContent = errorText;
  return false;
}

// ---------- Step 5: cut the reel with ffmpeg.wasm ----------
const SIZES = { "16:9": [960, 540], "9:16": [540, 960], "1:1": [720, 720], "4:5": [720, 900] };

async function buildReel() {
  if (!fitFollowedClips()) return;
  const clips = makeClips();
  if (!clips.length) throw new Error("Pick at least one moment.");
  const [W, H] = SIZES[$("aspect").value];
  showProgress("Making your reel…");
  setProgress(0, "Loading the video editor (first time takes a moment)…");

  try {
    state.reelBlob = await queueEditor(() => encodeReel(clips, W, H));
  } catch (error) {
    if (!isTouchDevice()) throw error;
    try { state.ffmpeg?.terminate(); } catch {}
    state.ffmpeg = null;
    state.ffmpegPromise = null;
    throw new Error("Your phone ran out of memory making the reel. Try a 1-minute reel, or use a computer.");
  }
  if (state.reelUrl) URL.revokeObjectURL(state.reelUrl);
  state.reelUrl = URL.createObjectURL(state.reelBlob);
  $("reel").src = state.reelUrl;
  $("download").href = state.reelUrl;
  const mb = state.reelBlob.size / 1048576;
  const secs = clips.reduce((s, c) => s + c.end - c.start, 0);
  $("reel-info").textContent = `${fmt(secs)} · ${$("aspect").value} · ${mb.toFixed(1)} MB (about ${Math.max(1, Math.ceil(mb * 8 / 5))} seconds to download on a typical 5 Mbps connection)`;
  $("share-info").textContent = "";
  const sr = state.spotReport;
  $("spot-info").hidden = !sr?.on;
  if (sr?.on) {
    const n = clips.length;
    $("spot-info").textContent = sr.added === n ? `Spotlight added to all ${n} clip${n === 1 ? "" : "s"} (first 2 seconds of each).`
      : `Spotlight added to ${sr.added} of ${n} clips.` +
        (sr.noFollow ? ` ${sr.noFollow} clip${sr.noFollow === 1 ? " wasn't" : "s weren't"} from Follow my player, so KitReel didn't know where to put the ring.` : "") +
        (sr.failed ? ` ${sr.failed} couldn't be added on this device${sr.lastError ? ` (${sr.lastError})` : ""}.` : "");
  }
  renderClipDownloads();
  hideProgress();
  show("step-reel");
  $("step-reel").scrollIntoView({ behavior: "smooth" });
}

async function encodeReel(clips, W, H) {
  const ff = await getEditor();
  const input = await mountInput(ff);
  const extras = {
    spotlight: $("fx-spotlight").checked, title: $("fx-title").checked, end: $("fx-end").checked,
    name: $("fx-name").value.trim(), team: $("fx-team").value.trim(),
    date: $("fx-date").value ? new Date($("fx-date").value + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "",
    number: $("kit-number").value.trim(),
  };
  const ratio = W / H, SW = state.width, SH = state.height;
  const total = clips.length + (extras.title ? 1 : 0) + (extras.end ? 1 : 0);

  let current = 0;
  const estimate = workSession.startEstimate();
  const onProg = ({ progress }) => setProgress(((current + Math.min(1, Math.max(0, progress))) / total) * 100,
    current < clips.length ? `Cutting clip ${current + 1} of ${clips.length}…` : "Adding title and end cards…",
    estimate(current, total));
  ff.on("progress", onProg);

  const names = [], temp = [];
  const writeCanvas = async (name, draw) => {
    const cv = document.createElement("canvas");
    draw(cv);
    const blob = await new Promise(res => cv.toBlob(res, "image/png"));
    await ff.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
    temp.push(name);
  };
  const VIDEO_OUT = ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2000k", "-maxrate", "2500k", "-bufsize", "4000k",
    "-pix_fmt", "yuv420p", "-r", "30"];
  const AUDIO_OUT = ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"];
  for (const u of state.clipBlobs) URL.revokeObjectURL(u.url);
  state.clipBlobs = [];
  state.spotReport = { on: extras.spotlight, added: 0, noFollow: 0, failed: 0, lastError: "" };
  const errLog = ({ message }) => { if (/error|invalid|no such|failed/i.test(message)) state.spotReport.lastError = message.slice(0, 200); };

  try {
    // Does the video have sound? Cards must match the clips (both with or both without audio).
    let hasAudio = false;
    const sniff = ({ message }) => { if (/Stream #\S+.*Audio:/.test(message)) hasAudio = true; };
    ff.on("log", sniff);
    try { await ff.exec(["-hide_banner", "-i", input]); } catch {}
    ff.off("log", sniff);

    // Cards (drawn here, turned into 2.5-second clips).
    const cardClip = async (kind, out) => {
      await writeCanvas(`${kind}.png`, cv => drawCard(cv, W, H, kind, extras));
      const args = ["-loop", "1", "-framerate", "30", "-t", "2.5", "-i", `${kind}.png`];
      if (hasAudio) { await ff.writeFile("silence.wav", silentWav(2.5)); temp.push("silence.wav"); args.push("-i", "silence.wav"); }
      args.push(...VIDEO_OUT, ...(hasAudio ? [...AUDIO_OUT, "-shortest"] : []), "-t", "2.5", out);
      return (await ff.exec(args)) === 0;
    };
    if (extras.title) {
      current = 0;
      if (await cardClip("title", "title.mp4")) names.push("title.mp4");
    }

    let ringReady = null;
    for (let i = 0; i < clips.length; i++) {
      await workSession.waitUntilVisible();
      current = i;
      const c = clips[i];
      const out = `c${i}.mp4`;
      const cam = cameraFor(c, SW, SH, ratio);
      const spot = extras.spotlight ? spotlightFor(c, cam, SW, SH, W, H) : null;
      const base = `${cropFilter(cam)},scale=${W}:${H},setsar=1`;
      const dur = (c.end - c.start).toFixed(2);
      const plain = ["-ss", c.start.toFixed(2), "-t", dur, "-i", input,
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", base, ...VIDEO_OUT, ...AUDIO_OUT, out];
      let code = 1;
      if (extras.spotlight && !spot) state.spotReport.noFollow++;
      if (spot) {
        // One ring image per size; overlay it at the player's feet for the first 2 seconds.
        const ringName = `ring-${spot.ringW}x${spot.ringH}.png`;
        if (ringReady !== ringName) { await writeCanvas(ringName, cv => drawRing(cv, spot.ringW, spot.ringH)); ringReady = ringName; }
        ff.on("log", errLog);
        code = await ff.exec(["-ss", c.start.toFixed(2), "-t", dur, "-i", input, "-loop", "1", "-t", dur, "-i", ringName,
          "-filter_complex", `[0:v]${base}[v];[v][1:v]overlay=x='${spot.x}':y='${spot.y}':enable='lt(t,2)'[out]`,
          "-map", "[out]", "-map", "0:a:0?", ...VIDEO_OUT, ...AUDIO_OUT, out]);
        ff.off("log", errLog);
        if (code === 0) state.spotReport.added++; else state.spotReport.failed++;
      }
      if (code !== 0) code = await ff.exec(plain);                         // spotlight failed: plain clip
      if (code !== 0) code = await ff.exec(["-ss", c.start.toFixed(2), "-t", dur, "-i", input,  // panning failed: still crop
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", `crop=${cam.w}:${cam.h}:${cam.xs[0].v}:${cam.ys[0].v},scale=${W}:${H},setsar=1`,
        ...VIDEO_OUT, ...AUDIO_OUT, out]);
      if (code !== 0) throw new Error(`The editor couldn't cut clip ${i + 1}.`);
      names.push(out);
      const data = await ff.readFile(out);
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      state.clipBlobs.push({ url: URL.createObjectURL(blob), name: `clip-${i + 1}.mp4`, clip: c });
      setProgress((i + 1) / total * 100, `Cutting clip ${i + 1} of ${clips.length}…`, estimate(i + 1, total));
    }

    if (extras.end) {
      current = clips.length;
      if (await cardClip("end", "end.mp4")) names.push("end.mp4");
    }

    await workSession.waitUntilVisible();
    setProgress(100, "Joining clips…");
    await ff.writeFile("list.txt", names.map((n) => `file '${n}'`).join("\n"));
    const code = await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "reel.mp4"]);
    if (code !== 0) throw new Error("The editor couldn't join the clips.");
    const data = await ff.readFile("reel.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    ff.off("progress", onProg);
    for (const n of [...names, ...temp, "list.txt", "reel.mp4"]) { try { await ff.deleteFile(n); } catch {} }
    await releaseInput(ff, input);
  }
}
async function releaseInput(ff, input) {
  if (input.startsWith("/in/")) {
    try { await ff.unmount("/in"); } catch {}
  } else {
    try { await ff.deleteFile(input); } catch {}
  }
}

async function mountInput(ff) {
  // Read straight from the user's file without copying it into memory, when supported.
  try {
    try { await ff.createDir("/in"); } catch {}
    await ff.mount("WORKERFS", { files: [state.file] }, "/in");
    return `/in/${state.file.name}`;
  } catch {
    if (state.file.size > 1500 * 1048576) {
      throw new Error("Your browser couldn't read this large file directly. Try Chrome or Edge, or trim the video to under 1.5 GB.");
    }
    const ext = (state.file.name.split(".").pop() || "mp4").toLowerCase();
    const name = `input.${ext}`;
    await ff.writeFile(name, new Uint8Array(await state.file.arrayBuffer()));
    return name;
  }
}

function cropFor(c, ratio) {
  const SW = state.width, SH = state.height;
  let w, h;
  if (SW / SH > ratio) { h = SH; w = Math.round(SH * ratio); } else { w = SW; h = Math.round(SW / ratio); }
  w -= w % 2; h -= h % 2;
  const x = Math.round(clamp(c.cx * SW - w / 2, 0, SW - w));   // keep the player in frame
  const y = Math.round(clamp(c.cy * SH - h / 2, 0, SH - h));
  return { w, h, x: x - (x % 2), y: y - (y % 2) };
}

function renderClipDownloads() {
  const box = $("clip-downloads");
  box.innerHTML = "";
  state.clipBlobs.forEach((b, i) => {
    const a = document.createElement("a");
    a.href = b.url; a.download = b.name; a.className = "clip-download";
    a.textContent = `⬇ Clip ${i + 1} · ${Math.round(b.clip.end - b.clip.start)}s${b.clip.reason ? ` · ${CLIP_ICON[b.clip.reason] || ""} ${b.clip.reason}` : ""}`;
    box.appendChild(a);
  });
  $("clip-downloads-wrap").hidden = !state.clipBlobs.length;
}

// ---------- share / clear ----------
// GitHub version: no upload server, so sharing hands the video file straight to the
// device's share sheet (Messages, WhatsApp, email, AirDrop…). Hidden where unsupported.
function canShareFiles() {
  try {
    return Boolean(navigator.canShare && navigator.canShare({
      files: [new File([new Blob()], "reel.mp4", { type: "video/mp4" })] }));
  } catch { return false; }
}
async function shareReel() {
  if (!state.reelBlob) return;
  const file = new File([state.reelBlob], "highlight-reel.mp4", { type: "video/mp4" });
  try {
    await navigator.share({ files: [file], title: "Highlight reel", text: "Made with KitReel: https://kitreel.nedwebservices.com" });
    $("share-info").textContent = "";
  } catch (e) {
    if (e && e.name === "AbortError") return;
    throw new Error("Sharing isn't available here. Use Download instead, then share the file.");
  }
}

function clearAll() {
  cancelCrowdNoise();
  for (const u of [state.url, state.reelUrl]) if (u) URL.revokeObjectURL(u);
  if (state.ffmpeg) { try { state.ffmpeg.terminate(); } catch {} }
  location.reload();
}

// ---------- helpers ----------
async function seek(t) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await workSession.waitUntilVisible();
    const target = t + (attempt ? 0.05 : 0);
    try {
      await waitForSeekFrame(target);
      await workSession.waitUntilVisible();
      return;
    } catch (error) {
      if (attempt || !error.seekTimeout) throw error;
    }
  }
}

function waitForSeekFrame(target) {
  return new Promise((resolve, reject) => {
    let activeMs = 0, lastCheck = performance.now(), timer;
    function cleanup() {
      clearInterval(timer);
      grabber.removeEventListener("seeked", check);
      grabber.removeEventListener("error", failed);
      document.removeEventListener("visibilitychange", visibility);
    }
    function finish(error) {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function failed() { finish(new Error("Video error")); }
    function visibility() {
      // Reset the clock on both transitions so a throttled interval cannot
      // charge the time spent in another app against the visible-time budget.
      lastCheck = performance.now();
      if (!document.hidden) check();
    }
    function check() {
      const now = performance.now();
      if (!document.hidden) activeMs += now - lastCheck;
      lastCheck = now;
      if (document.hidden && isTouchDevice()) return;
      if (grabber.readyState >= 2 &&
          Math.abs(grabber.currentTime - target) <= 0.25) {
        finish();
      } else if (!document.hidden && activeMs >= 20000) {
        const error = new Error("Timed out waiting for seeked");
        error.seekTimeout = true;
        finish(error);
      }
    }
    grabber.addEventListener("seeked", check);
    grabber.addEventListener("error", failed);
    document.addEventListener("visibilitychange", visibility);
    timer = setInterval(check, 200);
    try {
      // A same-time assignment need not emit seeked, hence the immediate check
      // and the ready-state polling fallback above.
      if (Math.abs(grabber.currentTime - target) <= 0.01 && grabber.readyState >= 2 && !grabber.seeking) check();
      else grabber.currentTime = target;
    } catch (error) { finish(error); }
  });
}

function forgivingFrameSeeker() {
  let consecutiveFailures = 0;
  return async (t) => {
    try {
      await seek(t);
      consecutiveFailures = 0;
      return true;
    } catch {
      if (++consecutiveFailures >= 5) {
        throw new Error("Your browser is having trouble reading this video. Try Chrome on a computer, or export the video as a standard 1080p MP4.");
      }
      return false;
    }
  };
}

async function seekDrawFrame(t, previousFrame = null, frameSeeker = seek) {
  while (true) {
    await workSession.waitUntilVisible();
    if (await frameSeeker(t) === false) return null;
    await drawFrame();
    const frame = { t, sig: frameSignature() };
    // Remember the actual last draw, including probes and direction changes.
    const previous = state.lastDrawnFrame || previousFrame;
    const sameAsPrevious = previous?.sig?.length === frame.sig.length &&
      previous.sig.every((value, index) => value === frame.sig[index]);
    if (document.hidden && previous &&
        Math.abs(t - previous.t) >= 0.4 && sameAsPrevious) {
      await waitForVisibleAfterFrozenFrame();
      continue;
    }
    state.lastDrawnFrame = frame;
    return frame;
  }
}

function waitForVisibleAfterFrozenFrame() {
  const notice = $("resume-notice");
  notice.textContent = "Paused: keep KitReel on screen to continue. It can be a smaller window, just not minimized or covered.";
  notice.hidden = false;
  if (!document.hidden) {
    showResumeNotice();
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      showResumeNotice();
      resolve();
    };
    document.addEventListener("visibilitychange", onVisible);
  });
}

function once(el, ev, ms) {
  // waitForEvent removes both the requested event and error listeners on
  // success, failure and timeout (including when ev is "seeked").
  return workSession.waitForEvent(el, ev, ms);
}
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}
function overlapOfSmaller(a, b) {   // same person seen whole in one half and cut off in the other
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (Math.min(a.w * a.h, b.w * b.h) || 1);
}
function kmeans(points, k) {
  const centers = [points[0]];
  while (centers.length < k) {   // spread-out starting points
    let best = null, bestD = -1;
    for (const p of points) { const d = Math.min(...centers.map((c) => dist2(p, c))); if (d > bestD) { bestD = d; best = p; } }
    centers.push(best);
  }
  let groups = [];
  for (let it = 0; it < 12; it++) {
    groups = centers.map(() => []);
    for (const p of points) groups[centers.reduce((bi, c, i) => (dist2(p, c) < dist2(p, centers[bi]) ? i : bi), 0)].push(p);
    groups.forEach((g, i) => { if (g.length) centers[i] = [0, 1, 2].map((ch) => avg(g.map((p) => p[ch]))); });
  }
  return centers.map((c, i) => ({ center: c, size: groups[i].length })).sort((a, b) => b.size - a.size);
}
function mergeSimilarTeamColors(clusters) {
  const merged = [];
  for (const cluster of [...clusters].sort((a, b) => b.size - a.size)) {
    const name = colorName(rgbToHex(...cluster.center));
    if (merged.some((kept) =>
      Math.sqrt(dist2(kept.center, cluster.center)) <= 60 ||
      colorName(rgbToHex(...kept.center)) === name
    )) continue;
    merged.push(cluster);
    if (merged.length === 3) break;
  }
  return merged;
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
function showProgress(title) { $("progress-title").textContent = title; setProgress(0, ""); show("progress-card"); }
function setProgress(pct, text, estimate = "") {
  $("progress").value = pct;
  $("progress-text").textContent = estimate ? `${text} · ${estimate}` : text;
}
function hideProgress() { hide("progress-card"); }
function show(...ids) { ids.forEach((id) => ($(id).hidden = false)); }
function hide(...ids) { ids.forEach((id) => ($(id).hidden = true)); }
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function fmt(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""); }
function hexToHsv(hex) { const n = parseInt(hex.slice(1), 16); return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255); }
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
function colorName(hex) {
  const { h, s, v } = hexToHsv(hex);
  let name;
  const hue = () => [[15, "red"], [40, "orange"], [65, "yellow"], [160, "green"], [200, "light blue"], [250, "blue"], [290, "purple"], [335, "pink"], [360, "red"]].find(([max]) => h < max)[1];
  if (v < 0.12 || (v < 0.2 && s < 0.3)) name = "black";
  else if (s < 0.18) name = v > 0.75 ? "white" : "grey";
  else name = (v < 0.35 ? "dark " : "") + hue();
  return name[0].toUpperCase() + name.slice(1);
}
