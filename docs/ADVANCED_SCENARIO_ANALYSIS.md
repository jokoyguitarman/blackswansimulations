# Advanced Scenario Support Analysis

## Based on: "C2E Bombing at Community Event" Scenario

## Executive Summary

The defense expert's scenario reveals several sophisticated simulation mechanics that need to be implemented or enhanced:

1. **Role-Specific Inject Delivery** (Partially exists, needs enhancement)
2. **Universal vs Team-Specific Injects** (Not implemented)
3. **Conditional/Decision-Dependent Triggers** (Not implemented)
4. **Fog of War / Information Gaps** (Not implemented)
5. **Volunteer Cards / Zone-Specific Information** (Not implemented)
6. **Interdependent Team Actions** (Not implemented)
7. **Time-Based Triggers with Dependencies** (Basic exists, needs enhancement)

---

## 1. Role-Specific Inject Delivery

### Current State

- `affected_roles` field exists in `scenario_injects` table
- Injects can specify which roles see them
- **BUT**: No clear distinction between "universal" and "role-specific" injects
- **BUT**: No filtering in the API to hide injects from non-affected roles

### Required Changes

#### Database Schema Enhancement

```sql
-- Add field to distinguish inject types
ALTER TABLE scenario_injects ADD COLUMN inject_scope VARCHAR(20) DEFAULT 'universal';
-- Values: 'universal', 'role_specific', 'team_specific'

-- Add field for team/group identifiers
ALTER TABLE scenario_injects ADD COLUMN target_teams TEXT[];
-- For team-specific injects: ['evacuation', 'triage', 'media']
```

#### API Changes

- Modify `GET /api/injects` to filter by user's role/team
- Return only:
  - Universal injects (always visible)
  - Role-specific injects where user's role is in `affected_roles`
  - Team-specific injects where user's team is in `target_teams`

#### Frontend Changes

- Different UI indicators for universal vs role-specific injects
- Optional: "Information Available to Others" indicator
- Team-specific injects shown only to relevant teams

---

## 2. Universal vs Team-Specific Injects

### Scenario Requirements

- **Universal Injects**: All teams see simultaneously (e.g., "Explosion occurs")
- **Team-Specific Injects**: Only relevant team sees (e.g., "Evacuation Team: Exit congestion")

### Implementation Strategy

#### New Inject Scope System

1. **Universal** (`inject_scope: 'universal'`)
   - No `affected_roles` or `target_teams` required
   - Visible to ALL participants
   - Examples: Explosion, time announcements, universal delays

2. **Role-Specific** (`inject_scope: 'role_specific'`)
   - Uses `affected_roles` array
   - Only users with matching roles see it
   - Examples: "Police Commander: Intelligence briefing"

3. **Team-Specific** (`inject_scope: 'team_specific'`)
   - Uses `target_teams` array
   - Only users assigned to those teams see it
   - Examples: "Evacuation Team: Exit congestion", "Triage Team: Casualty count unclear"

#### Database Schema

```sql
-- Enhance scenario_injects table
ALTER TABLE scenario_injects
  ADD COLUMN inject_scope VARCHAR(20) DEFAULT 'universal' CHECK (inject_scope IN ('universal', 'role_specific', 'team_specific')),
  ADD COLUMN target_teams TEXT[],
  ADD COLUMN requires_coordination BOOLEAN DEFAULT false;

-- Create team assignments table
CREATE TABLE IF NOT EXISTS session_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  team_name VARCHAR(100) NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id, team_name)
);
```

---

## 3. Conditional/Decision-Dependent Triggers

### Scenario Requirements

Example from document:

- "Inject E3 (suspicious man with backpack) should trigger an internal alert to Media/Comms and Triage teams."
- "Inject M1–M3 should influence Evacuation decisions when residents refuse to stand near Malay families."

### Current State

- Only time-based triggers (`trigger_time_minutes`)
- No conditional triggers based on decisions/actions
- No dependency system

### Required Implementation

#### New Trigger System

```sql
-- Add conditional trigger fields
ALTER TABLE scenario_injects
  ADD COLUMN trigger_type VARCHAR(20) DEFAULT 'time_based' CHECK (trigger_type IN ('time_based', 'conditional', 'decision_dependent', 'state_dependent')),
  ADD COLUMN trigger_conditions JSONB, -- Conditions that must be met
  ADD COLUMN depends_on_injects UUID[], -- Array of inject IDs that must have been published
  ADD COLUMN depends_on_decisions UUID[], -- Array of decision IDs that must be executed
  ADD COLUMN depends_on_state_variables JSONB; -- Scenario state requirements
```

#### Trigger Condition Examples

```json
{
  "trigger_type": "decision_dependent",
  "trigger_conditions": {
    "decision_type": "evacuation_plan",
    "decision_status": "executed",
    "decision_contains": "separate_malays"
  }
}
```

```json
{
  "trigger_type": "conditional",
  "trigger_conditions": {
    "inject_published": ["E3"],
    "requires_teams": ["media", "triage"]
  }
}
```

