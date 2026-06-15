# Security Audit Report — Black Swan Simulator

**Date:** 2026-06-15
**Scope:** Backend API (`server/`, `api/`), shared code (`shared/`), frontend (`frontend/src/`), dependencies, secrets handling, and configuration.
**Method:** Manual source review of authentication/authorization, input handling, injection/SSRF/path-traversal surfaces, file uploads, logging, secrets, and CORS/headers, plus dependency analysis (`npm audit`).

This report supersedes and expands `SECURITY_THREATS_SUMMARY.md`. Previously documented findings were re-verified; several were confirmed, one (H1) was downgraded, and several **new** findings were added (notably the voice-recordings IDOR and the broken Express error handler).

---

## Severity Summary

| #   | Severity     | Finding                                                                 | Location                                              |
| --- | ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | **Critical** | Voice recordings/transcripts IDOR — no access control                   | `server/routes/voice.ts` (`GET /calls/:sessionId`)    |
| H1  | **High**     | Objectives update IDOR — any trainer can edit any session's objectives  | `server/routes/objectives.ts` (`POST .../update`)     |
| H2  | **High**     | Channel messages IDOR — non-DM channels skip membership check           | `server/routes/channels.ts` (`GET /:channelId/messages`) |
| H3  | **High**     | Voice upload: unvalidated session/call from headers → path injection + no membership check | `server/routes/voice.ts` (`POST /upload`) |
| H4  | **High**     | Vulnerable dependencies (nodemailer SMTP injection, shell-quote, uuid)  | `package.json`                                        |
| M1  | **Medium**   | Express error handler has wrong arity → never runs; default handler leaks stack in non-prod | `server/index.ts` (~227)               |
| M2  | **Medium**   | Debug AI endpoints open to any authenticated user → cost/DoS abuse      | `server/routes/debug.ts`                              |
| M3  | **Medium**   | Invitation token logged unredacted (redaction pattern gap)              | `server/routes/invitations.ts`, `server/lib/logger.ts` |
| M4  | **Medium**   | Internal DB error messages returned to clients (`details: error.message`) | `server/routes/channels.ts` and others              |
| M5  | **Medium**   | Rate-limit key derived from **unverified** JWT `sub`                    | `server/index.ts` (~130)                              |
| M6  | **Medium**   | AI scenario generation: no prompt-injection hardening                   | `server/routes/ai.ts`, `server/services/aiService.ts` |
| L1  | **Low**      | Unauthenticated open tile proxy with unvalidated params                 | `server/routes/tileProxy.ts`                          |
| L2  | **Low**      | Public invitation lookup not given a dedicated strict rate limit        | `server/index.ts`, `server/routes/invitations.ts`     |
| L3  | **Low**      | CORS allowlist hardcodes localhost ports                                | `server/index.ts` (~89)                               |
| L4  | **Low**      | Unused default `SESSION_SECRET` fallback (downgraded from prior H1)     | `server/env.ts` (~30)                                 |
| L5  | **Low**      | Frontend `dangerouslySetInnerHTML` usages (currently static SVG/icons)  | `frontend/src/components/COP/*`, `Scenario/*`         |

---

## Critical

### C1 — Voice recordings & transcripts readable by any authenticated user (IDOR)

`GET /api/voice/calls/:sessionId` returns all voice calls, recording storage paths, and transcripts for the given session, but performs **no ownership or participant check** — unlike the sibling `POST /transcribe-session/:sessionId` route which does verify `session.trainer_id === user.id`.

```206:225:server/routes/voice.ts
router.get('/calls/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: calls, error } = await supabaseAdmin
      .from('voice_calls')
      .select('*, voice_recordings(*)')
      .eq('session_id', sessionId)
      .order('started_at', { ascending: false });
```

**Impact:** Any authenticated user (including anonymous participants created via join links) can enumerate session IDs and read private voice transcripts of other exercises. This is a confidentiality breach of potentially sensitive recorded communications.

