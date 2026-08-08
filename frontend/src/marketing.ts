import './marketing.css';

/**
 * Behaviour for the public marketing pages. Deliberately tiny and dependency
 * free: these pages must not pull in the application bundle.
 *
 * Everything here is progressive. The pages are fully readable and the form is
 * still usable if this script never runs.
 */

/** Enquiries fall back to this address whenever the API cannot be reached. */
const CONTACT_EMAIL = 'hello@blackswansimulations.com';

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// Unlocks the scroll-reveal CSS. Kept here rather than in the stylesheet so a
// blocked or failed script leaves every section visible instead of blank.
document.documentElement.classList.add('js');

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

      form.classList.add('hidden');
      successPanel?.classList.remove('hidden');
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
