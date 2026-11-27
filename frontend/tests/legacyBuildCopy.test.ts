import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_LABEL, legacyErrorCardBody, legacyTransportBody } from '../src/lib/legacyBuildCopy';

const DROPPED_STORYLINE =
  'The connection dropped during the Storyline stage — the phone may have locked, switched apps or changed network. The server may still be working, but this page can no longer receive it. Retry starts the build again from Characters.';

const UNREACHABLE_STORYLINE =
  "Couldn't reach the server to start the Storyline stage. Check the connection and retry. Retry starts the build again from Characters.";

describe('legacy build error copy', () => {
  test('a stream cut after a line uses the dropped-connection wording', () => {
    const shown = legacyErrorCardBody(legacyTransportBody(STAGE_LABEL.storyline, true));
    assert.equal(shown, DROPPED_STORYLINE);
  });

  test('a request that never delivered a line uses the could-not-reach wording', () => {
    const shown = legacyErrorCardBody(legacyTransportBody(STAGE_LABEL.storyline, false));
    assert.equal(shown, UNREACHABLE_STORYLINE);
  });

  test('organisation pages use the same split, with the stage label', () => {
    assert.equal(
      legacyErrorCardBody(legacyTransportBody(STAGE_LABEL.pages, true)),
      'The connection dropped during the Organisation pages stage — the phone may have locked, switched apps or changed network. The server may still be working, but this page can no longer receive it. Retry starts the build again from Characters.',
    );
    assert.equal(
      legacyErrorCardBody(legacyTransportBody(STAGE_LABEL.pages, false)),
      "Couldn't reach the server to start the Organisation pages stage. Check the connection and retry. Retry starts the build again from Characters.",
    );
  });

  test('other stage failures keep their message and gain the corrected retry sentence', () => {
    assert.equal(
      legacyErrorCardBody('NPC generation failed. Try again.'),
      'NPC generation failed. Try again. Retry starts the build again from Characters.',
    );
    assert.equal(
      legacyErrorCardBody(null),
      'The generator did not return a result. Retry starts the build again from Characters.',
    );
    assert.equal(
      legacyErrorCardBody(''),
      'The generator did not return a result. Retry starts the build again from Characters.',
    );
  });

  test('the retry sentence is not repeated when the message already ends with it', () => {
    assert.equal(legacyErrorCardBody(DROPPED_STORYLINE), DROPPED_STORYLINE);
  });
});