**Recommendation:** Load the session, then require `session.trainer_id === user.id`, `user.role === 'admin'`, or membership in `session_participants` before returning data — mirror the check already used in `transcribe-session` and the `media` routes.

---

## High

### H1 — Objectives update IDOR (confirmed)

`POST /api/objectives/session/:sessionId/update` requires the caller to be a `trainer`/`admin`, but never verifies the trainer **owns** the target session. Any trainer can modify objective progress/scores for any other trainer's session.

```121:140:server/routes/objectives.ts
router.post('/session/:sessionId/update', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { objective_id, progress_percentage, status, metrics, objective_name } = req.body;
    const user = req.user!;

    // Only trainers can manually update objectives
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can update objectives' });
    }
    // ... no session.trainer_id === user.id check ...
    await updateObjectiveProgress(sessionId, objective_id, progress_percentage, { ... });
```

The sibling GET routes in the same file *do* perform the ownership check, so this is an inconsistency rather than a design intent.

**Recommendation:** Add the same session-ownership check used by `GET /session/:sessionId` before calling `updateObjectiveProgress`.

### H2 — Channel messages IDOR for non-DM channels (confirmed)

`GET /api/channels/:channelId/messages` only enforces membership for `type === 'direct'` channels. For `private` / `role_specific` / standard channels, the access branch is empty, so messages are returned to any authenticated user who supplies a channel ID.

```586:604:server/routes/channels.ts
      // Check access based on channel type
      if (channel.type === 'direct') {
        // For direct messages, verify user is a member
        const members = (channel.members as string[]) || [];
        if (!Array.isArray(members) || !members.includes(user.id)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else if (channel.type === 'private' || channel.type === 'role_specific') {
        // Additional access checks needed
      }
```

