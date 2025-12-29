# Next Steps After Implementation

## Overview

After creating the files for decision-based triggers and objective tracking, follow these steps to activate the features.

---

## Step 1: Run Database Migrations

Run the migrations in **this exact order** in your Supabase SQL Editor:

### Migration Order:

1. **`024_add_ai_classification_to_decisions.sql`**
   - Adds `ai_classification` column to decisions table
   - Makes `type` nullable

2. **`027_allow_null_trigger_time_for_decision_injects.sql`**
   - Allows `trigger_time_minutes` to be NULL (for decision-based injects)
   - Adds constraint to ensure at least one trigger is specified

3. **`026_create_objective_tracking_system.sql`**
   - Creates `scenario_objective_progress` table
   - Creates `scenario_objectives` table
   - Creates PostgreSQL functions for tracking
   - Adds default objectives for C2E scenario

4. **`025_add_decision_based_injects_to_c2e.sql`**
   - Adds 9 decision-based injects to C2E Bombing scenario
   - **Requires:** C2E scenario must exist (run `demo/seed_c2e_scenario.sql` first if needed)

### How to Run:

1. Open Supabase Dashboard → SQL Editor
2. Copy and paste each migration file content
3. Run them in order (1 → 2 → 3 → 4)
4. Verify no errors

---

## Step 2: Verify C2E Scenario Exists

**Check if C2E scenario exists:**

```sql
SELECT id, title FROM scenarios WHERE title = 'C2E Bombing at Community Event';
```

**If it doesn't exist, run:**

- `demo/seed_c2e_scenario.sql` first
- Then run migration 025

---

## Step 3: Configure OpenAI API Key (Required for AI Classification)

**In your `.env` file or environment variables:**

```env
OPENAI_API_KEY=your_openai_api_key_here
```

**Without this:**

- Decision classification will be skipped
- Decision-based injects won't trigger
- System will log warnings but continue functioning

---

## Step 4: Restart Backend Server

After running migrations:

```bash
# Stop the server (Ctrl+C)
# Then restart
npm run dev
# or
npm start
```

**Why:** The server needs to load the new routes and services.

---

## Step 5: Test the Implementation

### Test 1: Create a Decision (No Type Selection)

1. Start a session with C2E scenario
2. Create a new decision
3. **Verify:** No "Decision Type" dropdown appears
4. Fill in: Title, Description, Required Approvers
5. Submit decision

### Test 2: Execute Decision → AI Classification

1. Approve the decision
2. Execute the decision
3. **Check backend logs** for:
   - "Decision classified and triggers evaluated"
   - AI classification stored
4. **Check database:**
   ```sql
   SELECT id, title, type, ai_classification
   FROM decisions
   WHERE status = 'executed'
   ORDER BY executed_at DESC
   LIMIT 1;
   ```
5. **Verify:** `ai_classification` column has JSON data

### Test 3: Decision-Based Inject Triggering

1. Create a decision like: "Order evacuation of all participants together"
2. Execute it (after media injects M1-M3 have published)
3. **Verify:** Inject "People Refuse Evacuation" auto-publishes
4. **Check:** Inject appears in session timeline

### Test 4: Objective Tracking

1. Start a new session
2. **Verify:** Objectives are initialized automatically
3. **Check database:**
   ```sql
   SELECT * FROM scenario_objective_progress
   WHERE session_id = 'your_session_id';
   ```
4. Execute a decision
5. **Verify:** Objective progress updated
6. **Check API:**
   ```bash
   GET /api/objectives/session/{sessionId}
   GET /api/objectives/session/{sessionId}/score
   ```

---

## Step 6: Verify Decision-Based Injects Were Added

**Check if injects were added:**

```sql
SELECT
  id,
  title,
  trigger_time_minutes,
  trigger_condition,
  type
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'C2E Bombing at Community Event'
  AND si.trigger_condition IS NOT NULL
  AND si.trigger_time_minutes IS NULL
ORDER BY title;
```

