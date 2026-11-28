import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBuildCalls } from '../../shared/buildEstimate';
import type { SetupSnapshot } from '../src/components/Scenario/setupValidation';
import {
  formatSetupCost,
  playerRunTeams,
  setupCost,
  setupEstimateInput,
} from '../src/components/Scenario/setupBuildEstimate';

const snapshot = (): SetupSnapshot => ({
  brief: 'A fire at the Johor plant injured six workers and the union wants answers today.',
  primary: {
    name: 'Meridian Technologies',
    country: 'Singapore',
    city: '',
    kind: 'company',
    roster: [
      { team_name: 'Communications', description: '', is_custom: false, is_public_voice: true },
      { team_name: 'Legal', description: '', is_custom: false, is_public_voice: false },
      {
        team_name: 'Facilities',
        description: 'Keeps the headquarters building running',
        is_custom: true,
        is_public_voice: false,
      },
    ],
  },
  extras: [
    {
      id: 'org_ai',
      display_name: 'Meridian Malaysia',
      short_name: '',
      country: 'Malaysia',
      city: '',
      kind: 'office',
      facebook_handle: '',
      x_handle: '',
      operation: 'ai',
      team_roster: [
        { team_name: 'Communications', description: '', is_custom: false, is_public_voice: true },
        { team_name: 'Legal', description: '', is_custom: false, is_public_voice: false },
      ],
    },
  ],
  pressure: [
    {
      id: 'prs_a',
      display_name: 'Ministry of Human Resources',
      kind: 'regulator',
      country: 'Malaysia',
      city: '',
      register: 'statutory',
      wants: '',
      facebook_handle: '',
      x_handle: '',
    },
  ],
  competitors: [{ id: 'riv_a', name: 'Apex Systems', country: 'Singapore', description: '' }],
});

describe('setup cost line', () => {
  test('matches estimateBuildCalls and counts player-run teams only', () => {
    const setup = snapshot();
    const cost = setupCost(setup);
    assert.equal(cost.calls, estimateBuildCalls(setupEstimateInput(setup)));
    assert.equal(cost.playerTeams, 3);
    assert.equal(playerRunTeams(setup), 3);
    assert.equal(cost.input.orgs, 2);
    assert.equal(cost.input.teams, 5);
    assert.equal(cost.input.customTeams, 1);
    assert.equal(cost.input.alliesAndRivals, 2);
    assert.equal(cost.input.pressureCountries, 1);
    assert.equal(cost.input.injectsEstimate, 0);
    assert.equal(
      formatSetupCost(cost.calls, cost.playerTeams),
      `About ${cost.calls} AI calls · 3 player-run teams (needs at least 3 players)`,
    );
  });
});
