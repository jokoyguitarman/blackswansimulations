# Domain split: prophyion.com and simulations.prophyion.com

The repo now holds two independently deployable front ends:

| Directory    | Deploys to                  | What it is                                       |
| ------------ | --------------------------- | ------------------------------------------------ |
| `marketing/` | `prophyion.com`             | Static marketing pages. No React, no app bundle. |
| `frontend/`  | `simulations.prophyion.com` | The simulation app: login, dashboards, war room. |

`prophyion.com` is canonical; `www` redirects to it. Each directory has its own
`vercel.json`, which is why each Vercel project must set its **Root Directory** —
Vercel reads that file relative to the root directory, not the repo root.

The old repo-root `vercel.json` has been deleted. If a project is left pointing at
the repo root it will build nothing useful.

---

## 1. Cloudflare — add the app subdomain

DNS for prophyion.com is on Cloudflare. Add one record:

| Type  | Name          | Target                 | Proxy        |
| ----- | ------------- | ---------------------- | ------------ |
| CNAME | `simulations` | `cname.vercel-dns.com` | **DNS only** |

Set the proxy to **DNS only** (grey cloud, not orange). Leaving Cloudflare's proxy
on in front of Vercel double-proxies the request, and breaks Vercel's automatic
certificate issuance.

Vercel shows the exact target when you add the domain in step 3, so use whatever
it displays if it differs.

Nothing else in Cloudflare changes. The apex A records, MX, SPF and DKIM all stay
as they are.

---

## 2. Vercel — reconfigure the existing project as the app

The existing project currently serves both. It becomes the app only.

1. **Settings → General → Root Directory**: set to `frontend`.
2. **Settings → General → Build & Development Settings**: leave as the framework
   default. `frontend/vercel.json` now supplies the build command and output
   directory.
3. **Settings → Domains**:
   - Add `simulations.prophyion.com` and make it the primary domain.
   - Remove `prophyion.com` and `www.prophyion.com` from this project. They move
     to the marketing project in step 3, and Vercel will not let two projects
     claim the same domain.
4. **Settings → Environment Variables**: confirm `VITE_API_URL` still points at
   the Render backend.
5. Redeploy.

---

## 3. Vercel — create the marketing project

1. **Add New → Project**, import the same repository.
2. **Root Directory**: `marketing`.
3. Framework preset: Vite. Build command and output directory come from
   `marketing/vercel.json`.
4. **Environment Variables**: add `VITE_API_URL` with the same Render backend URL.
   The enquiry form posts to it, and without this the form will post to
   `prophyion.com/api/contact`, which does not exist.
5. **Settings → Domains**:
   - Add `prophyion.com` and set it as primary.
   - Add `www.prophyion.com` and set it to **redirect to** `prophyion.com`.
6. Deploy.

---

## 4. Render — backend environment variables

The marketing site is now a different origin from the app, so the enquiry form
posts cross-origin and CORS has to allow it.

| Variable          | Value                               | Why                                                             |
| ----------------- | ----------------------------------- | --------------------------------------------------------------- |
| `MARKETING_URL`   | `https://prophyion.com`             | Allows the enquiry form through CORS. Without it the form 403s. |
| `CLIENT_URL`      | `https://simulations.prophyion.com` | Invitation and session emails build their links from this.      |
| `SMTP_USER`       | `kenneth@prophyion.com`             | Must match `EMAIL_FROM` or Gmail rewrites the sender.           |
| `SMTP_PASS`       | Google App Password                 | Generated at myaccount.google.com/apppasswords.                 |
| `EMAIL_FROM`      | `kenneth@prophyion.com`             | Already the code default.                                       |
| `EMAIL_FROM_NAME` | `Prophyion`                         | Already the code default.                                       |

Render redeploys on environment variable change. Confirm it comes back up,
otherwise `/api/contact` will not exist and the enquiry form falls back to its
"email us instead" message.

---

## 5. Optional but worth doing: DMARC

prophyion.com has SPF and DKIM but no DMARC, so the domain can be spoofed and
some recipients filter harder on domains without a policy. Add a Cloudflare TXT
record:

| Type | Name     | Content                                              |
| ---- | -------- | ---------------------------------------------------- |
| TXT  | `_dmarc` | `v=DMARC1; p=none; rua=mailto:kenneth@prophyion.com` |

`p=none` only monitors and changes nothing about delivery. Tighten to
`p=quarantine` after a few weeks of reports.

---

## 6. Verify

```
https://prophyion.com/                     -> marketing home, 200
https://www.prophyion.com/                 -> 301 to https://prophyion.com/
https://prophyion.com/consultants          -> consultants page, 200
https://prophyion.com/corporate-crisis     -> corporate crisis page, 200
https://prophyion.com/founder              -> founder page, 200
https://prophyion.com/thank-you            -> confirmation page, 200, noindex
https://prophyion.com/simulations          -> 301 to https://prophyion.com/
https://prophyion.com/simulations/founder  -> 301 to https://prophyion.com/founder
https://prophyion.com/login                -> 307 to simulations.prophyion.com/login
https://simulations.prophyion.com/login    -> app login screen
https://simulations.prophyion.com/simulations -> 301 to prophyion.com/
```

Then submit the enquiry form on the live site. Expect a redirect to
`/thank-you?ref=...`, a notification to kenneth@prophyion.com, a confirmation to
the address submitted, and a row in the `enquiries` table with both `notified_at`
and `acknowledged_at` set.

---

## Why the old URLs still work

Every `/simulations/*` path is 301-redirected to its new home, from both projects.
Anything already shared or indexed keeps working and passes its ranking signal to
the new URL. Bookmarked app routes (`/login`, `/signup`, `/dashboard/*`) hit the
marketing project and are forwarded to the app subdomain with a temporary
redirect, since those are not canonical content.

---

## Why each project has an `ignoreCommand`

Both projects watch the same branch, so by default a change to either one would
rebuild both. The `ignoreCommand` in each `vercel.json` skips the build when
nothing relevant changed. Exit code 0 skips, non-zero builds.

| Project                | Command                                      | Watches                   |
| ---------------------- | -------------------------------------------- | ------------------------- |
| `prophyion-web`        | `git diff --quiet HEAD^ HEAD -- .`           | `marketing/`              |
| `blackswansimulations` | `git diff --quiet HEAD^ HEAD -- . ../shared` | `frontend/` and `shared/` |

The app also watches `shared/` because `frontend/src` imports from
`@shared/{types,countries,roleVisibility}`. Without it, a shared-types change
would ship a stale app.

If `HEAD^` is unavailable the command errors rather than returning 0, so the
build proceeds. That is the safe direction: a redundant build costs a minute, a
skipped one ships nothing.

**Do not add explanatory `"//key"` entries to `vercel.json`.** Its schema sets
`additionalProperties: false`, so an unrecognised top-level key fails the
deployment immediately with a 0ms build and no logs. That is why this rationale
lives here instead.