**Expected:** 9 decision-based injects (or 10 if you included all suggestions)

---

## Step 7: Test Decision-Based Inject Matching

### Test Case 1: Evacuate Together

**Decision:** "Order evacuation of all participants together, no separation"
**Expected Trigger:** "People Refuse Evacuation" inject

### Test Case 2: Segregate

**Decision:** "Separate Malay evacuees from other participants"
**Expected Trigger:** "Discriminatory Evacuation Causes Backlash" inject

### Test Case 3: Public Statement

**Decision:** "Issue public statement about the situation" (without addressing misinformation)
**Expected Trigger:** "Statement Fails to Counter Misinformation" inject

---

## Step 8: Monitor Backend Logs

**Watch for:**

- ✅ "Decision classified and triggers evaluated"
- ✅ "Objective progress updated"
- ✅ "Auto-published inject based on decision"
- ⚠️ "OpenAI API key not configured" (if key missing)
- ❌ Any errors in classification or trigger evaluation

---

## Step 9: Verify Objectives Auto-Initialize

**When session starts:**

1. Change session status to `in_progress`
2. **Check database:**
   ```sql
   SELECT * FROM scenario_objective_progress
   WHERE session_id = 'your_session_id';
   ```
3. **Expected:** 4 objectives initialized (evacuation, triage, media, coordination)

---

## Step 10: Test Objective Scoring

**Execute decisions and check scores:**

1. **Good Decision:** "Issue statement addressing the false narrative about Malay involvement"
   - Should add bonus to "media" objective
   - Check: `bonuses` array in `scenario_objective_progress`

2. **Poor Decision:** "Separate Malays from other evacuees"
   - Should add penalty to "evacuation" and "media" objectives
   - Check: `penalties` array and reduced `score`

3. **Calculate Overall Score:**
   ```sql
   SELECT * FROM calculate_session_score('your_session_id');
   ```

---

## Troubleshooting

### Issue: Migrations Fail

**Solution:**

- Check if tables already exist
- Run migrations one at a time
- Check for syntax errors in SQL

### Issue: AI Classification Not Working

**Solution:**

- Verify `OPENAI_API_KEY` is set in `.env`
- Check backend logs for API errors
- Verify OpenAI account has credits

### Issue: Decision-Based Injects Not Triggering

**Solution:**

- Verify injects were added (Step 6)
- Check `trigger_condition` format is valid JSON
- Verify media narrative context exists (M1, M2, M3 published)
- Check backend logs for matching errors

### Issue: Objectives Not Initializing

**Solution:**

- Verify migration 026 ran successfully
- Check session status is `in_progress`
- Check backend logs for initialization errors
- Manually initialize: `POST /api/objectives/session/{id}/initialize`

### Issue: TypeScript Errors

**Solution:**

- Run `npm install` to ensure dependencies
- Check `tsconfig.json` includes new files
- Restart TypeScript server in IDE

---

## Optional: Create Frontend Components

**If you want UI for objectives:**

1. **Objective Progress Panel**
   - Display current progress for each objective
   - Show scores, penalties, bonuses
   - Real-time updates via WebSocket

2. **Session Score Dashboard**
   - Overall score display
   - Success level indicator
   - Objective breakdown chart

3. **Decision Impact Indicator**
   - Show how decisions affect objectives
   - Visual feedback on penalties/bonuses

---

## Summary Checklist

- [ ] Run migration 024
- [ ] Run migration 027
- [ ] Run migration 026
- [ ] Verify C2E scenario exists
- [ ] Run migration 025
- [ ] Set OPENAI_API_KEY in .env
- [ ] Restart backend server
- [ ] Test decision creation (no type dropdown)
- [ ] Test decision execution → AI classification
- [ ] Test decision-based inject triggering
- [ ] Test objective initialization
- [ ] Test objective tracking
- [ ] Test session scoring
- [ ] Monitor backend logs
- [ ] Verify all features working

---

**Once all steps are complete, the system is ready for use!**
