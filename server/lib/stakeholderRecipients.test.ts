import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StakeholderSchema, type Stakeholder } from './stakeholderContract.js';
import {
  MAX_EMAIL_RESPONDERS,
  MAX_ROSTER_RESPONDERS,
  pickResponders,
  resolveStakeholderRecipients,
} from './stakeholderRecipients.js';

const mk = (id: string, over: Partial<Stakeholder> = {}): Stakeholder =>
  StakeholderSchema.parse({
    id,
    name: id.replace(/_/g, ' '),
    title: 'Staff',
    organisation: 'Dyson Malaysia',
    relationship: 'internal',
    owning_team: 'HR',
    org_key: 'org_dyson_my',
    email: `${id}@dyson.sim`,
    phone: null,
    handle: `@${id.slice(0, 20)}`,
    ...over,
  });

const plantManager = mk('stk_plant_manager');
const hrCounterpart = mk('stk_hr_my');
const reporter = mk('stk_reporter', {
  relationship: 'media',
  organisation: 'The Star',
  owning_team: 'Communications',
});
const roster = Array.from({ length: 6 }, (_, i) => mk(`stk_roster_${i}`, { tier: 'roster' }));
const allStaff = mk('stk_johor_all_staff', {
  kind: 'group',
  members: [plantManager.id, ...roster.map((r) => r.id)],
  name: 'Johor plant — all staff (distribution list)',
});

const byId = new Map<string, Stakeholder>(
  [plantManager, hrCounterpart, reporter, allStaff, ...roster].map((s) => [s.id, s]),
);
const byEmail = new Map<string, Stakeholder>([...byId.values()].map((s) => [s.email, s]));
const findByEmail = async (a: string) => byEmail.get(a) ?? null;
const findById = async (id: string) => byId.get(id) ?? null;

describe('resolveStakeholderRecipients', () => {
  test('resolves every address, keeps order, ignores non-stakeholders, dedupes', async () => {
    const r = await resolveStakeholderRecipients(
      ['  STK_HR_MY@dyson.sim ', 'ceo@player.sim', plantManager.email, plantManager.email],
      findByEmail,
      findById,
    );
    assert.equal(r.primary?.id, hrCounterpart.id);
    assert.deepEqual(
      r.all.map((s) => s.id),
      [hrCounterpart.id, plantManager.id],
    );
  });

  test('expands a distribution list to its members and excludes the group record itself', async () => {
    const r = await resolveStakeholderRecipients([allStaff.email], findByEmail, findById);
    assert.equal(r.primary?.id, allStaff.id);
    assert.equal(
      r.all.some((s) => s.kind === 'group'),
      false,
    );
    assert.equal(r.all.length, 1 + roster.length);
    assert.equal(r.all[0].id, plantManager.id);
  });

  test('a member listed both directly and via the group appears once', async () => {
    const r = await resolveStakeholderRecipients(
      [plantManager.email, allStaff.email],
      findByEmail,
      findById,
    );
    assert.equal(r.all.filter((s) => s.id === plantManager.id).length, 1);
  });

  test('no stakeholder recipients → empty', async () => {
    const r = await resolveStakeholderRecipients(['x@player.sim'], findByEmail, findById);
    assert.equal(r.primary, null);
    assert.deepEqual(r.all, []);
  });
});

describe('pickResponders', () => {
  test('primary answers first; principals fill the budget before roster', () => {
    const all = [hrCounterpart, plantManager, reporter, ...roster];
    const picked = pickResponders(all, hrCounterpart, 'email-1');
    assert.equal(picked.length, MAX_EMAIL_RESPONDERS);
    assert.deepEqual(
      picked.map((s) => s.id),
      [hrCounterpart.id, plantManager.id, reporter.id],
    );
  });

  test('a group primary never answers; members are sampled within the roster cap', () => {
    const all = [plantManager, ...roster];
    const picked = pickResponders(all, allStaff, 'email-2');
    assert.equal(
      picked.some((s) => s.kind === 'group'),
      false,
    );
    assert.equal(picked[0].id, plantManager.id);
    const rosterPicked = picked.filter((s) => s.tier === 'roster');
    assert.equal(rosterPicked.length, Math.min(MAX_ROSTER_RESPONDERS, MAX_EMAIL_RESPONDERS - 1));
    assert.equal(picked.length, 1 + rosterPicked.length);
  });

  test('roster sample is stable for the same seed and differs across seeds', () => {
    const a = pickResponders(roster, null, 'seed-A').map((s) => s.id);
    const b = pickResponders(roster, null, 'seed-A').map((s) => s.id);
    assert.deepEqual(a, b);
    assert.equal(a.length, MAX_ROSTER_RESPONDERS);
    const seeds = ['seed-B', 'seed-C', 'seed-D', 'seed-E', 'seed-F'];
    const variants = new Set(
      seeds.map((s) =>
        pickResponders(roster, null, s)
          .map((x) => x.id)
          .join(','),
      ),
    );
    assert.ok(variants.size > 1, 'different seeds should sample differently at least sometimes');
  });

  test('never exceeds the overall cap even with many principals', () => {
    const many = Array.from({ length: 10 }, (_, i) => mk(`stk_principal_${i}`));
    assert.equal(pickResponders(many, many[0], 'x').length, MAX_EMAIL_RESPONDERS);
  });
});
