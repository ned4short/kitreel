// Free, in-browser jersey number reading (Tesseract.js, digits only).
// Loaded only when a player's number was entered, and only for the few
// players KitReel is unsure about, so it stays quick.

let workerPromise = null;
const cache = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("Couldn't load the number reader."));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) workerPromise = (async () => {
    await loadScript("/vendor/tesseract/tesseract.min.js");
    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract/core",
      langPath: "/vendor/tesseract/lang",
      gzip: true,
      logger: () => {},
    });
    await worker.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: "7" });
    return worker;
  })().catch(e => { workerPromise = null; throw e; });
  return workerPromise;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });
}

// Cut out the shirt (where numbers sit), enlarge it, and make two high-contrast
// versions: dark digits on light, and light digits on dark.
function shirtVersions(img) {
  const sx = img.width * 0.12, sy = img.height * 0.16, sw = img.width * 0.76, sh = img.height * 0.42;
  const H = 120, W = Math.max(60, Math.round(H * sw / sh));
  const base = document.createElement("canvas");
  base.width = W; base.height = H;
  const ctx = base.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  const src = ctx.getImageData(0, 0, W, H);
  const gray = new Float32Array(W * H);
  let min = 255, max = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299 * src.data[i * 4] + 0.587 * src.data[i * 4 + 1] + 0.114 * src.data[i * 4 + 2];
    gray[i] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const span = Math.max(1, max - min);
  return [false, true].map(invert => {
    const c = document.createElement("canvas");
    c.width = W + 40; c.height = H + 40;            // white margin helps the reader
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    const out = x.createImageData(W, H);
    for (let i = 0; i < gray.length; i++) {
      let v = (gray[i] - min) / span * 255;
      if (invert) v = 255 - v;
      v = v < 128 ? Math.max(0, v * 0.6) : Math.min(255, 128 + (v - 128) * 1.6);
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
    }
    x.putImageData(out, 20, 20);
    return c;
  });
}

// Returns { number: "10" | null, confidence: 0–100 } for one player crop (data URL).
export async function readJerseyNumber(cropUrl) {
  if (cache.has(cropUrl)) return cache.get(cropUrl);
  let best = { number: null, confidence: 0 };
  try {
    const worker = await getWorker();
    const img = await loadImage(cropUrl);
    for (const canvas of shirtVersions(img)) {
      const { data } = await worker.recognize(canvas);
      const digits = (data.text || "").replace(/\D/g, "");
      if (digits.length >= 1 && digits.length <= 2 && data.confidence > best.confidence) {
        best = { number: String(Number(digits)), confidence: data.confidence };
      }
    }
  } catch {}
  cache.set(cropUrl, best);
  return best;
}

// "match" | "mismatch" | "unknown" for a crop against the player's number.
export async function numberVerdict(cropUrl, wanted) {
  if (!wanted) return "unknown";
  const { number, confidence } = await readJerseyNumber(cropUrl);
  if (!number) return "unknown";
  if (number === String(Number(wanted)) && confidence >= 55) return "match";
  if (number !== String(Number(wanted)) && confidence >= 75) return "mismatch";
  return "unknown";
}
