# Disclosure and Security Checklist (PRIVATE)

Run before sending anything to the client. Status reflects the review done for this pack.

## 1. Client-facing PDF (`Prophyion_AI_Agents_Case_Study.pdf`)

| Check                                                                                   | Result                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exactly 3 pages                                                                         | Pass (PyMuPDF page count = 3; each page checked for overflow in the HTML before export)                                                                                                          |
| Title, subtitle and closing statement match the brief verbatim                          | Pass (closing statement string-matched in the extracted PDF text)                                                                                                                                |
| No source code, file paths, or code excerpts                                            | Pass. The text contains no `.ts`/`.tsx` paths. Table names (`stakeholder_conversations`) and a few function names (`pickResponders`) appear as terminology only                                  |
| No API keys, tokens or URLs with credentials                                            | Pass (pattern scan for `sk-` and JWT prefixes found nothing)                                                                                                                                     |
| No client, enterprise or government names; no real people                               | Pass. Scenario is a fictional dairy recall. Names used: Northgate Dairy Co-op, Mara Vance, Tomasz Kowal, Dr Ines Okafor, Freshfield Foods, Cllr Dan Reyes, Grace Lim, Jordan Ellis. All invented |
| Real incident from `docs/session-bugfix-spec-2026-09-20.md` anonymised                  | Pass. Only a generic "NPCs wrote Hi [Name]" line; no run, client or person named                                                                                                                 |
| Proposed features clearly separated                                                     | Pass. Page 3 uses A/B columns, dashed "Proposed" styling and footer note                                                                                                                         |
| No claim of negotiation games, five-lesson coaching or competitive scoring in Prophyion | Pass. The PDF says explicitly "No coaching-lesson model exists" and "Not in Prophyion"                                                                                                           |
| Partial / experimental labelled                                                         | Pass (AI teammates = Experimental; five rows on page 3 = Partial)                                                                                                                                |
| Sentiment not described as validated                                                    | Pass. "A training metric, not validated public-opinion measurement"                                                                                                                              |
| No claim of autonomous turn-taking                                                      | Pass. Stated as server-orchestrated                                                                                                                                                              |
| Page 2 diagram and terms match the repo                                                 | Pass: stakeholder, persona, `stakeholder_conversations`, social state, inject orchestration                                                                                                      |
| PDF metadata                                                                            | Creator is HeadlessChrome; author empty. Consider setting your name if you want one                                                                                                              |
| Fonts / legibility                                                                      | Smallest text is 6.2 pt (diagram labels and screenshot captions); body 7.3 to 8.6 pt                                                                                                             |

## 2. Screenshots (`screenshots/`)

| Check                                   | Result                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine UI                              | Yes: unmodified Prophyion frontend                                                                                                                                                                |
| Genuine data                            | **No.** All data is synthetic fixtures served by a local stub (`_build/stub-server.mjs`). No live backend or LLM. Captions in the PDF say so. Do not describe them as "live" or "production data" |
| Source code, keys, tokens visible       | No. Visible text is UI only                                                                                                                                                                       |
| Real names, emails, org data            | None. Email in S2 is `mara.vance@harbourledger.sim` (fictional, `.sim` TLD)                                                                                                                       |
| Browser chrome / URL bar / localStorage | Not in frame (page screenshots, no browser UI)                                                                                                                                                    |
| Memory UI                               | None exists. No screenshot of `stakeholder_conversations` was fabricated                                                                                                                          |

## 3. Repository hygiene

| Check                                | Result                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| No app code or config changed        | Pass. `git status` shows only the new `portfolio/` folder                                                   |
| No `.env` or secrets committed       | Pass. Only dummy values (`local-stub-anon-key`, an unsigned dummy JWT built at runtime) appear in `_build/` |
| `node_modules`                       | A symlink in `_build/` was removed before commit; `node_modules` is git-ignored                             |
| No deploy / publish                  | Nothing deployed, no external uploads. Work is on a branch and a draft PR for you to review                 |
| No production data or paid LLM calls | None                                                                                                        |

## 4. Things you must confirm before sending

1. **Role claim.** The PDF says "CTO and technical lead". The repo shows one dominant commit
   author (996 of about 1,006 commits) plus a few others. I cannot verify who that is. Confirm
   the wording, and whether you are comfortable if the client reads the git history.
2. **Permission to show the product.** Confirm Prophyion (formerly Black Swan Simulations)
   branding and UI may be shown publicly, and that no NDA covers the UI.
3. **Tests.** The "283 tests, all passing" figure comes from a run with placeholder env vars.
   Re-run on your machine if you want to quote it. The PDF does not claim the agent guards are
   tested.
4. **Counts.** "231 migrations" and the "30 s tick" are read from the repo, not from production.
5. **Model names.** Not in the PDF. If asked, say defaults are in code and production
   configuration is separate.
6. **Wording on page 1:** "AI teammates ... feature-flagged participants (Experimental)".
   They are off in production unless `ENABLE_TEAMMATE_BOTS=true`. Keep that label.
7. **Bug-fix line (page 2).** It paraphrases a real fix. If you prefer, delete that sentence;
   the page still fits.

## 5. Private files: do not send

- `Source_Evidence_Review.md`
- `Feature_Implementation_Matrix.md`
- this checklist
- `_build/` (stub server, fixtures, harness)

Send only the PDF, optionally with the PNGs in `screenshots/` if you want to share full-size
images (each is a fixture capture and should be described as such).
