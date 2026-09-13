/*
 * Shared chart engine for the Health dashboard page (config/health.yml).
 *
 * Same treatment as assets/strava-chart.js: six widgets (Schlaf, Ruhepuls,
 * HRV, Aktive Energie, Gewicht, Schritte) used to each carry their own copy
 * of the same ~3000-character inline chart function (window.__HC). Now they
 * share this one file instead, with the same visual/interaction upgrades —
 * a real y-axis, hover/tap tooltip with crosshair, a smoothed line — and,
 * per the same design call as Strava's HR chart, always a line: every one
 * of these metrics reads as a trend over the selected window, never bars.
 *
 * Health's own nav model (14/30/90 day range, no drill-down/paging) is
 * simpler than Strava's workouts/month/year/all, so this stays a separate,
 * self-contained file rather than sharing strava-chart.js's nav machinery.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var RANGES = [
    { days: 14, label: '14 T' },
    { days: 30, label: '30 T' },
    { days: 90, label: '90 T' },
  ];

  function el(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function ensureStyles() {
    if (document.getElementById('hc-style')) return;
    var s = document.createElement('style');
    s.id = 'hc-style';
    s.textContent = [
      '.hc-nav{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;}',
      '.hc-btn{border:none;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:0.78rem;',
      '  background:var(--color-widget-content-border);color:inherit;transition:background 0.15s;}',
      '.hc-btn:hover{filter:brightness(1.15);}',
      '.hc-btn.hc-on{background:var(--color-primary);color:#fff;}',
      '.hc-empty{color:var(--color-text-subdue);text-align:center;padding:30px 4px;font-size:0.85rem;}',
      '.hc-tip{position:absolute;pointer-events:none;background:var(--color-widget-content-border);',
      '  border-radius:6px;padding:5px 9px;font-size:0.76rem;line-height:1.35;white-space:nowrap;',
      '  box-shadow:0 2px 8px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.1s;z-index:5;}',
      '.hc-tip.hc-show{opacity:1;}',
      '.hc-tip b{color:var(--color-text-highlight);font-size:0.85rem;}',
      '.hc-summary{font-size:0.95rem;font-weight:600;color:var(--color-text-highlight);',
      '  margin-top:6px;text-align:right;}',
    ].join('\n');
    document.head.appendChild(s);
  }

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

  function fmtValue(v) {
    var r = Math.round(v * 10) / 10;
    return r % 1 === 0 ? String(r) : r.toFixed(1);
  }
  function fmtDate(key) {
    if (!key || key.length < 10) return key || '';
    var d = key.slice(0, 10).split('-');
    return d.length === 3 ? d[2] + '.' + d[1] + '.' + d[0] : key;
  }
  function pickLabels(xs, minGap) {
    var n = xs.length, keep = {};
    if (n <= 6) { for (var i = 0; i < n; i++) keep[i] = 1; return keep; }
    var step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((xs[n - 1] - xs[0]) / minGap))));
    for (var j = 0; j < n; j += step) keep[j] = 1;
    keep[n - 1] = 1;
    return keep;
  }

  function render(wrap, state) {
    ensureStyles();
    wrap.innerHTML = '';

    var nav = document.createElement('div');
    nav.className = 'hc-nav';
    RANGES.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hc-btn' + (state.days === r.days ? ' hc-on' : '');
      b.textContent = r.label;
      b.onclick = function () { state.days = r.days; load(wrap, state); };
      nav.appendChild(b);
    });
    wrap.appendChild(nav);

    var pts = (state.data && state.data.points) || [];
    if (!pts.length) {
      var empty = document.createElement('p');
      empty.className = 'hc-empty';
      empty.textContent = 'Noch keine Daten. Health Auto Export senden.';
      wrap.appendChild(empty);
      return;
    }

    drawChart(wrap, state, pts);

    var sum = document.createElement('div');
    sum.className = 'hc-summary';
    var vals = pts.map(function (p) { return p.value; });
    var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    sum.textContent = 'Ø ' + fmtValue(avg) + ' ' + state.unit;
    wrap.appendChild(sum);
  }

  function drawChart(wrap, state, pts) {
    var W = wrap.clientWidth || 320, H = 190;
    var padL = 30, padR = 10, padT = 14, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = pts.length;
    var vals = pts.map(function (p) { return p.value; });

    var dataMin = Math.min.apply(null, vals), dataMax = Math.max.apply(null, vals);
    var pad = (dataMax - dataMin) * 0.18 || Math.max(1, dataMax * 0.1);
    dataMin -= pad; dataMax += pad;
    if (dataMin < 0 && vals.every(function (v) { return v >= 0; })) dataMin = 0;
    var scale = niceTicks(dataMin, dataMax, 4);
    var yMin = scale.min, yMax = scale.max;

    function xAt(i) { return n === 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1); }
    function yAt(v) { return padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, style: 'width:100%;height:' + H + 'px;display:block;overflow:visible;' });

    scale.ticks.forEach(function (t) {
      if (t < yMin - 1e-9 || t > yMax + 1e-9) return;
      var gy = yAt(t);
      svg.appendChild(el('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: 'var(--color-separator)', 'stroke-width': '1', opacity: '0.45' }));
      var tl = el('text', { x: padL - 6, y: gy + 3, 'font-size': '9', 'text-anchor': 'end', fill: 'var(--color-text-subdue)' });
      tl.textContent = fmtValue(t);
      svg.appendChild(tl);
    });

    var geo = pts.map(function (p, i) { return { x: xAt(i), y: yAt(p.value), v: p.value, key: p.key }; });
    var lblKeep = pickLabels(geo.map(function (g) { return g.x; }), 34);

    var gradId = 'hc-grad-' + (wrap.id || Math.random().toString(36).slice(2));
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
      svg.appendChild(el('circle', { cx: g.x, cy: g.y, r: last ? '3' : '2', fill: state.color, opacity: last ? '1' : '0.75' }));
    });

    geo.forEach(function (g, i) {
      if (!lblKeep[i]) return;
      var lx = clamp(g.x, 16, W - 16);
      var t = el('text', { x: lx, y: H - 6, 'font-size': '9', 'text-anchor': 'middle', fill: 'var(--color-text-subdue)' });
      t.textContent = pts[i].label;
      svg.appendChild(t);
    });

    var crosshair = el('line', { y1: padT, y2: padT + plotH, stroke: 'var(--color-text-subdue)', 'stroke-width': '1', 'stroke-dasharray': '2,2', opacity: '0' });
    svg.appendChild(crosshair);
    var hoverDot = el('circle', { r: '4', fill: state.color, stroke: 'var(--color-widget-background-color, transparent)', 'stroke-width': '2', opacity: '0' });
    svg.appendChild(hoverDot);

    var hit = el('rect', { x: padL, y: 0, width: plotW, height: H, fill: 'transparent', style: 'cursor:crosshair;' });
    svg.appendChild(hit);

    var box = document.createElement('div');
    box.style.position = 'relative';
    box.appendChild(svg);
    wrap.appendChild(box);

    var tip = document.createElement('div');
    tip.className = 'hc-tip';
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
      hoverDot.setAttribute('cx', g.x); hoverDot.setAttribute('cy', g.y); hoverDot.setAttribute('opacity', '1');
      tip.innerHTML = '<b>' + fmtValue(g.v) + ' ' + state.unit + '</b><br>' + (fmtDate(g.key) || pts[i].label);
      // Clamp against the tip's actual measured width/height, not a guessed
      // ~90px — a fixed guess overlapped the y-axis labels on the left edge
      // and spilled past the right edge, since the real box is wider than
      // that guess accounted for near the edges.
      var boxW = box.clientWidth || W;
      var tipW = tip.offsetWidth || 90, tipH = tip.offsetHeight || 30;
      var left = clamp(g.x - tipW / 2, 4, boxW - tipW - 4);
      var top = Math.max(0, g.y - tipH - 10);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      tip.classList.add('hc-show');
    }
    function hide() {
      crosshair.setAttribute('opacity', '0'); hoverDot.setAttribute('opacity', '0');
      tip.classList.remove('hc-show');
    }
    hit.addEventListener('mousemove', function (e) { showAt(nearestIdx(e.clientX)); });
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', function (e) {
      if (!e.touches.length) return;
      showAt(nearestIdx(e.touches[0].clientX));
      clearTimeout(wrap._hcTapTimer);
      wrap._hcTapTimer = setTimeout(hide, 2500);
    }, { passive: true });
  }

  function load(wrap, state) {
    fetch('/health-api/series?metric=' + state.metric + '&days=' + state.days, { headers: { 'X-Api-Token': state.token } })
      .then(function (r) { return r.json(); })
      .then(function (data) { state.data = data; render(wrap, state); })
      .catch(function (e) {
        wrap.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'hc-empty';
        p.textContent = 'Fehler: ' + (e && e.message || e);
        wrap.appendChild(p);
      });
  }

  // Public entry point. wrapId: container <div> id. metric: any Health Auto
  // Export metric served by /health-api/series (sleep, resting_hr, hrv,
  // active_energy, weight, steps, ...). color: any CSS color. unit: display
  // unit string. token: X-Api-Token value for the fetch.
  window.HealthChart = function (wrapId, metric, color, unit, token) {
    var wrap = document.getElementById(wrapId);
    if (!wrap || wrap._hcBooted) return;
    wrap._hcBooted = true;
    var state = { metric: metric, color: color, unit: unit, token: token, days: 30 };
    load(wrap, state);
  };
})();
