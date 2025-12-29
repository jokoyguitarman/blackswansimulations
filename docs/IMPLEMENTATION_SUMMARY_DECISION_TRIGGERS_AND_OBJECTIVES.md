# Implementation Summary: Decision-Based Triggers & Objective Tracking

## Overview

This document summarizes the implementation of two major features:

1. **Decision-Based Inject Triggers** - Injects that automatically trigger based on player decisions
2. **Objective Tracking System** - Real-time tracking and scoring of scenario objectives

---

## Part A: Decision-Based Inject Triggers

### What Was Implemented

#### 1. Database Changes

- **Migration 024**: Added `ai_classification` JSONB column to `decisions` table
- **Migration 027**: Made `trigger_time_minutes` nullable (allows decision-based injects)
- **Migration 025**: Added 9 decision-based injects to C2E Bombing scenario

#### 2. Core Services

**`server/services/injectTriggerService.ts`** (NEW)

- `parseTriggerCondition()` - Parses JSON or text-based trigger conditions
- `matchesTriggerCondition()` - Matches AI classification against trigger criteria
- `findMatchingInjects()` - Finds injects that match a decision
- `shouldTriggerInject()` - Prevents duplicate publishing
- `evaluateDecisionBasedTriggers()` - Main entry point for trigger evaluation

**`server/services/aiService.ts`** (EXTENDED)

- `classifyDecision()` - AI classifies decisions into categories, keywords, semantic tags

#### 3. Integration Points

**`server/routes/decisions.ts`** (MODIFIED)

- When decision is executed:
  1. AI classifies the decision
  2. Classification stored in database
  3. System evaluates trigger conditions
  4. Matching injects are auto-published

**`frontend/src/components/Forms/CreateDecisionForm.tsx`** (MODIFIED)

- Removed `decision_type` dropdown
- Users no longer manually label decision types

#### 4. C2E Scenario Injects Added

**9 Decision-Based Injects:**

1. People Refuse Evacuation (Branch 1A - Evacuate Together)
2. Alternative Exit Routes Created (Branch 1A - Suggestion)
3. Discriminatory Evacuation Causes Backlash (Branch 1B - Segregate)
4. Legal/Policy Violation Concerns (Branch 1B - Suggestion)
5. Public Pressure Mounts (Branch 1C - Delay Evacuation)
6. Secondary Threat Risk Increases (Branch 1C - Suggestion)
7. Statement Partially Effective (Branch 2A - Address Misinformation)
8. Statement Fails to Counter Misinformation (Branch 2B - No Address)
9. Media Vacuum Filled by Speculation (Branch 2C - No Comment)
10. Victim Privacy Violated (Branch 3B - Allow Filming)

### How It Works

1. **User creates decision** (no type selection)
2. **Decision goes through approval workflow**
3. **When executed:**
   - AI analyzes title + description
   - Returns: categories, keywords, semantic tags
   - System matches against inject trigger conditions
   - Matching injects are auto-published

### Trigger Condition Format

**JSON Format:**

```json
{
  "type": "decision_based",
  "match_criteria": {
    "categories": ["emergency_declaration"],
    "keywords": ["evacuate", "together"],
    "semantic_tags": ["evacuation_order"]
  },
  "match_mode": "any"
}
```

**Simple Text Format:**

```
category:emergency_declaration AND keyword:evacuate AND keyword:together
```

---

## Part B: Objective Tracking System

### What Was Implemented

#### 1. Database Changes

- **Migration 026**: Created objective tracking system
  - `scenario_objective_progress` table - Tracks progress per session
  - `scenario_objectives` table - Defines objectives per scenario
  - PostgreSQL functions for updates, penalties, bonuses, scoring
  - Default objectives for C2E scenario

#### 2. Core Services

**`server/services/objectiveTrackingService.ts`** (NEW)

- `updateObjectiveProgress()` - Update progress percentage
- `addObjectivePenalty()` - Apply penalty points
- `addObjectiveBonus()` - Apply bonus points
- `getObjectiveProgress()` - Get all objectives for session
- `calculateSessionScore()` - Calculate weighted overall score
- `initializeSessionObjectives()` - Set up objectives when session starts
- `trackDecisionImpactOnObjectives()` - Auto-track decision impacts

