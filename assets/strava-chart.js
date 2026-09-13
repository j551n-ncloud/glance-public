/*
 * Shared chart engine for the Strava dashboard page (config/strava.yml).
 *
 * Replaces three copies of the same ~4000-character inline chart function
 * that used to be duplicated verbatim in the HR/effort/distance widget
 * templates. Each widget now only needs a tiny bootstrap snippet (see
 * strava.yml) that loads this file once and calls window.StravaChart.
 *
 * Design goals over the old inline version:
 *   - Bar chart for aggregated buckets (day/month/year), line chart for the
 *     per-workout trend — bars read better for discrete period totals,
 *     a line implies a continuous trend that isn't really there between
 *     e.g. two weekly totals.
 *   - A real (if minimal) y-axis with "nice" rounded tick values, instead of
 *     labelling only a few chosen data points.
 *   - Hover/tap tooltip with the exact value + full date, plus a crosshair —
 *     the old version only ever showed labels baked into the SVG at fixed
 *     extrema, nothing reacted to the pointer.
 *   - Catmull-Rom smoothed line instead of a plain polyline.
 *   - Same nav controls (Workouts/Monat/Jahr/Gesamt + prev/next), restyled.
 *
 * No dependencies, no build step — vanilla JS/SVG, theme-aware via the
 * dashboard's existing CSS custom properties (--color-*).
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  var SPANS = [
    { key: 'workouts', label: 'Workouts', granularity: 'activity', aggregated: false },
    { key: 'month', label: 'Monat', granularity: 'day', aggregated: true },
    { key: 'year', label: 'Jahr', granularity: 'month', aggregated: true },
    { key: 'all', label: 'Gesamt', granularity: 'year', aggregated: true },
  ];
  var PAGE = 12; // workouts per page when paging back through history

  // Always a line — every metric here (hr, effort, distance) reads as a
  // trend over time, and a line keeps that reading consistent across every
  // span instead of switching chart types depending on the view.
  function chartKind() {
    return 'line';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function el(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // One-time stylesheet, shared by every chart instance on the page.
  function ensureStyles() {
    if (document.getElementById('sc-style')) return;
    var s = document.createElement('style');
    s.id = 'sc-style';
    s.textContent = [
      '.sc-nav{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;}',
      '.sc-btn{border:none;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:0.78rem;',
      '  background:var(--color-widget-content-border);color:inherit;transition:background 0.15s;}',
      '.sc-btn:hover{filter:brightness(1.15);}',
      '.sc-btn.sc-on{background:var(--color-primary);color:#fff;}',
      '.sc-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;}',
      '.sc-arrow{border:none;background:var(--color-widget-content-border);color:inherit;border-radius:5px;',
      '  padding:2px 10px;cursor:pointer;font-size:0.8rem;line-height:1.4;}',
      '.sc-arrow:disabled{cursor:default;opacity:0.3;}',
      '.sc-label{flex:1;text-align:center;font-weight:600;font-size:0.85rem;}',
      '.sc-empty{color:var(--color-text-subdue);text-align:center;padding:30px 4px;font-size:0.85rem;}',
      '.sc-wrap{position:relative;}',
      '.sc-tip{position:absolute;pointer-events:none;background:var(--color-widget-content-border);',
      '  border-radius:6px;padding:5px 9px;font-size:0.76rem;line-height:1.35;white-space:nowrap;',
      '  box-shadow:0 2px 8px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.1s;z-index:5;}',
      '.sc-tip.sc-show{opacity:1;}',
      '.sc-tip b{color:var(--color-text-highlight);font-size:0.85rem;}',
      '.sc-summary{font-size:0.95rem;font-weight:600;color:var(--color-text-highlight);',
      '  margin-top:6px;text-align:right;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // "Nice" axis ticks (d3-style): rounds the range to human-friendly steps
  // (1/2/5 * 10^n) so gridlines land on 20/40/60 rather than 23/46/69.
  function niceNum(range, round) {
    var exp = Math.floor(Math.log(range) / Math.LN10);
    var frac = range / Math.pow(10, exp), nf;
    if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }
  function niceTicks(dataMin, dataMax, count) {
    if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
    var range = niceNum(dataMax - dataMin, false);
    var step = niceNum(range / (count - 1), true) || 1;
    var min = Math.floor(dataMin / step) * step;
    var max = Math.ceil(dataMax / step) * step;
    var ticks = [];
    for (var v = min; v <= max + step / 2; v += step) ticks.push(+v.toFixed(6));
    return { min: min, max: max, ticks: ticks };
  }

  // Catmull-Rom -> cubic Bezier, so the line reads as a smooth trend rather
  // than a jagged connect-the-dots polyline.
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return 'M' + pts[0].x + ',' + pts[0].y + ' L' + pts[1].x + ',' + pts[1].y;
    var d = 'M' + pts[0].x + ',' + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2.x + ',' + p2.y;
    }
    return d;
  }

  function fmtValue(metric, v) {
    if (metric === 'distance') return v < 10 ? v.toFixed(1) : Math.round(v).toString();
    return Math.round(v).toString();
  }
  function fmtDate(key, granularity) {
    if (!key) return '';
    if (granularity === 'year') return key;
    if (granularity === 'month') {
      var parts = key.split('-');
      return (MONTHS[parseInt(parts[1], 10) - 1] || parts[1]) + ' ' + parts[0];
    }
    var d = key.slice(0, 10).split('-');
    return d.length === 3 ? d[2] + '.' + d[1] + '.' + d[0] : key;
  }
  // Thin out x-axis labels so they don't overlap: greedily keep labels that
  // have at least minGap px of room from every label already kept.
  function pickLabels(xs, minGap) {
    var n = xs.length, keep = {};
    if (n <= 6) { for (var i = 0; i < n; i++) keep[i] = 1; return keep; }
    var stride = Math.ceil((xs[n - 1] - xs[0]) / minGap) || 1;
    var step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((xs[n - 1] - xs[0]) / minGap))));
    for (var j = 0; j < n; j += step) keep[j] = 1;
    keep[n - 1] = 1;
    return keep;
  }

  function render(wrap, state) {
    ensureStyles();
    wrap.innerHTML = '';
    wrap.classList.add('sc-wrap');

    // --- span selector -------------------------------------------------
    var nav = document.createElement('div');
    nav.className = 'sc-nav';
    SPANS.forEach(function (sp) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-btn' + (state.span === sp.key ? ' sc-on' : '');
      b.textContent = sp.label;
      b.onclick = function () { setSpan(wrap, state, sp.key); };
      nav.appendChild(b);
    });
    wrap.appendChild(nav);

    var spanDef = SPANS.filter(function (s) { return s.key === state.span; })[0];

    // --- header: prev / label / next ------------------------------------
    var head = document.createElement('div');
    head.className = 'sc-head';
    var prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'sc-arrow'; prev.textContent = '◀';
    prev.onclick = function () { shift(wrap, state, -1); };
    var lab = document.createElement('div');
    lab.className = 'sc-label';
    var next = document.createElement('button');
    next.type = 'button'; next.className = 'sc-arrow'; next.textContent = '▶';
    var canGoForward = !atMax(state);
    next.disabled = spanDef.key === 'all' || !canGoForward;
    next.onclick = function () { if (!next.disabled) shift(wrap, state, 1); };
    if (spanDef.key === 'all') { prev.style.visibility = 'hidden'; next.style.visibility = 'hidden'; }
    head.appendChild(prev); head.appendChild(lab); head.appendChild(next);
    wrap.appendChild(head);

    var pts = (state.data && state.data.points) || [];
    if (spanDef.key === 'workouts' && pts.length) {
      lab.textContent = fmtDate(pts[0].key, 'day') + ' – ' + fmtDate(pts[pts.length - 1].key, 'day');
    } else if (spanDef.key === 'month') {
      lab.textContent = MONTHS[state.month - 1] + ' ' + state.year;
    } else if (spanDef.key === 'year') {
      lab.textContent = '' + state.year;
    } else {
      lab.textContent = 'Alle Jahre';
    }

    if (!pts.length) {
      var empty = document.createElement('p');
      empty.className = 'sc-empty';
      empty.textContent = 'Keine Aktivitäten in diesem Zeitraum.';
      wrap.appendChild(empty);
      return;
    }

    drawChart(wrap, state, spanDef, pts);

    // --- summary ---------------------------------------------------------
    var sum = document.createElement('div');
    sum.className = 'sc-summary';
    var vals = pts.map(function (p) { return p.value; });
    var total = vals.reduce(function (a, b) { return a + b; }, 0);
    var text = state.metric === 'hr'
      ? 'Ø ' + Math.round(total / vals.length)
      : (chartKind(state, spanDef) === 'bar' ? 'Σ ' + fmtValue(state.metric, total) : 'Ø ' + fmtValue(state.metric, total / vals.length));
    sum.textContent = text + ' ' + state.unit;
    wrap.appendChild(sum);
  }

  function drawChart(wrap, state, spanDef, pts) {
    var W = wrap.clientWidth || 320, H = 190;
    var padL = 30, padR = 10, padT = 14, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = pts.length;
    var vals = pts.map(function (p) { return p.value; });

    var dataMin, dataMax;
    if (state.metric === 'hr') {
      dataMin = Math.min.apply(null, vals);
      dataMax = Math.max.apply(null, vals);
      var pad = (dataMax - dataMin) * 0.2 || 8;
      dataMin -= pad; dataMax += pad;
    } else {
      dataMin = 0;
      dataMax = Math.max.apply(null, vals) * 1.15 || 1;
    }
    var scale = niceTicks(dataMin, dataMax, 4);
    var yMin = scale.min, yMax = scale.max;
    if (state.metric !== 'hr') yMin = Math.min(yMin, 0);

    function xAt(i) { return n === 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1); }
    function yAt(v) { return padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, style: 'width:100%;height:' + H + 'px;display:block;overflow:visible;' });

    // gridlines + y-axis labels
    scale.ticks.forEach(function (t) {
      if (t < yMin - 1e-9 || t > yMax + 1e-9) return;
      var gy = yAt(t);
      svg.appendChild(el('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: 'var(--color-separator)', 'stroke-width': '1', opacity: '0.45' }));
      var tl = el('text', { x: padL - 6, y: gy + 3, 'font-size': '9', 'text-anchor': 'end', fill: 'var(--color-text-subdue)' });
      tl.textContent = fmtValue(state.metric, t);
      svg.appendChild(tl);
    });

    var geo = pts.map(function (p, i) { return { x: xAt(i), y: yAt(p.value), v: p.value, key: p.key }; });
    var lblKeep = pickLabels(geo.map(function (g) { return g.x; }), 34);
    var granularity = spanDef.granularity;
    var kind = chartKind(state, spanDef);

    var barW = 0;
    if (kind === 'bar') {
      barW = clamp(plotW / n * 0.62, 3, 34);
      var baseY = yAt(Math.max(yMin, 0));
      geo.forEach(function (g, i) {
        var top = Math.min(g.y, baseY), h = Math.max(2, Math.abs(baseY - g.y));
        var bar = el('rect', {
          x: g.x - barW / 2, y: top, width: barW, height: h, rx: Math.min(3, barW / 2),
          fill: state.color, opacity: '0.85', 'data-idx': i,
        });
        svg.appendChild(bar);
        g.el = bar;
      });
    } else {
      var gradId = 'sc-grad-' + (wrap.id || Math.random().toString(36).slice(2));
      var defs = el('defs', {});
      var lg = el('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      lg.appendChild(el('stop', { offset: '0', 'stop-color': state.color, 'stop-opacity': '0.30' }));
      lg.appendChild(el('stop', { offset: '1', 'stop-color': state.color, 'stop-opacity': '0.02' }));
      defs.appendChild(lg);
      svg.appendChild(defs);
      var linePath = smoothPath(geo);
      var baseline = padT + plotH;
      var areaPath = linePath + ' L' + geo[n - 1].x + ',' + baseline + ' L' + geo[0].x + ',' + baseline + ' Z';
      svg.appendChild(el('path', { d: areaPath, fill: 'url(#' + gradId + ')', stroke: 'none' }));
      svg.appendChild(el('path', { d: linePath, fill: 'none', stroke: state.color, 'stroke-width': '2.2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      geo.forEach(function (g, i) {
        var last = i === n - 1;
        var dot = el('circle', { cx: g.x, cy: g.y, r: last ? '3' : '2', fill: state.color, opacity: last ? '1' : '0.75' });
        svg.appendChild(dot);
        g.el = dot;
      });
    }

    // x-axis labels
    geo.forEach(function (g, i) {
      if (!lblKeep[i]) return;
      var lx = clamp(g.x, 16, W - 16);
      var t = el('text', { x: lx, y: H - 6, 'font-size': '9', 'text-anchor': 'middle', fill: 'var(--color-text-subdue)' });
      t.textContent = pts[i].label;
      svg.appendChild(t);
    });

    // crosshair (hidden until hover)
    var crosshair = el('line', { y1: padT, y2: padT + plotH, stroke: 'var(--color-text-subdue)', 'stroke-width': '1', 'stroke-dasharray': '2,2', opacity: '0' });
    svg.appendChild(crosshair);
    var hoverDot = el('circle', { r: '4', fill: state.color, stroke: 'var(--color-widget-background-color, transparent)', 'stroke-width': '2', opacity: '0' });
    svg.appendChild(hoverDot);

    // pointer capture layer
    var hit = el('rect', { x: padL, y: 0, width: plotW, height: H, fill: 'transparent', style: 'cursor:crosshair;' });
    svg.appendChild(hit);

    // Own positioning context for the tooltip: the nav/header rows above the
    // chart push the svg down within wrap, so the tip must be positioned
    // relative to this box (not wrap) or it renders offset upward by however
    // tall those rows are.
    var box = document.createElement('div');
    box.style.position = 'relative';
    box.appendChild(svg);
    wrap.appendChild(box);

    var tip = document.createElement('div');
    tip.className = 'sc-tip';
    box.appendChild(tip);

    function nearestIdx(clientX) {
      var rect = svg.getBoundingClientRect();
      var x = ((clientX - rect.left) / rect.width) * W;
      var best = 0, bestD = Infinity;
      geo.forEach(function (g, i) { var d = Math.abs(g.x - x); if (d < bestD) { bestD = d; best = i; } });
      return best;
    }
    function showAt(i) {
      var g = geo[i];
      crosshair.setAttribute('x1', g.x); crosshair.setAttribute('x2', g.x); crosshair.setAttribute('opacity', '0.6');
      hoverDot.setAttribute('cx', g.x); hoverDot.setAttribute('cy', g.y); hoverDot.setAttribute('opacity', kind === 'bar' ? '0' : '1');
      if (kind === 'bar' && g.el) g.el.setAttribute('opacity', '1');
      geo.forEach(function (o, j) { if (j !== i && kind === 'bar' && o.el) o.el.setAttribute('opacity', '0.85'); });
      tip.innerHTML = '<b>' + fmtValue(state.metric, g.v) + ' ' + state.unit + '</b><br>' + (fmtDate(g.key, granularity) || pts[i].label);
      // Clamp against the tip's actual measured width/height (not a guessed
      // ~90px) so it never overlaps the y-axis labels on the left or spills
      // past the right edge — both were happening with a fixed guess, since
      // the real box is a good deal wider than that near the edges.
      var boxW = box.clientWidth || W;
      var tipW = tip.offsetWidth || 90, tipH = tip.offsetHeight || 30;
      var left = clamp(g.x - tipW / 2, 4, boxW - tipW - 4);
      var top = Math.max(0, g.y - tipH - 10);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      tip.classList.add('sc-show');
    }
    function hide() {
      crosshair.setAttribute('opacity', '0'); hoverDot.setAttribute('opacity', '0');
      if (kind === 'bar') geo.forEach(function (o) { if (o.el) o.el.setAttribute('opacity', '0.85'); });
      tip.classList.remove('sc-show');
    }
    hit.addEventListener('mousemove', function (e) { showAt(nearestIdx(e.clientX)); });
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', function (e) {
      if (!e.touches.length) return;
      showAt(nearestIdx(e.touches[0].clientX));
      clearTimeout(wrap._scTapTimer);
      wrap._scTapTimer = setTimeout(hide, 2500);
    }, { passive: true });
  }

  function atMax(state) {
    var now = new Date();
    if (state.span === 'workouts') return state.workoutOffset <= 0;
    if (state.span === 'month') return state.year > now.getFullYear() || (state.year === now.getFullYear() && state.month >= now.getMonth() + 1);
    if (state.span === 'year') return state.year >= now.getFullYear();
    return true;
  }

  function setSpan(wrap, state, key) {
    var now = new Date();
    state.span = key; state.workoutOffset = 0; state.year = now.getFullYear(); state.month = now.getMonth() + 1;
    load(wrap, state);
  }

  function shift(wrap, state, dir) {
    if (state.span === 'workouts') { state.workoutOffset += dir < 0 ? 1 : -1; if (state.workoutOffset < 0) state.workoutOffset = 0; }
    else if (state.span === 'month') { state.month += dir; if (state.month < 1) { state.month = 12; state.year--; } if (state.month > 12) { state.month = 1; state.year++; } }
    else if (state.span === 'year') { state.year += dir; }
    load(wrap, state);
  }

  function spec(state) {
    var spanDef = SPANS.filter(function (s) { return s.key === state.span; })[0];
    if (state.span === 'month') {
      var lastDay = new Date(state.year, state.month, 0).getDate();
      return { granularity: 'day', from: state.year + '-' + pad2(state.month) + '-01', to: state.year + '-' + pad2(state.month) + '-' + pad2(lastDay) };
    }
    if (state.span === 'year') return { granularity: 'month', from: state.year + '-01-01', to: state.year + '-12-31' };
    if (state.span === 'all') return { granularity: 'year', from: '', to: '' };
    return { granularity: 'activity', from: '', to: '' };
  }

  function load(wrap, state) {
    var s = spec(state);
    var q = '/strava-api/series?metric=' + state.metric + '&granularity=' + s.granularity;
    if (s.from) q += '&from=' + s.from + '&to=' + s.to;
    if (state.span === 'workouts') q += '&count=' + PAGE + '&offset=' + (state.workoutOffset * PAGE);
    fetch(q, { headers: { 'X-Api-Token': state.token } })
      .then(function (r) { return r.json(); })
      .then(function (data) { state.data = data; render(wrap, state); })
      .catch(function (e) {
        wrap.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'sc-empty';
        p.textContent = 'Fehler: ' + (e && e.message || e);
        wrap.appendChild(p);
      });
  }

  // Public entry point. wrapId: container <div> id. metric: hr|effort|distance.
  // color: any CSS color (var(--color-...) works). unit: display unit string.
  // token: X-Api-Token value for the /strava-api/series fetch.
  window.StravaChart = function (wrapId, metric, color, unit, token) {
    var wrap = document.getElementById(wrapId);
    if (!wrap || wrap._scBooted) return;
    wrap._scBooted = true;
    var now = new Date();
    var state = { metric: metric, color: color, unit: unit, token: token, span: 'workouts', workoutOffset: 0, year: now.getFullYear(), month: now.getMonth() + 1 };
    load(wrap, state);
  };
})();
