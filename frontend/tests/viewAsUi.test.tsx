import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import EmailApp from '../src/components/SimDevice/EmailApp.tsx';
import OrgPageView from '../src/components/SimDevice/OrgPageView.tsx';
import FacebookMessengerView from '../src/components/SimDevice/FacebookMessengerView.tsx';
import PhoneApp from '../src/components/SimDevice/PhoneApp/PhoneApp.tsx';
import SocialFeedApp from '../src/components/SimDevice/SocialFeedApp.tsx';
import FacebookFeedApp from '../src/components/SimDevice/FacebookFeedApp.tsx';
import GroupChatApp from '../src/components/SimDevice/GroupChatApp.tsx';
import { ViewAsBanner } from '../src/components/SimDevice/ViewAsBanner.tsx';
import { ViewAsSelect } from '../src/components/SimDevice/ViewAsMenu.tsx';
import { SurfaceReadOnlyProvider } from '../src/components/SimDevice/surfaceReadOnly.tsx';
import RecentsList from '../src/components/SimDevice/PhoneApp/RecentsList.tsx';
import {
  CommentActions,
  CommentComposer,
  MessengerComposePanel,
  MessengerNewMessageButton,
  MessengerReplyBar,
  PagePostComposer,
} from '../src/components/SimDevice/surfaceComposers.tsx';
import type { ViewAsPlayer } from '../src/lib/viewAsRoster.ts';

function markup(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function shell(node: ReactElement, readOnly: boolean): string {
  return markup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/sim/session-1/device/email'] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/sim/:sessionId/device/email',
          element: createElement(
            AuthProvider,
            null,
            createElement(SurfaceReadOnlyProvider, { readOnly }, node),
          ),
        }),
      ),
    ),
  );
}

const players: ViewAsPlayer[] = [
  { userId: 'ada', name: 'Ada', team: 'Communications', page: 'Acme' },
  { userId: 'bea', name: 'Bea', team: 'Legal', page: 'No page' },
];

const call = {
  id: 'call-1',
  session_id: 'session-1',
  inject_id: null,
  direction: 'inbound',
  caller_name: 'Regina',
  caller_number: null,
  status: 'missed',
  mode: null,
  ring_deadline_at: '2026-01-01T00:00:00Z',
  attempt_no: 1,
  call_group_id: 'group-1',
  can_callback: true,
  answered_by_name: null,
  caller_missed_count: 1,
  group_missed_count: 1,
  duration_seconds: null,
  opening: null,
  next_attempt_at: null,
};

