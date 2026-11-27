import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupChatMessage,
  npcSenderStakeholderId,
  phoneCallMessage,
  phoneCaller,
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
    assert.deepEqual(
      phoneCaller(
        { title: 'MFA call' },
        { from_name: 'MFA Duty Officer', from_number: '+65 6379 8000' },
      ),
      { name: 'MFA Duty Officer', number: '+65 6379 8000' },
    );
  });

  test('falls back through caller_* keys, then the title', () => {
    assert.equal(
      phoneCaller({ title: 'T' }, { caller_name: 'Chief of Staff' }).name,
      'Chief of Staff',
    );
    assert.equal(phoneCaller({ title: 'T' }, { caller: { id: 1 } }).name, 'T');
    assert.deepEqual(phoneCaller({ title: 'Mayor’s office' }, {}), {
      name: 'Mayor’s office',
      number: null,
    });
  });

  test('uses from_address as the number when that is how it was authored', () => {
    assert.equal(
      phoneCaller({ title: 'T' }, { from_name: 'Pastor', from_address: '+60 9300 6062' }).number,
      '+60 9300 6062',
    );
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

  test('type stays within the chat_messages type CHECK', () => {
    assert.equal(phoneCallMessage({ title: 'T', content: '' }, {}).type, 'text');
    assert.equal(phoneCallMessage({ title: 'T', content: '' }, {}).content, '📞 Call from T');
  });
});
