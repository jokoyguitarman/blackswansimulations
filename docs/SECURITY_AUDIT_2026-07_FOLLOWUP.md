# Security Audit — Follow-up (Remaining Vulnerabilities)

**Date:** 2026-07-12
**Baseline:** `docs/SECURITY_AUDIT_2026-06.md` (initial audit)
**Scope of this pass:** Verify which of the June findings were closed by the security patches that shipped since, then re-scan the current `master` — including the **new** code (Stripe billing portal, warroom document blueprint, self-service trainer signup) — for anything still open.

## What changed since the last audit

Three security commits landed on `master`:

- `0988e8d` — closed the **privilege-escalation chain** in role assignment (migration 189: `handle_new_user` defaults to `participant`, elevated roles only from the server-side `session_invitations` table, `BEFORE UPDATE` trigger blocks role/agency changes via the anon key; `PATCH /api/profile` rejects role/agency from non-admins; signup role picker removed; `AuthContext` resolves the authoritative role from the server).
- `87ac885` — bumped vulnerable **frontend** deps (`react-router-dom`, `socket.io-client`), added front-end route guards for `/debug/*` and trainer views, added CSP `report-only` + `X-Content-Type-Options` + `Referrer-Policy`, moved `WindIndicator` off `innerHTML`, gated dev console logs, added `noopener,noreferrer` to AAR export.
- `c8b845b` — introduced a shared authorization library `server/lib/access.ts` (`assertSessionAccess` / `assertSessionOwner` / `assertTeamMembership` / `assertControlsOrgPage` / `assertScenarioOwner`) and applied it across channels, incidents, sessions, demo, decisions, placements, casualties, locations, scenarios; closed the `socialMessenger` PostgREST `.or()` injection; staff-gated the debug router; hardened the `SESSION_SECRET` dev fallback on deploy platforms; disabled demo-bot password login (migration 190).

These are real improvements and close several of the earlier findings (see the status table). This report focuses on **what is still open**.

---

## Status of the June findings

| ID  | June severity | Finding                                                     | Status now            |
| --- | ------------- | ----------------------------------------------------------- | --------------------- |
| C1  | Critical      | Voice recordings/transcripts IDOR (`GET /voice/calls/:id`)  | **STILL OPEN**        |
| H1  | High          | Objectives update IDOR (`POST /objectives/.../update`)      | **STILL OPEN**        |
| H2  | High          | Channel messages IDOR (non-DM channels)                     | **Fixed** (`c8b845b`) |
| H3  | High          | Voice upload: header-controlled path + no membership check  | **STILL OPEN**        |
| H4  | High          | Vulnerable dependencies                                     | **Partly fixed**      |
| M1  | Medium        | Express error handler wrong arity → leaks stack             | **STILL OPEN**        |
| M2  | Medium        | Debug AI endpoints open to any authenticated user           | **Fixed** (`c8b845b`) |
| M3  | Medium        | Invitation token logged unredacted                          | **STILL OPEN**        |
| M4  | Medium        | Internal DB error messages returned to clients              | **STILL OPEN**        |
| M5  | Medium        | Rate-limit key from unverified JWT                          | **STILL OPEN**        |
| M6  | Medium        | AI scenario generation prompt-injection hardening           | **Open (mitigated)**  |
| L1  | Low           | Unauthenticated open tile proxy                             | **STILL OPEN**        |
| L2  | Low           | Invitation lookup not rate-limited                          | **STILL OPEN**        |
| L3  | Low           | CORS allowlist hardcodes localhost                          | **STILL OPEN**        |
| L4  | Low           | Unused `SESSION_SECRET` default fallback                    | **Mostly addressed**  |
| L5  | Low           | Frontend `dangerouslySetInnerHTML`                          | **Partly addressed**  |
| —   | —             | Privilege-escalation via self-selected role (found in `0988e8d`) | **Fixed**        |

---

## Remaining vulnerabilities

### C1 — Voice recordings & transcripts still readable by any authenticated user (IDOR) — CRITICAL

