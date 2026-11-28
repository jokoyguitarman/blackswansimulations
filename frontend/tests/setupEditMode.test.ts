import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { editBannerText, editNumberFromAllowance, recompileTooltips, remainingBesideApply } from '../src/lib/editModeBanner.ts';
import {
  canMakePrimary,
  editModeFlags,
  isExistingOrg,
  readSetupEditLink,
  removedExistingTeams,
} from '../src/lib/editModeFlags.ts';
import { swapMakePrimary } from '../src/lib/makePrimary.ts';
import {
  applyBlockedByPlan,
  completeOrphanDecision,
  orphanChoiceLabel,
  orphanTargetField,
} from '../src/lib/orphanGating.ts';
import { removalConfirmText, reviewSections } from '../src/lib/reviewSections.ts';
import { editHistoryLine, editHistoryWho, lobbySetupNotice, visibleEditHistory } from '../src/lib/setupEditHistory.ts';
import { withRenamedTeams, withoutRenamedTeams } from '../src/lib/teamRename.ts';
import { composeTeamName } from '../../shared/teamNames.ts';

const link = {
  edit_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  scenario_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  scenario_title: 'Harbour leak',
  remaining: 2,
};

describe('edit mode flags and banner', () => {
  test('edit mode is on only when the draft carries a setup edit', () => {
    assert.equal(readSetupEditLink({}), null);
    assert.equal(readSetupEditLink({ setup_edit: { edit_id: 'x' } }), null);
    const read = readSetupEditLink({ setup_edit: link });
    assert.equal(read?.edit_id, link.edit_id);
    assert.equal(read?.remaining, 2);
    const flags = editModeFlags({ link: read, draftMissing: false, makePrimaryKey: null });
    assert.equal(flags.editMode, true);
    assert.equal(flags.adminEdit, false);
    assert.equal(flags.primaryRemoveDisabled, true);
    assert.equal(flags.primaryRemoveTitle, 'Make another organisation primary first');
  });

  test('a missing draft and an admin edit are flagged', () => {
    const admin = readSetupEditLink({ setup_edit: { ...link, remaining: null } });
    const flags = editModeFlags({ link: admin, draftMissing: true, makePrimaryKey: 'org_bravo' });
    assert.equal(flags.missingDraft, true);
    assert.equal(flags.adminEdit, true);
    assert.equal(flags.primaryRemoveTitle, 'The primary organisation cannot be removed.');
  });

  test('the banner counts the edit and what is left after it', () => {
    assert.equal(
      editBannerText({ title: 'Harbour leak', editNumber: 2, limit: 3, remaining: 2 }),
      'Editing setup of Harbour leak: edit 2 of 3 (1 left after this)',
    );
    assert.equal(
      editBannerText({ title: 'Harbour leak', editNumber: 1, limit: 3, remaining: null }),
      'Editing setup of Harbour leak: Admin edit: not counted',
    );
    assert.equal(editNumberFromAllowance(1, 2, 3), 2);
    assert.equal(remainingBesideApply(2), '1 left after this');
    assert.equal(remainingBesideApply(null), 'Admin edit: not counted');
  });

  test('the two recompile actions keep distinct tooltips', () => {
    const off = recompileTooltips({ enabled: false, remaining: 3, limit: 3 });
    assert.equal(off.edit, null);
    assert.match(off.modify, /scenario credit/);
    const on = recompileTooltips({ enabled: true, remaining: 2, limit: 3 });
    assert.equal(on.edit, 'Change this scenario in place (2 of 3 edits left)');
    assert.match(on.modify, /separate new scenario/);
  });

  test('only a non-primary players organisation can be made primary', () => {
    assert.equal(canMakePrimary({ operation: 'players', isCurrentPrimary: false }), true);
    assert.equal(canMakePrimary({ operation: 'ai', isCurrentPrimary: false }), false);
    assert.equal(canMakePrimary({ isCurrentPrimary: true }), false);
  });
});

