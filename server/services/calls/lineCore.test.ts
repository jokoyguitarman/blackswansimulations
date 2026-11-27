import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  callbackAllowed,
  claimLineVersion,
  DEFAULT_CALL_POLICY,
  midRingHolderDelta,
  onlineForAssignment,
  pickAutofill,
  planOfflineReassignment,
  resolveCallRingSet,
  resolveMessageRecipients,
  resolveUniversalLine,
  type RingSetInput,
} from './lineCore.js';

const members = {
  'Customer Service': [
    { user_id: 'aisha', is_bot: false },
    { user_id: 'ben', is_bot: false },
    { user_id: 'bot', is_bot: true },
  ],
  Operations: [{ user_id: 'dev', is_bot: false }],
  Legal: [{ user_id: 'chen', is_bot: false }],
};

function input(partial: Partial<RingSetInput>): RingSetInput {
  return {
    mode: 'line',
    targetTeams: ['Customer Service'],
    rolePlayers: { cs_head: ['aisha'] },
    roleTeam: { cs_head: 'Customer Service' },
    roleFallback: 'none',
    holdersByTeam: { 'Customer Service': ['ben'] },
    teamMembers: members,
    recipientsRingAll: null,
    online: () => true,
    busy: () => false,
    policy: DEFAULT_CALL_POLICY,
    ...partial,
  };
}

describe('resolveCallRingSet', () => {
  test('a role call rings only the role player, even when someone else holds the line', () => {
    const ringing = resolveCallRingSet(input({ mode: 'role', targetRoleId: 'cs_head' }));
    assert.deepEqual(ringing[0]?.ring, ['aisha']);
    assert.equal(ringing[0]?.mode_used, 'role');
    assert.equal(ringing[0]?.ring.includes('ben'), false);

    const busy = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'cs_head', busy: (id) => id === 'aisha', policy: { ...DEFAULT_CALL_POLICY, overflow_when_busy: true } }),
    );
    assert.equal(busy[0]?.outcome, 'role_busy');
    assert.deepEqual(busy[0]?.call_waiting, ['aisha']);
    assert.deepEqual(busy[0]?.ring, []);

    const offline = resolveCallRingSet(input({ mode: 'role', targetRoleId: 'cs_head', online: () => false }));
    assert.equal(offline[0]?.outcome, 'role_offline');
    assert.equal(offline[0]?.fallback_reason, undefined);

    const fallback = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'cs_head', roleFallback: 'line', online: (id) => id !== 'aisha' }),
    );
    assert.equal(fallback[0]?.fallback_reason, 'role_offline_fallback');
    assert.deepEqual(fallback[0]?.ring, ['ben']);
    assert.equal(fallback[0]?.mode_used, 'line');
  });

  test('unassigned, vacated and unknown roles fall back to the team line', () => {
    const unassigned = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'cs_head', rolePlayers: { cs_head: [] } }),
    );
    assert.equal(unassigned[0]?.fallback_reason, 'role_unassigned');
    assert.deepEqual(unassigned[0]?.ring, ['ben']);

    const vacated = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'cs_head', rolePlayers: { cs_head: [] }, vacatedRoleIds: ['cs_head'] }),
    );
    assert.equal(vacated[0]?.fallback_reason, 'role_vacated');

    const unknown = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'ghost', targetTeams: ['Legal'], rolePlayers: {}, roleTeam: {} }),
    );
    assert.equal(unknown[0]?.fallback_reason, 'unknown_role');
    assert.equal(unknown[0]?.line_team, 'Legal');

    const nowhere = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'ghost', targetTeams: [], rolePlayers: {}, roleTeam: {}, holdersByTeam: {} }),
    );
    assert.equal(nowhere[0]?.fallback_reason, 'unknown_role');
    assert.deepEqual(nowhere[0]?.ring, []);
  });

  test('line mode rings free holders, waits when they are busy, and can overflow', () => {
    const both = resolveCallRingSet(
      input({ holdersByTeam: { 'Customer Service': ['aisha', 'ben'] } }),
    );
    assert.deepEqual(both[0]?.ring, ['aisha', 'ben']);

    const oneBusy = resolveCallRingSet(
      input({ holdersByTeam: { 'Customer Service': ['aisha', 'ben'] }, busy: (id) => id === 'aisha' }),
    );
    assert.deepEqual(oneBusy[0]?.ring, ['ben']);

    const bothBusy = resolveCallRingSet(
      input({ holdersByTeam: { 'Customer Service': ['aisha', 'ben'] }, busy: () => true }),
    );
    assert.equal(bothBusy[0]?.outcome, 'line_busy');
    assert.deepEqual(bothBusy[0]?.call_waiting, ['aisha', 'ben']);

    const none = resolveCallRingSet(input({ online: () => false }));
    assert.equal(none[0]?.outcome, 'line_unattended');

    const overflow = resolveCallRingSet(
      input({
        holdersByTeam: { 'Customer Service': ['aisha'] },
        busy: (id) => id === 'aisha',
        policy: { ...DEFAULT_CALL_POLICY, overflow_when_busy: true },
      }),
    );
    assert.deepEqual(overflow[0]?.ring, ['ben']);
    assert.equal(overflow[0]?.ring.includes('bot'), false);
  });

  test('player mode, ring_all and the universal line rule', () => {
    const player = resolveCallRingSet(input({ mode: 'player', playerUserId: 'chen', targetTeams: [] }));
    assert.deepEqual(player[0]?.ring, ['chen']);
    assert.equal(player[0]?.mode_used, 'player');

    const groups = resolveCallRingSet(
      input({
        mode: 'ring_all',
        targetTeams: ['Customer Service', 'Legal'],
        recipientsRingAll: ['aisha', 'ben', 'bot'],
        busy: (id) => id === 'ben',
        teamMembers: {
          'Customer Service': members['Customer Service'],
          Legal: [{ user_id: 'ben', is_bot: false }],
        },
      }),
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.mode_used, 'ring_all');
    assert.deepEqual(groups[0]?.ring, ['aisha']);
    assert.equal(groups[1]?.outcome, 'line_busy');

    assert.deepEqual(resolveUniversalLine({ owningTeam: 'Legal', stakeholderTeam: 'Press', sessionTeams: ['Legal'] }), {
      team: 'Legal',
      warn: false,
    });
    assert.equal(
      resolveUniversalLine({ owningTeam: 'Missing', stakeholderTeam: 'Press', sessionTeams: ['Legal'] }).team,
      'Press',
    );
    const warn = resolveUniversalLine({ owningTeam: null, stakeholderTeam: null, sessionTeams: ['Legal'] });
    assert.equal(warn.team, null);
    assert.equal(warn.warn, true);
  });

  test('a redial is held while the role player is offline and rings when they return', () => {
    const held = resolveCallRingSet(
      input({
        mode: 'role',
        targetRoleId: 'cs_head',
        online: () => false,
        heldForRole: () => true,
      }),
    );
    assert.equal(held[0]?.outcome, 'held');
    const back = resolveCallRingSet(
      input({ mode: 'role', targetRoleId: 'cs_head', online: () => true, heldForRole: () => false }),
    );
    assert.deepEqual(back[0]?.ring, ['aisha']);
  });
});