#### Implementation Logic

1. Create `TriggerEvaluationService`:
   - Evaluates conditions before each inject check
   - Checks if dependencies are met
   - Evaluates scenario state variables
   - Determines if inject should trigger

2. Modify `InjectSchedulerService`:
   - Check both time AND conditions
   - Handle conditional triggers separately from time-based

---

## 4. Fog of War / Information Gaps

### Scenario Requirements

- "Volunteers return with fragmented, partially inaccurate reports"
- "No two accounts match"
- "C2E has no reliable sense of: Number of casualties, Severity of injuries, etc."

### Current State

- All information is accurate and complete
- No mechanism for partial/incomplete information
- No conflicting reports

### Required Implementation

#### Information Uncertainty System

```sql
-- Add uncertainty/accuracy fields to injects
ALTER TABLE scenario_injects
  ADD COLUMN information_accuracy DECIMAL(3,2) DEFAULT 1.0, -- 0.0 to 1.0
  ADD COLUMN information_completeness DECIMAL(3,2) DEFAULT 1.0, -- 0.0 to 1.0
  ADD COLUMN conflicting_reports JSONB, -- Array of alternative/conflicting information
  ADD COLUMN fog_of_war_level VARCHAR(20) DEFAULT 'none'; -- 'none', 'low', 'medium', 'high'
```

#### Example Data Structure

```json
{
  "information_accuracy": 0.7,
  "information_completeness": 0.5,
  "conflicting_reports": [
    {
      "source": "volunteer_1",
      "report": "I saw five people down.",
      "confidence": 0.6
    },
    {
      "source": "volunteer_2",
      "report": "I only saw smoke.",
      "confidence": 0.8
    },
    {
      "source": "volunteer_3",
      "report": "Someone said there is a second device.",
      "confidence": 0.3
    }
  ]
}
```

#### Frontend Display

- Show multiple conflicting reports as separate cards
- Indicate confidence levels
- Show "Information Gaps" indicator
- Allow players to request more information (triggers new injects)

---

## 5. Volunteer Cards / Zone-Specific Information

### Scenario Requirements

- "Volunteers sent to assess the situation return with inconsistent information"
- "They will be given limited, zone-specific observable information (volunteer cards)"
- "No volunteer sees the entire picture"

### Implementation Strategy

#### Volunteer Card System

```sql
-- Create volunteer reports/information cards
CREATE TABLE IF NOT EXISTS volunteer_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id UUID REFERENCES scenario_injects(id),
  zone_name VARCHAR(100) NOT NULL,
  observer_role VARCHAR(100), -- Which volunteer/observer saw this
  information_content JSONB NOT NULL, -- What they observed
  accuracy_level DECIMAL(3,2) DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Link cards to injects
CREATE TABLE IF NOT EXISTS inject_volunteer_cards (
  inject_id UUID REFERENCES scenario_injects(id),
  volunteer_card_id UUID REFERENCES volunteer_cards(id),
  PRIMARY KEY (inject_id, volunteer_card_id)
);
```

#### Zone-Based Information Delivery

- Injects can specify which zones they affect
- Volunteer cards are created per zone
- Teams receive only cards from zones they're assigned to
- Creates natural information gaps

---

## 6. Interdependent Team Actions

### Scenario Requirements

- "Inject E3 should trigger an internal alert to Media/Comms and Triage teams"
- "Inject M1–M3 should influence Evacuation decisions"
- "Inject T3 should prompt Media/Comms to prepare a counter-narrative"

### Implementation Strategy

#### Cross-Team Alert System

```sql
-- Add cross-team notification fields
ALTER TABLE scenario_injects
  ADD COLUMN triggers_alerts_to_teams TEXT[],
  ADD COLUMN influences_decisions JSONB,
  ADD COLUMN requires_coordination BOOLEAN DEFAULT false;
```

#### Decision Influence System

```json
{
  "triggers_alerts_to_teams": ["media", "triage"],
  "influences_decisions": {
    "decision_types": ["evacuation_plan"],
    "influence": "residents_refuse_near_malays"
  }
}
```

#### Coordination Requirements

- When inject requires coordination, create coordination tasks
- Notify relevant teams
- Track coordination completion

---

## 7. Enhanced Time-Based Triggers

### Scenario Requirements

- Precise timing (T+0, T+5, T+6, T+9, T+10, T+11, T+12, T+14, T+15)
- Some triggers depend on previous injects
- Some triggers are conditional on decisions

### Current State

- Basic time-based triggers work
- No dependency system
- No conditional evaluation

### Required Enhancement

#### Dependency Chain System

```sql
-- Add dependency tracking
ALTER TABLE scenario_injects
  ADD COLUMN dependency_chain_level INTEGER DEFAULT 0,
  ADD COLUMN depends_on_inject_ids UUID[],
  ADD COLUMN min_time_after_dependency INTEGER; -- Minutes after dependency trigger
```

#### Scheduler Enhancement

