# Removed footprint proposals keep coming back: fix spec

**Status:** ready to implement
**Scope:** corporate crisis wizard, Setup and Build (everything before Compile)
**Written:** 25 Oct 2026 against commit `6d472e1`. Line numbers below are from that commit; use the function names if they have moved.

---

## 1. Summary

The footprint radar on the Setup page adds the organisations it thinks the crisis implies: AI-operated offices and pressure groups. A trainer removed some of them, and they kept coming back while he worked towards Compile.

Four defects cause this. The first is almost certainly what he hit: it happens on every build, and removing the groups again in Setup does not help.

| Cause                                                                                                            | What the trainer sees                                                                                                      | Fixed by      |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **A.** The Storyline stage sends a stale copy of the pressure-group list and writes it back into wizard state    | Removed pressure groups are back on Review & Compile, with a spokesperson, a page and statements, and they get compiled    | Task 3        |
| **B.** Re-running the footprint adds every proposal not currently on the map, including ones the trainer removed | Removed offices and pressure groups reappear on Setup after editing the description and pressing Build, or after Re-detect | Tasks 4 and 5 |
| **C.** Proposals are matched to cards by their current name only                                                 | A proposal the trainer renamed is added again as a duplicate on the next footprint run                                     | Task 4        |
| **D.** The draft saved at the end of Build holds the state from before the build                                 | Reloading after Build reopens the previous build's pages and contacts beside the current Setup, and Compile then fails     | Task 6        |

Tasks 1 to 6 are required. Task 7 is a recommended server-side follow-up.

---

## 2. Background

- **Everything before Compile runs in the browser.** Setup lives in React state in `frontend/src/pages/SocialCrisisWizard.tsx`:
  - the primary organisation (`orgName`, `country`, `primaryCity`, `primaryKind`, `primaryShortName`, `teamRoster`);
  - `extraOrganisations: OrganisationDraft[]`, the offices, including AI-operated ones (`operation: 'ai'`);
  - `pressureOrgs: PressureOrgDraft[]`;
  - `competitorEntries`, the rivals.
- **Footprint.**
  - `detectFootprint()` (~line 583) posts the description to `POST /api/warroom/social-crisis/footprint`, which is one AI call at temperature 0.4 in `server/services/crisisFootprintService.ts`, so names vary between runs.
  - Proposed offices are added to `extraOrganisations` with `operation: 'ai'` and `proposed_reason`; proposed pressure groups are added to `pressureOrgs`.
  - It runs from the radar button, from Re-detect, and automatically from `goNext()` (~line 1905) when the trainer presses Build and the description has changed since the last run (tracked in `footprintRanFor`).
  - The radar chips (~line 2285) toggle a proposal on or off the map.
- **Build.** `generateAll()` (~line 1712) chains four `useCallback` stages, `generateNPCs` → `generateStoryline` → `generateConvergence` → `generateOrgPage`, then calls `saveDraftState(7)` and moves to Review & Compile (step 7).
  - Each stage sends the Setup lists to the server. The server validates them (`validateOrganisations` in `server/services/scenarioOrgModel.ts`) and generates for exactly what it receives.
- **Storyline stage and pressure groups.**
  - The server creates or reuses one spokesperson contact per pressure group it receives (`ensureSpokespersons` in `server/services/pressureOrgGenerationService.ts`).
  - It returns `pressure_organisations` with `org_key` and `spokesperson_stakeholder_id`.
  - The wizard copies those onto its drafts and passes the list to the Pages stage, which generates one page and two scheduled statements per pressure group.
- **Compile.** `compileScenario` posts the Setup lists plus all generated content to `/compile`, which checks the whole payload (`server/services/scenarioValidationService.ts`, the MO-\* rules) before persisting.
- **Drafts.** `buildDraftInput()` and `saveDraftState(step)` save to `/api/warroom/wizard/drafts`.
  - POST always creates the draft at `current_step: 1`; PATCH shallow-merges `input` and sets `current_step`.
  - On resume, the wizard reads `?draft=<id>`.
- **No lint on the frontend.** The root `eslint.config.mjs` ignores `frontend/**` and there is no `react-hooks` plugin, so stale `useCallback` dependency arrays are never flagged. Check every dependency array you touch by hand.