Not fixed. `GET /api/voice/calls/:sessionId` still returns every call, recording storage path, and transcript for the session with no ownership/participant check. The `access.ts` guards exist now but were **not** applied to this route.

```206:214:server/routes/voice.ts
router.get('/calls/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: calls, error } = await supabaseAdmin
      .from('voice_calls')
      .select('*, voice_recordings(*)')
      .eq('session_id', sessionId)
      .order('started_at', { ascending: false });
```

**Fix:** add `const access = await assertSessionAccess(sessionId, user); if (!access.ok) return res.status(access.status).json({ error: access.error });` before the query — the same helper already used in `channels.ts`.

### H3 — Voice upload trusts `x-session-id` / `x-call-id` headers with no validation or membership check — HIGH

Not fixed. Any authenticated user can still write recordings and insert `voice_recordings` rows for arbitrary sessions, and the header values are interpolated straight into the storage object path (path traversal within the bucket).

```23:36:server/routes/voice.ts
      const callId = req.headers['x-call-id'] as string | undefined;
      const sessionId = req.headers['x-session-id'] as string | undefined;
      if (!callId || !sessionId) {
        return res.status(400).json({ error: 'Missing x-call-id or x-session-id header' });
      }

      const userId = req.user!.id;
      const contentType = req.headers['content-type'] || 'audio/webm';
      const ext = contentType.includes('wav') ? 'wav' : ...;
      const storagePath = `voice/${sessionId}/${callId}/${userId}.${ext}`;
```