describe('make primary', () => {
  const primary = {
    org_key: 'primary',
    org_uid: 'uid-acme',
    display_name: 'Acme',
    short_name: 'ACME',
    country: 'Singapore',
    city: '',
    kind: 'company',
    facebook_handle: '',
    x_handle: '',
    team_roster: [{ team_name: 'Communications', description: '', is_custom: false, is_public_voice: true, team_uid: 't1' }],
  };
  const bravo = {
    id: 'bravo',
    org_key: 'org_bravo_sg',
    org_uid: 'uid-bravo',
    display_name: 'Bravo',
    short_name: 'BRAVO',
    country: 'Malaysia',
    city: 'Johor',
    kind: 'company',
    facebook_handle: '',
    x_handle: '',
    operation: 'players' as const,
    team_roster: [{ team_name: 'Legal', description: '', is_custom: false, is_public_voice: true, team_uid: 't2' }],
  };

  const previousFrom = (slot: typeof primary) => ({
    id: slot.org_uid || slot.org_key,
    display_name: slot.display_name,
    short_name: slot.short_name,
    country: slot.country,
    city: slot.city,
    kind: slot.kind,
    facebook_handle: slot.facebook_handle,
    x_handle: slot.x_handle,
    team_roster: slot.team_roster,
    operation: 'players' as const,
    org_key: slot.org_key,
    org_uid: slot.org_uid,
  });

  test('swaps the primary slot and undo restores it', () => {
    const swapped = swapMakePrimary(primary, [bravo], 'bravo', 'primary', previousFrom);
    assert.ok(swapped);
    assert.equal(swapped.primary.org_key, 'org_bravo_sg');
    assert.equal(swapped.primary.country, 'Malaysia');
    assert.equal(swapped.makePrimaryKey, 'org_bravo_sg');
    assert.equal(swapped.extras[0]?.org_key, 'primary');
    assert.equal(swapped.extras[0]?.display_name, 'Acme');
    const undone = swapMakePrimary(swapped.primary, swapped.extras, swapped.extras[0].id, 'primary', previousFrom);
    assert.equal(undone?.primary.org_key, 'primary');
    assert.equal(undone?.makePrimaryKey, null);
    assert.equal(undone?.extras[0]?.org_key, 'org_bravo_sg');
  });

  test('an AI-operated organisation cannot become primary', () => {
    assert.equal(swapMakePrimary(primary, [{ ...bravo, operation: 'ai' }], 'bravo', 'primary', previousFrom), null);
  });
});

