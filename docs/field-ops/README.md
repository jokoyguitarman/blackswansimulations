# Field operations War Room: build specification set

**Status:** v1.2, 3 Nov 2026. Ready for review. Nothing in this set is built. **Added 3 Nov 2026:** the owner's new requirements (a doctrine library by country, stored physics, and a living, real-time strategy world with units, fog of war, weather and traffic) are recorded in the master plan as D29 to D36 and WS9. Every entry is marked **Added 3 Nov 2026**. On the same day, 02 and 06 were revised and WS9's spec (11) was written. Every other spec that another one asked for something carries the answer as a marked addition. Master 10.8 items 37 to 40 settle the contracts between them.
**Baseline verified against:** commit `a0fb07a` on `master` (8 Nov 2026). **Updated 8 Nov 2026:** that commit, the launch security fix, changed four cited files: `server/index.ts`, `server/lib/access.ts`, `server/routes/ai.ts` and `server/routes/scenarios.ts`. Their 134 citations were moved to their lines at `a0fb07a`. The statements about what `GET /api/scenarios`, `GET /api/scenarios/:id` and the browser read policies of `scenarios` and `rts_scene_configs` do were rewritten, each marked "Updated 8 Nov 2026". The same commit took migration 218, so every field-ops migration moved up by one (master section 9). At the time, task T0.23's build was uncommitted in the working tree and moved lines in `server/index.ts`, `server/env.ts`, `server/routes/sessions.ts` and four frontend files; the citations are re-checked once it is committed. Before this, the baseline was commit `588387f` (3 Nov 2026). On 3 Nov, 88 citations were moved from `7c16bde` to their lines at `588387f`, after the booth and teammate commits of 28 and 29 Oct. Before that, the baseline was commit `7c16bde` (25 Oct 2026, 17:31). The set was first written against commit `6d472e1` (3 Oct 2026) plus five files that were then uncommitted: `frontend/src/pages/WarRoom.tsx`, `frontend/src/lib/api.ts`, `frontend/src/design/warroom.css`, `frontend/src/hooks/useRoleVisibility.ts` and `server/routes/warroom.ts`. Those five were committed unchanged in `56d4035`. Commits `907bb66` (one suite nav and the new brand mark), `f268e3f` and `7c16bde` (the corporate wizard's organisation removals) changed cited files, so on 25 Oct every citation was moved to its line at `7c16bde`, and the suite nav became master 10.8 item 34.
**Narrative source:** `docs/field-ops-user-journey.html` (how field ops works today, 185 findings, and the plan in "Addendum · Document-driven setup").
**UI source:** `docs/design/warroom/field-ops-setup.html` (the mockup, four states).

## 1. What this set is

The journey document says **what** field ops should become and why. This set says **how to build it**, in documents precise enough to hand to a coding agent: exact migrations, API contracts, file maps, component states, LLM contracts, tests, flags, commit plans and acceptance criteria.

It is written in two formats from one source. The Markdown files are the source of truth. The HTML files next to them are generated and must not be edited by hand.

## 2. Reading order

| # | Document | Workstream | Depends on |
| --- | --- | --- | --- |
| 00 | `00-master-plan.md` | Decisions, flags, migrations, shared contracts, order of work | none |
| 01 | `01-prerequisites.md` | WS0: live map (13.1), durable and draft compile (7.1, 7.3, 7.5), draft validation (5.4) | 00 |
| 02 | `02-teams-and-doctrines.md` | WS1: archetypes, capabilities, doctrine library, matching | 00, 01 |
| 03 | `03-setup-screen.md` | WS2: document, footprint radar, blueprint, five lanes, readiness | 00, 01, 02, 04 |
| 04 | `04-site-picker.md` | WS3: saved map search, addresses, radius, buildings involved, draft handoff | 00, 01 |
| 05 | `05-layout-step.md` | WS4: Lay out the scene opens with the site | 00, 01, 04 |
| 06 | `06-compile-and-review.md` | WS5: compile honours the blueprint, draft state, review, publish | 00 to 05 |
| 07 | `07-device-and-physics.md` | WS6: device specifics, calculator, library, casualties | 00, 03, 05 |
| 08 | `08-people-or-ai.md` | WS7: AI-operated agencies, lobby, end of engine auto-play | 00, 01, 02, 06 |
| 09 | `09-after-publish.md` | WS8: editor, pressure runtime | 00, 06 |
| 10 | `10-ui-spec-sheet.md` | The mockup, element by element | 00 to 09 |
| 11 | `11-living-world.md` (**Added 3 Nov 2026**) | WS9: the living world (stored spread physics, live fire, smoke, structure, plumes and crowds, units and travel, fog of war, weather and traffic) | 00, 01, 04 to 08; softly 09 |

