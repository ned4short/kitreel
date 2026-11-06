// Anonymous, first-party counters. No video contents, names, or IPs are sent.
const output = document.getElementById("footer-stats");
const donate = document.querySelector(".donate-button");
let visitorId;
try {
  visitorId = window.localStorage.getItem("kitreel-counter-visitor");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitorId || "")) {
    visitorId = crypto.randomUUID();
    window.localStorage.setItem("kitreel-counter-visitor", visitorId);
  }
} catch {
  visitorId = crypto.randomUUID();
}

let requestQueue = Promise.resolve();
function record(kind) {
  // Keep responses ordered and reuse event IDs on retries.
  const body = JSON.stringify({ kind, visitorId, eventId: crypto.randomUUID() });
  requestQueue = requestQueue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/stats", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true,
        });
        if (!res.ok) throw new Error("Counters unavailable");
        const data = await res.json();
        if (![data.views, data.visitors, data.uploads, data.donations].every(n => Number.isSafeInteger(n) && n >= 0)) return;
        if (output) output.textContent = `v-${data.views}-uv-${data.visitors}-up-${data.uploads}-d-${data.donations}`;
        return;
      } catch {
        // Optional counters must never interrupt file picking or navigation.
      }
    }
  }).catch(() => {});
}

// Register all interactions before making any network requests.
document.addEventListener("kitreel:video-loaded", () => record("upload"));
donate?.addEventListener("click", () => record("donate"));
donate?.addEventListener("auxclick", event => { if (event.button === 1) record("donate"); });
record("view");