#### 3. API Endpoints

**`server/routes/objectives.ts`** (NEW)

- `GET /api/objectives/session/:sessionId` - Get objective progress
- `GET /api/objectives/session/:sessionId/score` - Get session score
- `POST /api/objectives/session/:sessionId/initialize` - Initialize objectives (trainer)
- `POST /api/objectives/session/:sessionId/update` - Update progress (trainer)

#### 4. Integration Points

**`server/routes/decisions.ts`** (MODIFIED)

- Calls `trackDecisionImpactOnObjectives()` when decisions executed
- Automatically applies penalties/bonuses based on decision content

**`server/routes/sessions.ts`** (MODIFIED)

- Automatically initializes objectives when session status changes to `in_progress`

#### 5. C2E Scenario Objectives

**4 Objectives Defined:**

1. **Evacuation** (Weight: 30%)
   - Evacuate 1,000 participants safely
   - Penalties: Discriminatory segregation (-30), Major stampede (-50)

2. **Triage** (Weight: 25%)
   - Establish medical triage system
   - Penalties: Filming violation (-20), No coordination (-15)

3. **Media & Tension** (Weight: 30%)
   - Manage media and mitigate communal tension
   - Penalties: Discriminatory actions (-40), Harassment not prevented (-30)

4. **Coordination** (Weight: 15%)
   - Coordinate with emergency services

### How It Works

1. **Session starts** → Objectives initialized automatically
2. **Decisions executed** → Impact tracked automatically
3. **Progress updated** → Real-time tracking
4. **Session ends** → Overall score calculated

### Scoring System

- Each objective scored 0-100
- Weighted average for overall score
- Success levels:
  - **Excellent**: 90-100
  - **Good**: 75-89
  - **Adequate**: 60-74
  - **Needs Improvement**: <60

---

## Files Created/Modified

### New Files

- `migrations/024_add_ai_classification_to_decisions.sql`
- `migrations/025_add_decision_based_injects_to_c2e.sql`
- `migrations/026_create_objective_tracking_system.sql`
- `migrations/027_allow_null_trigger_time_for_decision_injects.sql`
- `server/services/injectTriggerService.ts`
- `server/services/objectiveTrackingService.ts`
- `server/routes/objectives.ts`
- `docs/C2E_BOMBING_DECISION_TREE.md`

### Modified Files

- `server/services/aiService.ts` - Added `classifyDecision()`
- `server/routes/decisions.ts` - Integrated AI classification and objective tracking
- `server/routes/sessions.ts` - Auto-initialize objectives on session start
- `server/index.ts` - Added objectives router
- `frontend/src/components/Forms/CreateDecisionForm.tsx` - Removed decision_type

---

## Testing Checklist

### Decision-Based Triggers

- [ ] Create decision without type
- [ ] Execute decision
- [ ] Verify AI classification stored
- [ ] Verify matching injects are published
- [ ] Verify injects don't publish twice
- [ ] Test with various decision types

### Objective Tracking

- [ ] Start session → Verify objectives initialized
- [ ] Execute decision → Verify impact tracked
- [ ] Check objective progress via API
- [ ] Calculate session score
- [ ] Verify penalties/bonuses applied correctly

---

## Next Steps (Optional Enhancements)

1. **Frontend UI for Objectives**
   - Display objective progress in session view
   - Show real-time scores
   - Visual progress indicators

2. **Enhanced Decision Impact Tracking**
   - More sophisticated penalty/bonus logic
   - Context-aware scoring (e.g., media narrative exists)

3. **Additional Decision-Based Injects**
   - Add remaining suggested injects from decision tree
   - Implement combined decision scenarios (Branch 5A)

4. **Objective-Based Win Conditions**
   - Define clear success thresholds
   - Early termination conditions
   - Real-time success indicators

---

## Migration Order

Run migrations in this order:

1. `024_add_ai_classification_to_decisions.sql`
2. `027_allow_null_trigger_time_for_decision_injects.sql`
3. `026_create_objective_tracking_system.sql`
4. `025_add_decision_based_injects_to_c2e.sql` (requires C2E scenario to exist)

---

**Implementation Date:** [Current Date]  
**Status:** ✅ Complete and Ready for Testing
