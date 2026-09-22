import './marketing.css';

/**
 * Behaviour for the public marketing pages. Deliberately tiny and dependency
 * free: these pages must not pull in the application bundle.
 *
 * Everything here is progressive. The pages are fully readable and the form is
 * still usable if this script never runs.
 */

/** Enquiries fall back to this address whenever the API cannot be reached. */
const CONTACT_EMAIL = 'kenneth@prophyion.com';

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Conversion confirmation page. A real URL, so analytics can anchor on it. */
const THANK_YOU_PATH = '/thank-you';

// Unlocks the scroll-reveal CSS. Kept here rather than in the stylesheet so a
// blocked or failed script leaves every section visible instead of blank.
document.documentElement.classList.add('js');

/** Read live rather than cached: the setting can change while the page is open. */
const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Counts an element from its current value to a target.
 *
 * Swapping the numbers instead would lose the point of showing them: it is the
 * count itself that makes the deterioration feel like it is happening to the
 * reader. Under reduced motion the value is set outright.
 */
const tweenFrames = new Map<HTMLElement, number>();

const tweenTo = (
  el: HTMLElement | null,
  target: number,
  format: (n: number) => string = String,
): void => {
  if (!el) return;
  const running = tweenFrames.get(el);
  if (running) cancelAnimationFrame(running);
  if (!Number.isFinite(target)) {
    el.textContent = '-';
    return;
  }
  if (reducedMotion()) {
    el.textContent = format(target);
    return;
  }
  const from = Number(String(el.textContent).replace(/[^\d]/g, '')) || 0;
  const startedAt = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - startedAt) / 700);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(Math.round(from + (target - from) * eased));
    if (t < 1) tweenFrames.set(el, requestAnimationFrame(step));
  };
  tweenFrames.set(el, requestAnimationFrame(step));
};

/* ── Header: transparent over the dark hero, solid once scrolled past it ── */
const header = document.getElementById('site-header');
if (header) {
  const syncHeader = () => header.classList.toggle('is-solid', window.scrollY > 40);
  window.addEventListener('scroll', syncHeader, { passive: true });
  syncHeader();
}

/* ── Scroll reveal ── */
const revealTargets = document.querySelectorAll<HTMLElement>('.reveal');
if (revealTargets.length > 0 && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );
  revealTargets.forEach((el) => observer.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add('is-visible'));
}

/* ── Hero exercise clock ── */
const clock = document.getElementById('sim-clock');
if (clock) {
  const startSeconds = Number(clock.dataset.start ?? 0);
  let elapsed = startSeconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  window.setInterval(() => {
    elapsed += 1;
    const h = pad(Math.floor(elapsed / 3600));
    const m = pad(Math.floor((elapsed % 3600) / 60));
    const s = pad(elapsed % 60);
    clock.textContent = `T+ ${h}:${m}:${s}`;
  }, 1000);
}

/* ── Hero feed: engagement that keeps climbing ──────────────────────
   Each counter drifts at its own rate so a visitor who stops to read watches
   the situation deteriorate, rather than seeing an obvious synchronised loop. */
const driftRates: Record<string, [min: number, max: number, everyMs: number]> = {
  mentions: [12, 60, 1300],
  'by-rt': [3, 14, 1900],
  'by-lk': [8, 30, 1500],
  'dk-rt': [20, 90, 1200],
  'dk-lk': [40, 160, 1100],
};

document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
  const rate = driftRates[el.dataset.count ?? ''];
  if (!rate) return;
  const [min, max, every] = rate;
  let value = Number(el.textContent?.replace(/[^\d]/g, '') ?? 0);
  window.setInterval(() => {
    value += Math.floor(Math.random() * (max - min)) + min;
    el.textContent = value.toLocaleString();
  }, every);
});

