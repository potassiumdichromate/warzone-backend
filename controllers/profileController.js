const { ethers } = require('ethers');
const crypto = require('crypto');

// controllers/warzoneController.js
const jwt = require('jsonwebtoken');
const PlayerProfile = require('../models/PlayerProfile');
const WarzoneNameWallet = require('../models/nameWallet');
const NameCounter = require('../models/nameCounter');
const { request } = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const SUPPORTED_WALLET_PROVIDER_TYPES = new Set([
  'metamask',
  'coinbase_wallet',
  'base_account',
  'rainbow',
  'phantom',
  'zerion',
  'cryptocom',
  'uniswap',
  'okx_wallet',
  'bitget_wallet',
  'universal_profile',
]);

function normalizeWalletProviderType(rawType) {
  if (!rawType) return null;
  const normalized = String(rawType).trim().toLowerCase();
  if (!normalized) return null;

  // Backward-compatible aliases seen in wallet SDKs.
  if (normalized === 'bitget') return 'bitget_wallet';
  if (normalized === 'okx') return 'okx_wallet';

  return SUPPORTED_WALLET_PROVIDER_TYPES.has(normalized) ? normalized : normalized;
}

function extractLoginWalletAddress(payload) {
  return (
    payload?.walletAddress ||
    payload?.wallet?.address ||
    payload?.privyMetaData?.walletAddress ||
    payload?.privyMetaData?.address ||
    null
  );
}

function normalizeWalletAddress(walletAddress) {
  return String(walletAddress || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  const normalized = normalizeWalletAddress(walletAddress);
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') }
  };
}

function getClientIp(req) {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  const xRealIp = req?.headers?.['x-real-ip'];
  const forwarded = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const realIp = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
  const firstForwardedIp = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return firstForwardedIp || realIp || req?.ip || req?.socket?.remoteAddress || '';
}

// Somnia mainnet / chain settings (env-driven, read lazily)
function readEnv(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const trimmed = String(v).trim();
  return trimmed === '' ? fallback : trimmed;
}

function getChainConfig() {
  const rpcUrl = readEnv('SOMNIA_RPC_URL', 'https://api.infra.mainnet.somnia.network');
  const contractAddress = readEnv('GAME_CONTRACT_ADDRESS', '0xEA4450c195ECFd63A6d7e35768fF351e748317cB');
  const ownerPkRaw = readEnv('GAME_OWNER_PRIVATE_KEY', readEnv('OWNER_PRIVATE_KEY', '0x4612ee7e7af911a0ddb516f345962f51d0de28243c1232499cdc28545b431087'));
  const waitConfirmations = Number(readEnv('WAIT_FOR_CONFIRMATIONS', '1'));
  const gasPriceGwei = readEnv('GAS_PRICE_GWEI', '');
  return { rpcUrl, contractAddress, ownerPkRaw, waitConfirmations, gasPriceGwei };
}

const GAME_ABI = [
  'function registerUser(address user, string name) external',
  'function startGameFor(address user) external returns (uint256)',
  'function endGameFor(address user) external returns (uint256)',
  'function isRegistered(address user) external view returns (bool)',
  'function activeSessionOf(address user) external view returns (uint256)',
];

let _gameContract;
function getGameContract() {
  if (_gameContract) return _gameContract;

  const { rpcUrl, contractAddress, ownerPkRaw } = getChainConfig();
  if (!rpcUrl) throw new Error('Missing SOMNIA_RPC_URL');
  if (!contractAddress) throw new Error('Missing GAME_CONTRACT_ADDRESS');
  if (!ownerPkRaw) throw new Error('Missing GAME_OWNER_PRIVATE_KEY');

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const pkTrim = ownerPkRaw.trim();
  const pk = pkTrim.startsWith('0x') ? pkTrim : `0x${pkTrim}`;
  const wallet = new ethers.Wallet(pk, provider);
  _gameContract = new ethers.Contract(contractAddress, GAME_ABI, wallet);
  return _gameContract;
}

function gasOverrides() {
  const { gasPriceGwei } = getChainConfig();
  if (gasPriceGwei && !Number.isNaN(Number(gasPriceGwei))) {
    return { gasPrice: ethers.utils.parseUnits(String(gasPriceGwei), 'gwei') };
  }
  return {};
}