describe('view-as banner and read-only composers', () => {
  test('the banner names the player and can switch, with no Act as control', () => {
    const html = markup(
      createElement(
        MemoryRouter,
        null,
        createElement(ViewAsBanner, {
          player: players[0],
          players,
          onSwitch: () => {},
          onExit: () => {},
        }),
      ),
    );
    assert.match(html, /Viewing as Ada \(Communications\) · read-only/);
    assert.match(html, /aria-label="Switch player"/);
    assert.match(html, /Ada \(Communications\) · Acme/);
    assert.match(html, /Bea \(Legal\) · No page/);
    assert.match(html, />Exit</);
    assert.equal(html.includes('Act as'), false);
  });

  test('the dropdown lists every participant and is not an Act as control', () => {
    const html = markup(
      createElement(ViewAsSelect, {
        label: 'View as',
        players,
        value: '',
        placeholder: 'View as…',
        onChange: () => {},
      }),
    );
    assert.match(html, /aria-label="View as"/);
    assert.match(html, /View as…/);
    assert.match(html, /Ada \(Communications\) · Acme/);
    assert.equal(html.includes('Act as'), false);
  });

  test('phone callback is hidden while the shell is read-only and shown for a player', () => {
    const list = (readOnly: boolean) =>
      markup(
        createElement(
          SurfaceReadOnlyProvider,
          { readOnly },
          createElement(RecentsList, {
            calls: [call],
            filter: 'all',
            onFilter: () => {},
            missedCount: 1,
            onOpen: () => {},
            onCallback: () => {},
          }),
        ),
      );
    assert.equal(list(true).includes('Call back'), false);
    assert.match(list(false), /Call back/);
  });

  test('page and messenger composers stay hidden under the read-only context', () => {
    const html = markup(
      createElement(
        SurfaceReadOnlyProvider,
        { readOnly: true },
        createElement(PagePostComposer, {
          readOnly: false,
          isFacebook: true,
          pageName: 'Acme',
          value: '',
          onChange: () => {},
          onPost: () => {},
        }),
      ),
    );
    // The prop still wins for these composers; the context is what the shell sets
    // on the views that pass readOnly through. A forced false prop keeps the box,
    // which is how a player page renders outside the shell.
    assert.match(html, /Post as Acme/);
    const hidden = markup(
      createElement(
        SurfaceReadOnlyProvider,
        { readOnly: true },
        createElement(PagePostComposer, {
          readOnly: true,
          isFacebook: true,
          pageName: 'Acme',
          value: '',
          onChange: () => {},
          onPost: () => {},
        }),
        createElement(CommentActions, {
          readOnly: true,
          isFacebook: true,
          liked: false,
          onLike: () => {},
          onReply: () => {},
        }),
        createElement(CommentComposer, {
          readOnly: true,
          isFacebook: true,
          pageName: 'Acme',
          value: '',
          onChange: () => {},
          onPost: () => {},
          replyingToName: null,
          onCancelReply: () => {},
          inputRef: null,
        }),
        createElement(MessengerNewMessageButton, { readOnly: true, onClick: () => {} }),
        createElement(MessengerReplyBar, {
          readOnly: true,
          value: '',
          onChange: () => {},
          onKeyDown: () => {},
          onSend: () => {},
          inputRef: null,
        }),
        createElement(MessengerComposePanel, {
          readOnly: true,
          open: true,
          recipient: '',
          text: '',
          handles: [],
          onRecipient: () => {},
          onText: () => {},
          onSend: () => {},
          onClose: () => {},
        }),
      ),
    );
    assert.equal(hidden.includes('Post as'), false);
    assert.equal(hidden.includes('Like'), false);
    assert.equal(hidden.includes('New message'), false);
    assert.equal(hidden.includes('Act as'), false);
  });

  test('email, messenger, the org page and the phone hide their composers when the shell is read-only', () => {
    const emailOn = shell(createElement(EmailApp), false);
    const emailOff = shell(createElement(EmailApp), true);
    assert.match(emailOn, /Inbox/);
    assert.equal((emailOn.match(/M12 20h9/g) || []).length > 0, true);
    assert.equal(emailOff.includes('M12 20h9'), false);

    const messageOn = shell(
      createElement(FacebookMessengerView, { sessionId: 'session-1' }),
      false,
    );
    const messageOff = shell(
      createElement(FacebookMessengerView, { sessionId: 'session-1' }),
      true,
    );
    assert.match(messageOn, /aria-label="New message"/);
    assert.equal(messageOff.includes('New message'), false);

    const pageOn = shell(createElement(OrgPageView, { platform: 'facebook' }), false);
    const pageOff = shell(createElement(OrgPageView, { platform: 'facebook' }), true);
    assert.equal(pageOff.includes('Post as'), false);
    assert.equal(pageOff.includes('Act as'), false);
    assert.equal(pageOn.includes('Act as'), false);

    const phoneOff = shell(createElement(PhoneApp), true);
    assert.equal(phoneOff.includes('Call back'), false);
    assert.equal(phoneOff.includes('Act as'), false);
  });

  test('a read-only social post keeps counts and the liked state, with the controls disabled', () => {
    const post = feedPost('x_twitter');
    const readOnly = shell(createElement(SocialFeedApp, { initialPosts: [post] }), true);
    const writable = shell(createElement(SocialFeedApp, { initialPosts: [post] }), false);
    assert.equal(buttonHas(readOnly, 'post-like-p1', 'disabled'), true);
    assert.equal(buttonHas(writable, 'post-like-p1', 'disabled'), false);
    assert.match(readOnly, /fill="#F91880"/);
    assert.match(readOnly, />3</);
    assert.match(readOnly, />2</);
    assert.match(readOnly, />4</);
    assert.match(readOnly, />9</);
    assert.equal(readOnly.includes('Submit report'), false);
    assert.match(writable, /data-testid="post-like-p1"/);

    const thread = shell(
      createElement(SocialFeedApp, { initialPosts: [post], openPostId: 'p1' }),
      true,
    );
    assert.match(thread, /Likes/);
    assert.match(thread, /<button disabled=""[^>]*title="Report post"/);
    assert.match(thread, /<button disabled=""[^>]*title="Dispute with facts"/);
    assert.equal(thread.includes('Submit report'), false);
    assert.equal(thread.includes('Report this post'), false);
  });

  test('a read-only facebook post keeps the reaction control visible and disabled', () => {
    const post = feedPost('facebook');
    const readOnly = shell(createElement(FacebookFeedApp, { initialPosts: [post] }), true);
    const writable = shell(createElement(FacebookFeedApp, { initialPosts: [post] }), false);
    assert.equal(buttonHas(readOnly, 'fb-react-p1', 'disabled'), true);
    assert.equal(buttonHas(writable, 'fb-react-p1', 'disabled'), false);
    assert.match(readOnly, />Like</);
    assert.match(readOnly, />Comment</);
    assert.equal(readOnly.includes('Submit report'), false);
  });

  test('read-only group chat still shows the conversation list and hides the call control', () => {
    const readOnly = shell(createElement(GroupChatApp), true);
    const writable = shell(createElement(GroupChatApp), false);
    assert.match(readOnly, /TeamChat/);
    assert.equal(readOnly.includes('>Calls<'), false);
    assert.match(writable, />Calls</);
    assert.equal(readOnly.includes('Act as'), false);
  });

  test('read-only hooks are not called after a short-circuit', () => {
    for (const file of [
      'components/SimDevice/OrgPageView.tsx',
      'components/SimDevice/FacebookMessengerView.tsx',
      'components/SimDevice/surfaceReadOnly.tsx',
    ]) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      assert.equal(/\|\|\s*useSurfaceReadOnly\(/.test(src), false, file);
      assert.equal(src.includes('useSurfaceIsReadOnly'), false, file);
    }
  });
});

function buttonHas(html: string, testId: string, attr: string): boolean {
  const match = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return !!match && match[0].includes(attr);
}

function feedPost(platform: string) {
  return {
    id: 'p1',
    author_handle: '@ada',
    author_display_name: 'Ada',
    author_type: 'player',
    content: 'Hello from Ada',
    hashtags: [],
    like_count: 3,
    repost_count: 2,
    reply_count: 4,
    view_count: 9,
    sentiment: 'neutral',
    content_flags: {},
    is_flagged_by_player: false,
    flagged_by_me: false,
    requires_response: false,
    responded_at: null,
    is_repost: false,
    created_at: '2026-01-01T00:00:00Z',
    platform,
    virality_score: 1,
    reply_to_post_id: null,
    liked_by_me: true,
    media_urls: [],
  };
}
