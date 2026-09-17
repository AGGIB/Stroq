/* Stroq docs — scroll-spy for the side nav only. Everything else on this page
   (menu toggle, copy buttons, the header install pill, scroll reveals) is
   handled by /main.js, which this page also loads. */
(function () {
  'use strict';

  var doc = document;
  var links = doc.querySelectorAll('.docs-nav-list a');
  if (!links.length) { return; }

  var byId = {};
  var sections = [];
  links.forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    var section = doc.getElementById(id);
    if (!section) { return; }
    byId[id] = a;
    sections.push(section);
  });

  var current = null;
  function setActive(id) {
    if (id === current) { return; }
    if (current && byId[current]) { byId[current].classList.remove('is-active'); }
    current = id;
    if (id && byId[id]) { byId[id].classList.add('is-active'); }
  }

  // Matches /styles.css's `scroll-padding-top: 5rem` (80px) on <html>: the
  // same line a clicked nav link lands a section on, so a section counts as
  // current exactly once it has reached its resting scroll position — a
  // few pixels of slack past that so the landed section itself qualifies.
  var LINE = 80 + 8;

  function recompute() {
    var current_ = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top - LINE <= 0) { current_ = sections[i].id; }
    }
    setActive(current_);
  }

  var ticking = false;
  function onScroll() {
    if (ticking) { return; }
    ticking = true;
    window.requestAnimationFrame(function () { recompute(); ticking = false; });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  recompute();
})();
