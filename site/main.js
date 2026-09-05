/* Stroq site — progressive enhancement only.
   Everything renders without this file; it adds the menu toggle, copy buttons,
   scroll reveals and the hero terminal animation. No storage. The only network
   call is Vercel Web Analytics (cookieless page views, first-party route),
   whose deferred script loads after this file. */
window.va =
  window.va ||
  function () {
    (window.vaq = window.vaq || []).push(arguments);
  };
(function () {
  'use strict';

  var doc = document;
  doc.documentElement.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var live = doc.getElementById('live-status');

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  function announce(text) {
    if (!live) { return; }
    live.textContent = '';
    window.setTimeout(function () { live.textContent = text; }, 30);
  }

  /* Menu toggle (small screens) ---------------------------------------- */
  var head = doc.querySelector('.site-head');
  var toggle = doc.querySelector('.nav-toggle');
  if (head && toggle) {
    var setOpen = function (open) {
      head.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () {
      setOpen(!head.classList.contains('is-open'));
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && head.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    doc.addEventListener('click', function (e) {
      if (head.classList.contains('is-open') && !head.contains(e.target)) { setOpen(false); }
    });
    each(head.querySelectorAll('.nav-menu a'), function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });
  }

  /* Copy buttons ------------------------------------------------------- */
  function selectText(el) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || !el) { return; }
    var range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function legacyCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (err) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }

  each(doc.querySelectorAll('[data-copy]'), function (btn) {
    var label = btn.querySelector('.copy-label');
    var idle = label ? label.textContent : 'Copy';
    var timer = null;

    function settle(ok) {
      window.clearTimeout(timer);
      btn.classList.toggle('is-copied', ok);
      btn.classList.toggle('is-failed', !ok);
      if (label) { label.textContent = ok ? 'Copied' : 'Copy failed'; }
      if (ok) {
        announce('Copied to clipboard');
      } else {
        selectText(doc.getElementById(btn.getAttribute('data-select')));
        announce('Copy failed. The command is selected; copy it manually.');
      }
      timer = window.setTimeout(function () {
        btn.classList.remove('is-copied', 'is-failed');
        if (label) { label.textContent = idle; }
      }, ok ? 1500 : 3000);
    }

    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { settle(true); },
          function () { settle(legacyCopy(text)); }
        );
      } else {
        settle(legacyCopy(text));
      }
    });
  });

  /* Scroll reveals ----------------------------------------------------- */
  var reveals = doc.querySelectorAll('.reveal');
  if (reveals.length) {
    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      each(reveals, function (el) { el.classList.add('is-visible'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        each(entries, function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      var viewportHeight = window.innerHeight;
      each(reveals, function (el) {
        /* Already on screen: show immediately so nothing flashes. */
        if (el.getBoundingClientRect().top < viewportHeight) { el.classList.add('is-visible'); }
        else { io.observe(el); }
      });
    }
  }

  /* Hero terminal ------------------------------------------------------ */
  var term = doc.querySelector('[data-term]');
  if (term && !reduceMotion.matches && 'IntersectionObserver' in window) {
    var script = Array.prototype.map.call(term.querySelectorAll('.tl'), function (li) {
      return { el: li, text: li.textContent, typed: li.hasAttribute('data-typed') };
    });
    var TYPE_MS = 24, LINE_PAUSE = 420, TYPED_PAUSE = 380, HOLD = 4100;
    var timer = null, visible = false, running = false, userPaused = false, cur = 0;
    var pauseBtn = term.querySelector('.term-pause');

    function later(ms, fn) { timer = window.setTimeout(fn, ms); }

    function clearLines() {
      each(script, function (s) { s.el.textContent = ''; s.el.classList.remove('is-typing'); });
    }

    function step(i) {
      cur = i;
      if (!visible || doc.hidden || userPaused) { running = false; return; }
      if (i >= script.length) {
        later(HOLD, function () { clearLines(); step(0); });
        return;
      }
      var s = script[i];
      if (!s.typed) {
        s.el.textContent = s.text;
        later(LINE_PAUSE, function () { step(i + 1); });
        return;
      }
      var n = 0;
      s.el.classList.add('is-typing');
      (function tick() {
        n += 1;
        s.el.textContent = s.text.slice(0, n);
        if (n < s.text.length) {
          later(TYPE_MS + Math.random() * 28, tick);
        } else {
          s.el.classList.remove('is-typing');
          later(TYPED_PAUSE, function () { step(i + 1); });
        }
      })();
    }

    function resume() {
      if (visible && !doc.hidden && !userPaused && !running) { running = true; step(cur); }
    }
    function pause() { window.clearTimeout(timer); running = false; }

    clearLines();
    if (pauseBtn) {
      pauseBtn.addEventListener('click', function () {
        userPaused = !userPaused;
        pauseBtn.setAttribute('aria-pressed', userPaused ? 'true' : 'false');
        pauseBtn.setAttribute('aria-label', (userPaused ? 'Play' : 'Pause') + ' the terminal animation');
        pauseBtn.textContent = userPaused ? 'Play' : 'Pause';
        if (userPaused) { pause(); } else { resume(); }
      });
    }

    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) { resume(); } else { pause(); }
    }, { threshold: 0.35 }).observe(term);

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) { pause(); } else { resume(); }
    });
  }
})();