/**
 * Safely extract values from PlayerAchievementData regardless of whether
 * Mongoose returns it as a Map, a plain object, or a Mongoose document.
 * This is the core fix — Mongoose Map cannot be iterated with Object.values().
 */
function extractAchievementValues(achievementData) {
  if (!achievementData) return [];

  // Mongoose Map (most common case with Map schema type)
  if (achievementData instanceof Map) {
    return Array.from(achievementData.values());
  }

  // After .toObject() — plain JS object
  if (typeof achievementData === 'object' && !Array.isArray(achievementData)) {
    return Object.values(achievementData).filter(
      v => v !== null && typeof v === 'object' && 'type' in v
    );
  }

  return [];
}

async function registerAndStartOnChain(walletAddress, displayName = '') {
  const overrides = gasOverrides();

  const result = {
    attemptedRegister: false,
    registerTxHash: null,
    attemptedStart: false,
    startTxHash: null,
    notes: [],
  };
  try {
    const contract = getGameContract();
    let registered = false;
    try {
      registered = await contract.isRegistered(walletAddress);
    } catch {
      result.notes.push('isRegistered check failed — continuing.');
    }

    if (!registered) {
      result.attemptedRegister = true;
      const tx = await contract.registerUser(walletAddress, displayName, overrides);
      result.registerTxHash = tx.hash;
      const { waitConfirmations } = getChainConfig();
      if (waitConfirmations >= 0) await tx.wait(waitConfirmations);
    } else {
      result.notes.push('Already registered on-chain.');
    }

    let activeId = 0;
    try {
      activeId = Number(await contract.activeSessionOf(walletAddress) || 0);
    } catch {
      result.notes.push('activeSessionOf check failed — attempting start anyway.');
    }

    if (!activeId) {
      result.attemptedStart = true;
      const tx2 = await contract.startGameFor(walletAddress, overrides);
      result.startTxHash = tx2.hash;
      const { waitConfirmations: wait2 } = getChainConfig();
      if (wait2 >= 0) await tx2.wait(wait2);
    } else {
      result.notes.push(`Game already active (sessionId=${activeId}).`);
    }
  } catch (err) {
    console.error('On-chain error:', err);
    result.notes.push(`On-chain error: ${err.message || String(err)}`);
  }

  console.log('registerAndStartOnChain result:', result);
  return result;
}

async function endGameIfActive(walletAddress) {
  const overrides = gasOverrides();

  const result = {
    attemptedEnd: false,
    endTxHash: null,
    notes: [],
  };

  try {
    const contract = getGameContract();
    let activeId = 0;
    try {
      activeId = Number(await contract.activeSessionOf(walletAddress) || 0);
    } catch {
      result.notes.push('activeSessionOf check failed — attempting end anyway.');
    }

    if (!activeId) {
      result.notes.push('No active game to end.');
      return result;
    }

    result.attemptedEnd = true;
    const tx = await contract.endGameFor(walletAddress, overrides);
    result.endTxHash = tx.hash;
    const { waitConfirmations } = getChainConfig();
    if (waitConfirmations >= 0) await tx.wait(waitConfirmations);
  } catch (err) {
    console.error('endGameIfActive error:', err);
    result.notes.push(`On-chain error: ${err.message || String(err)}`);
  }

  return result;
}

/* ---------------- defaults & utils ---------------- */
const defaultData = {
  PlayerProfile: { level: 1, exp: 0 },
  PlayerResources: { coin: 1000, gem: 0, stamina: 0, medal: 0, tournamentTicket: 0 },
  PlayerRambos: { "0": { id: 0, level: 1 } },
  PlayerRamboSkills: { "0": Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i.toString(), 0])) },
  PlayerGuns: { "0": { id: 0, level: 1, ammo: 0, isNew: false } },
  PlayerGrenades: { "500": { id: 500, level: 1, quantity: 10, isNew: false } },
  PlayerMeleeWeapons: { "600": { id: 600, level: 1, isNew: false } },
  PlayerCampaignProgress: {},
  PlayerCampaignStageProgress: {},
  PlayerCampaignRewardProgress: {},
  PlayerBoosters: { Hp: 0, Grenade: 0, Damage: 0, CoinMagnet: 0, Speed: 0, Critical: 0 },
  PlayerSelectingBooster: [],
  PlayerDailyQuestData: [],
  PlayerAchievementData: {},
  PlayerTutorialData: {}
};

