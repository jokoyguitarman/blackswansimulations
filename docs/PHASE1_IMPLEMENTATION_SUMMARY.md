# Phase 1 Implementation Summary

## Team Assignments and Enhanced Inject Scoping

**Status**: ✅ **COMPLETE**

---

## What Was Implemented

### 1. Database Schema ✅

#### New Tables

- **`scenario_teams`**: Defines available teams for a scenario
  - Fields: `id`, `scenario_id`, `team_name`, `team_description`, `required_roles[]`, `min_participants`, `max_participants`
- **`session_teams`**: Tracks team assignments for users within a session
  - Fields: `id`, `session_id`, `user_id`, `team_name`, `team_role`, `assigned_by`, `assigned_at`
  - Unique constraint: `(session_id, user_id, team_name)`

#### Enhanced Tables

- **`scenario_injects`**: Added new fields:
  - `inject_scope`: `'universal'` | `'role_specific'` | `'team_specific'` (default: `'universal'`)
  - `target_teams`: `TEXT[]` - Array of team names (used when `inject_scope = 'team_specific'`)
  - `requires_coordination`: `BOOLEAN` - Whether inject requires multi-team coordination

#### RLS Policies

- Full RLS policies added for both new tables
- Trainers/admins can manage team assignments
- Users can view their own team assignments

**Migration File**: `migrations/011_team_assignments_and_inject_scoping.sql`

---

### 2. Backend API ✅

#### New Endpoints (`/api/teams`)

- **`GET /api/teams/session/:id`**: Get all team assignments for a session
- **`POST /api/teams/session/:id/assign`**: Assign user to team
- **`DELETE /api/teams/session/:id/assign`**: Remove team assignment
- **`GET /api/teams/scenario/:id`**: Get team definitions for a scenario
- **`POST /api/teams/scenario/:id`**: Create team definition

#### Enhanced Endpoints

- **`GET /api/injects`**: Now filters injects based on:
  - `inject_scope = 'universal'` → Visible to all
  - `inject_scope = 'role_specific'` → Only if user's role in `affected_roles`
  - `inject_scope = 'team_specific'` → Only if user in one of `target_teams`
- **`POST /api/injects`**: Accepts new fields:
  - `inject_scope`
  - `target_teams`
  - `requires_coordination`

- **`POST /api/injects/:id/publish`**: Broadcast includes scope information

#### Schema Validation

- Updated Zod schemas to validate new inject fields
- Supports `null` for optional fields

**Files Modified**:

- `server/routes/injects.ts`
- `server/routes/scenarios.ts`
- `server/routes/teams.ts` (new file)
- `server/index.ts` (route registration)

---

### 3. Frontend Components ✅

#### New Components

- **`TeamAssignmentModal.tsx`**:
  - UI for trainers to assign users to teams
  - Shows current team assignments
  - Supports adding/removing assignments
  - Available teams: evacuation, triage, media, communications, logistics, command, medical, security

#### Enhanced Components

- **`CreateInjectForm.tsx`**:
  - New field: `inject_scope` dropdown (universal/role_specific/team_specific)
  - Conditional fields based on scope:
    - Role-specific: Shows `affected_roles` checkboxes (required)
    - Team-specific: Shows `target_teams` checkboxes (required)
    - Universal: Shows `affected_roles` checkboxes (optional)
  - New checkbox: `requires_coordination`

- **`AIInjectSystem.tsx`**:
  - Displays inject scope badge: `[UNIVERSAL]`, `[ROLE-SPECIFIC]`, or `[TEAM-SPECIFIC]`
  - Shows target teams for team-specific injects
  - Shows `[REQUIRES_COORDINATION]` badge when applicable

- **`SessionView.tsx`**:
  - Added "Manage Teams" button in participants tab (trainers only)
  - Integrated `TeamAssignmentModal`

#### API Client

