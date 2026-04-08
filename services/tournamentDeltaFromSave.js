/**
 * Tournament coin delta for saveProfile: stores baseline per (wallet, round) in PlayerRoundParticipation.
 * baselineCoin is never exposed in API responses from profileController.
 */
const https = require('https');
const PlayerProfile = require('../models/PlayerProfile');
const PlayerRoundParticipation = require('../models/PlayerRoundParticipation');

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api-stage.intraverse.io';
const DEFAULT_GAME_SLUG = process.env.INTRAVERSE_GAME_SLUG || 'warzone-warriors';

function shortWallet(w) {
  const s = String(w || '').trim();
  if (s.length < 14) return s || '(empty)';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function snippet(value, max = 480) {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value).slice(0, max);
  }
}

function isRoundIntervalActive(round) {
  if (!round || !Array.isArray(round.intervals) || round.intervals.length === 0) return false;
  const now = Date.now();
  return round.intervals.some((iv) => now >= iv.startDate && now <= iv.endDate);
}

/**
 * GET /api/v2/tournament/game/:slug — same source as intraverseTestRoutes sync-tournaments.
 * Returns the first round id whose interval contains now (RUNNING tournaments first).
 */
async function resolveActiveRoundIdFromIntraverse(slug = DEFAULT_GAME_SLUG) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }
  const url = `${BASE_URL}/api/v2/tournament/game/${encodeURIComponent(slug)}?size=30`;
  let status;
  let body;
  try {
    const r = await fetchJSON(url, { method: 'GET', headers });
    status = r.status;
    body = r.body;
  } catch (err) {
    // Optional: log tournament-list failures when debugging round resolution
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_fetch_error', slug, message: err.message || String(err) });
    return {
      roundId: null,
      reason: 'FETCH_ERROR',
      fetchStatus: 0,
      detail: err.message || String(err),
    };
  }
  if (status !== 200) {
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_http_error', slug, httpStatus: status, body: snippet(body) });
    return { roundId: null, reason: 'FETCH_FAILED', fetchStatus: status, detail: body };
  }
  const tournaments = body?.data;
  if (!Array.isArray(tournaments)) {
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_invalid_body', slug, httpStatus: status });
    return { roundId: null, reason: 'INVALID_RESPONSE', fetchStatus: status };
  }
  const running = tournaments.filter((t) => String(t?.status || '').toUpperCase() === 'RUNNING');
  const rest = tournaments.filter((t) => String(t?.status || '').toUpperCase() !== 'RUNNING');
  for (const t of [...running, ...rest]) {
    for (const r of t.rounds || []) {
      if (isRoundIntervalActive(r)) {
        // console.log('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'active_round_resolved', slug, roundId: String(r.id), tournamentId: t.id != null ? String(t.id) : undefined });
        return {
          roundId: String(r.id),
          tournamentId: t.id != null ? String(t.id) : undefined,
          fetchStatus: status,
        };
      }
    }
  }
  // console.log('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'no_active_round', slug, tournamentCount: tournaments.length });
  return { roundId: null, reason: 'NO_ACTIVE_ROUND', fetchStatus: status };
}

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

async function postIntraverseGamePoint({ roundId, walletAddress, roomId, score }) {
  const headers = { 'Content-Type': 'application/json' };
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

/**
 * After profile is saved with updated coins: establish baseline or compute delta, update medal increment, forward cumulative delta to Intraverse.
 * Does not return baselineCoin to callers.
 */
async function applyTournamentDeltaOnProfileSave(walletAddress, roundId, roomId) {
  const profile = await PlayerProfile.findOne(walletAddressRegexQuery(walletAddress));
  if (!profile) {
    return { ok: false, reason: 'NO_PROFILE' };
  }

  const coins = Number(profile.PlayerResources?.coin) || 0;
  const w = String(walletAddress).trim();

  let participation = await PlayerRoundParticipation.findOne({
    ...walletAddressRegexQuery(walletAddress),
    roundId: String(roundId),
  });

  let cumulativeDelta = 0;
  let medalAdded = 0;

  if (!participation) {
    participation = new PlayerRoundParticipation({
      walletAddress: w,
      roundId: String(roundId),
      baselineCoin: coins,
      roundPoints: 0,
    });
    await participation.save();
    cumulativeDelta = 0;
    medalAdded = 0;
  } else {
    cumulativeDelta = Math.max(0, coins - (Number(participation.baselineCoin) || 0));
    const previous = Number(participation.roundPoints) || 0;
    medalAdded = Math.max(0, cumulativeDelta - previous);
    participation.roundPoints = cumulativeDelta;
    participation.lastUpdated = new Date();
    await participation.save();

    if (medalAdded > 0) {
      if (!profile.PlayerResources) {
        profile.PlayerResources = {
          coin: 1000,
          gem: 0,
          stamina: 0,
          medal: 0,
          tournamentTicket: 0,
        };
      }
      profile.PlayerResources.medal = (Number(profile.PlayerResources.medal) || 0) + medalAdded;
      await profile.save();
    }
  }

  let intrabaseStatus;
  let intrabaseBody;
  try {
    const iv = await postIntraverseGamePoint({
      roundId: String(roundId),
      walletAddress: w,
      roomId,
      score: cumulativeDelta,
    });
    intrabaseStatus = iv.status;
    intrabaseBody = iv.body;
    const okHttp = intrabaseStatus >= 200 && intrabaseStatus < 300;
    const ivPayloadBase = {
      ts: new Date().toISOString(),
      wallet: shortWallet(w),
      roundId: String(roundId),
      scoreSent: cumulativeDelta,
      medalAdded,
      httpStatus: intrabaseStatus,
      response: snippet(intrabaseBody),
    };
    if (okHttp) {
      console.log('[tournament-intraverse]', { event: 'game_point_ok', ...ivPayloadBase });
    } else {
      console.warn('[tournament-intraverse]', { event: 'game_point_http_error', ...ivPayloadBase });
    }
  } catch (err) {
    intrabaseStatus = 0;
    intrabaseBody = { error: err.message || String(err) };
    console.warn('[tournament-intraverse]', {
      ts: new Date().toISOString(),
      event: 'game_point_request_failed',
      wallet: shortWallet(w),
      roundId: String(roundId),
      scoreSent: cumulativeDelta,
      medalAdded,
      message: err.message || String(err),
    });
  }

  return {
    ok: true,
    roundId: String(roundId),
    cumulativeDelta,
    medalAdded,
    intrabaseStatus,
    intrabaseBody,
  };
}

module.exports = {
  applyTournamentDeltaOnProfileSave,
  postIntraverseGamePoint,
  resolveActiveRoundIdFromIntraverse,
};