**Fix:** UUID-validate both IDs, verify the caller is a member of the session (`assertSessionAccess`), and confirm the `callId` belongs to that session before uploading. (See the June report's H3 before/after for the full snippet.)

### H1 — Objectives update IDOR — HIGH

Not fixed. `POST /api/objectives/session/:sessionId/update` checks the caller is a trainer/admin but never verifies they **own** the session, so any trainer can rewrite another trainer's objective scores. The sibling GET routes in the same file do check ownership.

```121:135:server/routes/objectives.ts
router.post('/session/:sessionId/update', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { objective_id, progress_percentage, status, metrics, objective_name } = req.body;
    const user = req.user!;

    // Only trainers can manually update objectives
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can update objectives' });
    }
    // ... no ownership check ...
```

**Fix:** `const access = await assertSessionOwner(sessionId, user); if (!access.ok) return res.status(access.status).json({ error: access.error });`

### H4 — Backend dependencies still vulnerable — HIGH (backend), frontend clear

The frontend is now clean (`npm audit` → 0 vulnerabilities). The **root/back-end** package still ships vulnerable versions:

| Package      | Severity | Note                                                                                          |
| ------------ | -------- | --------------------------------------------------------------------------------------------- |
| `nodemailer` | **High** | Still `^7.0.10`. Advisory count has *grown* since June (SMTP command injection, CRLF header injection, jsonTransport file-access bypass, OAuth2 TLS validation, raw-message SSRF/file-read). Used at runtime by the email service. |
| `uuid`       | Moderate | Pulled transitively via `exceljs` (`>=3.5.0`); missing buffer bounds check in v3/v5/v6.        |

`concurrently` / `shell-quote` from the June report is resolved.

**Fix:** bump `nodemailer` to `^9.0.3` (breaking — review `server/services/emailService.ts` against the v9 transport API) and run `npm audit fix`. Consider committing a `package-lock.json` (still gitignored) so backend audits run in CI.

### M1 — Express error handler still declared with 3 params — MEDIUM

Not fixed. Express only treats middleware with **arity 4** as an error handler; with three params this never runs, so thrown errors fall through to the default finalhandler, which returns the full stack trace outside production.

```234:245:server/index.ts
// Error handler - sanitize errors for production
app.use((err: unknown, _req: express.Request, res: express.Response) => {
  const error = err as Error;

  // Log full error server-side
  logger.error({ error: error.message, stack: error.stack }, 'Request error');

  // Send sanitized error to client
  res.status(500).json({
    error: env.nodeEnv === 'production' ? 'Internal Server Error' : error.message,
  });
});
```

**Fix:** add the fourth `_next: express.NextFunction` parameter.

### M3 — Invitation token still logged unredacted — MEDIUM

Not fixed on either side: the route still logs the raw token, and the logger redaction list still only has `*.token` (which does not match a top-level `token` key).

```40:43:server/routes/invitations.ts
    if (error || !invitation) {
      logger.warn({ error, token }, 'Invitation not found or invalid');
      return res.status(404).json({ error: 'Invitation not found or expired' });
    }
```

```29:37:server/lib/logger.ts
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.secret',
    ],
```

**Fix:** stop logging the token (log a hash or nothing) and add `'token'` to the redaction paths.

### M4 — Internal DB error messages still returned to clients — MEDIUM

Not fixed. `details: error.message` (raw Supabase/Postgres text) is still returned from multiple handlers, leaking schema/constraint hints. Current occurrences:

- `server/routes/channels.ts` — lines 148, 177, 208, 514, 520, 578, 620, 779
- `server/routes/sessions.ts` — line 155
- `server/routes/injects.ts` — lines 808, 936, 943, 961

**Fix:** log details server-side; return a generic message (optionally include `details` only when `env.nodeEnv !== 'production'`).

### M5 — Rate-limit key derived from an unverified JWT — MEDIUM

Not fixed. The global limiter still `jwt.decode`s (no signature check) to derive the `user:<sub>` bucket, so an attacker can forge `sub` values to evade IP limits or exhaust a victim's bucket.

```133:153:server/index.ts
  keyGenerator: (req) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const [, token] = authHeader.split(' ');
        if (token) {
          const decoded = jwt.decode(token) as { sub?: string } | null;
          if (decoded?.sub) {
            return `user:${decoded.sub}`;
          }
        }
      }
    } catch { ... }
```

**Fix:** key the global limiter by IP only; do per-user limiting in a limiter mounted after `requireAuth` where `req.user.id` is trustworthy.

### M6 — AI prompt-injection hardening — MEDIUM (mitigated, not closed)

Unchanged in code, but exposure is now lower because the AI/warroom flows are staff- and **credit**-gated. User-supplied `context`/`specific_requirements` (and now uploaded document text in the warroom blueprint flow) are still passed to the model without explicit prompt boundaries. Keep the gating and add clear system-prompt delimiters; continue to schema-validate model output.

### L1 — Unauthenticated open tile proxy — LOW

Not fixed. `GET /api/tiles/:z/:x/:y.png` is still unauthenticated and interpolates raw params into the outbound fetch URL (host is fixed to OSM, so it's a bandwidth-amplification/open-relay concern rather than SSRF). Add `requireAuth`, validate `z/x/y` as bounded integers.

### L2 — Invitation lookup not rate-limited — LOW

Not fixed. `GET /api/invitations/:token` is public but only covered by the general API limiter. Add the strict `joinLimiter` to `/api/invitations` to slow token enumeration.

### L3 — CORS allowlist hardcodes localhost — LOW

Not fixed (a `localhost:4173` entry was even added). Drive the allowlist from env in production so localhost origins are not accepted there.

```91:98:server/index.ts
const allowedOrigins = [
  env.clientUrl,
  'http://localhost:3000',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3005',
  'http://localhost:4173',
];
```

### L4 — `SESSION_SECRET` default — LOW (mostly addressed)

`resolveSessionSecret()` now refuses to boot with the dev default when `VERCEL`/`RENDER` is set, which covers the main deploy targets. Residual: the value is still unused anywhere in code, and a non-`production`, non-Vercel/Render host could still boot with the dev default. Remove the unused config or fail closed whenever `NODE_ENV !== 'development'`.

### L5 — `dangerouslySetInnerHTML` — LOW (partly addressed)

`WindIndicator` was moved to `textContent`. Other components (`MapElementResponsePanel`, `AssetPalette`, `EvacuationZone`, `ScenarioDetailView`) still use `dangerouslySetInnerHTML`, but only with build-time SVG/emoji/icon strings, so current risk is minimal. Keep user/AI content out of these sinks.

---

## New findings in code added since June

### N1 — Payout release has no idempotency guard → potential double transfer — MEDIUM

`POST /api/billing/payouts/:id/release` reads the payout, checks `status === 'pending_release'`, calls `createTransfer()` (Stripe), then updates the row to `released`. There is no row lock/transaction and no Stripe idempotency key, so two concurrent admin releases (or a retried request) can both pass the status check and issue **two** Stripe transfers for the same payout.

```576:618:server/routes/billing.ts
      const { data: payout } = await supabaseAdmin
        .from('payouts')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!payout) return res.status(404).json({ error: 'Payout not found' });
      if (payout.status !== 'pending_release') {
        return res
          .status(409)
          .json({ error: `Payout is '${payout.status}', only pending_release can be released` });
      }
      // ... no lock; transfer issued below ...
      transferId = await createTransfer({ accountId: ..., amountCents: payout.amount_cents, ... });
```

**Impact:** real money; admin-only and low likelihood, but the blast radius is a duplicate payout.
**Fix:** (a) pass a deterministic Stripe idempotency key (e.g. `payout.id`) to `stripe.transfers.create`, and/or (b) do a conditional status flip first — `UPDATE payouts SET status='releasing' WHERE id=? AND status='pending_release'` and only proceed if a row was affected. The webhook path is already idempotent; this closes the release path too.

> The rest of the billing surface is solid: the Stripe webhook verifies the signature over the raw body (mounted before `express.json()`), dedupes on `event_id`, ignores unknown invoices, and won't unwind an already-paid invoice. Invoice/org/payout ownership is checked in code, and admin money endpoints re-check `role === 'admin'` per call.

### N2 — Warroom document upload is not staff-gated — LOW

`POST /api/warroom/social-crisis/upload-document` runs behind `requireAuth` only (no `requireStaff`). Any authenticated user (including anonymous join participants) can submit files that are parsed server-side by `pdf-parse` / `mammoth`. The 10 MB multer limit caps size, but complex documents still consume CPU/memory, and the extracted text later feeds AI blueprint extraction (prompt-injection surface — though `extract-blueprint` itself is credit-gated).

```857:888:server/routes/socialCrisisWarroom.ts
router.post(
  '/upload-document',
  requireAuth,
  upload.single('file'),
  async (req: AuthenticatedRequest, res) => {
    ...
      if (ext === 'pdf' || file.mimetype === 'application/pdf') {
        const pdfParseModule = await import('pdf-parse');
        ...
      } else if (ext === 'docx' || ...) {
        const mammoth = await import('mammoth');
```

**Fix:** add `requireStaff` (parsing/blueprint building is a trainer activity), and keep the size/type limits.

---

## Suggested remediation order

1. **C1** — apply `assertSessionAccess` to `GET /voice/calls/:sessionId` (one-line fix, critical exposure).
2. **H1, H3** — apply `assertSessionOwner`/`assertSessionAccess` + UUID validation to the two remaining voice/objectives routes (the guard library already exists — this is just wiring it in).
3. **M1** — fix the error-handler arity.
4. **N1** — add a Stripe idempotency key / conditional status flip on payout release.
5. **H4** — upgrade `nodemailer` (and `uuid`/`exceljs`); commit a backend lockfile.
6. **M3, M4, M5** — stop leaking tokens/DB errors; harden the rate-limit key.
7. **N2, M6, L1–L5** — defense-in-depth.

## Positive controls added since June

- `server/lib/access.ts` result-returning guards, applied broadly (channels, incidents, sessions, demo, decisions, placements, casualties, locations, scenarios).
- Privilege-escalation chain closed at DB + API + client layers (migrations 189/190, profile PATCH, signup, AuthContext).
- `socialMessenger` PostgREST `.or()` injection closed via handle denylisting.
- `requireStaff` middleware; debug router staff-gated; front-end `/debug` and trainer routes role-gated.
- Frontend dependency advisories cleared; CSP report-only + `X-Content-Type-Options` + `Referrer-Policy` added.
- Stripe billing built with verified + idempotent webhooks and in-code ownership checks.
