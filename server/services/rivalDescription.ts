/**
 * Trainer-written rival descriptions. Pure: the page prompt quotes them, and a
 * non-empty description becomes the runtime stance. There is no second field.
 */

export const RIVAL_DESCRIPTION_MAX = 600;

export const TRAINER_STANCE_INSTRUCTION =
  'When a competitor includes "Trainer\'s description", follow it: use that description as the rival\'s stance, and write its voice and branded history so they agree. Do not replace a trainer description.';

export interface RivalPromptEntry {
  name: string;
  country?: string;
  city?: string;
  kind?: string;
  description?: string;
}

/** One line of the prompt. Internal whitespace is collapsed so the line stays one line. */
export function promptDescription(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

export function competitorPromptLine(entry: RivalPromptEntry, index: number): string {
  const loc = entry.country
    ? ` — ${entry.city ? `${entry.city}, ` : ''}${entry.country}${entry.kind ? ` (${entry.kind})` : ''}`
    : '';
  const head = `  COMPETITOR ${index + 1} [ref C${index + 1}]: ${entry.name}${loc}`;
  const description = promptDescription(entry.description);
  return description ? `${head}\n    Trainer's description: ${description}` : head;
}

/** Competitor block for the page prompt. The follow-it instruction appears only when a description does. */
export function competitorPromptSection(competitors: RivalPromptEntry[]): string {
  if (competitors.length === 0) return '';
  const lines = competitors.map((entry, index) => competitorPromptLine(entry, index)).join('\n');
  const guided = competitors.some((entry) => promptDescription(entry.description) !== '');
  return guided ? `${lines}\n${TRAINER_STANCE_INSTRUCTION}` : lines;
}

/**
 * The trainer wins. A non-empty description is the stance; otherwise the model's
 * stance is kept. Whitespace-only text on either side counts as absent.
 */
export function stanceFromTrainer(
  generatedStance: unknown,
  trainerDescription: string | undefined,
): string | undefined {
  const trainer = trainerDescription?.trim();
  if (trainer) return trainer;
  if (generatedStance == null) return undefined;
  const generated = String(generatedStance).trim();
  return generated || undefined;
}
