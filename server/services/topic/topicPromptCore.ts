import { matchesLeakTerms } from '../generation/peaceFeedCore.js';
import {
  formatPersonaStanceLine,
  isCompetitorPersona,
  MEDIA_REACT_LINE,
  reactionTypesAndRules,
  REACTION_ITEM_SCHEMA,
} from './reactionPromptShared.js';

export type TopicLabel = 'on_topic' | 'bridge' | 'off_topic' | 'crisis' | 'unclassified';
export type TopicPhase = 'not_started' | 'peace' | 'crisis';
export type PostKind = 'normal' | 'crisis';
export type BridgeStance = 'engage' | 'stay';

export interface StancePersona {
  handle: string;
  type: string;
  personality: string;
  bias: string;
  tier?: string;
}

export interface AssignedStance {
  handle: string;
  stance: BridgeStance;
  /** Engage probability after adjustments, before the page-force and stay floor. */
  engageProbability: number;
  forcedEngage: boolean;
}

const LABEL_SET = new Set<TopicLabel>([
  'on_topic',
  'bridge',
  'off_topic',
  'crisis',
  'unclassified',
]);

/** FNV-1a mapped onto [0, 1). Stable across processes. */
export function unitFromSeed(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function isBiasedPersona(persona: StancePersona): boolean {
  const bias = persona.bias.trim().toLowerCase();
  return bias !== '' && bias !== 'none' && !bias.includes('supportive');
}

function isSupportiveOrNone(persona: StancePersona): boolean {
  const bias = persona.bias.trim().toLowerCase();
  return bias === '' || bias === 'none' || bias.includes('supportive');
}

/**
 * Engage share is `1 - stayShare` (default stay share 0.4, so 0.6 engage).
 * Media, politicians, competitors and biased personas gain 0.25.
 * Background-tier personas, and supportive or none-bias personas, lose 0.25.
 * A page author forces media and competitors to engage.
 * Three or more personas include one stay unless every persona was forced to engage.
 * In that case the page force wins and there is no stay.
 */
export function assignBridgeStances(
  selected: ReadonlyArray<{ persona: StancePersona }>,
  seed: string,
  options?: {
    authorIsPage?: boolean;
    stayShare?: number;
    unit?: (key: string) => number;
  },
): AssignedStance[] {
  const stayShare = options?.stayShare ?? 0.4;
  const unit = options?.unit ?? unitFromSeed;
  const authorIsPage = options?.authorIsPage === true;
  const base = 1 - stayShare;

  const drawn = selected.map((entry) => {
    const persona = entry.persona;
    let probability = base;
    const media = persona.type === 'npc_media';
    const politician = persona.type === 'npc_politician';
    const competitor = isCompetitorPersona(persona);
    if (media || politician || competitor || isBiasedPersona(persona)) probability += 0.25;
    if (persona.tier === 'background' || isSupportiveOrNone(persona)) probability -= 0.25;
    probability = Math.min(1, Math.max(0, probability));
    const roll = unit(`${seed}\n${persona.handle}`);
    const forcedEngage = authorIsPage && (media || competitor);
    const stance: BridgeStance = forcedEngage || roll < probability ? 'engage' : 'stay';
    return {
      handle: persona.handle,
      stance,
      engageProbability: probability,
      forcedEngage,
      roll,
    };
  });

  if (drawn.length >= 3 && drawn.every((row) => row.stance === 'engage')) {
    const candidates = drawn.filter((row) => !row.forcedEngage);
    if (candidates.length > 0) {
      const flip = candidates.reduce((best, row) => (row.roll > best.roll ? row : best));
      flip.stance = 'stay';
    }
  }

  return drawn.map(({ handle, stance, engageProbability, forcedEngage }) => ({
    handle,
    stance,
    engageProbability,
    forcedEngage,
  }));
}

export function isCrisisActivity(input: {
  phase: TopicPhase;
  label: TopicLabel;
  postKind: PostKind;
}): boolean {
  if (input.phase !== 'crisis') return false;
  if (input.label === 'bridge' || input.label === 'crisis' || input.label === 'unclassified') {
    return true;
  }
  return input.label === 'on_topic' && input.postKind === 'crisis';
}

export interface TopicReply {
  author_handle?: string;
  content?: string;
  [key: string]: unknown;
}

export interface TopicCheckResult {
  label: TopicLabel;
  bridgeTopic: string;
  confidence: number | null;
  reactions: TopicReply[];
  dropped: Array<{ handle: string; content: string }>;
}

function parseClassification(
  raw: unknown,
  isReply: boolean,
): { label: TopicLabel; bridgeTopic: string; confidence: number | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const labelRaw = typeof record.label === 'string' ? record.label.trim() : '';
  if (!LABEL_SET.has(labelRaw as TopicLabel) || labelRaw === 'unclassified') return null;
  if (labelRaw === 'crisis' && isReply) return null;
  const confidenceRaw = Number(record.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : null;
  const bridgeTopic = typeof record.bridge_topic === 'string' ? record.bridge_topic.trim() : '';
  return { label: labelRaw as TopicLabel, bridgeTopic, confidence };
}

function stanceFor(
  handle: string,
  stances: ReadonlyMap<string, BridgeStance> | Readonly<Record<string, BridgeStance>>,
): BridgeStance {
  const lower = handle.toLowerCase();
  if (stances instanceof Map) {
    const direct = stances.get(handle);
    if (direct) return direct;
    for (const [key, value] of stances) {
      if (key.toLowerCase() === lower) return value;
    }
    return 'stay';
  }
  const record = stances as Readonly<Record<string, BridgeStance>>;
  if (record[handle]) return record[handle];
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower) return value;
  }
  return 'stay';
}

