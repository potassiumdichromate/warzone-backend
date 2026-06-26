const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const PlayerProfile = {};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../models/PlayerProfile' && parent?.filename?.endsWith('crossGameGunRewardService.js')) {
    return PlayerProfile;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { grantWarzoneGunReward } = require('../services/crossGameGunRewardService');
Module._load = originalLoad;

const walletAddress = '0x1234567890123456789012345678901234567890';

test.afterEach(() => {
  PlayerProfile.findOne = undefined;
});

test('grants the mapped medium gun for a cross-game source', async () => {
  const saved = { called: false };
  const player = {
    walletAddress,
    PlayerGuns: new Map(),
    PlayerAchievementData: {},
    async save() {
      saved.called = true;
    },
  };
  PlayerProfile.findOne = async () => player;

  const reward = await grantWarzoneGunReward({
    walletAddress,
    sourceGame: 'zeroDash',
    difficulty: 'medium',
    metric: 'best',
    value: 8,
  });

  assert.equal(reward.created, true);
  assert.equal(reward.rewardId, 4);
  assert.equal(reward.rewardName, 'Shotgun');
  assert.deepEqual(player.PlayerGuns.get('4'), { id: 4, level: 1, ammo: 100000, isNew: true });
  assert.equal(saved.called, true);
});

test('does not duplicate an already owned cross-game gun', async () => {
  const player = {
    walletAddress,
    PlayerGuns: new Map([['6', { id: 6, level: 1, ammo: 100000, isNew: false }]]),
    PlayerAchievementData: {},
    async save() {},
  };
  PlayerProfile.findOne = async () => player;

  const reward = await grantWarzoneGunReward({
    walletAddress,
    sourceGame: 'highwayHustle',
    difficulty: 'medium',
    metric: 'points',
    value: 25000,
  });

  assert.equal(reward.created, false);
  assert.equal(reward.rewardId, 6);
  assert.equal(reward.rewardName, 'Bullpup');
  assert.equal(player.PlayerGuns.size, 1);
});
