/* Stroq site — progressive enhancement only.
   Everything renders without this file: the long list of attacks is a native
   <details>, the commands are text, nothing is hidden until a script brings it
   back. This file adds the menu toggle, copy buttons, the header install command,
   the attack wall and its viewer, expand-all for the list, the current chapter in
   the header, and the one drawing motion. No storage. The network calls are the
   install count (/api/stats, first-party) and Vercel Web Analytics (cookieless
   page views, first-party route), whose deferred script loads after this file.
   ES5 syntax; the DOM APIs used (closest, classList.toggle with a flag) are the
   ones every browser that matters has had for years. */
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
    head.addEventListener('focusout', function (e) {
      if (head.classList.contains('is-open') && e.relatedTarget && !head.contains(e.relatedTarget)) { setOpen(false); }
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

  /* The header command ------------------------------------------------- */
  /* The command in the header duplicates the one in the hero while both are on
     screen. Hand it over only once the hero's has scrolled away. It keeps its space
     in the row either way, so the links never shift when it appears. */
  var navCmd = doc.querySelector('[data-nav-install]');
  var heroCmd = doc.querySelector('.hero .install-pill');
  if (navCmd && heroCmd && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      navCmd.classList.toggle('is-shown', !entries[entries.length - 1].isIntersecting);
    }, { threshold: 0 }).observe(heroCmd);
  } else if (navCmd) {
    navCmd.classList.add('is-shown');
  }

  /* The install count ------------------------------------------------- */
  /* /api/stats reads npm server-side, so the page's `connect-src 'self'`
     stays intact and no visitor's request reaches a third party. The line
     already reads correctly without the number, so any failure is silent. */
  var installsEl = doc.querySelector('[data-installs]');
  if (installsEl && window.fetch) {
    fetch('/api/stats', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || typeof data.installs !== 'number' || data.installs <= 0) { return; }
        var n = installsEl.querySelector('.hero-installs-n');
        if (!n) { return; }
        n.textContent = data.installs.toLocaleString('en-US');
        installsEl.hidden = false;
      })
      .catch(function () { /* the line stands on its own */ });
  }

  /* The thread --------------------------------------------------------- */
  /* Elements marked data-draw start drawn. Only when an observer is about to
     bring them back are they armed (hidden), and a visitor who prefers reduced
     motion never has anything armed at all. */
  var drawables = doc.querySelectorAll('[data-draw]');
  if (drawables.length && 'IntersectionObserver' in window && !reduceMotion.matches) {
    var drawer = new IntersectionObserver(function (entries) {
      each(entries, function (entry) {
        if (!entry.isIntersecting) { return; }
        entry.target.classList.add('is-drawn');
        drawer.unobserve(entry.target);
      });
    }, { threshold: 0.2 });
    each(drawables, function (el) {
      el.classList.add('is-armed');
      drawer.observe(el);
    });
  }

  /* The current chapter in the header ---------------------------------- */
  var chapterLinks = {};
  each(doc.querySelectorAll('.nav-links a[href^="#"]'), function (a) {
    chapterLinks[a.getAttribute('href').slice(1)] = a;
  });
  var chapters = doc.querySelectorAll('main > section[id]');
  if (chapters.length && 'IntersectionObserver' in window) {
    /* A thin band across the middle of the viewport: the chapter crossing it is
       the one being read. Chapters without a header link clear the marker. */
    var chapterObserver = new IntersectionObserver(function (entries) {
      each(entries, function (entry) {
        if (!entry.isIntersecting) { return; }
        each(Object.keys(chapterLinks), function (id) { chapterLinks[id].removeAttribute('aria-current'); });
        var link = chapterLinks[entry.target.id];
        if (link) { link.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    each(chapters, function (section) { chapterObserver.observe(section); });
  }

  /* The attack wall ---------------------------------------------------- */
  /* One tile per incident, a radio group: exactly one is selected, and the viewer
     shows its row from the list below, so the text lives in one place. The wall is
     a single tab stop with arrow keys inside it, because 36 tab stops is a lot to
     ask of a keyboard. It is hidden until the last line of this block has run
     (.js-ready), so a failure anywhere in it leaves the list, which is the whole
     truth, and no dead tiles. */
  var wall = doc.querySelector('.wall');
  var viewer = doc.getElementById('viewer');
  var tiles = wall ? Array.prototype.slice.call(wall.querySelectorAll('.tile')) : [];
  var COLUMNS = 6;

  function element(tag, className, text) {
    var el = doc.createElement(tag);
    if (className) { el.className = className; }
    if (text !== undefined) { el.textContent = text; }
    return el;
  }

  function showIncident(id) {
    var row = doc.getElementById(id);
    if (!row || !viewer) { return; }
    var top = element('p', 'viewer-top');
    top.appendChild(element('span', 'viewer-n', row.querySelector('.atk-n').textContent));
    top.appendChild(row.querySelector('.chip').cloneNode(true));
    var meta = element('p', 'viewer-meta');
    meta.appendChild(element('span', 'viewer-effect', row.getAttribute('data-effect')));
    meta.appendChild(row.querySelector('.atk-src').cloneNode(true));
    while (viewer.firstChild) { viewer.removeChild(viewer.firstChild); }
    viewer.appendChild(top);
    viewer.appendChild(element('p', 'viewer-what', row.querySelector('.atk-what').textContent));
    viewer.appendChild(meta);
  }

  /* A tile's name carries the whole incident, so a screen reader that moves
     focus from tile to tile hears it without a second, live announcement. */
  function nameTile(tile) {
    var row = doc.getElementById(tile.getAttribute('data-for'));
    if (!row) { return; }
    var verdict = row.classList.contains('atk-deny') ? 'blocked' : 'asked';
    tile.setAttribute('aria-label', row.querySelector('.atk-n').textContent + ', ' + verdict + ', ' +
      row.getAttribute('data-effect') + '. ' + row.querySelector('.atk-what').textContent);
  }

  function selectTile(tile, focus) {
    each(tiles, function (t) {
      var on = t === tile;
      t.setAttribute('aria-checked', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    showIncident(tile.getAttribute('data-for'));
    if (focus) { tile.focus(); }
  }

  /* On a phone the viewer sits above the wall; keep it in sight after a tap. */
  function keepViewerVisible() {
    if (!viewer || !viewer.scrollIntoView) { return; }
    var box = viewer.getBoundingClientRect();
    var headerHeight = head ? head.offsetHeight : 0;
    if (box.top < headerHeight || box.bottom > window.innerHeight) {
      viewer.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
  }

  if (wall && viewer && tiles.length) {
    each(tiles, function (tile) {
      nameTile(tile);
      tile.addEventListener('click', function () { selectTile(tile, true); keepViewerVisible(); });
    });
    var MOVES = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS };
    wall.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) { return; }
      var at = tiles.indexOf(doc.activeElement);
      if (at < 0) { return; }
      var next = at;
      if (MOVES[e.key] !== undefined) { next = at + MOVES[e.key]; }
      else if (e.key === 'Home') { next = 0; }
      else if (e.key === 'End') { next = tiles.length - 1; }
      else { return; }
      if (next < 0 || next >= tiles.length) { return; }
      e.preventDefault();
      selectTile(tiles[next], true);
    });
    selectTile(tiles[0], false);
    doc.documentElement.classList.add('js-ready');
  }

  /* The long list ------------------------------------------------------ */
  var all = doc.getElementById('all-incidents');
  var groups = all ? all.querySelectorAll('.grp') : [];
  var expandBtn = doc.querySelector('[data-expand-all]');

  function allGroupsOpen() {
    return Array.prototype.every.call(groups, function (g) { return g.open; });
  }

  function syncExpandLabel() {
    if (expandBtn) {
      expandBtn.textContent = allGroupsOpen() ? 'Collapse all groups' : 'Expand all groups';
    }
  }

  if (all && expandBtn && groups.length) {
    expandBtn.hidden = false;
    expandBtn.addEventListener('click', function () {
      var open = !allGroupsOpen();
      each(groups, function (g) { g.open = open; });
      syncExpandLabel();
      announce(open ? 'All ' + groups.length + ' groups expanded' : 'All groups collapsed');
    });
    each(groups, function (g) { g.addEventListener('toggle', syncExpandLabel); });
  }

  /* A link to #atk-17 opens the list and the group that holds that row. */
  function revealFromHash() {
    var id = '';
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (err) { return; }
    if (!/^atk-\d\d$/.test(id) || !all) { return; }
    var row = doc.getElementById(id);
    if (!row) { return; }
    all.open = true;
    var group = row.closest('.grp');
    if (group) { group.open = true; }
    row.scrollIntoView({ block: 'center' });
  }
  revealFromHash();
  window.addEventListener('hashchange', revealFromHash);

})();
