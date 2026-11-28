import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SESSION_CONCLUDED_CODE,
  directThreadVisible,
  isSessionStaff,
  messengerHandleFilter,
  pageHandlesForInbox,
  playerWriteBlock,
} from './socialAccess.js';

const PLAYER = { id: 'player-1', role: 'player' };
const OTHER = { id: 'player-2', role: 'player' };
const TRAINER = { id: 'trainer-1', role: 'trainer' };
const OTHER_TRAINER = { id: 'trainer-2', role: 'trainer' };
const ADMIN = { id: 'admin-1', role: 'admin' };
const OWNED = { trainer_id: 'trainer-1', status: 'in_progress' };
const FIRST_PAGE = '@first_org';
const CONTROLLED = '@comms_desk';

describe('isSessionStaff', () => {
  test('admins see every session, and a trainer only the sessions they ran', () => {
    assert.equal(isSessionStaff(ADMIN, OWNED), true);
    assert.equal(isSessionStaff(TRAINER, OWNED), true);
    assert.equal(isSessionStaff(OTHER_TRAINER, OWNED), false);
    assert.equal(isSessionStaff(PLAYER, OWNED), false);
  });
});

describe('player writes freeze when the session has ended', () => {
  test('a live session still accepts player posts', () => {
    assert.equal(playerWriteBlock(PLAYER, OWNED), null);
    assert.equal(playerWriteBlock(PLAYER, { trainer_id: 'trainer-1', status: 'paused' }), null);
  });

  test('completed and cancelled sessions reject players with a clear error', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const block = playerWriteBlock(PLAYER, { trainer_id: 'trainer-1', status });
      assert.equal(block?.status, 409);
      assert.equal(block?.code, SESSION_CONCLUDED_CODE);
      assert.match(block?.error ?? '', /ended/i);
    }
  });

  test('the trainer who ran the session and admins are not frozen', () => {
    const ended = { trainer_id: 'trainer-1', status: 'completed' };
    assert.equal(playerWriteBlock(TRAINER, ended), null);
    assert.equal(playerWriteBlock(ADMIN, ended), null);
    assert.equal(playerWriteBlock(OTHER_TRAINER, ended)?.code, SESSION_CONCLUDED_CODE);
  });

  test('CONCLUDED_SESSION_WRITE_FREEZE=false turns the freeze off', () => {
    const block = playerWriteBlock(
      PLAYER,
      { trainer_id: 'trainer-1', status: 'completed' },
      {
        CONCLUDED_SESSION_WRITE_FREEZE: 'false',
      },
    );
    assert.equal(block, null);
  });
});

describe('page inboxes', () => {
  const pages = [FIRST_PAGE, CONTROLLED, '@rival'];

  test('a player who controls nothing does not see the first org page', () => {
    assert.deepEqual(
      pageHandlesForInbox({ staff: false, controlledHandles: [], sessionPageHandles: pages }),
      [],
    );
  });

  test('a player sees only the page they control, not the first page in the table', () => {
    assert.deepEqual(
      pageHandlesForInbox({
        staff: false,
        controlledHandles: [CONTROLLED],
        sessionPageHandles: pages,
      }),
      [CONTROLLED],
    );
  });

  test('session staff see every page inbox', () => {
    assert.deepEqual(
      pageHandlesForInbox({ staff: true, controlledHandles: [], sessionPageHandles: pages }),
      pages,
    );
  });

  test('handles that could break the query filter are dropped', () => {
    assert.deepEqual(
      pageHandlesForInbox({
        staff: false,
        controlledHandles: ['@ok', '@bad"handle', '@also\\bad'],
        sessionPageHandles: pages,
      }),
      ['@ok'],
    );
  });

  test('the messenger filter lists the player and their page, not a stranger page', () => {
    const filter = messengerHandleFilter('@ada', [CONTROLLED]);
    assert.match(filter, /sender_handle\.eq\."@ada"/);
    assert.match(filter, /recipient_handle\.eq\."@comms_desk"/);
    assert.doesNotMatch(filter, /first_org/);
    assert.equal(messengerHandleFilter('@bad"name', ['@also"bad']), '');
  });

  test('a thread is visible to its parties, the page controller, and session staff', () => {
    const pageThread = {
      playerHandle: '@ada',
      pageHandles: [CONTROLLED],
      senderHandle: '@stranger',
      recipientHandle: CONTROLLED,
    };
    assert.equal(directThreadVisible({ ...pageThread, staff: false }), true);
    assert.equal(directThreadVisible({ ...pageThread, pageHandles: [], staff: false }), false);
    assert.equal(directThreadVisible({ ...pageThread, pageHandles: [], staff: true }), true);
    assert.equal(
      directThreadVisible({
        staff: false,
        playerHandle: '@ada',
        pageHandles: [],
        senderHandle: '@ada',
        recipientHandle: '@sam',
      }),
      true,
    );
    assert.equal(
      directThreadVisible({
        staff: false,
        playerHandle: '@ada',
        pageHandles: [CONTROLLED],
        senderHandle: OTHER.id,
        recipientHandle: '@someone_else',
      }),
      false,
    );
  });
});
