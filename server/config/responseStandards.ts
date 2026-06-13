/**
 * Canonical social-media crisis response standard.
 *
 * Source: internal framework "Evaluating Social Media Crisis Communication:
 * A Framework for Strategic Excellence". This replaces the per-scenario
 * `researchGeneralBestPractices` AI call so every social-crisis scenario is
 * graded against one consistent, auditable standard.
 *
 * Consumed at runtime via `scenarios.initial_state.research_guidelines` by:
 *  - contentGraderService (grades player posts against best_practice/source_basis)
 *  - socialCrisisAiService.shouldCancelSocialInject (AI cancellation gate)
 *  - buildSOPFromResearch (SOP timing + content guidelines)
 */

import type { ResearchGuidelines } from '../services/socialCrisisGeneratorService.js';

export const RESPONSE_STANDARDS: ResearchGuidelines = {
  per_team: [
    {
      team_name: 'Crisis Response Team',
      guidelines: [
        {
          guideline_id: 'speed_quick',
          best_practice:
            'Acknowledge the crisis quickly to pre-empt the information vacuum, and immediately freeze all pre-scheduled marketing content.',
          source_basis: 'Attribute 1: Speed of Communication',
          timing_window: 'First 5-10 minutes',
          if_violated:
            'A silence vacuum forms; speculation, misinformation and "internet warriors" become the primary source of truth.',
          if_followed:
            'The brand becomes the immediate anchor of reliable information and reclaims the narrative.',
          detection_signals: [
            'official_response_exists',
            'sop_step_publish_completed',
            'player_post_count_gt_3',
          ],
        },
        {
          guideline_id: 'speed_accurate',
          best_practice:
            'Verify potential causes and remedies before publishing; never trade accuracy for raw speed.',
          source_basis: 'Attribute 1: Speed of Communication (Accurate)',
          timing_window: 'Before each public statement',
          if_violated:
            'Errors are distributed at scale, forcing later retractions that erode credibility.',
          if_followed: 'Statements hold up under scrutiny and avoid secondary correction crises.',
          detection_signals: ['sop_step_fact_check_completed', 'facts_confirmed'],
        },
        {
          guideline_id: 'transparency_rule_of_three',
          best_practice:
            'Apply the Rule of Three: Tell the Truth, Tell it All, Tell it Fast. Avoid selective disclosure and canned messages.',
          source_basis: 'Attribute 2: Transparency and Honesty (Murphy, 2015)',
          timing_window: 'Throughout the response',
          if_violated:
            'Gaps invite stakeholders to become investigators who denounce the brand for a perceived cover-up; a secondary crisis of character ignites.',
          if_followed:
            'Controlling the full timeline reduces the impact of external allegations and builds trust.',
          detection_signals: [
            'signal_addresses_specific_claims',
            'player_addressed_fake_news_spiral',
            'team_flagged_misinformation',
          ],
        },
        {
          guideline_id: 'victim_centered',
          best_practice:
            'Centre the people affected (Stakeholder Theory over Shareholder Supreme). Match the level of empathy and accommodation to the crisis cluster: Victim (low responsibility), Accidental (moderate), Preventable (high - full apology and compensation).',
          source_basis: 'Attribute 3: Victim-Centered Communication',
          timing_window: 'From first acknowledgement onward',
          if_violated:
            'Imbalanced stakeholder relations and a profit-first posture cause catastrophic reputational harm.',
          if_followed:
            'Demonstrating "ethics of care and justice" establishes a universal ethical foundation that transcends the event.',
          detection_signals: [
            'signal_acknowledged_affected_parties',
            'signal_no_collective_blame',
            'signal_includes_safety_info',
            'signal_includes_actionable_guidance',
          ],
        },
        {
          guideline_id: 'ethical_posture_rdap',
          best_practice:
            'Move up the RDAP scale toward a Proactive posture - anticipate responsibility and do more than is required, rather than Reactive (denying) or Defensive (admitting but fighting).',
          source_basis: 'Attribute 4: Ethical Posture (RDAP Scale)',
          timing_window: 'Strategic, sustained',
          if_violated:
            'A reactive/defensive posture reads as doing the bare minimum and signals weak corporate character.',
          if_followed:
            'A proactive posture (passing the Universal Law and Humanity-as-an-End tests) projects leadership and integrity.',
          detection_signals: ['community_leader_contacted', 'player_used_leader_amplification'],
        },
        {
          guideline_id: 'consistency_core_narrative',
          best_practice:
            'Maintain one Core Narrative and a unified voice across every platform (Facebook, X, corporate site) using a response grid.',
          source_basis: 'Attribute 5: Consistency of Message Across Mediums',
          timing_window: 'Every published message',
          if_violated:
            'Message fragmentation - conflicting information across platforms - is read as dishonesty or incompetence.',
          if_followed: 'A consistent, unified voice reinforces credibility and control.',
          detection_signals: [
            'player_message_is_consistent_across_channels',
            'player_executed_multi_platform_blitz',
          ],
        },
        {
          guideline_id: 'clarity_language',
          best_practice:
            'Use thoughtful, concise, human language. Clarity de-escalates and is a defence against disinformation and bot exploitation; vague messaging drives stakeholders to competitors.',
          source_basis: 'Attribute 6: Clarity of Message',
          timing_window: 'Every published message',
          if_violated:
            'Unclear messaging is exploited by bad actors to propagate misinformation and pushes stakeholders away.',
          if_followed:
            'Clean, empathetic communication addresses legitimate concerns and isolates malicious actors.',
          detection_signals: ['player_posted_official_statement', 'player_pinned_verified_update'],
        },
      ],
    },
  ],
  group_wide: {
    coordination_guidelines: [
      'Maintain a single Core Narrative; every responder and page speaks with one unified voice.',
      'Treat every crisis as a "Public Perception" crisis - damage is measured by how stakeholders perceive the response.',
      'Facilitate discourse in the comments so stakeholders feel heard rather than managed.',
    ],
    escalation_protocols: [
      'Match posture to the crisis cluster and aim for Proactive on the RDAP scale (anticipate responsibility, do more than required).',
      'For Preventable-cluster crises (organisational misdeed/human error), escalate to full apology and compensation ("rebuild" strategy).',
      'Brief leadership early and secure approval before publishing high-stakes statements.',
    ],
    timing_benchmarks: {
      first_response_minutes: 10,
      misinformation_debunk_minutes: 30,
    },
    case_studies: [],
  },
};
