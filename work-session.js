// A work session owns foreground timing, wake locks, and navigation protection.
export function createWorkSession({
  document, window, navigator, onResume = () => {},
  pauseWhenHidden = () => true,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let running = false, generation = 0, wakeLock = null, pendingWake = null;
  let hiddenSince = null, hiddenTime = 0;

  function elapsed() {
    return now() - hiddenTime - (hiddenSince === null ? 0 : now() - hiddenSince);
  }
  function beforeUnload(event) {
    if (!running) return;
    event.preventDefault();
    event.returnValue = "";
  }
  async function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock?.release(); } catch {}
  }
  async function requestWakeLock() {
    const token = generation;
    try {
      if (!running || document.hidden || !navigator?.wakeLock?.request ||
          (wakeLock && !wakeLock.released) || pendingWake === token) return;
      pendingWake = token;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (!running || token !== generation || document.hidden) {
          try { await lock.release(); } catch {}
          return;
        }
        wakeLock = lock;
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
      } finally {
        if (pendingWake === token) pendingWake = null;
      }
    } catch {} // Denied, unsupported, or battery-saving mode must not stop work.
  }
  function visibilityChanged() {
    if (!running) return;
    if (document.hidden) {
      if (pauseWhenHidden() && hiddenSince === null) hiddenSince = now();
      void releaseWakeLock();
    } else {
      if (hiddenSince !== null) {
        hiddenTime += now() - hiddenSince;
        hiddenSince = null;
        onResume();
      }
      void requestWakeLock();
    }
  }
  function start() {
    running = true;
    generation++;
    hiddenTime = 0;
    hiddenSince = document.hidden && pauseWhenHidden() ? now() : null;
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibilityChanged);
    void requestWakeLock();
  }
  async function finish() {
    running = false;
    generation++; // An outstanding request may resolve after the work is over.
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("beforeunload", beforeUnload);
    await releaseWakeLock();
  }
  function waitUntilVisible() {
    if (!document.hidden || !pauseWhenHidden()) return Promise.resolve();
    return new Promise((resolve) => {
      function visible() {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", visible);
        resolve();
      }
      document.addEventListener("visibilitychange", visible);
    });
  }
  function waitForEvent(element, event, ms, { pauseWhenHidden = false } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null, remaining = ms, armedAt = null;
      function cleanup() {
        clearTimer(timer);
        element.removeEventListener(event, success);
        element.removeEventListener("error", failure);
        document.removeEventListener("visibilitychange", visibility);
      }
      function success() { cleanup(); resolve(); }
      function failure() { cleanup(); reject(new Error("Video error")); }
      function timeout() {
        const error = new Error(`Timed out waiting for ${event}`);
        // A throttled timer can fire before the hidden-state event is delivered.
        error.hiddenTimeout = pauseWhenHidden && document.hidden;
        cleanup();
        reject(error);
      }
      function arm() {
        armedAt = now();
        timer = setTimer(timeout, Math.max(0, remaining));
      }
      function visibility() {
        if (document.hidden) {
          if (armedAt !== null) {
            remaining -= now() - armedAt;
            armedAt = null;
            clearTimer(timer);
          }
        } else if (armedAt === null) arm();
      }
      element.addEventListener(event, success);
      element.addEventListener("error", failure);
      if (pauseWhenHidden) document.addEventListener("visibilitychange", visibility);
      if (!pauseWhenHidden || !document.hidden) arm();
    });
  }
  function startEstimate() {
    const started = elapsed();
    return (done, total) => {
      if (done < 5 || done >= total) return "";
      const remaining = ((elapsed() - started) / done) * (total - done);
      if (!Number.isFinite(remaining) || remaining <= 0) return "";
      return remaining < 60000 ? "less than a minute left" :
        `about ${Math.ceil(remaining / 60000)} min left`;
    };
  }
  return { start, finish, waitUntilVisible, waitForEvent, startEstimate,
    get running() { return running; } };
}