---

## 3. Root causes

### 3.1 Cause A: the Storyline stage brings removed pressure groups back

`generateStoryline` (~lines 1246–1436) reads two values that are missing from its dependency array (~lines 1424–1434):

- `pressureOrganisationsPayload`, as the request's `pressure_organisations` (~line 1300);
- `pressureOrgs`, in `const mergedPressure = pressureOrgs.map(...)` (~line 1359).

The dependency array today:

```ts
[
  crisisDescription,
  country,
  orgName,
  personas,
  factSheet,
  blueprint,
  teamRoster,
  organisationsPayload,
  competitorsPayload,
];
```

The memoised callback therefore keeps the pressure list from the last time one of those values changed. Removing a pressure group changes none of them. When Build runs:

1. The request sends the old list, removed groups included, and the server creates a spokesperson for each one.
2. `mergedPressure` is built from the old list, and `setPressureOrgs(mergedPressure)` (~line 1391) writes it back into state. The removed groups are restored.
3. `generateAll` passes `story.pressureOrganisations` (the old list) to the Pages stage, which generates their pages and statements.
4. Review & Compile lists them under "Run by the AI", and Compile sends them, because `pressureOrganisationsPayload` is now computed from the restored state.

This repeats on every rebuild. The Pages stage always returns persona twins for the spokespeople, so `personas` changes after the restore and the callback is re-created holding the restored list. Removing the groups again in Setup does not refresh it.

The bug came in with `908de942` (20 Sep 2026), which added the pressure merge without updating the dependency array.

The same stale copy causes three more symptoms:

- A pressure group renamed or edited (kind, country, demands) as the last change before Build is reverted after Build.
- A pressure group added as the last change is missing from the request. It is either removed from state by the write-back, or, when the stale list was empty, stays in state with no spokesperson and no page, and Compile fails with MO-PRS-004 or MO-PRS-007.
- If the radar added pressure groups but no office, and nothing else in the dependency array changes before Build, the callback still holds the list from before the radar ran. No spokesperson or page is generated for any pressure group, and Compile fails with MO-PRS-004.

`generateConvergence` (dependencies ~lines 1571–1585) and `compileScenario` (dependencies ~lines 1865–1887) also read `pressureOrganisationsPayload` without listing it. Other dependencies happen to refresh them after a build today, but it is the same bug.

AI-operated offices are not affected by Cause A. `organisationsPayload` is in every stage's dependency array, and nothing writes offices back from a server response.

### 3.2 Cause B: footprint re-runs re-add what the trainer removed

`detectFootprint` adds every proposal whose name, lowercased, is not on the map. It keeps no record of removals, so a removed proposal counts as "not on the map" and is added again.

What triggers a re-run:

- Pressing Build after any change to the description or the uploaded document. `goNext` re-runs the footprint when `footprintRanFor.current !== text`, and afterwards always stays on Setup, even when nothing new was added (~line 1911).
- Re-detect on the radar.

On the server, the guard rail (`guardRailFootprint`) only de-duplicates against the protagonist names in the request. The request carries no pressure groups and no removals, so the model can propose them again.

### 3.3 Cause C: renamed proposals come back as duplicates

Proposals are matched to cards by current display name in `detectFootprint`, `hasOrgProposal` and `hasPressureProposal` (~lines 2003–2009).

- Rename "Dyson Malaysia" to "Dyson Johor Plant" and the next footprint run adds "Dyson Malaysia" again.
- Its radar chip also shows as off, and clicking it adds a second copy.
- A later run that writes the name differently, such as "Dyson Malaysia Sdn Bhd" or "Ministry of Human Resources (MOHR)", is not recognised as the same organisation either.

### 3.4 Cause D: the draft saved after Build is stale

`generateAll` ends with `await saveDraftState(7)`. That `saveDraftState` is the one captured when Build was pressed, so it saves `buildDraftInput()` as it was at that moment: Setup at the time of the click and generated content from before the build.