// The reporter's deadline runs down, because a still clock is not pressure.
document.querySelectorAll<HTMLElement>('[data-countdown]').forEach((el) => {
  let left = Number(el.dataset.countdown ?? 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  window.setInterval(() => {
    if (left > 0) left -= 1;
    el.textContent = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
  }, 1000);
});

/* Field-ops readout: headcount rising, inbox filling. */
const evacCount = document.getElementById('evac-count');
if (evacCount) {
  let evacuated = Number(evacCount.textContent?.replace(/[^\d]/g, '') ?? 0);
  window.setInterval(() => {
    evacuated = Math.min(1480, evacuated + Math.floor(Math.random() * 7) + 2);
    evacCount.textContent = evacuated.toLocaleString();
  }, 1800);
}

const mailBadge = document.getElementById('mail-badge');
if (mailBadge) {
  let unread = Number(mailBadge.textContent?.replace(/[^\d]/g, '') ?? 0);
  window.setInterval(() => {
    unread += 1;
    mailBadge.textContent = String(unread);
  }, 6000);
}

/* ── Reveal cards ───────────────────────────────────────────────────
   Hover handles this on a mouse via CSS. Touch needs a real tap, and tapping
   the revealed card again puts the artwork back. */
document.querySelectorAll<HTMLElement>('.reveal-card').forEach((card) => {
  const toggle = card.querySelector<HTMLButtonElement>('.rc-toggle');
  if (!toggle) return;

  const setOpen = (open: boolean) => {
    card.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => setOpen(true));

  // Tapping the open card closes it again, which mouse users get free on mouseleave.
  card.addEventListener('click', (event) => {
    if (card.classList.contains('is-open') && event.target !== toggle) setOpen(false);
  });

  card.addEventListener('mouseleave', () => setOpen(false));
});

/* ── Recorded clips ─────────────────────────────────────────────────
   Marked preload="none" in the markup, so nothing is fetched until a clip is
   actually scrolled to. Playing only what is on screen matters on the storyboard
   page, which carries four of them: autoplaying the lot would decode four videos
   at once to show one. */
const clips = document.querySelectorAll<HTMLVideoElement>('video[data-clip]');
if (clips.length > 0) {
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const clip = entry.target as HTMLVideoElement;
          if (entry.isIntersecting && !reducedMotion()) {
            // Autoplay is refused often enough (data saver, battery saver, a
            // policy the muted attribute does not satisfy) that it cannot be
            // treated as reliable. The poster is already showing, so a rejected
            // promise needs no handling beyond not becoming an error.
            void clip.play().catch(() => undefined);
          } else if (!clip.paused) {
            clip.pause();
          }
        });
      },
      { threshold: 0.3 },
    );
    clips.forEach((clip) => io.observe(clip));
  } else {
    clips.forEach((clip) => void clip.play().catch(() => undefined));
  }

  // Give a visitor who cannot autoplay, or who has motion turned off, a way in.
  clips.forEach((clip) => {
    clip.addEventListener('click', () => {
      if (clip.paused) void clip.play().catch(() => undefined);
      else clip.pause();
    });
  });
}

/* ── Corporate Crisis storyboard ────────────────────────────────────
   Seven acts down the page against a rail that tracks whichever one is being
   read. The scoring readouts belong to the act, not to the scroll position, so
   they move in one step per act rather than interpolating continuously. The
   numbers are scores from a real session, and sliding between them would imply a
   precision the exercise does not claim. */
