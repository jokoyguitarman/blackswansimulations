# Role-Based Information Blind Spots System

## Overview

The Unified Simulation Environment implements a **role-based information visibility system** that creates strategic blind spots for each player class. This design forces inter-agency communication and information sharing, making the simulation more realistic and challenging.

## Design Philosophy

In real crisis situations, agencies don't have perfect information. Each agency has:

- **Visible Information**: Data they naturally have access to based on their role
- **Blind Spots**: Information they cannot see and must request from other agencies
- **Communication Requirements**: The need to coordinate and share information

This creates authentic training scenarios where:

- Players must actively communicate to get complete situational awareness
- Information gaps create realistic decision-making challenges
- Coordination becomes critical for effective crisis response

## How It Works

### 1. Information Types

The system defines 24+ information types that can be visible or hidden:

- `incidents` - All incidents and their details
- `casualties` - Casualty counts and medical data
- `intelligence` - Intelligence reports and classified intel
- `public_sentiment` - Public sentiment metrics
- `infrastructure_status` - Infrastructure and utility status
- `resources` - Resource availability and allocations
- And many more...

### 2. Role Visibility Configuration

Each role has a configuration in `shared/roleVisibility.ts` that defines:

- **Visible**: Information types the role can see automatically
- **Hidden**: Information types that are blind spots (must request)
- **Description**: Explanation of the role's information perspective

### 3. UI Implementation

- **ClassifiedBlocker Component**: Wraps information and shows "CLASSIFIED" for blind spots
- **Role-Specific Dashboards**: Different dashboards for trainers vs. agency roles
- **Visual Indicators**: Clear warnings about blind spots and communication requirements

## Role Blind Spot Examples

### Defence Liaison

**Can See:**

- Incidents and locations
- Defence assets
- Intelligence reports
- Weather data

**Blind Spots (Must Request):**

- Casualties (from Health)
- Health capacity (from Health)
- Police operations (from Police)
- Utility status (from Utilities)
- Public sentiment (from PIO)

### Police Commander

**Can See:**

- Incidents and locations
- Police operations
- Public sentiment (public safety concerns)
- Media reports

**Blind Spots (Must Request):**

- Casualties (from Health)
- Defence assets (from Defence)
- Intelligence (from Intelligence Analyst)
- Utility status (from Utilities)
- Financial data (from Civil Government)

### Health Director

**Can See:**

- Casualties
- Health capacity
- Health-related incidents
- Weather data (affects health planning)

**Blind Spots (Must Request):**

- Defence assets (from Defence)
- Police operations (from Police)
- Intelligence (from Intelligence Analyst)
- Public sentiment (from PIO)
- Infrastructure status (from Utilities)

### Public Information Officer

**Can See:**

- Media reports
- Public sentiment
- Public-facing decisions
- Public incidents (limited detail)

**Blind Spots (Must Request):**

- Exact incident locations (classified)
- Casualties (from Health)
- Defence assets (from Defence)
- Police operations (from Police)
- Intelligence (from Intelligence Analyst)
- Infrastructure status (from Utilities)

### Utility Manager

**Can See:**

- Infrastructure status
- Utility status
- Weather data
- Infrastructure-related incidents

**Blind Spots (Must Request):**

- Casualties (from Health)
- Defence assets (from Defence)
- Police operations (from Police)
- Intelligence (from Intelligence Analyst)
- Public sentiment (from PIO)
- Financial data (from Civil Government)

### Intelligence Analyst

**Can See:**

- Intelligence reports
- Incidents and locations
- Public sentiment (for analysis)
- Media reports (for analysis)
- All decisions (for analysis)

**Blind Spots (Must Request):**

- Casualties (from Health)
- Defence assets (from Defence)
- Police operations (from Police)
- Utility status (from Utilities)
- Financial data (from Civil Government)

### NGO Liaison

**Can See:**

- NGO activities
- Casualties (for humanitarian aid)
- Public sentiment (for community needs)
- Media reports

**Blind Spots (Must Request):**

- Exact incident locations (classified)
- Defence assets (from Defence)
- Police operations (from Police)
- Intelligence (from Intelligence Analyst)
- Infrastructure status (from Utilities)
- Financial data (from Civil Government)

### Civil Government

**Can See:**

- Financial data
- Political pressure
- Public sentiment
- Government decisions
- Approval chains

**Blind Spots (Must Request):**

- Casualties (from Health)
- Defence assets (from Defence)
- Police operations (from Police)
- Intelligence (from Intelligence Analyst)
- Utility status (from Utilities)
- Infrastructure status (from Utilities)

### Trainer/Admin

**Can See:**

- **EVERYTHING** (full system visibility)
- Trainer notes
- AI injects
- Complete timeline

**Blind Spots:**

- None (for exercise oversight)

## Communication Requirements

To access blind spot information, players must:

1. **Use Communication Channels**: Request information via the communication system
2. **Specify Information Type**: Clearly state what information is needed
3. **Wait for Response**: Other agencies can choose to share or withhold information
4. **Build Trust**: Effective communication builds inter-agency trust

## Benefits

1. **Realistic Training**: Mirrors real-world information silos
2. **Forces Communication**: Players must actively coordinate
3. **Strategic Gameplay**: Information becomes a strategic resource
4. **Decision Challenges**: Incomplete information creates realistic dilemmas
5. **Team Building**: Encourages collaboration and trust-building

## Technical Implementation

### Files

- `shared/roleVisibility.ts` - Visibility configuration
- `frontend/src/hooks/useRoleVisibility.ts` - React hook for visibility checks
- `frontend/src/components/ClassifiedBlocker.tsx` - Component to hide information
- `frontend/src/components/dashboards/TrainerDashboard.tsx` - Trainer view
- `frontend/src/components/dashboards/AgencyDashboard.tsx` - Agency role view

### Usage Example

```tsx
import { ClassifiedBlocker } from '../components/ClassifiedBlocker';

<ClassifiedBlocker informationType="casualties">
  <CasualtyReport data={casualties} />
</ClassifiedBlocker>;
```

If the user's role cannot see `casualties`, they'll see a "CLASSIFIED" blocker instead.

## Future Enhancements

1. **Information Sharing API**: Backend endpoints to request/share information
2. **Communication Channels**: Real-time chat for information requests
3. **Information Trading**: Negotiate information exchanges
4. **Trust Metrics**: Track which agencies share information reliably
5. **Information Leaks**: Simulate accidental information disclosure
6. **Time Delays**: Information requests take time to process
7. **Partial Information**: Some roles get partial/redacted information
