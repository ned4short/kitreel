// Progress stepper: highlights the step the visitor is on, based on which section is showing.
(function () {
  var list = document.getElementById("stepper");
  if (!list) return;
  var items = Array.prototype.slice.call(list.querySelectorAll("li"));
  function update() {
    var current = 0;
    items.forEach(function (li, i) {
      var s = document.getElementById(li.getAttribute("data-step"));
      if (s && !s.hidden) current = i;
    });
    items.forEach(function (li, i) {
      li.classList.toggle("done", i < current);
      li.classList.toggle("active", i === current);
      if (i === current) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }
  var obs = new MutationObserver(update);
  items.forEach(function (li) {
    var s = document.getElementById(li.getAttribute("data-step"));
    if (s) obs.observe(s, { attributes: true, attributeFilter: ["hidden"] });
  });
  update();
})();
