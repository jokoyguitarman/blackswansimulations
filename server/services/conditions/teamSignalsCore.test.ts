import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionFacts,
  gradesByTeam,
  latestActivity,
  needsTeamSignalFacts,
  overallGrade,
  roleTeamSlugs,
  teamLabelMap,
} from './teamSignalsCore.js';

describe('team signal facts', () => {
  test('signal reads are skipped unless a tick key uses them', () => {
    assert.equal(
      needsTeamSignalFacts([
        'unresponded:k1:10|team=legal',
        'decision_recorded:public_position',
        'chain_active:k1',
        'mood_is:stk_a:angry',
      ]),
      false,
    );
    assert.equal(needsTeamSignalFacts(['duty_late:review|role=cs_head']), true);
    assert.equal(needsTeamSignalFacts(['team_silent:10|team=legal']), true);
    assert.equal(needsTeamSignalFacts(['content_failed:2:50|team=comms']), true);
    assert.equal(needsTeamSignalFacts(['decision_made:public_position|team=comms']), true);
  });

  test('activity keeps the later minute per team', () => {
    const activity = latestActivity([
      { team_slug: 'legal', minute: 4 },
      { team_slug: 'legal', minute: 14 },
      { team_slug: 'comms', minute: 2 },
      { team_slug: '', minute: 9 },
    ]);
    assert.deepEqual(activity, {
      legal: { last_minute: 14 },
      comms: { last_minute: 2 },
    });
  });

  test('grades stay with the team that wrote them', () => {
    assert.equal(overallGrade({ overall: 40, role_fit: 10 }), 40);
    assert.equal(overallGrade({ overall: null }), null);
    assert.equal(overallGrade(null), null);
    assert.deepEqual(
      gradesByTeam([
        { team_slug: 'legal', score: 40 },
        { team_slug: 'legal', score: 80 },
        { team_slug: 'comms', score: 10 },
      ]),
      { legal: [40, 80], comms: [10] },
    );
  });

  test('decisions keep a category for the team and drop dismissed or unknown rows', () => {
    assert.deepEqual(
      decisionFacts([
        { team_name: 'Communications', category: 'public_position', minute: 12, status: 'active' },
        { team_name: 'Legal', category: 'legal_action', minute: 4, status: 'reversed' },
        { team_name: 'Legal', category: 'public_position', minute: 6, status: 'dismissed' },
        { team_name: 'Legal', category: 'not_a_category', minute: 7, status: 'active' },
        { team_name: '', category: 'other', minute: 1, status: 'active' },
      ]),
      [
        { team_slug: 'communications', category: 'public_position', minute: 12 },
        { team_slug: 'legal', category: 'legal_action', minute: 4 },
      ],
    );
  });

  test('role scope resolves to the role team slug', () => {
    assert.deepEqual(roleTeamSlugs([{ role_id: 'cs_head', team_name: 'Customer Service' }]), {
      cs_head: 'customer_service',
    });
    assert.deepEqual(teamLabelMap(['Legal', 'Customer Service']), {
      legal: 'Legal',
      customer_service: 'Customer Service',
    });
  });
});
