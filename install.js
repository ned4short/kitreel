// "Install app" button + offline support.
// When the button shows:
//  - Chrome / Edge / Samsung Internet (Android, Windows, Mac, Chromebook): only once the
//    browser says the app can be installed. Tapping it opens the browser's install prompt.
//  - iPhone / iPad: always, since Apple has no install prompt. Tapping it shows how to
//    use Share → Add to Home Screen.
//  - Never when KitReel is already open as an installed app, or right after installing.
//  - Firefox and others that can't install apps: no button.
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  var btn = document.getElementById("install-app");
  var tip = document.getElementById("install-tip");
  if (!btn) return;

  var installed = window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    navigator.standalone === true;
  if (installed) return;

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var deferred = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    btn.hidden = true;
    if (tip) tip.hidden = true;
  });

  if (isIOS && tip) btn.hidden = false;

  btn.addEventListener("click", function () {
    if (deferred) {
      deferred.prompt();
      // Either way, hide it for now; the browser offers it again on a later visit.
      deferred.userChoice.then(function () { btn.hidden = true; deferred = null; });
    } else if (tip) {
      tip.hidden = !tip.hidden;
    }
  });

  var close = document.getElementById("install-tip-close");
  if (close) close.addEventListener("click", function () { tip.hidden = true; });
})();