- Evaluate dependencies before triggering
- Respect timing constraints
- Handle circular dependencies
- Log dependency chain for AAR

---

## 8. Team Assignment System

### Current State

- Users have roles (e.g., "police_commander")
- No team assignments within sessions
- No team-specific interfaces

### Required Implementation

#### Team Management

```sql
-- Teams table (already designed above)
CREATE TABLE IF NOT EXISTS session_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  team_name VARCHAR(100) NOT NULL,
  team_role VARCHAR(100), -- Optional: role within team
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id, team_name)
);

-- Team definitions per scenario
CREATE TABLE IF NOT EXISTS scenario_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  team_name VARCHAR(100) NOT NULL,
  team_description TEXT,
  required_roles TEXT[],
  min_participants INTEGER DEFAULT 1,
  max_participants INTEGER
);
```

#### Team Assignment UI

- Trainer assigns users to teams during session setup
- Users can see their team assignments
- Team-specific dashboards/interfaces

---

## 9. Media/Misinformation System

### Scenario Requirements

- "Viral video circulates"
- "Misinformation spreads"
- "Racial accusations emerge online"
- "Journalists arrive early"

### Required Implementation

#### Media Posts Table

```sql
CREATE TABLE IF NOT EXISTS media_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform VARCHAR(50), -- 'tiktok', 'instagram', 'telegram', 'whatsapp', 'news'
  content_type VARCHAR(50), -- 'video', 'image', 'text', 'audio'
  content_url TEXT,
  content_text TEXT,
  author_type VARCHAR(50), -- 'bystander', 'journalist', 'misinformation', 'official'
  sentiment VARCHAR(20), -- 'neutral', 'positive', 'negative', 'inflammatory'
  is_misinformation BOOLEAN DEFAULT false,
  is_viral BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Misinformation Tracking

- Track misinformation posts
- Track viral spread
- Influence public sentiment
- Require counter-messaging from Media team

---

## 10. Implementation Priority

### Phase 1: Core Requirements (Critical)

1. ✅ Role-specific inject filtering (enhance existing)
2. ✅ Universal vs team-specific injects
3. ✅ Team assignment system
4. ✅ Conditional triggers (basic)

### Phase 2: Advanced Features (High Priority)

5. ⚠️ Fog of war / information gaps
6. ⚠️ Volunteer cards / zone-specific info
7. ⚠️ Decision-dependent triggers
8. ⚠️ Cross-team coordination

### Phase 3: Polish (Medium Priority)

9. ⚠️ Enhanced time-based triggers with dependencies
10. ⚠️ Media/misinformation system (if not exists)

---

## 11. Data Model Changes Summary

### New Tables

- `session_teams` - Team assignments per session
- `scenario_teams` - Team definitions per scenario
- `volunteer_cards` - Zone-specific information cards
- `media_posts` - Social media/news posts
- `inject_dependencies` - Dependency tracking (optional, or use JSONB)

### Modified Tables

- `scenario_injects` - Add:
  - `inject_scope` (universal/role_specific/team_specific)
  - `target_teams`
  - `trigger_type` (time_based/conditional/decision_dependent)
  - `trigger_conditions` (JSONB)
  - `depends_on_injects` (UUID[])
  - `depends_on_decisions` (UUID[])
  - `information_accuracy`
  - `information_completeness`
  - `conflicting_reports` (JSONB)
  - `triggers_alerts_to_teams`
  - `requires_coordination`

---

## 12. API Changes Required

### New Endpoints

- `POST /api/sessions/:id/teams` - Assign teams
- `GET /api/sessions/:id/teams` - Get team assignments
- `GET /api/sessions/:id/volunteer-cards` - Get zone-specific info
- `POST /api/injects/:id/evaluate-trigger` - Check if conditional trigger should fire

### Modified Endpoints

- `GET /api/injects?session_id=:id` - Filter by role/team
- `POST /api/injects` - Support new fields
- `GET /api/sessions/:id/events` - Include team-specific filtering

---

## 13. Frontend Changes Required

### New Components

- Team Assignment UI
- Volunteer Card Display
- Conflicting Reports Viewer
- Information Gap Indicators
- Cross-Team Coordination Panel

### Modified Components

- Inject Display - Show scope (universal/team-specific)
- Timeline Feed - Filter by team visibility
- COP Dashboard - Team-specific views
- Decision Creation - Show influenced injects

---

## Next Steps

1. **Review and approve this analysis**
2. **Create migration scripts** for database changes
3. **Implement Phase 1 features** (core requirements)
4. **Test with simplified version** of the C2E scenario
5. **Iterate based on feedback**

---

## Questions for Discussion

1. Should team assignments be **per-session** or **per-scenario**?
2. How should **fog of war** be represented in the UI? Multiple conflicting reports at once?
3. Should **conditional triggers** be evaluated in real-time or batch?
4. How do we prevent **information leakage** between teams? (Technical + UX)
5. Should **volunteer cards** be auto-generated or manually created by trainers?
