// "Install app" button + offline support.
// When the button shows:
//  - Chrome / Edge / Samsung Internet (Android, Windows, Mac, Chromebook): only once the
//    browser says the app can be installed. Tapping it opens the browser's install prompt.
//  - iPhone / iPad: always, since Apple has no install prompt. Tapping it shows how to
//    use Share → Add to Home Screen.
//  - Never when KitReel is already open as an installed app, or right after installing.
//  - Firefox and others that can't install apps: no button.
//  - The × beside the button hides it on that device for 7 days. The /app page
//    ignores that, so people can always install from there.
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  var HIDE_KEY = "kitreel-install-hidden-until";
  var HIDE_DAYS = 7;
  var onAppPage = document.body.hasAttribute("data-app-page");
  var wrap = document.getElementById("install-wrap");
  var btn = document.getElementById("install-app");
  var tip = document.getElementById("install-tip");
  var hideBtn = document.getElementById("install-hide");
  var box = wrap || btn;
  if (!btn) return;

  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }

  var installed = window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    navigator.standalone === true;
  var hiddenByUser = !onAppPage && Number(get(HIDE_KEY) || 0) > Date.now();

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var deferred = null;

  function show(on) {
    box.hidden = !on;
    if (!on && tip) tip.hidden = true;
    document.dispatchEvent(new CustomEvent("kitreel-install", { detail: { canPrompt: Boolean(deferred), installed: installed } }));
  }

  if (installed) { show(false); return; }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    if (!hiddenByUser) show(true);
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    installed = true;
    show(false);
  });

  if (isIOS && tip && !hiddenByUser) show(true);

  btn.addEventListener("click", function () {
    if (deferred) {
      deferred.prompt();
      // Either way, hide it for now; the browser offers it again on a later visit.
      deferred.userChoice.then(function (choice) {
        deferred = null;
        if (choice.outcome === "accepted") installed = true;
        show(false);
      });
    } else if (tip) {
      tip.hidden = !tip.hidden;
    }
  });

  if (hideBtn) hideBtn.addEventListener("click", function () {
    set(HIDE_KEY, String(Date.now() + HIDE_DAYS * 24 * 60 * 60 * 1000));
    hiddenByUser = true;
    show(false);
  });

  var close = document.getElementById("install-tip-close");
  if (close) close.addEventListener("click", function () { tip.hidden = true; });
})();
