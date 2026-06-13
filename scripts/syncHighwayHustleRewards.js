require('dotenv').config();
const mongoose = require('mongoose');
const PlayerProfile = require('../models/PlayerProfile');
const { grantLamborghiniIfEligible } = require('../services/highwayHustleRewardService');

async function main() {
  const threshold = Number(process.env.HIGHWAY_HUSTLE_LAMBORGHINI_COIN_THRESHOLD || 3000);
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!process.env.HIGHWAY_HUSTLE_REWARD_GRANT_SECRET) {
    throw new Error('HIGHWAY_HUSTLE_REWARD_GRANT_SECRET is required');
  }

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || 'new-warzone',
  });

  let eligible = 0;
  let granted = 0;
  let failed = 0;
  const cursor = PlayerProfile.find({
    'PlayerResources.coin': { $gte: threshold },
  }).cursor();

  for await (const player of cursor) {
    eligible += 1;
    try {
      const result = await grantLamborghiniIfEligible(player);
      if (result.granted) granted += 1;
    } catch (error) {
      failed += 1;
      console.error('[cross-game-reward-backfill] grant failed', {
        walletAddress: player.walletAddress,
        message: error?.message || String(error),
      });
    }
  }

  console.log('[cross-game-reward-backfill] complete', { threshold, eligible, granted, failed });
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[cross-game-reward-backfill] fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
