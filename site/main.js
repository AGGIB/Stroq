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

  /* The fork: one poisoned file, two outcomes -------------------------- */
  /* The command in the header duplicates the one in the hero while both are on
     screen. Hand it over only once the hero's has scrolled away. It keeps its space
     in the row either way, so the links never shift when it appears. */
  var navCmd = doc.querySelector('[data-nav-install]');
  var heroCmd = doc.querySelector('.hero .install-pill');
  if (navCmd && heroCmd && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      navCmd.classList.toggle('is-shown', !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(heroCmd);
  } else if (navCmd) {
    navCmd.classList.add('is-shown');
  }

  /* The steps are readable without this: CSS leaves every one at full opacity
     and the sequence only ever *emphasises* the order they happen in. With no
     JS, reduced motion, or no IntersectionObserver, the reader simply sees the
     finished comparison, which is the point of it anyway. */
  var fork = doc.querySelector('[data-fork]');
  if (fork && !reduceMotion.matches && 'IntersectionObserver' in window) {
    var steps = fork.querySelectorAll('.fstep');
    var replayBtn = fork.querySelector('[data-fork-replay]');
    var STEP_MS = 620, HOLD_MS = 2600;
    var fTimer = null, played = false;

    function reach(n) {
      each(steps, function (el) {
        el.classList.toggle('is-reached', Number(el.getAttribute('data-step')) <= n);
      });
    }

    function play() {
      window.clearTimeout(fTimer);
      fork.classList.add('is-playing');
      var n = 0;
      (function tick() {
        n += 1;
        reach(n);
        if (n < 4) {
          fTimer = window.setTimeout(tick, STEP_MS);
        } else {
          /* Land on the finished state and stay there. A landing page loop that
             restarts while someone is reading the outcome is a distraction. */
          fTimer = window.setTimeout(function () { fork.classList.remove('is-playing'); }, HOLD_MS);
        }
      })();
    }

    if (replayBtn) {
      replayBtn.addEventListener('click', function () {
        played = true;
        play();
        announce('Replaying the comparison.');
      });
    }

    new IntersectionObserver(function (entries, obs) {
      if (!entries[0].isIntersecting || played) { return; }
      played = true;
      obs.disconnect();
      play();
    }, { threshold: 0.4 }).observe(fork);

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) {
        window.clearTimeout(fTimer);
        fork.classList.remove('is-playing');
      }
    });
  }
})();