- Added `api.teams.*` methods:
  - `getSessionTeams(sessionId)`
  - `assignTeam(sessionId, userId, teamName, teamRole?)`
  - `removeTeamAssignment(sessionId, userId, teamName)`
  - `getScenarioTeams(scenarioId)`
  - `createScenarioTeam(...)`

**Files Modified**:

- `frontend/src/lib/api.ts`
- `frontend/src/components/Forms/CreateInjectForm.tsx`
- `frontend/src/components/Injects/AIInjectSystem.tsx`
- `frontend/src/pages/SessionView.tsx`
- `frontend/src/components/Teams/TeamAssignmentModal.tsx` (new file)

---

## How It Works

### Inject Filtering Logic

1. **Universal Injects** (`inject_scope = 'universal'`)
   - Always visible to all participants
   - No filtering applied

2. **Role-Specific Injects** (`inject_scope = 'role_specific'`)
   - Only visible if user's role is in `affected_roles` array
   - Example: Only `police_commander` sees injects with `affected_roles: ['police_commander']`

3. **Team-Specific Injects** (`inject_scope = 'team_specific'`)
   - Only visible if user is assigned to one of the teams in `target_teams` array
   - Example: Only users in `['evacuation', 'triage']` teams see injects with `target_teams: ['evacuation', 'triage']`
   - Requires team assignment via `TeamAssignmentModal`

### Team Assignment Flow

1. **Trainer assigns teams**:
   - Navigate to session → Participants tab → "Manage Teams" button
   - Select participant and team
   - Click "Assign"
   - User is now in that team

2. **Team-specific injects become visible**:
   - When inject with `inject_scope = 'team_specific'` is published
   - Backend checks if user is in one of `target_teams`
   - If yes → inject appears in their feed
   - If no → inject is filtered out

3. **Users can see their teams**:
   - Users can view their team assignments (read-only)
   - Team assignments shown in participants tab

---

## Example Usage

### Creating a Team-Specific Inject

1. **Trainer creates inject**:

   ```typescript
   {
     title: "Exit congestion at Gate B",
     content: "More than 150 people attempting to leave simultaneously...",
     inject_scope: "team_specific",
     target_teams: ["evacuation"],
     severity: "high",
     // ...
   }
   ```

2. **Only evacuation team members see this inject** when it's published

### Creating a Role-Specific Inject

1. **Trainer creates inject**:

   ```typescript
   {
     title: "Intelligence briefing",
     content: "New threat assessment available...",
     inject_scope: "role_specific",
     affected_roles: ["intelligence_analyst", "police_commander"],
     severity: "medium",
     // ...
   }
   ```

2. **Only intelligence analysts and police commanders see this inject**

---

## Testing Checklist

- [x] Database migration runs successfully
- [x] Team assignment API endpoints work
- [x] Inject creation accepts new fields
- [x] Inject list filters correctly by scope
- [x] Team assignment UI displays correctly
- [x] Inject display shows scope indicators
- [x] Create inject form supports all scope types

## Next Steps (Phase 2)

- Conditional/decision-dependent triggers
- Fog of war / information gaps
- Volunteer cards / zone-specific information
- Cross-team coordination requirements
- Enhanced time-based triggers with dependencies

---

## Files Changed

### Backend

- `migrations/011_team_assignments_and_inject_scoping.sql` (new)
- `server/routes/teams.ts` (new)
- `server/routes/injects.ts` (modified)
- `server/routes/scenarios.ts` (modified)
- `server/index.ts` (modified)

### Frontend

- `frontend/src/components/Teams/TeamAssignmentModal.tsx` (new)
- `frontend/src/components/Forms/CreateInjectForm.tsx` (modified)
- `frontend/src/components/Injects/AIInjectSystem.tsx` (modified)
- `frontend/src/pages/SessionView.tsx` (modified)
- `frontend/src/lib/api.ts` (modified)

---

**Implementation Date**: 2025-01-13
**Status**: ✅ Complete and ready for testing
