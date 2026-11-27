import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { communityLeaderContactedCore } from './communityLeaderContactedCore.js';

describe('community_leader_contacted', () => {
  test('a to_addresses match on a community stakeholder is true', () => {
    assert.equal(
      communityLeaderContactedCore(
        [
          {
            action_type: 'email_sent',
            content: 'Please see the attached note.',
            metadata: { to_addresses: ['Imam@Mosque.sim'], cc_addresses: [] },
          },
        ],
        [{ email: 'imam@mosque.sim', relationship: 'community' }],
      ),
      true,
    );
  });

  test('mentioning community in the body is not enough when stakeholders exist', () => {
    assert.equal(
      communityLeaderContactedCore(
        [
          {
            action_type: 'email_sent',
            content: 'We should talk to the community leader.',
            metadata: { to_addresses: ['press@news.sim'], cc_addresses: [] },
          },
        ],
        [{ email: 'imam@mosque.sim', relationship: 'community' }],
      ),
      false,
    );
  });

  test('with no stakeholders the keyword check uses addresses only', () => {
    assert.equal(
      communityLeaderContactedCore(
        [
          {
            action_type: 'email_sent',
            content: 'community leader',
            metadata: { to_addresses: ['desk@agency.sim'] },
          },
        ],
        [],
      ),
      false,
    );
    assert.equal(
      communityLeaderContactedCore(
        [
          {
            action_type: 'email_sent',
            content: 'hello',
            metadata: { to_addresses: ['community.liaison@city.sim'], cc_addresses: [] },
          },
        ],
        [],
      ),
      true,
    );
  });
});
