const https = require('https');
const PlayerProfile = require('../models/PlayerProfile');
const TournamentMetadata = require('../models/TournamentMetadata');
const PlayerRoundParticipation = require('../models/PlayerRoundParticipation');

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api-stage.intraverse.io';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressRegexQuery(walletAddress) {
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(String(walletAddress).trim())}$`, 'i') },
  };
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

function isRoundIntervalActive(round) {
  if (!round || !Array.isArray(round.intervals) || round.intervals.length === 0) return false;
  const now = Date.now();
  return round.intervals.some((iv) => now >= iv.startDate && now <= iv.endDate);
}

async function findRoundMetaByRoundId(roundId) {
  const meta = await TournamentMetadata.findOne({ 'rounds.id': roundId }).lean();
  if (!meta || !Array.isArray(meta.rounds)) return { meta: null, round: null };
  const round = meta.rounds.find((r) => r.id === roundId);
  return { meta, round: round || null };
}

/**
 * Coin delta vs round baseline; updates participation; optionally exp and/or medal; does not call Intraverse.
 * @param {object} opts
 * @param {boolean} [opts.updateExp=true]
 * @param {boolean} [opts.updateMedal=true]
 */
async function computeTournamentGamePoint(walletAddress, roundId, opts = {}) {
  const {
    kills,
    deaths,
    metadata,
    updateExp = true,
    updateMedal = true,
  } = opts;

  const profile = await PlayerProfile.findOne(walletAddressRegexQuery(walletAddress));
  if (!profile) return { ok: false, reason: 'NO_PROFILE' };

  const { meta, round } = await findRoundMetaByRoundId(roundId);
  if (!round || !isRoundIntervalActive(round)) {
    return { ok: false, reason: 'ROUND_NOT_ACTIVE' };
  }

  const currentCoins = Number(profile.PlayerResources?.coin) || 0;
  let participation = await PlayerRoundParticipation.findOne({
    ...walletAddressRegexQuery(walletAddress),
    roundId,
  });

  if (!participation) {
    participation = new PlayerRoundParticipation({
      walletAddress,
      roundId,
      tournamentId: meta.tournamentId,
      baselineCoin: currentCoins,
      roundPoints: 0,
    });
    await participation.save();
  }

  const previousRoundPoints = Number(participation.roundPoints) || 0;
  const delta = Math.max(0, currentCoins - Number(participation.baselineCoin));
  const expGain = Math.max(0, delta - previousRoundPoints);

  participation.roundPoints = delta;
  if (kills !== undefined) participation.kills = kills;
  if (deaths !== undefined) participation.deaths = deaths;
  if (metadata) participation.metadata = { ...participation.metadata, ...metadata };
  participation.lastUpdated = new Date();
  await participation.save();

  if (expGain > 0 && (updateExp || updateMedal)) {
    if (updateExp) {
      if (!profile.PlayerProfile) {
        profile.PlayerProfile = { level: 1, exp: 0 };
      }
      profile.PlayerProfile.exp = (Number(profile.PlayerProfile.exp) || 0) + expGain;
    }
    if (updateMedal) {
      if (!profile.PlayerResources) {
        profile.PlayerResources = {
          coin: 1000,
          gem: 0,
          stamina: 0,
          medal: 0,
          tournamentTicket: 0,
        };
      }
      profile.PlayerResources.medal = (Number(profile.PlayerResources.medal) || 0) + expGain;
    }
    await profile.save();
  }

  return { ok: true, delta, expGain };
}

/**
 * POST computed score to Intraverse (server key).
 */
async function postIntraverseGamePoint({ roundId, walletAddress, roomId, score }) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }
  const body = {
    roundId,
    roomId: String(roomId || `warzone-${Date.now()}`).slice(0, 64),
    score: Number(score),
    walletAddress,
  };
  return fetchJSON(`${BASE_URL}/api/v2/game-point/`, {
    method: 'POST',
    headers,
    body,
  });
}

module.exports = {
  computeTournamentGamePoint,
  postIntraverseGamePoint,
  BASE_URL,
  isRoundIntervalActive,
  findRoundMetaByRoundId,
};
