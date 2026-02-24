# Revert: Stricter robustness scoring

## Summary

This document describes the change that makes **robustness scoring strict** in the inter-team impact matrix: robustness is required per decision, and the AI is given explicit calibration bands (1–3 weak, 4–6 partial/mediocre, 7–10 strong) plus a strictness instruction so that mediocre or generic decisions receive lower scores. Reverting restores **optional** robustness with no calibration, so the model may again return higher scores more often and the high band (de-escalation) will trigger more frequently.

---

## Files changed

- **`server/services/aiService.ts`**
  - In `computeInterTeamImpactMatrix`: added a one-line comment `/* REVERT: stricter robustness calibration – see docs/REVERT_STRICTER_ROBUSTNESS_SCORING.md */` above the system prompt.
  - System prompt: bullet 2 changed from "Optionally, for each decision_id, output a robustness score..." to "Required: for each decision_id... use the exact same decision_id keys" with explicit score bands (1–3, 4–6, 7–10) and the strictness sentence "Be strict: mediocre or generic responses should typically score 4–5; reserve 7+ only for...". JSON example robustness values changed from `7, 4` to `5, 7`.
  - User prompt: "optional robustness per decision_id" replaced with "robustness per decision_id (required; use the strict calibration above)".
- **`docs/REVERT_STRICTER_ROBUSTNESS_SCORING.md`** (this file).

---

## Previous behavior (before this change)

- Robustness in the impact matrix was **optional**. The prompt said: "Optionally, for each decision_id, output a robustness score from 1 (weak, increases escalation) to 10 (strong, mitigates escalation)."
- No calibration bands or strictness instruction; the model often returned 6–8, so the mean frequently reached the high band (≥7) and de-escalation outcomes dominated.
- User prompt line: "Produce the impact matrix ... and optional robustness per decision_id (1-10). ..."

---

## New behavior (after this change)

- Robustness is **required**: the `robustness` object must contain an entry for every `decision_id` in the input, using the exact same IDs.
- Explicit calibration: 1–3 (weak), 4–6 (partial/mediocre), 7–10 (strong), with examples. A strictness line instructs the model to score mediocre/generic responses typically 4–5 and reserve 7+ for clearly strong, specific decisions.
- Low and medium bands (escalation or mixed outcomes) trigger more often; high band (de-escalation) requires clearly strong decisions.

---

## How to revert

To restore optional robustness with no calibration:

1. **`server/services/aiService.ts`**
   - In `computeInterTeamImpactMatrix`, **remove** the line:
     - `/* REVERT: stricter robustness calibration – see docs/REVERT_STRICTER_ROBUSTNESS_SCORING.md */`
   - **Replace** the current system prompt bullet 2 and the following bullets (through the JSON robustness example) with the previous text below.
   - **Replace** the user prompt line that says "robustness per decision_id (required; use the strict calibration above)" with "optional robustness per decision_id (1-10)".

**Previous system prompt (bullet 2 only – replace the current bullet 2 and calibration):**

```
2. Optionally, for each decision_id, output a robustness score from 1 (weak, increases escalation) to 10 (strong, mitigates escalation). Teams with no decisions in the window have robustness 0 (do not invent entries for them).
```

**Previous JSON robustness example (inside the format block):**

```
  "robustness": {
    "decision-uuid-1": 7,
    "decision-uuid-2": 4
  },
```

(Current has `5` and `7`; revert to `7` and `4`.)

**Previous user prompt (trailing line):**

```
Produce the impact matrix (acting_team -> affected_team -> score -2 to +2) and optional robustness per decision_id (1-10). When escalation context is provided, reference it in your analysis reasoning. Return JSON only.
```

2. **`docs/REVERT_STRICTER_ROBUSTNESS_SCORING.md`**
   - You can delete this file or keep it for reference.

After reverting, robustness is optional again and the model will not receive calibration or strictness instructions; high robustness scores and de-escalation outcomes may again dominate.
