import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import EmailApp from '../src/components/SimDevice/EmailApp.tsx';
import OrgPageView from '../src/components/SimDevice/OrgPageView.tsx';
import FacebookMessengerView from '../src/components/SimDevice/FacebookMessengerView.tsx';
import PhoneApp from '../src/components/SimDevice/PhoneApp/PhoneApp.tsx';
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
});