**Impact:** Cross-session chat disclosure. The WebSocket `join_channel` handler has the same weakness (only checks `role_specific` against the user's role, never session membership).

**Recommendation:** For all non-DM channels, verify the user is the session trainer/admin or a participant of `channel.session_id` (and apply `role_filter` where relevant) before returning messages or joining the room.

### H3 — Voice upload: header-controlled path + missing membership check

`POST /api/voice/upload` builds the storage path from `x-session-id` and `x-call-id` request headers with no validation and no check that the caller belongs to the session:

```23:40:server/routes/voice.ts
      const callId = req.headers['x-call-id'] as string | undefined;
      const sessionId = req.headers['x-session-id'] as string | undefined;
      if (!callId || !sessionId) {
        return res.status(400).json({ error: 'Missing x-call-id or x-session-id header' });
      }

      const userId = req.user!.id;
      const contentType = req.headers['content-type'] || 'audio/webm';
      const ext = contentType.includes('wav') ? 'wav' : ...;
      const storagePath = `voice/${sessionId}/${callId}/${userId}.${ext}`;
      // upload to 'voice-recordings' bucket at storagePath
```

**Impact:**
- Any authenticated user can write recordings and insert `voice_recordings` rows for arbitrary sessions (data pollution / spoofing of who spoke).
- `sessionId`/`callId` are interpolated into the storage object path. Values containing `../` or extra path segments can place objects at unexpected locations within the bucket (path traversal within the storage namespace).

**Recommendation:** Validate `sessionId`/`callId` as UUIDs, verify the user is a participant/trainer of the session, and confirm the `callId` belongs to that session before uploading.

### H4 — Vulnerable dependencies

`npm audit` reports the following (run after generating a lockfile):

| Package      | Severity | Issue                                                                                   | Path                          |
| ------------ | -------- | --------------------------------------------------------------------------------------- | ----------------------------- |
| `nodemailer` | Moderate | SMTP command injection via `envelope.size` and CRLF in transport name (GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g) | runtime dependency (email sending) |
| `shell-quote`| Critical | `quote()` does not escape newlines in object `.op` values (GHSA-w7jw-789q-3m8p)          | via `concurrently` (dev only) |
| `uuid`       | Moderate | Missing buffer bounds check in v3/v5/v6 (GHSA-w5hq-g745-h8pq)                            | via `exceljs`                 |

`nodemailer` is the most relevant since it is used at runtime by the email service; the others are transitive (and `shell-quote` is dev-only via `concurrently`).

**Recommendation:** Upgrade `nodemailer` to a patched release (≥ 9.0.0; review for breaking changes in the email service). Upgrade `concurrently`/`exceljs` to pull patched `shell-quote`/`uuid`, or run `npm audit fix`. Commit a `package-lock.json` so `npm audit` is reproducible (it is currently gitignored, which prevents lockfile-based auditing in CI).

---

## Medium

### M1 — Express error handler is registered as ordinary middleware (wrong arity)

The final error handler declares only three parameters. Express identifies error-handling middleware by **arity of 4** (`err, req, res, next`); with three params it is treated as a normal middleware and the `err`/`res` positions are mis-bound, so it never runs as intended.

```227:237:server/index.ts
app.use((err: unknown, _req: express.Request, res: express.Response) => {
  const error = err as Error;
  logger.error({ error: error.message, stack: error.stack }, 'Request error');
  res.status(500).json({
    error: env.nodeEnv === 'production' ? 'Internal Server Error' : error.message,
  });
});
```

**Impact:** Thrown/`next(err)` errors fall through to Express's built-in `finalhandler`, which in non-production returns the **full stack trace** in the HTTP response (information disclosure). The intended sanitization/centralized logging never executes.

**Recommendation:** Add the fourth `next` parameter: `app.use((err, req, res, next) => { ... })` so Express registers it as an error handler.

### M2 — Debug AI endpoints accessible to any authenticated user

The `/api/debug/*` routes (`rts-assess`, `rts-casualty-image`, `rts-victim-image`, `rts-triage-assess`, `rts-enrich-scene`, `rts-fire-params`, `enhance-building`, `building-studs`) require only `requireAuth` — there is no trainer/admin restriction. Several call OpenAI/DAL-E with user-supplied prompts/images.

**Impact:** Any logged-in user (incl. anonymous join participants) can drive paid OpenAI/DALL-E usage and external Overpass/Microsoft footprint queries, enabling cost-amplification and DoS. `building-studs`/`snap-test` also share a process-global cache (`lastGrids`) across all users.

**Recommendation:** Gate `/api/debug` behind trainer/admin role (or disable it entirely in production via `env.nodeEnv`), and avoid shared mutable module state for per-request data.

### M3 — Invitation token logged without redaction

The logger redaction paths use `*.token`, which matches `something.token` but **not** a top-level `token` key. The invitations route logs the raw token at top level:

```40:43:server/routes/invitations.ts
    if (error || !invitation) {
      logger.warn({ error, token }, 'Invitation not found or invalid');
      return res.status(404).json({ error: 'Invitation not found or expired' });
    }
```

```28:39:server/lib/logger.ts
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.secret',
    ],
    remove: true,
  },
```

**Impact:** Invitation tokens (used for signup/session access) land in logs in clear text, contradicting the assumption recorded in the previous summary.

**Recommendation:** Don't log raw tokens (log a short hash or just "present"), and/or add `token` (and `*.*.token`) to the redaction paths.

### M4 — Internal database error details returned to clients

Several handlers return Supabase/Postgres error text directly to the client, e.g. in `channels.ts`:

```577:579:server/routes/channels.ts
        return res
          .status(500)
          .json({ error: 'Failed to fetch channel', details: channelError.message });
```

**Impact:** Leaks schema/constraint/migration hints (one branch even tells the client to "run migration 017_add_direct_messaging.sql"), aiding attackers in mapping the data model.

**Recommendation:** Log details server-side; return a generic message to clients. Reserve verbose details for `env.nodeEnv !== 'production'`.

### M5 — Rate-limit key derived from unverified JWT

The global limiter decodes the JWT **without verifying its signature** to derive the per-user bucket key:

```130:150:server/index.ts
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

**Impact:** An attacker can forge an unsigned/garbage JWT with an arbitrary `sub` to (a) evade IP-based limiting by rotating `sub` values, or (b) deliberately exhaust a victim's `user:<sub>` bucket to deny them service. The token is only verified later by `requireAuth`, so the limiter itself trusts attacker-controlled input.

**Recommendation:** Only key by `sub` after authentication (e.g., apply the limiter after `requireAuth`, or fall back to IP and add a separate authenticated limiter), or verify the token before trusting `sub`.

### M6 — AI prompt-injection exposure (confirmed, low likelihood)

`POST /api/ai/scenarios/generate` forwards user-controlled `context` and `specific_requirements` (≤1000 chars each) into the OpenAI prompt. Access is restricted to trainers, which limits exposure, but there is no explicit prompt boundary/hardening.

**Recommendation:** Keep the trainer restriction; add clear system-prompt boundaries and treat model output as untrusted (it is already JSON-validated downstream — verify this remains true).

---

## Low

- **L1 — Open tile proxy:** `GET /api/tiles/:z/:x/:y.png` is unauthenticated and interpolates path params into an outbound `fetch` URL. The host is fixed to `*.tile.openstreetmap.org`, so SSRF is constrained, but it is an open, uncapped relay (bandwidth amplification) and params are not validated as integers. Consider requiring auth, validating `z/x/y` as bounded integers, and adding caching/rate limits.
- **L2 — Invitation lookup rate limiting:** `GET /api/invitations/:token` is public but only covered by the general API limiter; add a dedicated strict limiter (like `/api/join`) to slow token enumeration.
- **L3 — CORS allowlist:** `allowedOrigins` hardcodes several `localhost` ports alongside `env.clientUrl`. Drive the allowlist entirely from env in production so localhost origins are not accepted there.
- **L4 — Unused SESSION_SECRET default:** `env.sessionSecret` falls back to `'dev-secret-change-in-production'` outside production, but the value is not referenced anywhere in code (auth is delegated to Supabase). Lower risk than previously rated; remove the unused config or wire up a real use and fail-closed in production.
- **L5 — `dangerouslySetInnerHTML`:** All current uses inject build-time SVG/emoji/icon strings, not user data, so XSS risk is presently minimal. Keep user/AI-generated content out of these sinks; prefer `textContent` or a sanitizer if that ever changes.

---

## Positive Controls Observed

- JWT verified via Supabase in both `requireAuth` and the WebSocket handshake middleware.
- Most session-scoped routes (`media`, `decisions`, `injects`, `voice/transcribe-session`, objectives GETs, etc.) correctly check trainer ownership or participant membership.
- Helmet security headers (CSP enabled in production); CORS uses an origin allowlist with credentials.
- Body size limits (10 MB API, 1 KB join) and rate limiting (general + stricter `/api/join`).
- Zod validation on many inputs; join display names are character-restricted.
- Pino redacts `authorization`/`cookie`/`set-cookie`/`*.password`/`*.apiKey`/`*.secret` (see M3 for the `token` gap).
- No `.env`/secret files are tracked; `.gitignore` covers `.env*`, and no hardcoded API keys/secrets were found in source.
- No raw SQL string concatenation, `eval`, `new Function`, or `child_process` usage in application code (queries go through the Supabase client with parameter binding).

---

## Suggested Remediation Order

1. **C1, H1, H2, H3** — close the IDOR/authorization gaps (add session ownership/membership checks; validate header-derived IDs).
2. **M1** — fix the error-handler arity (small change, prevents stack-trace disclosure).
3. **H4** — upgrade `nodemailer` and run `npm audit fix`; commit a lockfile.
4. **M2–M5** — restrict debug routes, stop leaking DB errors/tokens, harden the rate-limit key.
5. **M6, L1–L5** — defense-in-depth hardening.