describe('review sections and orphan gating', () => {
  const plan = {
    teams: {
      retire: [
        { team_uid: 'old', team_name: 'Old desk', reason: 'removed', source_id: 's1' },
        { team_uid: 'renamed', team_name: 'Press', reason: 'renamed', source_id: 's2' },
      ],
      successors: [{ team_uid: 'renamed', team_name: 'Press', from_name: 'Media', reason: 'renamed' }],
    },
    injects: { retire: [{ inject_id: 'i1', inject_key: 'old_note', reason: 'team_layer' }] },
    orphans: [{ id: 'role:cs', kind: 'player_role', message: 'Move the role', choices: ['reassign', 'move_to_retired'] }],
    scheduled_sessions: [{ session_id: 'sess', unassigned_players: [{ user_id: 'u', team_name: 'Old desk' }] }],
  };
  const outputs = [
    {
      stage: 'storyline',
      skipped: false,
      revisions: [
        {
          inject_id: 'inj-1',
          inject_key: 'dawn',
          decision: 'revise',
          write: 'in_place',
          reason: 'The hour changed.',
          new: { title: 'Dawn note', content: 'It started at dawn.' },
        },
        { inject_id: 'inj-keep', inject_key: 'same', decision: 'keep', write: 'none', reason: 'Unchanged' },
      ],
      flags: [{ inject_id: 'hand-1', inject_key: 'trainer_note', reason: 'Names the old company.', provenance: 'hand_edited' }],
      generated: { team_storylines: { Logistics: [] }, stakeholders: [{ id: 's', name: 'Mina' }] },
    },
    { stage: 'pages', skipped: true, revisions: [], flags: [] },
  ];

  test('sections split adds, renames, removals, revisions, flags and orphans', () => {
    const sections = reviewSections(plan, outputs);
    const titles = sections.map((section) => section.title);
    assert.deepEqual(titles, [
      'Added',
      'Renamed',
      'Removed / retired',
      'Revised by the brief change',
      'Hand-edited content flagged',
      'Needs your decision',
    ]);
    const revised = sections.find((section) => section.id === 'revised');
    assert.equal(revised?.keepAllOriginals, true);
    assert.equal(revised?.rows.some((row) => row.injectId === 'inj-keep'), false);
    assert.equal(revised?.rows[0]?.reason, 'The hour changed.');
    assert.equal(revised?.rows[0]?.rejectable, true);
    const flagged = sections.find((section) => section.id === 'flagged');
    assert.equal(flagged?.rows[0]?.reason, 'Names the old company.');
    assert.equal(flagged?.keepAllOriginals, false);
    const removed = sections.find((section) => section.id === 'removed');
    assert.equal(removed?.rows.some((row) => row.title === 'Press'), false);
    assert.equal(removed?.rows.some((row) => row.title === 'Old desk'), true);
  });

  test('apply waits for a plan with no orphans left', () => {
    assert.equal(applyBlockedByPlan({ plan: null, planning: false }), true);
    assert.equal(applyBlockedByPlan({ plan: { applicable: false, orphans: [{ id: 'role:cs' }] }, planning: false }), true);
    assert.equal(applyBlockedByPlan({ plan: { applicable: true, orphans: [] }, planning: true }), true);
    assert.equal(applyBlockedByPlan({ plan: { applicable: true, orphans: [] }, planning: false }), false);
    assert.equal(orphanChoiceLabel('move_to_retired'), 'move to retired');
  });

  test('each orphan kind gets the picker its resolution needs', () => {
    const catalogs = { teams: ['Legal', 'Press'], injectKeys: ['dawn_note'], orgKeys: ['primary', 'org_bravo'] };
    assert.equal(orphanTargetField({ id: 'r', kind: 'player_role' }, 'reassign'), 'team_name');
    assert.equal(orphanTargetField({ id: 's', kind: 'stakeholder' }, 'reassign'), 'team_name');
    assert.equal(orphanTargetField({ id: 'p', kind: 'pressure_targets' }, 'retarget'), 'org_keys');
    assert.equal(orphanTargetField({ id: 'm', kind: 'mood_consequence' }, 'retarget'), 'inject_key');
    assert.equal(orphanTargetField({ id: 'c', kind: 'condition', target_key: 'old' }, 'retarget'), 'inject_key');
    assert.equal(orphanTargetField({ id: 'c2', kind: 'condition' }, 'retarget'), 'team_name');
    assert.equal(orphanTargetField({ id: 'ch', kind: 'chain_target' }, 'retarget'), 'team_name');
    assert.equal(
      orphanTargetField({ id: 'd', kind: 'team_dependency', condition_key: 'fired|team=old' }, 'retarget'),
      'team_name',
    );
    assert.equal(orphanTargetField({ id: 'd2', kind: 'team_dependency', target_key: 'old' }, 'retarget'), 'inject_key');
    assert.equal(orphanTargetField({ id: 'd3', kind: 'team_dependency' }, 'reassign'), 'team_name');
    assert.equal(orphanTargetField({ id: 'r', kind: 'player_role' }, 'move_to_retired'), null);
    assert.equal(
      completeOrphanDecision({ id: 'r', kind: 'player_role' }, 'reassign', { team_name: 'P' }, catalogs),
      null,
    );
    assert.deepEqual(
      completeOrphanDecision({ id: 'r', kind: 'player_role' }, 'reassign', { team_name: 'Legal' }, catalogs),
      { choice: 'reassign', team_name: 'Legal' },
    );
    assert.deepEqual(
      completeOrphanDecision({ id: 'p', kind: 'pressure_targets' }, 'retarget', { org_keys: ['primary'] }, catalogs),
      { choice: 'retarget', org_keys: ['primary'] },
    );
    assert.deepEqual(
      completeOrphanDecision({ id: 'c', kind: 'condition' }, 'retire_inject', {}, catalogs),
      { choice: 'retire' },
    );
  });

  test('removal confirmation uses the dry-run counts', () => {
    assert.equal(
      removalConfirmText(plan),
      'Removes 1 team, retires 1 inject, unassigns 1 player in 1 scheduled session.',
    );
  });
});