- **First build of a new draft.** The captured draft id is still `null`, so it POSTs a second draft and switches the URL to it. That draft has no build content and opens at step 1, so reloading lands on Setup and the build is lost.
- **Later builds.** It PATCHes `current_step: 7` with the previous build's content. Reloading opens Review & Compile with the previous build's pages, spokespersons and statements beside the current Setup lists.
  - The page of a pressure group removed since then shows under Organisation pages.
  - Compile fails with MO-ORG-005, because that page points at an organisation the registry no longer has.

---

## 4. Reproducing it today

Use an admin account, because admins skip the scenario-credit check. Locally, setting `SOCIAL_PERSONAS_PER_COUNTRY=20` on the server shortens the Characters stage.

**Setup used throughout:** primary organisation "Dyson", country Singapore. Description (from `server/services/crisisFootprint.test.ts`):

> Dyson HQ in Singapore faces a scandal over unfair labour practices at its contract manufacturing factory in Johor, Malaysia. Workers allege forced overtime and withheld wages; a Malaysian NGO has documented cases and the Ministry of Human Resources is asking questions.

**R1 (Cause A, the reported bug)**

1. Press **Detect footprint & continue**. Expect one AI-operated office and three or four pressure groups.
2. Optionally remove the office first, to make the build smaller. Then remove two pressure groups, and make those removals your last edits.
3. Press **Build the scenario** and wait for Review & Compile.
4. **Bug:** the two removed groups are back.
   - They are listed under "Run by the AI", each with a spokesperson and statements, and their pages are under Organisation pages.
   - In DevTools, the `generate-storyline` request body's `pressure_organisations` still contains them.
5. Press Back twice to reach Setup: they are on the map again. Remove them and build again, and they come back again.

**R2 (Cause A, edits)**

- Rename a pressure group as the last edit, then build: Review & Compile shows the old name.
- Add a pressure group as the last edit, then build: it has disappeared, or Compile fails with MO-PRS-004.

**R3 (Cause B)**

1. Detect the footprint.
2. Remove the office and one pressure group.
3. Add a sentence to the description.
4. Press **Build the scenario**: the footprint runs again, both removed organisations are back, and the wizard stays on Setup.

Pressing Re-detect does the same.

**R4 (Cause C)**

1. Detect the footprint.
2. Rename the proposed office.
3. Press **Re-detect**: the original proposal is added again beside the renamed card.

**R5 (Cause D)**

1. On a brand-new draft, finish a build, then reload: you land on Setup, the build is gone, and the drafts list has gained a second draft.
2. Build, go back, remove a pressure group, build again, then reload: Review & Compile shows the removed group's page under Organisation pages, and Compile fails with MO-ORG-005.

---

## 5. Required behaviour (acceptance criteria)

- **AC1: removed stays removed through Build.** After a proposed office or pressure group is removed in Setup and Build is pressed:
  - it does not appear anywhere on Review & Compile: "Run by the AI", the summary tiles, Response teams, Organisation pages, or as the "speaks for" link of any contact;
  - it is absent from the request bodies of `generate-storyline`, `generate-convergence`, `generate-org-page` and `compile`, in `organisations`, `pressure_organisations` and `org_page.orgs`.
- **AC2: repeatable.** Going back to Setup, removing more organisations and building again behaves the same way, any number of times.
- **AC3: last-minute edits survive.** A pressure group added, renamed or edited (kind, country, demands) as the very last change before Build:
  - is what the Storyline request sends and what Review & Compile shows;
  - gets a spokesperson and a page;
  - passes Compile validation.
- **AC4: re-runs respect removals.** Re-detect, and Build after editing the description, never add back an organisation the trainer removed from the same side (office or pressure group).
  - This holds when the new run writes the name differently, for example "Dyson Malaysia Sdn Bhd" for "Dyson Malaysia", or "Ministry of Human Resources (MOHR)" for "Ministry of Human Resources".
  - Removed proposals still show on the radar as off chips. Clicking one adds it back and forgets the removal.
- **AC5: renames are not duplicated.** Renaming a proposed organisation and re-running the footprint does not add the original proposal again, and that proposal's radar chip shows as on.
- **AC6: removals survive save and resume.** After Save draft and a reload, the removed proposals are still off, and Re-detect still does not bring them back.
- **AC7: Build does not stall.** When Build re-runs the footprint because the description changed:
  - if nothing new is added, the build starts without a second click;
  - if something new is added, the wizard stays on Setup and the notice says what was added and how many removed proposals stayed off;
  - the first footprint run of a draft still stops on Setup, as it does today.
