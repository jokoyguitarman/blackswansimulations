# Revert: Session-wide theme usage for inject generation

## Summary

This document describes the change that adds **session-wide theme and keyword usage** (and per-scope theme usage plus a **decision summary line**) to inject generation so the AI prefers underused themes and avoids repeating the same angles. **No raw inject text** is passed to the generator—only theme labels, counts, and keyword lists. Reverting removes this "read the room" behavior and restores inject generation without theme/diversity guidance.

---

## Files changed

- **`server/services/aiService.ts`**
  - New: `INJECT_THEMES`, `InjectThemeId`, `ThemeUsageEntry`, `ThemeUsageByScope`, `extractThemeAndKeywords()`, `aggregateThemeUsage()`, `computeDecisionsSummaryLine()`.
  - Session context type: added `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`.
  - In `generateInjectFromDecision`: new prompt blocks `themeUsageContext` and `decisionsSummaryContext` (and their inclusion in the user prompt).
- **`server/services/aiInjectSchedulerService.ts`**
  - Imports: `aggregateThemeUsage`, `computeDecisionsSummaryLine`.
  - After formatting recent injects: query **all** session injects (no 5-min filter), aggregate theme usage, compute decisions summary line, add `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine` to `baseContext`.
- **`server/services/injectTriggerService.ts`**
  - Imports: `aggregateThemeUsage`, `computeDecisionsSummaryLine`.
  - In parallel fetch: added `allSessionInjectsResult` (all session injects). After processing: aggregate theme usage, compute decisions summary, add same three fields to `enhancedContext`.
- **`docs/REVERT_SESSION_THEME_USAGE_INJECTS.md`** (this file).

---

## Previous behavior (before this change)

- Inject generation received only: scenario, decisions, recent injects (last 5 min in scheduler; last 10 in trigger), objectives, escalation/impact matrix, etc. No session-wide theme counts or decision summary.
- Injects could repeat the same themes (e.g. resource strain, misinformation) many times in a session.

---

## New behavior (after this change)

- **Scheduler and trigger** query all injects published in the session and run keyword-based theme extraction on each (title + short content snippet). Results are aggregated globally and per-scope (universal vs per-team).
- A **decision summary line** is computed from decision types (e.g. "Teams have repeatedly addressed: public statements and clarification (5), resource allocation (3).").
- **Context** passed to `generateInjectFromDecision` includes `themeUsageThisSession`, `themeUsageByScope`, and `decisionsSummaryLine` when non-empty.
- The **prompt** includes a "THEME USAGE THIS SESSION" block (and per-scope usage when generating universal or team-specific injects) plus a "DECISIONS SUMMARY" line and a policy line: prefer underused themes; for overused themes avoid repeating the same angles; when robustness is high prefer de-escalation and underused themes.

---

## How to revert

To remove session theme usage and decision summary from inject generation:

1. **`server/services/aiInjectSchedulerService.ts`**
   - Remove `aggregateThemeUsage` and `computeDecisionsSummaryLine` from the import from `./aiService.js`.
   - Delete the entire block that starts with `// Session-wide theme usage:` (the query for all session injects, the try/catch that calls `aggregateThemeUsage` and `computeDecisionsSummaryLine`, and the variables `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`).
   - In `baseContext`, remove the three properties: `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`.

2. **`server/services/injectTriggerService.ts`**
   - Remove `aggregateThemeUsage` and `computeDecisionsSummaryLine` from the import from `./aiService.js`.
   - In the `Promise.all` array: remove the `allSessionInjectsResult` query (the "Get ALL session injects for theme usage" entry) and remove `allSessionInjectsResult` from the destructuring list.
   - Delete the block that starts with `// Session-wide theme usage and decision summary` (the try/catch that aggregates and sets `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`).
   - In `enhancedContext`, remove the three properties: `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`.

3. **`server/services/aiService.ts`**
   - In `generateInjectFromDecision`, remove from the session context type the three optional properties: `themeUsageThisSession`, `themeUsageByScope`, `decisionsSummaryLine`.
   - Delete the block that builds `themeUsageGlobal`, `scopeUsage`, `themeUsageContext`, and `decisionsSummaryContext` (from `// Session-wide theme usage (avoid repeating themes)` through `When robustness is high, prefer injects that reflect improvement...`).
   - In the `userPrompt` template, remove `${themeUsageContext}${decisionsSummaryContext}` (so the template goes directly from `injectTypeContext` to `escalationContext`).
   - Optionally remove the exported constants and functions used only for this feature: `INJECT_THEMES`, `InjectThemeId`, `ThemeUsageEntry`, `ThemeUsageByScope`, `extractThemeAndKeywords`, `aggregateThemeUsage`, `computeDecisionsSummaryLine`. (If you keep them, they are harmless; they will simply be unused.)

4. **`docs/REVERT_SESSION_THEME_USAGE_INJECTS.md`**
   - You can delete this file or leave it for reference.

After reverting, inject generation will no longer receive theme usage or decision summary; behavior will match the previous "no session theme diversity" logic.