describe('edit history and the lobby notice', () => {
  const rows = [
    { id: '1', status: 'applied', opened_by_admin: false, opened_by_name: 'Amina', edit_number: 1, created_at: 'a', applied_at: 'b' },
    { id: '2', status: 'applied', opened_by_admin: true, opened_by_name: 'Jo', edit_number: null, created_at: 'c', applied_at: 'd' },
    { id: '3', status: 'abandoned', opened_by_admin: false, edit_number: null, created_at: 'e', applied_at: null },
    { id: '4', status: 'failed', opened_by_admin: true, edit_number: null, created_at: 'f', applied_at: null },
    { id: '5', status: 'open', opened_by_admin: false, edit_number: null, created_at: 'g', applied_at: null },
  ];

  test('trainers see applied edits and admins also see abandoned and failed ones', () => {
    assert.deepEqual(visibleEditHistory(rows, false).map((row) => row.id), ['1', '2']);
    assert.deepEqual(visibleEditHistory(rows, true).map((row) => row.id), ['1', '2', '3', '4']);
  });

  test('admin edits are labelled and not counted, and the summary is one line', () => {
    assert.equal(editHistoryWho(rows[1]), 'Admin edit · not counted');
    assert.equal(editHistoryWho(rows[0]), 'Amina');
    assert.equal(
      editHistoryLine({ teams_added: 1, teams_succeeded: 1, teams_retired: 3, injects_retired: 4, primary_swap: true }),
      '1 team added, 1 renamed, 2 teams removed, 4 injects updated, primary organisation changed',
    );
  });

  test('the lobby names what changed and how many players were unassigned', () => {
    const notice = lobbySetupNotice(
      [
        {
          summary: {
            teams_added: 1,
            teams_succeeded: 1,
            teams_retired: 2,
            unassigned_players: 9,
            new_teams: ['Logistics'],
            unassigned_by_session: [
              { session_id: 'sess-a', count: 3 },
              { session_id: 'sess-b', count: 6 },
            ],
          },
        },
      ],
      'sess-a',
    );
    assert.equal(
      notice,
      'Setup changed since this session was created: new teams Logistics, renamed 1, removed 1 (3 players unassigned)',
    );
    assert.equal(lobbySetupNotice([], 'sess-a'), null);
  });
});

describe('team rename', () => {
  test('an existing team takes the new short name and undo clears it', () => {
    const roster = [
      { team_name: 'Communications', description: '', is_custom: false, is_public_voice: true, team_uid: 't1', function_key: 'Communications' },
      { team_name: 'Night desk', description: '', is_custom: true, is_public_voice: false },
    ];
    const renamed = withRenamedTeams(roster, 'BRAVO', true);
    assert.equal(renamed[0]?.display_name, composeTeamName('Communications', { short_name: 'BRAVO' }, true));
    assert.equal(renamed[1]?.display_name, undefined);
    assert.equal(withoutRenamedTeams(renamed)[0]?.display_name, undefined);
    assert.equal(composeTeamName('Communications', { short_name: 'BRAVO' }, false), 'Communications');
  });

  test('a new org key is not existing, and only baseline teams need a removal preview', () => {
    const baseline = new Set(['primary', 'org_bravo_sg']);
    assert.equal(isExistingOrg('org_bravo_sg', baseline), true);
    assert.equal(isExistingOrg('org_fresh', baseline), false);
    assert.equal(isExistingOrg(undefined, baseline), false);
    const before = [
      { team_uid: 'uid-legal', team_name: 'Legal' },
      { team_uid: 'uid-new', team_name: 'Night desk' },
      { team_name: 'Draft' },
    ];
    const after = [{ team_uid: 'uid-new', team_name: 'Night desk' }];
    assert.deepEqual(
      removedExistingTeams(before, after, new Set(['uid-legal'])).map((team) => team.team_uid),
      ['uid-legal'],
    );
    assert.deepEqual(removedExistingTeams(before, after, new Set(['uid-other'])), []);
  });
});
