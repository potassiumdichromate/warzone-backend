const test = require('node:test');
const assert = require('node:assert/strict');

const {
  grantLamborghiniIfEligible,
} = require('../services/highwayHustleRewardService');

const walletAddress = '0x1234567890123456789012345678901234567890';

test('does not call Highway Hustle below the configured coin threshold', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
  };

  const result = await grantLamborghiniIfEligible({
    walletAddress,
    PlayerResources: { coin: 2999 },
  });

  assert.equal(result.eligible, false);
  assert.equal(calls, 0);
});

test('grants the Lamborghini using the shared server secret at 3000 coins', async () => {
  process.env.HIGHWAY_HUSTLE_REWARD_GRANT_SECRET = 'test-secret';
  process.env.HIGHWAY_HUSTLE_API_URL = 'https://highway.example/api';

  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 201,
      json: async () => ({ success: true, created: true }),
    };
  };

  const result = await grantLamborghiniIfEligible({
    walletAddress,
    PlayerResources: { coin: 3000 },
  });

  assert.equal(result.granted, true);
  assert.equal(request.url, 'https://highway.example/api/player/rewards/grant');
  assert.equal(request.options.headers['x-contest-grant-secret'], 'test-secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    walletAddress,
    rewardId: 'lamborghini',
    rewardType: 'vehicle',
    note: 'Unlocked by reaching 3000 coins in Warzone Warriors',
  });
});
