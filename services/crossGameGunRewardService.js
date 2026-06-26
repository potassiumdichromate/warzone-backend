const PlayerProfile = require('../models/PlayerProfile');

const CROSS_GAME_REWARD_SECRET = 'warzone-gun-cross-game-reward-v1';
const REWARD_SECRET_HEADER = 'x-cross-game-reward-secret';

const MEDIUM_GUN_REWARDS = Object.freeze({
  zeroDash: Object.freeze({ gunId: 4, gunName: 'Shotgun' }),
  highwayHustle: Object.freeze({ gunId: 6, gunName: 'Bullpup' }),
  zerogool: Object.freeze({ gunId: 2, gunName: 'ScarH' }),
});

function normalizeWalletAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidWalletAddress(value) {
  return /^0x[a-f0-9]{40}$/i.test(value || '');
}

function getExpectedSecret() {
  return String(process.env.CROSS_GAME_WARZONE_REWARD_SECRET || CROSS_GAME_REWARD_SECRET).trim();
}

function verifyRewardSecret(req) {
  const provided = String(req.header(REWARD_SECRET_HEADER) || '').trim();
  return Boolean(provided && provided === getExpectedSecret());
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  return { walletAddress: { $regex: new RegExp(`^${walletAddress}$`, 'i') } };
}

function ensurePlayerGunMap(player) {
  if (player.PlayerGuns instanceof Map) return player.PlayerGuns;
  const map = new Map(Object.entries(player.PlayerGuns || {}));
  player.PlayerGuns = map;
  return map;
}

async function grantWarzoneGunReward({ walletAddress, sourceGame, difficulty, metric, value }) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!isValidWalletAddress(wallet)) {
    const err = new Error('A valid walletAddress is required');
    err.statusCode = 400;
    throw err;
  }

  const reward = MEDIUM_GUN_REWARDS[sourceGame];
  if (!reward) {
    const err = new Error('Unsupported cross-game reward source');
    err.statusCode = 400;
    throw err;
  }

  const profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(wallet));
  if (!profile) {
    const err = new Error('Warzone player profile not found');
    err.statusCode = 404;
    throw err;
  }

  const gunKey = String(reward.gunId);
  const gunsMap = ensurePlayerGunMap(profile);
  const existing = gunsMap instanceof Map ? gunsMap.get(gunKey) : gunsMap[gunKey];
  const created = !existing;

  if (created) {
    const gunData = { id: reward.gunId, level: 1, ammo: 100000, isNew: true };
    if (gunsMap instanceof Map) {
      gunsMap.set(gunKey, gunData);
    } else {
      gunsMap[gunKey] = gunData;
      profile.PlayerGuns = gunsMap;
      if (typeof profile.markModified === 'function') profile.markModified('PlayerGuns');
    }
  }

  if (!profile.PlayerAchievementData) profile.PlayerAchievementData = {};
  profile.PlayerAchievementData[`CROSS_GAME_${sourceGame}_${reward.gunName}`] = {
    type: 1001,
    claimTimes: 1,
    progress: Number(value) || 0,
    isReady: false,
    sourceGame,
    difficulty,
    metric,
    rewardType: 'warzone_gun',
    gunId: reward.gunId,
    gunName: reward.gunName,
    grantedAt: new Date().toISOString(),
  };

  await profile.save();

  return {
    walletAddress: profile.walletAddress,
    sourceGame,
    difficulty,
    metric,
    value: Number(value) || 0,
    rewardType: 'warzone_gun',
    rewardId: reward.gunId,
    rewardName: reward.gunName,
    created,
  };
}

module.exports = {
  CROSS_GAME_REWARD_SECRET,
  MEDIUM_GUN_REWARDS,
  REWARD_SECRET_HEADER,
  grantWarzoneGunReward,
  verifyRewardSecret,
};