- **AC8: no clashes across sides.** The footprint never adds a proposal whose normalised name equals an organisation already on the other side (office versus pressure group). A proposal therefore never creates a name clash, which Setup would flag as an error and the server would refuse with MO-PRS-001.
- **AC9: reload after Build.** Reloading right after a build:
  - reopens the same draft on Review & Compile with the content of the build that just finished;
  - no second draft is created;
  - compiling from there succeeds.
- **AC10: checks pass.** `npm test` (including the new tests), `npm run typecheck`, `npm run lint` and `npm --prefix frontend run build` all succeed.

---

## 6. Implementation plan

Do the tasks in order. Task 3 fixes the reported bug on its own, so it can ship first if needed.

### Files to touch

| File                                                                                                                                        | Change                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `shared/orgNames.ts`                                                                                                                        | new: organisation-name matcher (Task 1)                                             |
| `frontend/src/components/Scenario/setupValidation.ts`                                                                                       | use the shared matcher (Task 1)                                                     |
| `frontend/src/components/Scenario/setupOrganisations.ts`                                                                                    | new: pure Setup helpers (Task 2)                                                    |
| `frontend/src/components/Scenario/OrganisationRosterBuilder.tsx`                                                                            | add `proposed_from?: string` to `OrganisationDraft` and `PressureOrgDraft` (Task 4) |
| `frontend/src/pages/SocialCrisisWizard.tsx`                                                                                                 | Tasks 3–6                                                                           |
| `frontend/tests/setupOrganisations.test.ts`                                                                                                 | new: tests                                                                          |
| `package.json`                                                                                                                              | add the new test file to the `test` script                                          |
| Task 7 only: `server/routes/socialCrisisWarroom.ts`, `server/services/crisisFootprintService.ts`, `server/services/crisisFootprint.test.ts` | server-side footprint awareness                                                     |

### Task 1: shared organisation-name matcher

Create `shared/orgNames.ts`. It must be pure and import nothing, because both the frontend (`@shared/orgNames`) and the server (`../../shared/orgNames.js`) will import it.

```ts
/** Lowercase, accents and bracketed text dropped, punctuation collapsed:
 *  "Ministry of Human Resources (MOHR)" -> "ministry of human resources". */
export function normaliseOrgName(name: string): string;

/** The same organisation written two ways: equal once normalised, or the shorter
 *  (8+ characters) appearing as whole words inside the longer. */
export function sameOrganisationName(a: string, b: string): boolean;
```

How to build it:

- Normalise with `normalize('NFD')`, then strip combining marks (`/\p{M}+/gu`), lowercase, replace `/\([^)]*\)/g` with a space, collapse `/[^\p{L}\p{N}]+/gu` to single spaces, and trim. Unicode classes keep non-Latin names comparable; the current helper strips them to nothing.
- For whole-word containment, compare `` ` ${long} ` `` with `` ` ${short} ` ``.
- An empty normalised name never matches.

Expected results, to use as tests:

| a                           | b                                  | result                            |
| --------------------------- | ---------------------------------- | --------------------------------- |
| Dyson Malaysia              | dyson malaysia.                    | true                              |
| Dyson Malaysia              | Dyson Malaysia Sdn Bhd             | true                              |
| Ministry of Human Resources | Ministry of Human Resources (MOHR) | true                              |
| Médecins Sans Frontières    | Medecins Sans Frontieres           | true                              |
| Dyson                       | Dyson Malaysia                     | false (shorter than 8 characters) |
| Ministry of Labour          | Ministry of Labourers              | false (not whole words)           |
| (empty)                     | Dyson                              | false                             |

Then make `looksLikeSameBody` in `setupValidation.ts` (~line 119) call `sameOrganisationName`. The existing test "likely duplicate pressure groups are flagged softly" must stay green.

### Task 2: pure Setup helpers

