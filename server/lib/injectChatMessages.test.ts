import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupChatMessage,
  npcSenderStakeholderId,
  looksLikePhoneNumber,
  phoneCallMessage,
  phoneCaller,
  selectInjectTeamChannels,
} from './injectChatMessages.js';

describe('npcSenderStakeholderId', () => {
  test('prefers the authored stakeholder id', () => {
    assert.equal(npcSenderStakeholderId('Pastor Daniel', 'stk_pastor'), 'stk_pastor');
  });

  test('derives a stable npc: id from the name', () => {
    assert.equal(
      npcSenderStakeholderId('MFA Duty Officer (Ops Room)'),
      'npc:mfa_duty_officer_ops_room',
    );
    assert.equal(npcSenderStakeholderId('!!!'), 'npc:npc');
  });
});

describe('groupChatMessage', () => {
  test('keeps the existing sender fallbacks and content', () => {
    assert.deepEqual(
      groupChatMessage({ content: 'Hold the line' }, { sender_name: ' Ops Lead ' }),
      {
        sender_stakeholder_id: 'npc:ops_lead',
        sender_display_name: 'Ops Lead',
        content: 'Hold the line',
        type: 'text',
      },
    );
    assert.equal(groupChatMessage({ content: 'x' }, {}).sender_display_name, 'NPC');
  });
});

describe('phoneCaller', () => {
  test('reads from_name and from_number', () => {
    assert.deepEqual(phoneCaller({ from_name: 'MFA Duty Officer', from_number: '+65 6379 8000' }), {
      name: 'MFA Duty Officer',
      number: '+65 6379 8000',
    });
  });

  test('falls back through caller_* keys; null name when nothing names the caller', () => {
    assert.equal(phoneCaller({ caller_name: 'Chief of Staff' }).name, 'Chief of Staff');
    assert.deepEqual(phoneCaller({ caller: { id: 1 } }), { name: null, number: null });
  });

  test('caller_id is a number when it looks like one, otherwise a name', () => {
    assert.deepEqual(phoneCaller({ caller_id: '+65 9123 4567' }), {
      name: null,
      number: '+65 9123 4567',
    });
    assert.deepEqual(phoneCaller({ caller_id: 'CNA Producer' }), {
      name: 'CNA Producer',
      number: null,
    });
    assert.equal(phoneCaller({ from_name: 'Pastor', caller_id: 'stk_x' }).name, 'Pastor');
  });

  test('from_address counts as a number only when it is one', () => {
    assert.equal(phoneCaller({ from_address: '+60 9300 6062' }).number, '+60 9300 6062');
    assert.equal(phoneCaller({ from_address: 'press@cna.sim' }).number, null);
    assert.equal(
      phoneCaller({ from_address: 'press@cna.sim', callback_number: '6123 4567' }).number,
      '6123 4567',
    );
  });
});

describe('looksLikePhoneNumber', () => {
  test('accepts phone formats, rejects emails and ids', () => {
    for (const ok of ['+65 6379 8000', '(03) 9123-4567', '61234567']) {
      assert.equal(looksLikePhoneNumber(ok), true, ok);
    }
    for (const bad of ['press@cna.sim', 'stk_reporter', '12345', '+65 XXXX XXXX']) {
      assert.equal(looksLikePhoneNumber(bad), false, bad);
    }
  });
});

describe('phoneCallMessage', () => {
  test('a call becomes a persisted chat line from the caller', () => {
    const msg = phoneCallMessage(
      {
        title: 'Request for worker welfare liaison',
        content: 'Calls asking who is responsible.\n',
      },
      {
        from_name: 'Pastor Daniel',
        from_address: '+60 9300 6062',
        stakeholder_id: 'stk_dm_o_pastor_daniel',
      },
    );
    assert.deepEqual(msg, {
      sender_stakeholder_id: 'stk_dm_o_pastor_daniel',
      sender_display_name: 'Pastor Daniel',
      content: '📞 Call from Pastor Daniel (+60 9300 6062)\n\nCalls asking who is responsible.',
      type: 'text',
    });
  });

  test('without a caller name it reads as an incoming call about the title', () => {
    const msg = phoneCallMessage(
      { title: 'CNA producer requests on-record statement', content: 'Need it in 10.' },
      { from_address: 'press@cna.sim' },
    );
    assert.equal(msg.sender_display_name, 'Unknown caller');
    assert.equal(msg.sender_stakeholder_id, 'npc:unknown_caller');
    assert.equal(
      msg.content,
      '📞 Incoming call: CNA producer requests on-record statement\n\nNeed it in 10.',
    );
  });

  test('type stays within the chat_messages type CHECK', () => {
    const msg = phoneCallMessage({ title: 'T', content: '' }, { from_number: '+65 6000 0000' });
    assert.equal(msg.type, 'text');
    assert.equal(msg.content, '📞 Incoming call (+65 6000 0000): T');
  });
});

describe('selectInjectTeamChannels', () => {
  test('a player on two teams gets the call only in the targeted team channel', () => {
    assert.deepEqual(
      selectInjectTeamChannels(['Communications — DBS', 'Legal — DBS'], ['Legal — DBS']),
      ['Legal — DBS'],
    );
  });

  test('a demo user on many teams does not fan the inject out', () => {
    const teams = ['A', 'B', 'C', 'D', 'E', 'A'];
    assert.deepEqual(selectInjectTeamChannels(teams, ['C', 'Z']), ['C']);
  });

  test('falls back to the players own teams when no team matched by name', () => {
    assert.deepEqual(selectInjectTeamChannels(['Ops', 'Ops', 'Comms'], ['incident_command']), [
      'Ops',
      'Comms',
    ]);
    assert.deepEqual(selectInjectTeamChannels(['Ops'], ['org:org_dbs']), ['Ops']);
  });

  test('no player teams means no channels', () => {
    assert.deepEqual(selectInjectTeamChannels([], ['Legal — DBS']), []);
  });
});
