import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildInterdependencyMatrix, type MatrixInput } from './interdependencyMatrix.js';

/**
 * Shape of the Fault Lines hour (29 Oct 2026): eight staffed ministry teams,
 * an empty bank seat and an empty data-protection seat, a public line that
 * named the bank, one intel share, one withheld intel item, one escalation
 * to the empty bank seat, a clearance draft that never went out, and no
 * decision-log entries. Coordination sat in email.
 */
function faultLines(): MatrixInput {
  return {
    teams: [
      { name: 'ISD', org: 'Ministry of Home Affairs', staffed: true },
      { name: 'SPF', org: 'Ministry of Home Affairs', staffed: true },
      { name: 'IMDA', org: 'Ministry of Digital Development and Information', staffed: true },
      { name: 'CSA', org: 'Ministry of Digital Development and Information', staffed: true },
      { name: 'MCCY Office', org: 'Ministry of Culture, Community and Youth', staffed: true },
      { name: 'Harmony Circle', org: 'Ministry of Culture, Community and Youth', staffed: true },
      { name: 'MOF Office', org: 'Ministry of Finance', staffed: true },
      { name: 'MAS', org: 'Ministry of Finance', staffed: true },
      { name: 'PDPC', org: 'Ministry of Digital Development and Information', staffed: false },
      { name: 'DBS Communications', org: 'DBS', staffed: false },
    ],
    emails: [
      {
        at_minute: 8,
        from_team: 'ISD',
        to_teams: [],
        text: 'We will share the verified clips with IMDA and ask SPF to hold the neighbourhood calls.',
      },
      {
        at_minute: 9,
        from_team: 'Harmony Circle',
        to_teams: [],
        text: 'Harmony Circle has briefed the MHA desks and will stay off the public feed.',
      },
      {
        at_minute: 11,
        from_team: 'CSA',
        to_teams: [],
        text: 'Christmas outreach is paused until the rumour drops off the neighbourhood chats.',
      },
      {
        at_minute: 7,
        from_team: 'ISD',
        to_teams: [],
        text: 'ISD confirms the clips are synthetic and we will brief our own desk before the next turn.',
      },
    ],
    intel: [
      {
        title: 'Synthetic video origin',
        holder_team: 'IMDA',
        needed_by: ['ISD'],
        shared: true,
        shared_at_minutes: 18,
        shared_by_team: 'IMDA',
        deadline_minutes: 30,
        deadline_missed: false,
      },
      {
        title: 'Account cluster',
        holder_team: 'CSA',
        needed_by: ['MAS'],
        shared: false,
        shared_at_minutes: null,
        shared_by_team: null,
        deadline_minutes: 20,
        deadline_missed: true,
      },
    ],
    decisions: [],
    actions: [
      {
        at_minute: 13,
        team: 'SPF',
        action_type: 'escalated',
        text: 'Escalating the verified DBS update for the bank communications seat.',
      },
      {
        at_minute: 16,
        team: 'MCCY Office',
        action_type: 'draft_submitted_for_approval',
        text: 'Draft for clearance. We acknowledge the community targeted online.',
        document_team: 'MCCY Office',
      },
    ],
    posts: [
      {
        at_minute: 6,
        team: 'ISD',
        text: 'This is an influence operation. The accusations against a community are false.',
        overall: 90,
      },
      {
        at_minute: 12,
        team: 'MOF Office',
        text: 'DBS services are disrupted. Customers should use alternate channels.',
        overall: 80,
      },
      {
        at_minute: 13,
        team: 'IMDA',
        text: 'Synthetic video is being removed from platforms.',
        overall: 74,
      },
    ],
  };
}

function cell(matrix: ReturnType<typeof buildInterdependencyMatrix>, from: string, to: string) {
  return matrix.cells.find((c) => c.from === from && c.to === to);
}