/**
 * Downgrades a low-confidence bridge, rejects an invalid label, and drops replies
 * that name leak terms when the label is not an engaging bridge (or the post is a
 * normal post and the label is unclassified).
 */
export function checkTopicReplies(input: {
  classification: unknown;
  reactions: readonly TopicReply[];
  stances: ReadonlyMap<string, BridgeStance> | Readonly<Record<string, BridgeStance>>;
  leakTerms: readonly string[];
  postKind: PostKind;
  isReply: boolean;
  minConfidence: number;
}): TopicCheckResult {
  const parsed = parseClassification(input.classification, input.isReply);
  let label: TopicLabel = parsed?.label ?? 'unclassified';
  let bridgeTopic = parsed?.bridgeTopic ?? '';
  let confidence = parsed?.confidence ?? null;

  if (label === 'bridge' && (confidence == null || confidence < input.minConfidence)) {
    label = 'off_topic';
    bridgeTopic = '';
  }

  const leakCheck =
    label === 'unclassified'
      ? input.postKind === 'normal'
      : label !== 'bridge' && label !== 'crisis';

  const reactions: TopicReply[] = [];
  const dropped: Array<{ handle: string; content: string }> = [];
  for (const reaction of input.reactions) {
    const handle = String(reaction.author_handle || '');
    const content = String(reaction.content || '');
    const stance = stanceFor(handle, input.stances);
    const drop =
      matchesLeakTerms(content, input.leakTerms) &&
      (leakCheck || (label === 'bridge' && stance === 'stay'));
    if (drop) {
      dropped.push({ handle, content });
      continue;
    }
    reactions.push(reaction);
  }

  if (label === 'unclassified') {
    bridgeTopic = '';
    confidence = null;
  }

  return { label, bridgeTopic, confidence, reactions, dropped };
}

export interface TopicPromptPersona {
  handle: string;
  name: string;
  personality: string;
  bias: string;
  type: string;
  reactionType: string;
  stance: BridgeStance;
}

export interface TopicPromptInput {
  phase: TopicPhase;
  postFormat: string;
  playerHandle: string;
  playerContent: string;
  imagePrompt?: string;
  authorIsPage: boolean;
  orgName: string;
  topicKind: PostKind;
  parent: {
    content: string;
    authorHandle: string;
    authorDisplayName?: string;
    authorType?: string;
    topicKind: PostKind;
  } | null;
  threadReplies: Array<{ authorHandle: string; content: string }>;
  addressedComment: { handle: string; content: string } | null;
  personas: TopicPromptPersona[];
  crisisDescription: string;
  /** Included only outside peace. The caller omits crisis facts during peace. */
  officialScrutinyBlock: string;
  /** Official-statement format or a page post. Drives attack/cover wording, same as the legacy prompt. */
  isOfficialComms: boolean;
  isReply: boolean;
}

const PERSONAL_AUTHOR_BLOCK =
  "This is an individual. Personas treat it as one person's opinion: friends-and-followers tone, less formality. Media rarely pick it up unless it is inflammatory. Nobody treats it as the organisation's position, unless the person identifies themselves as staff.";

/** The §5.3 peace block. DM, email and stakeholder prompts use this same sentence. */
export function topicPeaceBlock(orgName: string): string {
  const org = orgName.trim() || 'the organisation';
  return `Ordinary day. Nothing unusual has happened to ${org}. If someone mentions an incident, a recall, an accident or a scandal you have not heard of, react with mild confusion, ask what they mean, or ignore it. Never invent details.`;
}

export const TOPIC_CLASSIFICATION_OBJECT =
  '{ "label": "on_topic|bridge|off_topic|crisis", "bridge_topic": "short phrase or empty", "confidence": 0.0 }';

