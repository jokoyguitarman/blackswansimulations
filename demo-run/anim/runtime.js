/**
 * Deterministic animation runtime.
 *
 * The point of rendering the trailer rather than recording it is that every
 * frame must be reproducible: frame 412 has to look identical whether it is
 * rendered first or last, on a busy machine or an idle one. So there is no
 * requestAnimationFrame here and no wall clock. The page exposes __seek(ms),
 * which computes the complete visual state from the time value alone, and the
 * renderer calls it once per frame before screenshotting.
 *
 * Animation is declared as tracks — a selector, a property, keyframes. Anything
 * that cannot be expressed that way (a caret blinking, a number with thousands
 * separators, a click ripple) gets a dedicated track type rather than escaping
 * into imperative code, because imperative code is where non-determinism gets
 * back in. Seeking backwards has to produce the same frame as seeking forwards.
 */

(() => {
  const EASINGS = {
    linear: (t) => t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    in: (t) => t * t * t,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    /** Slight overshoot, for things that land rather than merely arrive. */
    back: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  };

  function sample(keys, t, ease) {
    if (!keys || !keys.length) return 0;
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i];
      const [t1, v1] = keys[i + 1];
      if (t >= t0 && t <= t1) {
        const raw = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
        return v0 + (v1 - v0) * (EASINGS[ease] || EASINGS.out)(raw);
      }
    }
    return keys[keys.length - 1][1];
  }

  const fmt = (n) => Math.round(n).toLocaleString('en-SG');
  const nodes = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  /**
   * Compose transform pieces per element so separate tracks do not fight.
   *
   * Critically, this preserves a layout transform declared in the markup via
   * data-xf. Elements centred with translate(-50%,-50%) were being knocked out
   * of position the moment any transform track touched them, because writing
   * style.transform replaced the centring outright — which is what threw the
   * report dialog to the lower right and dropped the stats panel half a frame.
   */
  const xf = new WeakMap();
  function setXf(el, key, value) {
    const cur = xf.get(el) || { x: 0, y: 0, scale: 1, rotate: 0, base: el.getAttribute('data-xf') || '' };
    cur[key] = value;
    xf.set(el, cur);
    el.style.transform =
      (cur.base ? cur.base + ' ' : '') +
      'translate3d(' + cur.x + 'px,' + cur.y + 'px,0) scale(' + cur.scale + ') rotate(' + cur.rotate + 'deg)';
  }

  const TRACKS = {
    opacity: (el, tr, t) => {
      el.style.opacity = String(sample(tr.keys, t, tr.ease));
    },
    x: (el, tr, t) => setXf(el, 'x', sample(tr.keys, t, tr.ease)),
    y: (el, tr, t) => setXf(el, 'y', sample(tr.keys, t, tr.ease)),
    scale: (el, tr, t) => setXf(el, 'scale', sample(tr.keys, t, tr.ease)),
    rotate: (el, tr, t) => setXf(el, 'rotate', sample(tr.keys, t, tr.ease)),

    /** Scroll a container. The most common motion in the film. */
    scroll: (el, tr, t) => {
      el.scrollTop = sample(tr.keys, t, tr.ease);
    },

    /** Characters appearing under a caret. */
    type: (el, tr, t) => {
      const n = Math.round(sample(tr.keys, t, tr.ease || 'linear'));
      const typing = n > 0 && n < tr.text.length;
      const blink = typing || Math.floor(t / 500) % 2 === 0;
      el.textContent = '';
      const done = document.createElement('span');
      done.className = 'typed';
      done.textContent = tr.text.slice(0, n);
      const caret = document.createElement('span');
      caret.className = 'caret';
      if (!blink) caret.style.opacity = '0';
      el.appendChild(done);
      el.appendChild(caret);
      if (tr.showRest) {
        const rest = document.createElement('span');
        rest.className = 'untyped';
        rest.textContent = tr.text.slice(n);
        el.appendChild(rest);
      }
    },

    /** A counter rolling upward. */
    number: (el, tr, t) => {
      el.textContent = (tr.prefix || '') + fmt(sample(tr.keys, t, tr.ease)) + (tr.suffix || '');
    },

    /** Width as a percentage, for gauge bars. */
    widthPct: (el, tr, t) => {
      el.style.width = sample(tr.keys, t, tr.ease) + '%';
    },

    /** Add a class from a moment onward, e.g. a post flipping to "arrived". */
    classAt: (el, tr, t) => {
      el.classList.toggle(tr.class, t >= tr.at);
    },

    /** Progressively draw an SVG path. */
    draw: (el, tr, t) => {
      const len = el.getTotalLength ? el.getTotalLength() : 0;
      el.style.strokeDasharray = String(len);
      el.style.strokeDashoffset = String(len * (1 - sample(tr.keys, t, tr.ease)));
    },

    /**
     * A trend line whose shape IS the metric.
     *
     * Rebuilds the path each frame by sampling the same keyframes that drive
     * the number, so the graph rises and falls with the figure instead of being
     * a decorative squiggle that happens to point the right way. It also grows
     * left to right, so the line is a record of what has happened so far rather
     * than a prediction of the whole clip.
     */
    spark: (el, tr, t) => {
      const t0 = tr.from ?? 0;
      const t1 = tr.to ?? 1;
      const upto = Math.max(t0, Math.min(t, t1));
      if (upto <= t0) {
        el.setAttribute('d', '');
        return;
      }
      const n = tr.points ?? 48;
      const span = tr.max - tr.min || 1;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const tt = t0 + ((upto - t0) * i) / n;
        const v = sample(tr.keys, tt, tr.ease);
        const x = (((tt - t0) / (t1 - t0)) * tr.w).toFixed(1);
        const y = (tr.h - ((v - tr.min) / span) * tr.h).toFixed(1);
        pts.push(x + ',' + y);
      }
      el.setAttribute('d', 'M' + pts.join(' L'));
    },

    /** Present only within a window — for beats that come and go. */
    visible: (el, tr, t) => {
      el.style.display = t >= tr.from && t < tr.to ? '' : 'none';
    },
  };

  /**
   * The pointer, as its own track type.
   *
   * It has to stay crisp at any output resolution and sit above everything, so
   * it is an inline SVG arrow whose tip is the anchor point — the same shape as
   * the system cursor, because that is what makes the audience read this as
   * somebody using a computer rather than a diagram animating itself.
   */
  function ensureEl(id, css, html) {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = css;
    if (html) el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  const CURSOR_SVG =
    '<svg width="26" height="31" viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M1 1 L1 19.2 L5.7 14.6 L8.9 21.8 L12.1 20.4 L9 13.4 L15.4 13.1 Z" ' +
    'fill="#FFFFFF" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  function applyCursor(tr, t) {
    const c = ensureEl(
      '__cursor',
      'position:fixed;left:0;top:0;width:26px;height:31px;pointer-events:none;' +
        'z-index:2147483647;transform-origin:0 0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))',
      CURSOR_SVG,
    );
    const x = sample(tr.x, t, tr.ease);
    const y = sample(tr.y, t, tr.ease);

    // A click both presses the arrow and throws a ring. Both are derived from
    // the click list rather than spawned, so seeking backwards cleans up.
    const RING_MS = 420;
    const hit = (tr.clicks || []).find((c0) => t >= c0 && t < c0 + RING_MS);
    const press = (tr.clicks || []).find((c0) => t >= c0 && t < c0 + 120) !== undefined;
    const base = tr.subtle ? 0.8 : 1;

    c.style.opacity = String(tr.opacity ? sample(tr.opacity, t, tr.ease) : tr.subtle ? 0.72 : 1);
    c.style.transform =
      'translate3d(' + x + 'px,' + y + 'px,0) scale(' + (press ? base * 0.86 : base) + ')';

    const ring = ensureEl(
      '__ring',
      'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
        'border:2px solid rgba(56,189,248,.95);pointer-events:none;z-index:2147483646;opacity:0',
    );
    if (hit === undefined) {
      ring.style.opacity = '0';
    } else {
      const p = (t - hit) / RING_MS;
      ring.style.opacity = String(1 - p);
      ring.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + (0.4 + p * 2.8) + ')';
    }
  }

  let DATA = [];
  window.__load = (tracks) => {
    DATA = tracks || [];
  };

  window.__seek = (t) => {
    for (const tr of DATA) {
      if (tr.prop === 'cursor') {
        applyCursor(tr, t);
        continue;
      }
      const fn = TRACKS[tr.prop];
      if (!fn) continue;
      for (const el of nodes(tr.sel)) fn(el, tr, t);
    }
    document.documentElement.setAttribute('data-frame-t', String(t));
  };
})();
