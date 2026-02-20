// controllers/newDBController.js
const mongoose = require('mongoose');
const PlayerProfile = require('../models/PlayerProfile');
const WarzoneNameWallet = require('../models/nameWallet');

const EVENT_DB_URI =
  process.env.EVENT_DB_URI ||
  process.env.NEW_MONGO_URI ||
  process.env.NEW_DB_URI;
const EVENT_DB_NAME =
  process.env.EVENT_DB_NAME ||
  process.env.NEW_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  'new-warzone';

let newDbConn;
let AltProfile;
let AltNameWallet;

async function getAltModels() {
  if (AltProfile && AltNameWallet) return { AltProfile, AltNameWallet };

  if (!newDbConn) {
    if (!EVENT_DB_URI) {
      throw new Error('EVENT_DB_URI is not configured');
    }

    newDbConn = mongoose.createConnection(EVENT_DB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      dbName: EVENT_DB_NAME,
    });
    newDbConn.on('connected', () => console.log('[newDB] connected'));
    newDbConn.on('error', (err) => console.error('[newDB] connection error:', err));
    await newDbConn.asPromise();
  }

  // Reuse existing schemas on this separate connection
  AltProfile = newDbConn.model('WarzonePlayerProfile', PlayerProfile.schema);
  AltNameWallet = newDbConn.model('WarzoneNameWallet', WarzoneNameWallet.schema);

  return { AltProfile, AltNameWallet };
}

// GET all entries from the specific DB (no limit)
exports.getSpecificDBLeaderboard = async (req, res) => {
  try {
    const { AltProfile, AltNameWallet } = await getAltModels();

    const docs = await AltProfile
      .find()
      .sort({ 'PlayerResources.coin': -1 })
      .limit(100); // top 100 entries
    const walletAddresses = docs.map(d => d.walletAddress);

    // Optional: attach names if present in the same DB
    const nameDocs = await AltNameWallet.find({ walletAddress: { $in: walletAddresses } });
    const nameMap = Object.fromEntries(nameDocs.map(n => [n.walletAddress, n.name]));

    const data = docs.map(d => {
      const obj = d.toObject(); // apply schema getters/decoders
      return {
        ...obj,
        name: nameMap[obj.walletAddress] || null,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('getSpecificDBLeaderboard error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch data from specific DB' });
  }
};

// Optional: merged result across current default DB + the specific DB
exports.getMergedLeaderboard = async (req, res) => {
  try {
    const { AltProfile } = await getAltModels();
    const [currentDocs, altDocs] = await Promise.all([
      // Default connection model (current DB)
      PlayerProfile.find(),
      // Alt connection model (specific DB)
      AltProfile.find(),
    ]);

    // Merge by walletAddress (last in wins)
    const byWallet = new Map();
    for (const d of [...currentDocs, ...altDocs]) {
      const obj = d.toObject();
      byWallet.set(obj.walletAddress, obj);
    }

    const data = Array.from(byWallet.values());
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('getMergedLeaderboard error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch merged data' });
  }
};