/** Missing or invalid classification, including `crisis` on a reply. */
export function readTopicClassification(
  raw: unknown,
  isReply: boolean,
): { label: TopicLabel; bridgeTopic: string; confidence: number | null } {
  return (
    parseClassification(raw, isReply) ?? {
      label: 'unclassified',
      bridgeTopic: '',
      confidence: null,
    }
  );
}

function authorBlock(authorIsPage: boolean, orgName: string): string {
  if (!authorIsPage) return PERSONAL_AUTHOR_BLOCK;
  const org = orgName.trim() || 'the organisation';
  return `This is ${org} speaking officially. Personas judge it as the brand's voice: they expect a professional tone and hold the organisation to what it says. A page that jokes or jabs about another organisation's crisis is newsworthy: media and competitor personas are more likely to engage, quote it, and question whether it's appropriate. Customers react as customers (service, product, deals).`;
}

/**
 * Post context first, then persona stances, then a fenced crisis block
 * (or the peace block), then the page-versus-personal author block.
 */
export function buildTopicAwareReactionPrompt(input: TopicPromptInput): {
  system: string;
  user: string;
} {
  const subject = input.parent
    ? {
        content: input.parent.content,
        authorHandle: input.parent.authorHandle,
        authorDisplayName: input.parent.authorDisplayName || '',
        authorKind: input.parent.authorType === 'official_account' ? 'page' : 'person',
        topicKind: input.parent.topicKind,
      }
    : {
        content: input.playerContent,
        authorHandle: input.playerHandle,
        authorDisplayName: '',
        authorKind: input.authorIsPage ? 'page' : 'person',
        topicKind: input.topicKind,
      };

  const threadLines = input.threadReplies
    .map((reply) => `${reply.authorHandle}: "${reply.content}"`)
    .join('\n');

  const personaLines = input.personas
    .map((persona) => formatPersonaStanceLine(persona, persona.reactionType, persona.stance))
    .join('\n');

  const postContext = `Your replies are about THIS post and THIS exchange.

POST CONTEXT:
Author: ${subject.authorHandle}${subject.authorDisplayName ? ` (${subject.authorDisplayName})` : ''} (${subject.authorKind})
Topic kind: ${subject.topicKind}
Format: ${input.postFormat}
"${subject.content}"${
    input.parent
      ? `\n\nTHREAD:\n${threadLines || '(no earlier replies)'}`
      : '\n\nThis is a top-level post. There is no parent thread.'
  }${
    input.addressedComment
      ? `\n\nThe player is SPECIFICALLY responding to ${input.addressedComment.handle}'s comment: "${input.addressedComment.content}"`
      : ''
  }

COMMENT BEING ANSWERED:
${input.playerHandle}: "${input.playerContent}"${input.imagePrompt ? `\n[Attached media: ${input.imagePrompt}]` : ''}`;

  const personaBlock = `PERSONAS:
${personaLines}`;

  const crisisOrPeace =
    input.phase === 'peace'
      ? `PEACE:\n${topicPeaceBlock(input.orgName)}`
      : `CRISIS CONTEXT: use ONLY if you label the comment \`bridge\`, and ONLY for personas whose stance is \`engage\`. Personas with \`stay\` reply about the post as if the remark were a passing jab (ignore it, deflect, or tease back about the post). For \`on_topic\` or \`off_topic\`, never mention the crisis.
${input.crisisDescription}${input.orgName ? `\nOrganization: ${input.orgName}` : ''}`;

  const author = `AUTHOR:\n${authorBlock(input.authorIsPage, input.orgName)}`;

  const labelRule = input.isReply
    ? 'This is a reply. classification.label must be on_topic, bridge, or off_topic. Do not use crisis.'
    : 'This is a top-level post. Use classification.label crisis when the post is about the crisis, otherwise on_topic, bridge, or off_topic.';

  const scrutiny =
    input.phase === 'peace' || !input.officialScrutinyBlock
      ? ''
      : `\n${input.officialScrutinyBlock.trim()}\n`;

  const system = `${postContext}

${personaBlock}

${crisisOrPeace}

${author}
${scrutiny}
${reactionTypesAndRules(input.playerHandle, input.isOfficialComms)}
- ${labelRule}
Each reaction should be 1-3 sentences, feel like a real social media reply/post. Stay in character.${input.isReply ? ' Since this is a thread reply, respond DIRECTLY to what the player said -- argue, agree, counter, or react to their specific words.' : ''}
${MEDIA_REACT_LINE}

Return ONLY valid JSON:
{ "classification": ${TOPIC_CLASSIFICATION_OBJECT}, "reactions": [${REACTION_ITEM_SCHEMA}] }`;

  const user = `Player post by ${input.playerHandle}:\n"${input.playerContent}"${input.imagePrompt ? `\n\n[Attached media: ${input.imagePrompt}]` : ''}`;
  return { system, user };
}

export { PERSONAL_AUTHOR_BLOCK };
