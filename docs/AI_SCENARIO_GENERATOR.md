# AI Scenario Generator

## Overview

The AI Scenario Generator is an integrated feature that uses OpenAI's GPT models to automatically generate complete, detailed scenarios from minimal user input. This dramatically speeds up scenario creation and ensures high-quality, realistic crisis management scenarios.

## Features

### ✅ Complete Scenario Generation

- **Title**: Descriptive scenario name
- **Description**: 3-4 paragraph detailed scenario description
- **Category**: Automatically matched to selected category
- **Difficulty**: Matched to selected difficulty level
- **Duration**: Uses specified duration
- **Objectives**: Multiple learning objectives
- **Initial State**: Scenario starting conditions
- **Suggested Injects**: AI-generated event injections with timing

### ✅ Smart Prompting

- **Context Field**: Optional background information (e.g., "Major city during peak hours")
- **Specific Requirements**: Optional constraints (e.g., "Must involve cyber attack")
- **Category & Difficulty**: Pre-selected from form
- **Duration**: Pre-selected from form

### ✅ Automatic Inject Creation

- When a scenario is saved with AI-generated suggested injects, they are automatically created in the database
- Injects include:
  - Trigger timing (minutes into scenario)
  - Type (media_report, field_update, citizen_call, etc.)
  - Title and content
  - Severity level
  - Affected roles

## Usage

### For Trainers

1. **Navigate to Scenarios** → Click `[CREATE_SCENARIO]`
2. **Click `[AI_GENERATE]`** button in the form header
3. **Fill in prompts** (optional):
   - **Context**: Background information about the scenario setting
   - **Specific Requirements**: Any specific elements you want included
4. **Set basic parameters**:
   - Category (cyber, infrastructure, etc.)
   - Difficulty (beginner to expert)
   - Duration (15-480 minutes)
5. **Click `[GENERATE_SCENARIO]`**
6. **Review generated content**:
   - Title, description, and objectives are auto-filled
   - Suggested injects are displayed below the form
7. **Edit as needed** before saving
8. **Click `[CREATE_SCENARIO]`** to save

### Example Prompts

**Context:**

```
A major metropolitan area during morning rush hour. Multiple critical infrastructure systems are interconnected. The city has a population of 2 million with limited emergency response resources.
```

**Specific Requirements:**

```
Must involve a coordinated cyber attack targeting power grid and transportation systems. Should test inter-agency communication and resource sharing. Include elements of public panic and media pressure.
```

## Technical Implementation

### Backend

**API Endpoint:** `POST /api/ai/scenarios/generate`

**Request:**

```json
{
  "category": "cyber",
  "difficulty": "advanced",
  "duration_minutes": 90,
  "context": "Optional context...",
  "specific_requirements": "Optional requirements..."
}
```

**Response:**

```json
{
  "data": {
    "title": "AI Generated Scenario Title",
    "description": "Detailed scenario description...",
    "category": "cyber",
    "difficulty": "advanced",
    "duration_minutes": 90,
    "objectives": ["Objective 1", "Objective 2", ...],
    "initial_state": {...},
    "suggested_injects": [...]
  }
}
```

**Service:** `server/services/aiService.ts`

- Uses OpenAI GPT-4o-mini (cost-effective)
- Structured JSON output
- Error handling and logging

### Frontend

**Component:** `frontend/src/components/Forms/CreateScenarioForm.tsx`

- Toggle AI generator panel
- Prompt input fields
- Generation status indicator
- Display suggested injects
- Auto-populate form fields

**API Client:** `frontend/src/lib/api.ts`

- `api.ai.generateScenario()` method

## Security

- ✅ **Trainer-only access**: Only trainers and admins can use AI generation
- ✅ **API key protection**: OpenAI API key stored server-side only
- ✅ **Input validation**: All prompts validated and sanitized
- ✅ **Rate limiting**: Protected by existing API rate limits
- ✅ **Error handling**: Graceful error messages, no API key exposure

## Configuration

### Required Environment Variable

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
```

Get your API key from: https://platform.openai.com/api-keys

### Model Selection

Currently using `gpt-4o-mini` for cost-effectiveness. Can be changed in `server/services/aiService.ts`:

```typescript
model: 'gpt-4o-mini', // Change to 'gpt-4o' or 'gpt-4-turbo' for higher quality
```

## Cost Considerations

- **gpt-4o-mini**: ~$0.15 per 1M input tokens, ~$0.60 per 1M output tokens
- **Average scenario generation**: ~500-1000 tokens total
- **Estimated cost per scenario**: $0.001-0.002 (less than 1 cent)

## Future Enhancements

- [ ] Template-based generation (pre-defined scenario templates)
- [ ] Multi-language support
- [ ] Scenario refinement (regenerate specific parts)
- [ ] Inject timing optimization
- [ ] Real-world scenario database integration
- [ ] Custom AI model fine-tuning

## Troubleshooting

### "Failed to generate scenario"

- Check `OPENAI_API_KEY` is set in `.env`
- Verify API key is valid and has credits
- Check server logs for detailed error messages

### "OpenAI API key not configured"

- Ensure `OPENAI_API_KEY` is in your `.env` file
- Restart the server after adding the key

### Poor quality scenarios

- Try providing more detailed context
- Specify specific requirements
- Adjust difficulty level
- Consider using a more powerful model (gpt-4o)