const ccRail = document.querySelector<HTMLElement>('[data-cc-rail]');
if (ccRail) {
  const scenes = [...document.querySelectorAll<HTMLElement>('[data-cc-scene]')];
  const items = [...ccRail.querySelectorAll<HTMLElement>('[data-cc-rail-item]')];
  const clockEl = ccRail.querySelector<HTMLElement>('[data-cc-clock]');

  const metric = (key: string): HTMLElement | null =>
    ccRail.querySelector<HTMLElement>(`[data-cc-metric="${key}"]`);
  const fill = (key: string): HTMLElement | null =>
    ccRail.querySelector<HTMLElement>(`[data-cc-fill="${key}"]`);

  // Same temperature palette the landing page storyboard uses, so the two
  // sections read as the same instrument.
  const TEMP_COLOUR: Record<string, string> = {
    calm: '#15803D',
    watch: '#D97706',
    critical: '#B91C1C',
    recover: '#15803D',
  };

  let shown = -1;

  const showScene = (index: number): void => {
    const scene = scenes[index];
    if (!scene || index === shown) return;
    shown = index;

    scenes.forEach((s, i) => s.classList.toggle('is-current', i === index));
    items.forEach((item, i) => item.classList.toggle('is-active', i === index));

    if (clockEl) clockEl.textContent = scene.dataset.clock ?? 'T+00:00';

    const temp = scene.dataset.temp ?? 'calm';
    const colour = TEMP_COLOUR[temp] ?? TEMP_COLOUR.calm;

    // Escalation risk is the one measure where a high number is the bad one, so
    // it is always drawn in the warning colour rather than the act's.
    (['trust', 'narrative', 'risk'] as const).forEach((key) => {
      const value = Number(scene.dataset[key] ?? 0);
      tweenTo(metric(key), value);
      const bar = fill(key);
      if (bar) {
        bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
        bar.style.backgroundColor = key === 'risk' ? '#B91C1C' : colour;
      }
    });

    tweenTo(metric('mentions'), Number(scene.dataset.mentions ?? 0), (n) => n.toLocaleString());
  };

  if ('IntersectionObserver' in window && scenes.length > 0) {
    // A band across the middle of the viewport, so the act that owns the rail is
    // the one the reader is looking at rather than whichever merely touches the
    // top edge. Ties go to the lower act, which is the direction of travel.
    const io = new IntersectionObserver(
      (entries) => {
        entries
          .filter((entry) => entry.isIntersecting)
          .forEach((entry) => showScene(scenes.indexOf(entry.target as HTMLElement)));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    scenes.forEach((scene) => io.observe(scene));
    showScene(0);
  } else {
    showScene(0);
  }
}

/* ── Enquiry form ── */
const form = document.getElementById('enquiry-form') as HTMLFormElement | null;
const successPanel = document.getElementById('enquiry-success');
const errorPanel = document.getElementById('enquiry-error');
const submitButton = document.getElementById('enquiry-submit') as HTMLButtonElement | null;

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const data = new FormData(form);

    // Honeypot. Bots fill hidden fields; people cannot see this one.
    if (String(data.get('website') ?? '').trim() !== '') {
      successPanel?.classList.remove('hidden');
      form.classList.add('hidden');
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Sending…';
    }
    errorPanel?.classList.add('hidden');

    try {
      const response = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organisation: data.get('organisation'),
          sector: data.get('sector') || null,
          contact_name: data.get('contact_name'),
          contact_email: data.get('contact_email'),
          team_size: data.get('team_size') || null,
          message: data.get('message') || null,
          source: window.location.pathname,
          website: '',
        }),
      });

      if (!response.ok) throw new Error(`Request failed with ${response.status}`);

      // Redirect to a real URL so the conversion has something to be measured
      // against. The inline panel stays as the fallback for anyone who lands here
      // with navigation blocked.
      const body = (await response.json().catch(() => null)) as { id?: string } | null;
      const target = body?.id
        ? `${THANK_YOU_PATH}?ref=${encodeURIComponent(body.id)}`
        : THANK_YOU_PATH;

      form.classList.add('hidden');
      successPanel?.classList.remove('hidden');
      window.location.assign(target);
    } catch {
      // Never a dead end: surface a real address the visitor can use instead.
      errorPanel?.classList.remove('hidden');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Request a scoping call';
      }
    }
  });
}

/* Fill in the fallback address wherever the markup asks for it. */
document.querySelectorAll<HTMLAnchorElement>('[data-contact-email]').forEach((el) => {
  el.href = `mailto:${CONTACT_EMAIL}`;
  el.textContent = CONTACT_EMAIL;
});

/* ── Thank-you page: show the enquiry reference if we were given one ── */
const referenceBlock = document.getElementById('enquiry-reference');
if (referenceBlock) {
  const reference = new URLSearchParams(window.location.search).get('ref');
  const slot = referenceBlock.querySelector('[data-reference-value]');
  // Only ever render a plain UUID, never arbitrary text from the query string.
  if (reference && slot && /^[0-9a-f-]{8,36}$/i.test(reference)) {
    slot.textContent = reference.slice(0, 8).toUpperCase();
    referenceBlock.classList.remove('hidden');
  }
}