const generateDefaultName = async () => {
  const counter = await NameCounter.findByIdAndUpdate(
    'default',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `JohnDigger${counter.seq}`;
};

function normalizeProfile(obj) {
  if (!obj) return obj;
  const ensure = (key, defVal) => {
    if (obj[key] === undefined || obj[key] === null) {
      obj[key] = Array.isArray(defVal) ? [] : (typeof defVal === 'object' ? {} : defVal);
    }
  };
  for (const [k, v] of Object.entries(defaultData)) ensure(k, v);

  if (obj.PlayerCampaignProgress == null) obj.PlayerCampaignProgress = {};
  if (obj.PlayerCampaignStageProgress == null) obj.PlayerCampaignStageProgress = {};
  if (obj.PlayerCampaignRewardProgress == null) obj.PlayerCampaignRewardProgress = {};
  if (obj.PlayerSelectingBooster == null) obj.PlayerSelectingBooster = [];
  if (obj.PlayerDailyQuestData == null) obj.PlayerDailyQuestData = [];
  if (obj.PlayerAchievementData == null) obj.PlayerAchievementData = {};
  if (obj.PlayerTutorialData == null) obj.PlayerTutorialData = {};

  return obj;
}

const getWalletProfile = async (walletAddress) => {
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  if (!normalizedWalletAddress) throw new Error('walletAddress required');

  let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));

  if (!profile) {
    profile = new PlayerProfile({ walletAddress, ...defaultData });
    normalizeProfile(profile);
    await profile.save();
  } else {
    if (profile.PlayerCampaignProgress == null) profile.PlayerCampaignProgress = {};
    if (profile.PlayerCampaignStageProgress == null) profile.PlayerCampaignStageProgress = {};
    normalizeProfile(profile);
    await profile.save();
  }
  return profile;
};