The numbering of workstreams (WS0 to WS9) is fixed in the master plan. The file numbers are only for ordering: files 01 to 09 are WS0 to WS8, 10 is the UI sheet and 11 is WS9.

## 3. How every spec is written

Every workstream spec (01 to 09, and 11) uses these sixteen sections, in this order, with these exact heading texts, so a reader can jump between specs:

1. `## 1. Purpose, goals and non-goals`
2. `## 2. Decisions and assumptions`
3. `## 3. Current state (verified)`
4. `## 4. Target behaviour and acceptance criteria`
5. `## 5. Data model`
6. `## 6. Server`
7. `## 7. Client`
8. `## 8. AI and LLM contracts`
9. `## 9. Security, privacy and safety`
10. `## 10. Flags, rollout and observability`
11. `## 11. Tests`
12. `## 12. Tasks`
13. `## 13. Commit plan and backtracking`
14. `## 14. File map`
15. `## 15. Risks and open questions`
16. `## 16. Definition of done`

A section that does not apply still appears, with one line saying why ("Not applicable: this workstream has no LLM calls."). The UI spec sheet (10) has its own structure, given in its header.

Directly under the title every spec carries a header block:

```
**Status:** v1, 24 Oct 2026. Not built.
**Workstream:** WS<n>
**Depends on:** <documents>
**Flags:** <names from the master plan>
**Migrations:** <numbers from the allocated range, or "none">
**Baseline:** verified against commit a0fb07a (8 Nov 2026); see the README.
```

## 4. Conventions

**Status tags.** Every factual statement about the current code is tagged or obviously verified:

- **Verified:** read in the code on the baseline, with a `path:line` citation.
- **Proposed:** the design we agreed, not yet built.
- **Assumed (D-number):** a default for a decision that is still open. The D-number points to the decision log in the master plan, where the owner can overrule it.

**Citations.** Cite code as `path/to/file.ts:120` or `path/to/file.ts:120-160`, always repository-relative, always on the baseline. A file that does not exist yet is written with `(new)` after it, for example `server/services/fieldOps/site/siteSearch.ts (new)`.

**Names come from the master plan.** Migration numbers, flag names, route prefixes, component names, type names and enum values are allocated in `00-master-plan.md`. A spec never invents one outside its allocation. If a spec needs something outside, it lists it under "Cross-spec requests" in its risks section instead of taking it.

**Markdown subset.** So that the HTML builder renders every file the same way, use only: headings (`#` to `####`), paragraphs, bullet and numbered lists (two levels of nesting at most), pipe tables, fenced code blocks with a language tag, `mermaid` fenced blocks, block quotes, horizontal rules, inline code, bold, italics and links. No raw HTML. No emojis.

**Spelling and tone.** British spelling. Plain sentences. Say what the code does, then what it will do.

**Safety stance for anything involving devices.** Specs describe categories, quantities, effects and response data. They never describe how to build, arm, hide or deploy a device, and they never list formulations or proportions. Published scaling relationships and reference tables are cited by name, not reproduced as instructions.

**Links.** Link to other specs with relative paths, for example `[the master plan](00-master-plan.md#3-decision-log)`. The HTML builder rewrites `.md` links to `.html`.

## 5. Building the HTML and checking the set

```
node scripts/build-field-ops-spec-html.mjs
node scripts/verify-field-ops-specs.mjs
```

The builder writes one `.html` per `.md` in this folder, plus `index.html`. The checker fails on: missing template sections, citations to files that do not exist (unless marked `(new)`), line numbers past the end of a file, migration numbers outside a spec's allocation or used twice, flags that are neither existing nor in the master plan, links that do not resolve, unknown decision numbers, placeholder text, and task or acceptance-criteria ids that belong to another workstream. It also warns about thin sections, bare file names, raw HTML and American spellings, and it lists device-related wording for a human to read.

Both scripts share the small Markdown parser in `scripts/lib/field-ops-md.mjs`, so a heading becomes the same anchor in the HTML and in the checker. Useful options for the checker: `--only=02,05` checks only those documents, `--strict` also fails on warnings, `--allow-missing` tolerates documents that are not written yet, and `--quiet` hides the notes.

## 6. Changing a spec

Edit the Markdown, run the checker, rebuild the HTML. If a change touches a contract owned by another spec (a type, a route, a flag, a migration), change the master plan first and say so in its change log.