describe('lobby auto-fill and line maintenance', () => {
  test('auto-fill picks one online human for an empty line and refuses when presence is off', () => {
    const filled = pickAutofill({
      presenceEnabled: true,
      randomInt: () => 0,
      teams: [
        {
          team_name: 'Customer Service',
          holders: [],
          members: [
            { user_id: 'bot', is_bot: true, online: true },
            { user_id: 'aisha', is_bot: false, online: true },
          ],
        },
        {
          team_name: 'Legal',
          holders: ['chen'],
          members: [{ user_id: 'chen', is_bot: false, online: true }],
        },
      ],
    });
    assert.equal(filled.ok, true);
    if (filled.ok) assert.deepEqual(filled.picks, [{ team_name: 'Customer Service', user_id: 'aisha' }]);
    const blind = pickAutofill({
      presenceEnabled: false,
      randomInt: () => 0,
      teams: [{ team_name: 'Customer Service', holders: [], members: [{ user_id: 'aisha', is_bot: false, online: true }] }],
    });
    assert.deepEqual(blind, { ok: false, code: 'presence_unavailable' });
  });

  test('offline reassignment keeps a covered line, replaces the only holder, and stays quiet in boot grace', () => {
    const covered = planOfflineReassignment({
      holders: [
        { user_id: 'aisha', online: false },
        { user_id: 'ben', online: true },
      ],
      members: [],
      enginesOn: true,
      bootGrace: false,
      reassignOnOffline: true,
      randomInt: () => 0,
    });
    assert.equal(covered.action, 'none');

    const moved = planOfflineReassignment({
      holders: [{ user_id: 'aisha', online: false }],
      members: [
        { user_id: 'aisha', is_bot: false, online: false },
        { user_id: 'ben', is_bot: false, online: true },
        { user_id: 'bot', is_bot: true, online: true },
      ],
      enginesOn: true,
      bootGrace: false,
      reassignOnOffline: true,
      randomInt: () => 0,
    });
    assert.deepEqual(moved, { action: 'reassign', deactivate: ['aisha'], assign: 'ben' });

    const grace = planOfflineReassignment({
      holders: [{ user_id: 'aisha', online: false }],
      members: [{ user_id: 'ben', is_bot: false, online: true }],
      enginesOn: true,
      bootGrace: true,
      reassignOnOffline: true,
      randomInt: () => 0,
    });
    assert.equal(grace.action, 'skip_boot_grace');
  });

  test('a trainer add rings and a trainer remove withdraws', () => {
    const delta = midRingHolderDelta({
      previousHolders: ['aisha'],
      nextHolders: ['ben'],
      ringNewHolders: true,
    });
    assert.deepEqual(delta.ring, ['ben']);
    assert.deepEqual(delta.withdraw, ['aisha']);
  });

  test('call-back permission follows the policy, and role players are always allowed', () => {
    assert.equal(
      callbackAllowed({
        callbackBy: 'any_team_member',
        isTeamMember: true,
        isHolder: false,
        isRoleCall: false,
        isRolePlayer: false,
      }).allowed,
      true,
    );
    const rejected = callbackAllowed({
      callbackBy: 'line_holders',
      isTeamMember: true,
      isHolder: false,
      isRoleCall: false,
      isRolePlayer: false,
    });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.code, 'callback_not_allowed');
    assert.equal(
      callbackAllowed({
        callbackBy: 'line_holders',
        isTeamMember: true,
        isHolder: false,
        isRoleCall: true,
        isRolePlayer: true,
      }).allowed,
      true,
    );
  });

  test('two claims of the same line version: only the first succeeds', () => {
    const first = claimLineVersion(3, 3);
    assert.equal(first.ok, true);
    assert.equal(first.next, 4);
    const second = claimLineVersion(first.next, 3);
    assert.equal(second.ok, false);
  });

  test('with engines off, an active assignee is treated as online', () => {
    assert.equal(
      onlineForAssignment({ enginesOn: false, activeAssignee: true, presenceOnline: false, bootGrace: false }),
      true,
    );
    assert.equal(
      onlineForAssignment({ enginesOn: true, activeAssignee: true, presenceOnline: false, bootGrace: false }),
      false,
    );
    const groups = resolveCallRingSet(
      input({
        online: (id) =>
          onlineForAssignment({
            enginesOn: false,
            activeAssignee: id === 'ben',
            presenceOnline: false,
            bootGrace: false,
          }),
      }),
    );
    assert.deepEqual(groups[0]?.ring, ['ben']);
  });
});