describe('Fault Lines interdependency matrix', () => {
  const matrix = buildInterdependencyMatrix(faultLines());

  test('the decision log is empty, and the note says so', () => {
    assert.equal(matrix.coverage.decision_log_count, 0);
    assert.match(matrix.note, /decision log/i);
  });

  test('mail, intel, the escalation and the public line land on the teams they named', () => {
    const isdImda = cell(matrix, 'ISD', 'IMDA');
    assert.ok(isdImda);
    assert.equal(isdImda.same_org, false);
    assert.equal(isdImda.headline, 'told');
    assert.equal(isdImda.email_count, 1);
    assert.equal(cell(matrix, 'IMDA', 'ISD')?.headline, 'enabled');

    const isdSpf = cell(matrix, 'ISD', 'SPF');
    assert.ok(isdSpf);
    assert.equal(isdSpf.same_org, true);
    assert.equal(isdSpf.headline, 'told');

    assert.equal(cell(matrix, 'CSA', 'MAS')?.headline, 'withheld');
    assert.equal(cell(matrix, 'SPF', 'DBS Communications')?.headline, 'unanswered');
    assert.equal(cell(matrix, 'MOF Office', 'DBS Communications')?.headline, 'unanswered');
    assert.equal(cell(matrix, 'Harmony Circle', 'ISD')?.headline, 'told');
    assert.equal(cell(matrix, 'Harmony Circle', 'SPF')?.headline, 'told');
  });

  test('a team is not a dependency of itself, and a lookalike word is not a team', () => {
    assert.equal(cell(matrix, 'ISD', 'ISD'), undefined);
    assert.equal(
      matrix.cells.some((c) => c.from === 'CSA' && c.to === 'MAS' && c.email_count > 0),
      false,
    );
    assert.equal(
      matrix.decisions.some((d) => d.by === 'CSA' && d.source === 'email'),
      false,
    );
  });

  test('public lines and the held draft stay on the register even when they name nobody', () => {
    const isdLine = matrix.decisions.find((d) => d.by === 'ISD' && d.source === 'public_post');
    assert.ok(isdLine);
    assert.equal(isdLine.at_minute, 6);
    assert.deepEqual(isdLine.impacts, []);

    const draft = matrix.decisions.find((d) => d.by === 'MCCY Office' && d.source === 'draft');
    assert.ok(draft);
    assert.match(draft.what, /not published/i);
    assert.deepEqual(draft.impacts, []);
    assert.equal(matrix.coverage.drafts_held, 1);
    assert.equal(matrix.coverage.public_lines, 3);
    assert.equal(matrix.coverage.escalations, 1);
    assert.equal(matrix.coverage.intel_shared, 1);
    assert.equal(matrix.coverage.intel_withheld, 1);
  });

  test('the untouched empty seat is not invented as a column', () => {
    assert.equal(
      matrix.teams.some((t) => t.name === 'PDPC'),
      false,
    );
    assert.equal(
      matrix.teams.some((t) => t.name === 'DBS Communications'),
      true,
    );
  });

  test('ministries roll up, and a pair inside one ministry does not', () => {
    const mdToHome = matrix.agency_cells.find(
      (c) =>
        c.from === 'Ministry of Digital Development and Information' &&
        c.to === 'Ministry of Home Affairs',
    );
    assert.ok(mdToHome);
    assert.equal(mdToHome.headline, 'enabled');
    assert.equal(
      matrix.agency_cells.some(
        (c) => c.from === 'Ministry of Home Affairs' && c.to === 'Ministry of Home Affairs',
      ),
      false,
    );
    const homeToBank = matrix.agency_cells.find(
      (c) => c.from === 'Ministry of Home Affairs' && c.to === 'DBS',
    );
    assert.equal(homeToBank?.headline, 'unanswered');
  });
});

describe('recorded decisions and late intel', () => {
  test('a logged decision tells the team that was named and records the consequence', () => {
    const matrix = buildInterdependencyMatrix({
      teams: [
        { name: 'MOF Office', org: 'Ministry of Finance', staffed: true },
        { name: 'MAS', org: 'Ministry of Finance', staffed: true },
        { name: 'IMDA', org: 'Ministry of Digital Development and Information', staffed: true },
      ],
      emails: [],
      intel: [],
      actions: [],
      posts: [],
      decisions: [
        {
          at_minute: 12,
          by_team: 'MOF Office',
          summary: 'Publish the bank disruption line before the market opens.',
          informed: ['MAS duty desk'],
          reactions: [
            {
              actor: 'IMDA',
              outcome: 'fired',
              title: 'Platforms ask for the official line',
              at_minute: 20,
            },
          ],
        },
      ],
    });
    assert.equal(matrix.coverage.decision_log_count, 1);
    assert.doesNotMatch(matrix.note, /No decision was written/);
    assert.equal(cell(matrix, 'MOF Office', 'MAS')?.headline, 'told');
    assert.equal(cell(matrix, 'MOF Office', 'MAS')?.same_org, true);
    assert.equal(cell(matrix, 'MOF Office', 'IMDA')?.headline, 'consequence');
    const row = matrix.decisions.find((d) => d.source === 'decision_log');
    assert.equal(row?.at_minute, 12);
    assert.equal(row?.impacts.length, 2);
  });

  test('intel shared after the deadline is late, and MOF names both finance seats', () => {
    const matrix = buildInterdependencyMatrix({
      teams: [
        { name: 'IMDA', org: 'Ministry of Digital Development and Information', staffed: true },
        { name: 'MOF Office', org: 'Ministry of Finance', staffed: true },
        { name: 'MAS', org: 'Ministry of Finance', staffed: true },
      ],
      emails: [
        {
          at_minute: 4,
          from_team: 'IMDA',
          to_teams: ['MOF Office'],
          text: 'Sharing the clip hash with MOF Office only.',
        },
        {
          at_minute: 5,
          from_team: 'IMDA',
          to_teams: [],
          text: 'Please also tell MOF so the ministry can align its statement.',
        },
      ],
      intel: [
        {
          title: 'Clip hash',
          holder_team: 'IMDA',
          needed_by: ['MAS'],
          shared: true,
          shared_at_minutes: 40,
          shared_by_team: 'IMDA',
          deadline_minutes: 30,
          deadline_missed: false,
        },
      ],
      decisions: [],
      actions: [],
      posts: [],
    });
    assert.equal(cell(matrix, 'IMDA', 'MAS')?.headline, 'late');
    assert.equal(cell(matrix, 'IMDA', 'MOF Office')?.email_count, 2);
    assert.ok(cell(matrix, 'IMDA', 'MAS'));
    const mofOnly = matrix.cells.filter((c) => c.from === 'IMDA' && c.to === 'MOF Office');
    assert.equal(mofOnly.length, 1);
  });
});
