import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CommentActions,
  CommentComposer,
  MessengerComposePanel,
  MessengerNewMessageButton,
  MessengerReplyBar,
  PagePostComposer,
} from '../src/components/SimDevice/surfaceComposers.tsx';

function markup(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

const composers = (readOnly: boolean) =>
  [
    markup(
      createElement(PagePostComposer, {
        readOnly,
        isFacebook: true,
        pageName: 'Acme',
        value: '',
        onChange: () => {},
        onPost: () => {},
      }),
    ),
    markup(
      createElement(CommentActions, {
        readOnly,
        isFacebook: true,
        liked: false,
        onLike: () => {},
        onReply: () => {},
      }),
    ),
    markup(
      createElement(CommentComposer, {
        readOnly,
        isFacebook: true,
        pageName: 'Acme',
        value: '',
        onChange: () => {},
        onPost: () => {},
        replyingToName: null,
        onCancelReply: () => {},
        inputRef: null,
      }),
    ),
    markup(createElement(MessengerNewMessageButton, { readOnly, onClick: () => {} })),
    markup(
      createElement(MessengerReplyBar, {
        readOnly,
        value: '',
        onChange: () => {},
        onKeyDown: () => {},
        onSend: () => {},
        inputRef: null,
      }),
    ),
    markup(
      createElement(MessengerComposePanel, {
        readOnly,
        open: true,
        recipient: '',
        text: '',
        handles: ['@fan'],
        onRecipient: () => {},
        onText: () => {},
        onSend: () => {},
        onClose: () => {},
      }),
    ),
  ].join('\n');

describe('read-only page and inbox composers', () => {
  test('readOnly hides every composer and action', () => {
    const html = composers(true);
    assert.equal(html.replace(/\n/g, ''), '');
    assert.equal(html.includes('Post as'), false);
    assert.equal(html.includes('Like'), false);
    assert.equal(html.includes('Reply'), false);
    assert.equal(html.includes('Comment as'), false);
    assert.equal(html.includes('New message'), false);
    assert.equal(html.includes('Aa'), false);
    assert.equal(html.includes('Type a message'), false);
    assert.equal(html.includes('Send'), false);
  });

  test('an editable surface renders every composer', () => {
    const html = composers(false);
    assert.match(html, /Post as Acme/);
    assert.match(html, />Like</);
    assert.match(html, />Reply</);
    assert.match(html, /Comment as Acme/);
    assert.match(html, /aria-label="New message"/);
    assert.match(html, /placeholder="Aa"/);
    assert.match(html, /aria-label="Send"/);
    assert.match(html, /placeholder="Type a message\.\.\."/);
    assert.match(html, />Send</);
  });
});