Create `frontend/src/components/Scenario/setupOrganisations.ts`. Use no React, `import type` only from `./OrganisationRosterBuilder`, and import the matcher from `@shared/orgNames`. This keeps it testable under `node --import tsx --test` the same way `setupValidation.ts` is.

```ts
export type ProposalSide = 'office' | 'pressure';
export interface DismissedProposal {
  side: ProposalSide;
  name: string;
}
export const MAX_DISMISSED = 50;

export interface SetupLists {
  primary: { display_name: string; country: string };
  offices: Array<{ display_name: string; country: string; proposed_from?: string }>;
  pressure: Array<{ display_name: string; country: string; proposed_from?: string }>;
}

export function namesOf(d: { display_name: string; proposed_from?: string }): string[];
export function isOnMap(
  side: ProposalSide,
  proposal: { display_name: string; country: string },
  lists: SetupLists,
): boolean;
export function isDismissed(list: DismissedProposal[], side: ProposalSide, name: string): boolean;
export function recordDismissal(
  list: DismissedProposal[],
  side: ProposalSide,
  draft: { display_name: string; proposed_from?: string },
): DismissedProposal[];
export function clearDismissal(
  list: DismissedProposal[],
  side: ProposalSide,
  name: string,
): DismissedProposal[];
export function parseDismissedProposals(raw: unknown): DismissedProposal[];
export function selectFootprintAdditions<
  O extends { display_name: string; country: string },
  P extends { display_name: string; country: string },
>(
  footprint: { implied_organisations: O[]; pressure_organisations: P[] },
  lists: SetupLists,
  dismissed: DismissedProposal[],
  room: { offices: number; pressure: number },
): { offices: O[]; pressure: P[]; keptOff: string[]; noRoom: string[] };
export function mergeSpokespersonLinks<
  T extends { display_name: string; org_key?: string; spokesperson_stakeholder_id?: string },
>(
  drafts: T[],
  wire: Array<{ display_name: string; org_key: string; spokesperson_stakeholder_id?: string }>,
): T[];
```

What each one must do:

- **`namesOf`** returns the names a card answers to: its current `display_name` and, when present, the `proposed_from` it was created from. Trim both and drop blanks.
- **`isOnMap`** is true when the proposal is already on its side of the map. The office side includes the primary.
  - It matches if any card's `proposed_from` is the same organisation as the proposal, in any country, because the card came from this proposal even if the trainer later changed its country.
  - It also matches if any card's current name is the same organisation and the countries are equal or either one is blank.
- **`isDismissed`** is true when any entry on that side has the same organisation name. Country is ignored. A false positive costs the trainer one click on the chip; a false negative is the bug being fixed.
- **`recordDismissal`** adds each name from `namesOf(draft)` that is not already dismissed on that side, and keeps only the newest `MAX_DISMISSED` entries.
- **`clearDismissal`** drops every entry on that side whose name is the same organisation.
- **`parseDismissedProposals`** is for draft resume. It keeps well-formed `{ side, name }` entries only, trims names, and caps the list at `MAX_DISMISSED`. Anything that is not an array returns `[]`.
- **`selectFootprintAdditions`** walks each list in order and, for each proposal:
  1. skips it if `isOnMap` on its own side;
  2. skips it if dismissed on its side, recording the name in `keptOff`;
  3. skips it if its normalised name equals any organisation on the other side (primary and offices for a pressure proposal, pressure groups for an office proposal), because the server requires names to be unique across sides. Use exact normalised equality here, not containment: "Dyson Malaysia Workers Union" is a legitimate pressure group next to the office "Dyson Malaysia";
  4. skips it if the same organisation was already picked earlier in this run;
  5. skips it if its side has no room left, recording the name in `noRoom`;
  6. otherwise picks it.
- **`mergeSpokespersonLinks`** copies `org_key` and `spokesperson_stakeholder_id` from the wire entry with the same display name (trimmed, case-insensitive). It never adds, drops or reorders cards, and leaves every other field alone.

### Task 3: every Build stage uses the current pressure list (Cause A)

All changes are in `SocialCrisisWizard.tsx`.