describe('resolveMessageRecipients', () => {
  test('a role email goes to the role players, a fallback email goes to the team, and chat is mentioned', () => {
    const email = resolveMessageRecipients({
      app: 'email',
      mode: 'role',
      targetRoleId: 'cs_head',
      rolePlayers: { cs_head: ['aisha'] },
      roleTeam: { cs_head: 'Customer Service' },
      roleNames: { aisha: 'Aisha' },
      roleFallback: 'none',
      targetTeams: ['Customer Service'],
      teamMembers: members,
      resolvedUserIds: ['aisha', 'ben'],
    });
    assert.deepEqual(email.userIds, ['aisha']);
    assert.equal(email.changed, true);

    const chat = resolveMessageRecipients({
      app: 'group_chat',
      mode: 'role',
      targetRoleId: 'cs_head',
      rolePlayers: { cs_head: ['aisha'] },
      roleTeam: { cs_head: 'Customer Service' },
      roleNames: { aisha: 'Aisha' },
      roleFallback: 'none',
      targetTeams: ['Legal'],
      teamMembers: members,
      resolvedUserIds: null,
    });
    assert.equal(chat.mention, '@Aisha ');
    assert.deepEqual(chat.teamNames, ['Customer Service']);
    assert.deepEqual(chat.userIds, ['aisha']);

    const fallback = resolveMessageRecipients({
      app: 'email',
      mode: 'role',
      targetRoleId: 'cs_head',
      rolePlayers: { cs_head: [] },
      roleTeam: { cs_head: 'Customer Service' },
      roleFallback: 'none',
      targetTeams: ['Customer Service'],
      teamMembers: members,
      resolvedUserIds: null,
    });
    assert.equal(fallback.fallback_reason, 'role_unassigned');
    assert.deepEqual(fallback.userIds, ['aisha', 'ben']);
  });
});
