# Fix Team Grouping in Incident Assignment

## Problem

Teams (command, evacuation, triage, media, defence, etc.) are being incorrectly grouped by agency based on the roles of team members. Teams are standalone entities and should not be grouped. The user wants teams displayed the same way as in the Team Assignment Modal in the participants section - as a simple flat list.

## Reference Implementation

In `TeamAssignmentModal.tsx` (lines 155-166), teams are displayed as a simple flat dropdown:

- No grouping
- Teams shown in uppercase
- Simple alphabetical list: evacuation, triage, media, communications, logistics, command, medical, security

## Solution

Display teams exactly like in the team assignment modal - as a flat list in a separate section from agency roles.

## Implementation

### 1. Update Backend API

**File**: `server/routes/incidents.ts`

- Remove `determinePrimaryAgency` function entirely - teams don't need agency grouping
- Return teams as a simple array without `primary_agency` field
- Just return team names with their agency roles (for reference only, not for grouping)

### 2. Update Frontend Modal

**File**: `frontend/src/components/Incidents/AssignIncidentModal.tsx`

- Remove all team grouping logic (`teamsByAgency`)
- Show agency roles in one optgroup section labeled "Agency Roles"
- Show teams in a separate optgroup section labeled "Teams"
- Display teams as a flat alphabetical list (like TeamAssignmentModal)
- Format team names as uppercase (matching TeamAssignmentModal style)

## Files to Modify

1. `server/routes/incidents.ts` - Remove agency grouping logic, return simple team list
2. `frontend/src/components/Incidents/AssignIncidentModal.tsx` - Update dropdown to match TeamAssignmentModal style

## Expected Outcome

- Agency roles shown in "Agency Roles" optgroup section
- Teams shown in "Teams" optgroup section as a flat alphabetical list (no sub-grouping)
- Teams displayed in UPPERCASE (matching TeamAssignmentModal)
- No incorrect grouping of teams by agency
- Clear separation between agency roles and teams
- Consistent with team assignment modal in participants section