1. **`generateStoryline`:**
   - Add `pressureOrgs` and `pressureOrganisationsPayload` to the dependency array.
   - Replace `setPressureOrgs(mergedPressure)` with `setPressureOrgs((prev) => mergeSpokespersonLinks(prev, pressureWire))`, keeping the `pressureWire.length > 0` guard. The stage must never write back a list it captured.
   - Return `pressureOrganisations: mergeSpokespersonLinks(pressureOrgs, pressureWire)`. This is the list this call sent, so the Pages stage generates pages for exactly the groups that got spokespeople.
2. **`generateConvergence`:** add `pressureOrganisationsPayload` to the dependency array.
3. **`compileScenario`:** add `pressureOrganisationsPayload` to the dependency array.
4. **`buildDraftInput`** (~lines 792–826): add the missing `brandLogoUrl` to its dependency array while you are there.
5. **Audit.** Re-check the dependency array of every callback you touch against what its body reads. `generateNPCs`, `generateOrgPage` and `detectFootprint` are complete today.

Optional tidy-up: `pressureOrganisationsPayload` and the inline mapping in `generateOrgPage` (~lines 1618–1631) build the same request shape. They can share one `toPressureWire(p)` function.

### Task 4: remember removed proposals (Causes B and C)

All changes are in `SocialCrisisWizard.tsx` unless noted otherwise.

1. **Types** (`OrganisationRosterBuilder.tsx`): add `proposed_from?: string` to `OrganisationDraft` and `PressureOrgDraft`. It holds the proposal's original `display_name`. It is never sent to the server; the payload builders pick fields explicitly, so nothing else changes.
2. **State:** add `const [dismissedProposals, setDismissedProposals] = useState<DismissedProposal[]>([])`.
3. **Draft:**
   - Add `dismissed_proposals: dismissedProposals` to `buildDraftInput`, together with the dependency.
   - On resume (~line 938), add `setDismissedProposals(parseDismissedProposals(input.dismissed_proposals))`.
   - Older drafts have no such key and resume with `[]`.
4. **Set `proposed_from`** wherever a card is created from a proposal: in `detectFootprint` for both offices and pressure groups, and in the "add back" branch of `toggleOrgProposal` and `togglePressureProposal`.
5. **Record removals:**
   - The office card's `onRemove` (~line 2496) and the pressure card's `onRemove` (~line 2581) also call `setDismissedProposals((prev) => recordDismissal(prev, side, card))`. Do this for any named card, proposed or manual: a trainer who removed "X" does not want X added back automatically.
   - The "off" branch of `toggleOrgProposal` and `togglePressureProposal` removes every card on that side matching the proposal (the `isOnMap` rule applied to that single card, so a renamed card is found too). It then records the proposal's name and the removed cards' names.
   - The primary is never removed. A proposal that matches the primary shows as on, and its chip does nothing when clicked.
6. **Add back:** the "on" branch of each toggle adds the card with `proposed_from` set and calls `clearDismissal` for the proposal's name.
7. **Chips:** `hasOrgProposal` and `hasPressureProposal` become `isOnMap('office' | 'pressure', proposal, lists)`. An off chip whose proposal is dismissed has the tooltip "You removed this. Click to add it back."
8. **`detectFootprint`:**
   - Replace the two name filters with `selectFootprintAdditions(fp, lists, dismissedProposals, room)`.
   - Room is 5 minus the number of offices (6 organisations in total, primary included) and 6 minus the number of pressure groups.
   - Build drafts from the picked proposals exactly as today, plus `proposed_from`.
   - Add `dismissedProposals` to its dependencies.
   - Update the notice:
     - always: the countries line, then "Added N AI-operated organisation(s) and M pressure group(s).";
     - if `keptOff` is not empty: "K you removed earlier stayed off the map. Click a chip to add one back.";
     - if `noRoom` is not empty: "No room for <names>: the map takes 6 organisations and 6 pressure groups.";
     - if anything was added: "Remove anything that does not belong."
9. Dismissals are deliberately not cleared when the description changes. The trainer's decision stands, and the chip is one click away.

### Task 5: Build only pauses when the footprint added something

1. Change `detectFootprint` to return `{ outcome: 'ran' | 'refused' | 'skipped' | 'failed'; added: number }`, where `added` counts offices plus pressure groups actually added. `runFootprint` ignores the result as it does today.
2. In `goNext` (~lines 1905–1914), keep the re-run condition but replace the early return:

```ts
const firstRun = footprint === null;
const r = await detectFootprint({ silent: true });
if (r.outcome === 'refused') return;
if (r.outcome === 'ran' && (firstRun || r.added > 0)) return; // new proposals to review
```

A failed or skipped run continues to the build, as it does today.

### Task 6: save the draft after Build from the final state (Cause D)

1. **Draft id ref.** Add `const wizardDraftIdRef = useRef<string | null>(null)`.
   - Set it wherever the id is set: on resume (~line 882), and after a successful POST in `saveDraftState`.
   - `saveDraftState` reads the id from the ref instead of from state, and drops `wizardDraftId` from its dependency array. A stale `saveDraftState` then still PATCHes the right draft, and no second draft is created.
2. **POST step.** POST ignores `current_step`. When `saveDraftState` creates a draft with `nextStep > 1`, it PATCHes `current_step` straight afterwards.
3. **Save after the final render.** In `generateAll`, replace `await saveDraftState(7)` with a flag, and drop `saveDraftState` from `generateAll`'s dependencies:

```ts
const pendingBuildSave = useRef(false);

// end of generateAll
setBuildStage('done');
pendingBuildSave.current = true;
setStep(7);

// component body
useEffect(() => {
  if (step !== 7 || !pendingBuildSave.current) return;
  pendingBuildSave.current = false;
  void saveDraftState(7);
}, [step, saveDraftState]);
```

The effect runs after the render that contains the last stage's state, so `buildDraftInput()` holds the finished build. The ref also keeps React StrictMode's double effect run from saving twice. The draft is larger now that it holds the full build; the server accepts 10 MB bodies.

### Task 7 (recommended): the server footprint knows about existing pressure groups and removals

This is defence in depth. The client filter from Task 4 stays the source of truth.

1. **`/footprint` route** (`server/routes/socialCrisisWarroom.ts`, ~line 308). Accept two optional body fields:
   - `pressure_organisations: [{ display_name, country, kind? }]` (max 12);
   - `dismissed: [{ side: 'office' | 'pressure', name }]` (max 50).
2. **`inferCrisisFootprint(text, orgs, opts?)`.** When given, the user prompt adds "Pressure organisations already entered: …" and "Do not propose these, the trainer removed them: …". Keep `opts` optional: `runNpcsPipeline` calls `inferCrisisFootprint(crisisText, orgs)` and must keep working unchanged.
3. **`guardRailFootprint(raw, text, existingOrgs, opts?)`.** Drop proposals that are the same organisation (`sameOrganisationName`) as an existing pressure group or a dismissed name on the same side. Use `sameOrganisationName` instead of exact lowercase for the existing protagonist names too.
4. **Wizard.** `detectFootprint` sends both fields.
5. **Tests.** Extend `server/services/crisisFootprint.test.ts`: an existing pressure group is not re-proposed; a dismissed office and a dismissed pressure group are dropped, including name variants; omitting `opts` behaves exactly as before.

---

## 7. Tests

Create `frontend/tests/setupOrganisations.test.ts` with `node:test` and `node:assert/strict`, in the same style as `frontend/tests/setupValidation.test.ts`, and append it to the root `package.json` `test` script. Cover:

- **`sameOrganisationName`:** every row of the Task 1 table.
- **`recordDismissal` and `clearDismissal`:**
  - records the current name and `proposed_from`;
  - ignores blank names and duplicates;
  - caps at `MAX_DISMISSED`, keeping the newest;
  - clears name variants on the same side only.
- **`isOnMap`:**
  - matches by current name with compatible countries;
  - does not match the same name in a different country;
  - matches by `proposed_from` even after the card's country changed;
  - matches the primary on the office side.
- **`selectFootprintAdditions`:**
  - skips cards on the map, by name and by `proposed_from`;
  - skips dismissed proposals, including name variants, and lists them in `keptOff`;
  - a pressure dismissal does not block an office proposal;
  - skips an exact cross-side clash but keeps "Dyson Malaysia Workers Union" beside the office "Dyson Malaysia";
  - de-duplicates within one run;
  - respects room and reports `noRoom`;
  - keeps the proposal order.
