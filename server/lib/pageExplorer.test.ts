import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summariseMessengerThreads } from './messengerThreads.js';
import {
  pageInboxDecision,
  parsePageInboxQuery,
  parsePageThreadOrgKey,
  projectSessionPages,
  threadBelongsToPage,
} from './pageExplorer.js';

const fullPage = {
  org_key: 'rival',
  display_name: 'Rival Co',
  is_primary: false,
  role: 'antagonist',
  control_mode: 'ai',
  kind: 'pressure',
  register: 'hostile',
  operation: 'ai',
  spokesperson_stakeholder_id: 'reg-1',
  controllers: ['user-a'],
  facebook: {
    id: 'page-1',
    platform: 'facebook',
    org_key: 'rival',
    page_name: 'Rival Co',
    page_handle: '@rival',
    page_bio: 'We sell things',
    page_logo_url: 'https://example.test/logo.png',
    follower_count: 12,
    verified: true,
    role: 'antagonist',
    control_mode: 'ai',
    kind: 'pressure',
    session_id: 'session-1',
  },
  x_twitter: null,
};

describe('page inbox access', () => {
  test('a controller and spectating staff may open the page', () => {
    assert.equal(
      pageInboxDecision({ spectatingStaff: false, controlledOrgKey: 'acme', orgKey: 'acme' }),
      'allow',
    );
    assert.equal(
      pageInboxDecision({ spectatingStaff: true, controlledOrgKey: null, orgKey: 'rival' }),
      'allow',
    );
  });

  test('another participant and a trainer who does not run the session may not', () => {
    assert.equal(
      pageInboxDecision({ spectatingStaff: false, controlledOrgKey: 'acme', orgKey: 'rival' }),
      'deny',
    );
    assert.equal(
      pageInboxDecision({ spectatingStaff: false, controlledOrgKey: null, orgKey: 'acme' }),
      'deny',
    );
  });

  test('query parsing requires an org key and a known platform', () => {
    assert.deepEqual(parsePageInboxQuery(' acme ', 'facebook'), {
      orgKey: 'acme',
      platform: 'facebook',
    });
    assert.equal(parsePageInboxQuery('', 'facebook'), null);
    assert.equal(parsePageInboxQuery('acme', 'tiktok'), null);
    assert.equal(parsePageInboxQuery(['acme'], 'facebook'), null);
    assert.equal(parsePageThreadOrgKey(' rival '), 'rival');
    assert.equal(parsePageThreadOrgKey('  '), null);
  });

  test('a thread belongs to a page only when every message does', () => {
    assert.equal(
      threadBelongsToPage('@acme', [
        { sender_handle: '@fan', recipient_handle: '@acme' },
        { sender_handle: '@acme', recipient_handle: '@fan' },
      ]),
      true,
    );
    assert.equal(
      threadBelongsToPage('@acme', [
        { sender_handle: '@fan', recipient_handle: '@acme' },
        { sender_handle: '@fan', recipient_handle: '@other' },
      ]),
      false,
    );
  });
});

describe('page list projection', () => {
  test('staff keep the same page objects', () => {
    const pages = [fullPage];
    assert.equal(projectSessionPages(pages, { staff: true, controlledOrgKey: null }), pages);
  });

  test('a participant keeps internal fields only on the page they control', () => {
    const controlled = { ...fullPage, org_key: 'acme', display_name: 'Acme' };
    const projected = projectSessionPages([controlled, fullPage], {
      staff: false,
      controlledOrgKey: 'acme',
    });
    assert.equal(projected[0], controlled);
    const rival = projected[1] as Record<string, unknown>;
    assert.deepEqual(Object.keys(rival).sort(), [
      'display_name',
      'facebook',
      'is_primary',
      'org_key',
      'x_twitter',
    ]);
    assert.equal(rival.role, undefined);
    assert.equal(rival.controllers, undefined);
    const facebook = rival.facebook as Record<string, unknown>;
    assert.equal(facebook.page_handle, '@rival');
    assert.equal(facebook.page_bio, 'We sell things');
    assert.equal(facebook.role, undefined);
    assert.equal(facebook.control_mode, undefined);
    assert.equal(facebook.session_id, undefined);
  });
});

describe('messenger thread summary', () => {
  test('groups a page inbox the same way as a personal inbox', () => {
    const older = {
      thread_id: 't1',
      created_at: '2026-01-01T00:00:00Z',
      sender_handle: '@fan',
      recipient_handle: '@acme',
      sender_display_name: 'Fan',
      is_read: false,
      content: 'first',
    };
    const newer = {
      ...older,
      created_at: '2026-01-01T00:05:00Z',
      sender_handle: '@acme',
      recipient_handle: '@fan',
      sender_display_name: 'Acme',
      is_read: true,
      content: 'second',
    };
    const threads = summariseMessengerThreads([newer, older], ['@acme'], '');
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.is_org_page_thread, true);
    assert.equal(threads[0]?.unread_count, 1);
    assert.equal(threads[0]?.latest_message.content, 'second');
    assert.deepEqual(threads[0]?.other_participant, { handle: '@fan', display_name: 'Fan' });
  });
});