/* ---------------- controllers ---------------- */
exports.saveProfile = async (req, res) => {
  try {
    const { data: shouldUpdate, walletAddress, ...data } = req.body;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    if (shouldUpdate) {
      const profile = await getWalletProfile(walletAddress);
      return res.json(profile);
    }

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
    if (!profile) profile = new PlayerProfile({ walletAddress, ...defaultData });

    data.PlayerCampaignProgress = {};

    if (data.PlayerCampaignStageProgress == null) {
      data.PlayerCampaignStageProgress = {};
    }

    Object.assign(profile, data);
    normalizeProfile(profile);

    await profile.save();

    const chainEnd = await endGameIfActive(walletAddress);

    const fresh = await getWalletProfile(walletAddress);
    return res.json({ ...fresh, chain: chainEnd });
  } catch (error) {
    console.error('Error in saveProfile:', error);
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({ error: error.message, details: error.errors });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getDailyQuests = async (req, res) => {
  try {
    const { walletAddress } = req.query;
    if (!walletAddress) {
      return res.status(400).json({ success: false, error: "walletAddress is required" });
    }

    const profile = await getWalletProfile(walletAddress);
    if (!profile) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    return res.json({
      wallet: walletAddress,
      PlayerDailyQuestData: profile.PlayerDailyQuestData || []
    });
  } catch (error) {
    console.error("Error in getDailyQuests:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const walletAddress = req.query.walletAddress;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    const profile = await getWalletProfile(walletAddress);
    return res.json(profile);
  } catch (error) {
    console.error('Error in getProfile:', error);
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({ error: error.message, details: error.errors });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /dailyQuests/type/:type?walletAddress=0x...
exports.getDailyQuestByType = async (req, res) => {
  const requestId = crypto.randomBytes(16).toString('hex');
  try {
    const { walletAddress } = req.query;
    const type = Number(req.params.type);
    const clientIp = getClientIp(req);

    res.set('X-Request-Id', requestId);
    console.log('[getDailyQuestByType] start', { requestId, walletAddress, type, ip: clientIp, reqIp: req?.ip });

    if (!walletAddress) {
      console.warn('[getDailyQuestByType] missing walletAddress', { requestId, ip: clientIp, reqIp: req.ip });
      return res.status(400).json({ success: false, error: "walletAddress is required", requestId });
    }
    if (!Number.isFinite(type)) {
      console.warn('[getDailyQuestByType] invalid type', { requestId, type: req.params.type });
      return res.status(400).json({ success: false, error: "type must be a number", requestId });
    }

    const profile = await getWalletProfile(walletAddress);
    const all = Array.isArray(profile.PlayerDailyQuestData) ? profile.PlayerDailyQuestData : [];
    const matches = all.filter(q => Number(q.type) === type);

    let completed = false;
    let reward = '';

    console.log("requestID: ", requestId, " :: Matched ", matches);

    if (type == 11) {
      reward = 'Stage Runner';
      if (matches.length > 0 && matches[0].progress > 2) completed = true;
    } else if (type == 1) {
      reward = 'Mass Annihilation';
      if (matches.length > 0 && matches[0].progress >= 200) completed = true;
    } else if (type == 9) {
      reward = 'Tank Buster';
      if (matches.length > 0 && matches[0].progress >= 20) completed = true;
    } else if (type == 10) {
      reward = 'Hardcore Victor';
      if (matches.length > 0 && matches[0].progress > 5) completed = true;
    } else if (type == 0) {
      reward = 'Boss Slayer';
      if (matches.length > 0 && matches[0].progress >= 3) completed = true;
    }

    const newResponse = {
      success: true,
      status: 200,
      wallet: walletAddress,
      completed: completed ?? false,
      score: matches[0]?.progress ?? 0,
      isClaimed: matches[0]?.isClaimed ?? false,
      reward: reward,
    };

    console.log('[getDailyQuestByType] success', { requestId, walletAddress, type, completed: newResponse.completed, score: newResponse.score });
    return res.json({ ...newResponse });
  } catch (error) {
    console.error("[getDailyQuestByType] error", { requestId, message: error?.message, stack: error?.stack });
    res.set('X-Request-Id', requestId);
    return res.status(500).json({
      ok: false,
      status: 500,
      error: "Server Error, Please Retry",
      requestId
    });
  }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const leaderboard = await PlayerProfile.find()
      .sort({ 'PlayerResources.coin': -1 })
      .limit(100);

    const walletAddresses = leaderboard.map(p => p.walletAddress);
    const nameRecords = await WarzoneNameWallet.find({ walletAddress: { $in: walletAddresses } });
    const nameMap = {};
    nameRecords.forEach(r => { nameMap[r.walletAddress] = r.name; });

    const leaderboardWithNames = leaderboard.map(doc => {
      const profile = doc.toObject();
      const normalized = normalizeProfile(profile);
      return {
        ...normalized,
        name: nameMap[profile.walletAddress] || `JohnDigger${Math.floor(Math.random() * 1000)}`
      };
    });

    res.json(leaderboardWithNames);
  } catch (error) {
    console.error('Error in getLeaderboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching leaderboard' });
  }
};

exports.checkNameExistance = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const profile = await WarzoneNameWallet.findOne({ name });
    if (profile) return res.json({ success: false, message: 'Name already exists' });
    return res.json({ success: true, message: 'Name is available' });
  } catch (error) {
    console.error('Error in checkNameExistance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.saveName = async (req, res) => {
  try {
    const { name, walletAddress } = req.body;
    if (!walletAddress || !name) {
      return res.status(400).json({ success: false, error: 'Wallet address and name are required' });
    }

    const existingName = await WarzoneNameWallet.findOne({ name });
    if (existingName && existingName.walletAddress !== walletAddress) {
      return res.status(400).json({ success: false, error: 'Name is already taken' });
    }

    const profile = await WarzoneNameWallet.findOneAndUpdate(
      { walletAddress },
      { name, isDefaultName: false },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, message: 'Name saved successfully', data: profile });
  } catch (error) {
    console.error('Error saving name:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.getName = async (req, res) => {
  try {
    const walletAddress = req.walletAddress;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    let nameRecord = await WarzoneNameWallet.findOne({ walletAddress });
    if (!nameRecord) {
      const defaultName = await generateDefaultName();
      nameRecord = new WarzoneNameWallet({ walletAddress, name: defaultName, isDefaultName: true });
      await nameRecord.save();
    }

    res.json({ success: true, name: nameRecord.name, isDefault: nameRecord.isDefaultName || false });
  } catch (error) {
    console.error('Error in getName:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.login = async (req, res) => {
  try {
    const walletAddress = extractLoginWalletAddress(req.body);
    const providerType = normalizeWalletProviderType(
      req.body?.walletProviderType ||
      req.body?.walletType ||
      req.body?.privyMetaData?.type ||
      req.body?.wallet?.walletClientType
    );
    const providerName = req.body?.providerName || req.body?.privyMetaData?.providerName || null;
    const privyUserId = req.body?.privyUserId || req.body?.privyMetaData?.privyUserId || null;

    if (!walletAddress) {
      return res.status(400).json({ success: false, message: 'Wallet address is required' });
    }

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
    const isNewUser = !profile;

    if (isNewUser) {
      profile = new PlayerProfile({ walletAddress, ...defaultData });
      normalizeProfile(profile);
      profile.walletProviderType = providerType;
      profile.walletProviderName = providerName;
      profile.privyUserId = privyUserId;
      profile.lastLoginAt = new Date();
      await profile.save();
    } else {
      normalizeProfile(profile);
      profile.walletProviderType = providerType || profile.walletProviderType || null;
      profile.walletProviderName = providerName || profile.walletProviderName || null;
      profile.privyUserId = privyUserId || profile.privyUserId || null;
      profile.lastLoginAt = new Date();
      await profile.save();
    }

    const chainResult = await registerAndStartOnChain(walletAddress, '');

    const token = jwt.sign({ walletAddress }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      ...(process.env.NODE_ENV === 'production' ? { domain: '.warzonewarriors.xyz' } : {})
    });

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'User registered successfully' : 'Login successful',
      token,
      user: {
        walletAddress: profile.walletAddress,
        walletProviderType: profile.walletProviderType,
        walletProviderName: profile.walletProviderName,
        isNewUser,
      },
      chain: chainResult,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during authentication' });
  }
};

// GET /achieveQuests/type/:type?walletAddress=0x...
exports.getAchieveQuestByType = async (req, res) => {
  const requestId = crypto.randomBytes(16).toString('hex');
  try {
    const { walletAddress } = req.query;
    const type = Number(req.params.type);
    const clientIp = getClientIp(req);

    res.set('X-Request-Id', requestId);
    console.log('[getAchieveQuestByType] start', { requestId, walletAddress, type, ip: clientIp, reqIp: req?.ip });

    if (!walletAddress) {
      console.warn('[getAchieveQuestByType] missing walletAddress', { requestId, ip: clientIp, reqIp: req.ip });
      return res.status(400).json({ success: false, error: "walletAddress is required", requestId });
    }
    if (!Number.isFinite(type)) {
      console.warn('[getAchieveQuestByType] invalid type', { requestId, type: req.params.type });
      return res.status(400).json({ success: false, error: "type must be a number", requestId });
    }

    const profile = await getWalletProfile(walletAddress);

    // FIX: PlayerAchievementData is a Mongoose Map (schema type: Map).
    // Object.values() does NOT work on Mongoose Maps — must use extractAchievementValues()
    // which handles both Map instances and plain objects (post-.toObject()) correctly.
    const all = extractAchievementValues(profile.PlayerAchievementData);

    const matches = all.filter(q => q && Number(q.type) === type);

    console.log('[getAchieveQuestByType] all count:', all.length, '| matches:', JSON.stringify(matches));

    let completed = false;
    let reward = '';

    if (type == 4) {
      reward = 'Tank Buster';
      if (matches.length > 0 && matches[0].progress >= 20) completed = true;
    } else if (type == 23) {
      reward = 'Hardcore Victor';
      if (matches.length > 0 && matches[0].progress > 5) completed = true;
    } else if (type == 39) {
      reward = 'Boss Slayer';
      if (matches.length > 0 && matches[0].progress >= 3) completed = true;
    } else if (type == 0) {
      reward = 'Mass Annihilation';
      if (matches.length > 0 && matches[0].progress >= 200) completed = true;
    }

    const newResponse = {
      success: true,
      status: 200,
      wallet: walletAddress,
      completed: completed ?? false,
      score: matches[0]?.progress ?? 0,
      isClaimed: matches[0]?.isReady ?? false,
      reward: reward,
    };

    console.log('[getAchieveQuestByType] success', { requestId, walletAddress, type, completed: newResponse.completed, score: newResponse.score });
    return res.json({ ...newResponse });
  } catch (error) {
    console.error("[getAchieveQuestByType] error", { requestId, message: error?.message, stack: error?.stack });
    res.set('X-Request-Id', requestId);
    return res.status(500).json({
      ok: false,
      status: 500,
      error: "Server Error, Please Retry",
      requestId
    });
  }
};