- **`mergeSpokespersonLinks`:**
  - annotates matches;
  - never adds a wire entry that has no card (the regression for Cause A);
  - keeps order and the trainer's other edits;
  - an empty wire returns the cards unchanged.
- **`parseDismissedProposals`:** `undefined`, a non-array, entries with an unknown side or missing name, untrimmed names, and an oversize list.

Run these before opening the PR:

```bash
npm test
npm run typecheck
npm run lint
npm --prefix frontend run build
```

`npm test` passed on 25 Oct 2026 with 283 tests, 37 of them in `frontend/tests/setupValidation.test.ts`. `npm --prefix frontend run build` runs `tsc` with `noUnusedLocals`, `noUnusedParameters` and `erasableSyntaxOnly`, so no enums and no parameter properties.

---

## 8. Manual QA (after the fix)

Use the R1–R5 setup from section 4 on a real build, locally or on a preview deployment. Keep DevTools open on the Network tab.

1. **AC1 and AC2.** Repeat R1. Review & Compile shows only the pressure groups left on the map. The `generate-storyline`, `generate-org-page` and `compile` bodies list exactly those groups. Back to Setup, remove one more, build again: same result.
2. **AC3.** Repeat R2. The renamed group keeps its new name. The added group appears with a spokesperson and a page. Compile succeeds.
3. **AC4 and AC7.** Repeat R3.
   - Build re-runs the footprint. The removed office and group stay off, shown as off chips with the "You removed this" tooltip.
   - If nothing new was proposed, the build starts by itself.
   - Click an off chip: it comes back on the map, and a further Re-detect leaves it alone.
4. **AC5.** Repeat R4. There is no duplicate, and the renamed card's chip is on.
5. **AC6.** Remove a proposal, Save draft, reload, Re-detect: it stays off.
6. **AC8.** Before detecting, add a pressure group named exactly like the office the radar will propose. For the Dyson description this is usually "Dyson Malaysia". Detect: no office of that name is added, and Setup shows no name-clash error.
7. **AC9.** On a brand-new draft, build and reload: Review & Compile shows the finished build, and the drafts list has a single draft. Build twice with a removal in between, reload, then Compile: it succeeds, and the removed group appears nowhere.

Attach to the PR: screenshots of Review & Compile for steps 1 and 7, and the `pressure_organisations` array from the `compile` request in step 1.

---

## 9. Expected behaviour that is not a bug

- **The description still names a removed organisation.** Generated posts, facts and contacts can therefore still mention it. Cast completion also gives every office a regulator contact, which may come from the same body as a removed pressure group, but that contact will not speak for any page. To keep an organisation out of the story entirely, edit the description as well.
- **Removing an AI-operated office does not remove its country from the story.** If the description puts the incident there, the Characters stage can still add a small spillover crowd from that country, visible to everyone.
- **The auto-generated rival is not a footprint proposal.** "Auto-generate a hostile rival" is ticked by default and invents a rival page during Build when no rivals are named. Untick it in Setup to avoid it.
- **Editing the description re-runs the footprint on Build.** This is by design. It may propose organisations that are new, which is why Build stops when something new is added.

---

## 10. Out of scope

- Editing, adding or removing organisations on Review & Compile, or after Compile in the library Preview.
- The Back button from Review & Compile landing on the finished Building screen.
- Edit fields for rival cards in Setup; removing the auto-generated rival after Build.
- Passing removed names into the storyline or cast prompts.
- Adding React hooks linting to the frontend. This is a recommended follow-up, because it would have caught Cause A.

---

## 11. Definition of done

- Tasks 1–6 are merged. Task 7 is either merged or filed as a follow-up.
- AC1–AC10 are verified with the QA script in section 8, with screenshots and request bodies attached to the PR.
- New tests are added and registered in `package.json`, and all four commands in section 7 pass.
- Prettier has been run on the changed files (lint-staged also runs it on commit).
- Only the files listed in section 6 are staged. The working tree has unrelated local changes (for example `frontend/src/pages/WarRoom.tsx` and `server/routes/warroom.ts`); leave them alone.
