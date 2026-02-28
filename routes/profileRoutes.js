const express = require('express');
const router = express.Router();
const { getProfile, saveProfile, getLeaderboard, checkNameExistance, getDailyQuests,
  getDailyQuestByType, getAchieveQuestByType, saveName, getName, login } = require('../controllers/profileController');
const { getSpecificDBLeaderboard } = require('../controllers/newDBController');
const verifyUser = require('../routes/middleware/verifyUser');
const rateLimiter = require('../routes/middleware/rateLimiter');

const iapController = require('../controllers/iap.controller');
// In-memory pricing exposure for store UI (Coins/Gems only)

function getClientIp(req) {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  const xRealIp = req?.headers?.['x-real-ip'];
  const forwarded = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const realIp = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
  const firstForwardedIp = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return firstForwardedIp || realIp || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function normalizeWallet(value) {
  return String(value || '').trim().toLowerCase();
}

function validateWalletQuery(req, res, next) {
  const wallet = normalizeWallet(req.query?.walletAddress);
  if (!wallet) {
    return res.status(400).json({ success: false, error: 'walletAddress is required' });
  }
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ success: false, error: 'walletAddress must be a valid EVM address' });
  }
  next();
}

function validateQuestType(req, res, next) {
  const type = Number(req.params?.type);
  if (!Number.isFinite(type)) {
    return res.status(400).json({ success: false, error: 'type must be a number' });
  }
  next();
}

const questIpLimiter = rateLimiter({
  windowMs: 60_000,
  max: Number(process.env.QUEST_RATE_LIMIT_PER_IP || 120),
  keyGenerator: (req) => `quest-ip:${getClientIp(req)}`,
  message: 'Too many quest requests from this IP, please try again later.',
});

const questWalletLimiter = rateLimiter({
  windowMs: 60_000,
  max: Number(process.env.QUEST_RATE_LIMIT_PER_WALLET || 40),
  keyGenerator: (req) => `quest-ip-wallet:${getClientIp(req)}:${normalizeWallet(req.query?.walletAddress)}`,
  message: 'Too many quest requests for this wallet from this IP, please slow down.',
});


router.get('/', getProfile);
router.post('/', saveProfile);
router.get('/dailyQuests', getDailyQuests);
router.get('/dailyQuests/type/:type', questIpLimiter, questWalletLimiter, validateWalletQuery, validateQuestType, getDailyQuestByType);
router.get('/achieveQuests/type/:type', questIpLimiter, questWalletLimiter, validateWalletQuery, validateQuestType, getAchieveQuestByType);
router.get('/leaderboard', getLeaderboard);
router.get('/leaderboard/allTime',getSpecificDBLeaderboard)
router.post('/name', checkNameExistance);
router.post('/saveName', verifyUser, saveName);
router.get('/name', verifyUser, getName);
router.post('/login', login);

router.get("/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

router.post('/iap/purchase', verifyUser, iapController.purchase);
// Legacy alias for FE compatibility
router.post('/api/v1/player/iap/purchase', verifyUser, iapController.purchase);

// Optional: expose pricing for Coins/Gems so FE can render store
router.get('/iap/pricing', (req, res) => {
  // Keep in sync with controllers/iap.controller.js
  const currency = 'ETH';
  const coinPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '500', amount: 500, priceEth: '2', price: 2, currency },
    { product: '1000', amount: 1000, priceEth: '4', price: 4, currency },
    { product: '2000', amount: 2000, priceEth: '7.5', price: 7.5, currency },
  ];
  const gemPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '300', amount: 300, priceEth: '1.5', price: 1.5, currency },
    { product: '500', amount: 500, priceEth: '2.5', price: 2.5, currency },
    { product: '1000', amount: 1000, priceEth: '5', price: 5, currency },
  ];

  res.json({ ok: true, data: { coins: coinPacks, gems: gemPacks, currency } });
});
// Legacy alias for FE compatibility
router.get('/api/v1/player/iap/pricing', (req, res) => {
  const currency = 'STT';
  const coinPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '500', amount: 500, priceEth: '2', price: 2, currency },
    { product: '1000', amount: 1000, priceEth: '4', price: 4, currency },
    { product: '2000', amount: 2000, priceEth: '7.5', price: 7.5, currency },
  ];
  const gemPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '300', amount: 300, priceEth: '1.5', price: 1.5, currency },
    { product: '500', amount: 500, priceEth: '2.5', price: 2.5, currency },
    { product: '1000', amount: 1000, priceEth: '5', price: 5, currency },
  ];

  res.json({ ok: true, data: { coins: coinPacks, gems: gemPacks, currency } });
});

module.exports = router;
