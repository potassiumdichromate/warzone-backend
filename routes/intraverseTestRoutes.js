const express = require('express');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PlayerProfile = require('../models/PlayerProfile');

const router = express.Router();

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api.intraverse.io';
const DEFAULT_GAME_SLUG = process.env.INTRAVERSE_GAME_SLUG || 'kult-games';

function getPlayBaseUrl() {
  if (process.env.INTRAVERSE_PLAY_BASE_URL) {
    return process.env.INTRAVERSE_PLAY_BASE_URL;
  }

  if (BASE_URL.includes('api-stage.intraverse.io')) {
    return 'https://play-stage.intraverse.io';
  }

  if (BASE_URL.includes('api.intraverse.io')) {
    return 'https://play.intraverse.io';
  }

  return 'https://play-stage.intraverse.io';
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

function buildQueryString(source, allowedKeys) {
  const params = new URLSearchParams();

  allowedKeys.forEach((key) => {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value));
    }
  });

  const query = params.toString();
  return query ? `?${query}` : '';
}

function getUserJwt(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const forwardedJwt = String(req.headers['x-user-jwt'] || '').trim();
  if (forwardedJwt.toLowerCase().startsWith('bearer ')) {
    return forwardedJwt.slice(7).trim();
  }

  return forwardedJwt;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const json = Buffer.from(payloadBase64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function pickPrimaryWalletAddress(payload) {
  const wallets = Array.isArray(payload?.wallets) ? payload.wallets : [];
  if (wallets.length === 0) return '';

  const ethereumWallet = wallets.find((item) => String(item?.chain || '').toLowerCase() === 'ethereum');
  if (ethereumWallet?.walletAddress) return String(ethereumWallet.walletAddress).trim().toLowerCase();

  const first = wallets[0];
  return String(first?.walletAddress || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  const normalized = String(walletAddress || '').trim().toLowerCase();
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') },
  };
}

function buildAuthHeaders(req, { includeClientKey = false, includeServerKey = false, includeUserJwt = false } = {}) {
  const headers = {};

  if (includeClientKey && process.env.INTRAVERSE_CLIENT_KEY) {
    headers['x-game-key'] = process.env.INTRAVERSE_CLIENT_KEY;
  }

  if (includeServerKey && process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }

  if (includeUserJwt) {
    const userJwt = getUserJwt(req);
    if (userJwt) {
      headers.Authorization = `Bearer ${userJwt}`;
    }
  }

  return headers;
}

async function proxyToIntraverse(req, res, path, options = {}) {
  try {
    const headers = {
      ...buildAuthHeaders(req, options.auth),
      ...(options.headers || {}),
    };

    const response = await fetchJSON(`${BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    console.log(`[intraverse] ${options.method || 'GET'} ${path}`, response.status, JSON.stringify(response.body, null, 2));
    res.status(response.status).json({ status: response.status, body: response.body });
  } catch (error) {
    console.error(`[intraverse] ${options.method || 'GET'} ${path} failed`, error);
    res.status(500).json({ error: error.message });
  }
}

router.get('/auth/magic-link', (req, res) => {
  const clientKey = String(process.env.INTRAVERSE_CLIENT_KEY || '').trim();
  if (!clientKey) {
    return res.status(500).json({
      success: false,
      message: 'INTRAVERSE_CLIENT_KEY is not configured on the server.',
    });
  }

  const authHash = crypto.randomUUID();
  const playBaseUrl = getPlayBaseUrl();
  const magicLoginUrl = `${playBaseUrl}/magic-login?hash=${encodeURIComponent(authHash)}&game=${encodeURIComponent(clientKey)}`;

  return res.json({
    success: true,
    authHash,
    clientKey,
    playBaseUrl,
    magicLoginUrl,
  });
});

router.post('/auth/user-login', async (req, res) => {
  const authHeader = String(req.headers.authorization || '').trim();
  const bodyToken = String(req.body?.idToken || req.body?.token || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : bodyToken;
  const bodyUserId = String(req.body?.userId || req.body?.user || '').trim();

  if (!token && !bodyUserId) {
    return res.status(400).json({
      success: false,
      message: 'Missing user identity. Provide { userId } or { idToken }.',
    });
  }

  const decoded = token ? decodeJwtPayload(token) : null;
  const intraverseUserId = bodyUserId
    || String(decoded?.user_id || decoded?.sub || '').trim();

  if (!intraverseUserId) {
    return res.status(400).json({
      success: false,
      message: 'Unable to extract userId from payload/token.',
    });
  }

  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'idToken is required to fetch wallet details from Intraverse.',
    });
  }

  const serverKey = String(process.env.INTRAVERSE_SERVER_KEY || '').trim();
  if (!serverKey) {
    return res.status(500).json({
      success: false,
      message: 'INTRAVERSE_SERVER_KEY is not configured on the server.',
    });
  }

  let userGameProfile = null;
  try {
    const response = await fetchJSON(`${BASE_URL}/api/v2/user/${encodeURIComponent(intraverseUserId)}/game`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-game-server-key': serverKey,
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json({
        success: false,
        message: 'Intraverse user lookup failed.',
        intraverseStatus: response.status,
        intraverseBody: response.body,
      });
    }

    userGameProfile = response.body;
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to call Intraverse user lookup API.',
      error: error.message,
    });
  }

  const walletAddress = pickPrimaryWalletAddress(userGameProfile);
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      message: 'No walletAddress found in Intraverse user profile.',
      intraverseUserId,
      intraverseProfile: userGameProfile,
    });
  }

  const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
  const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
  const backendToken = jwt.sign(
    { walletAddress, intraverseUserId },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );

  const now = Math.floor(Date.now() / 1000);
  const userName = String(decoded?.name || userGameProfile?.username || '').trim();

  try {
    const profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(walletAddress));
    if (profile) {
      profile.Intraverse = {
        userId: intraverseUserId,
        userName,
      };
      await profile.save();
    } else {
      await PlayerProfile.create({
        walletAddress,
        Intraverse: {
          userId: intraverseUserId,
          userName,
        },
      });
    }
  } catch (dbError) {
    console.error('[intraverse] failed to persist intraverse profile:', dbError);
  }

  const user = {
    userId: intraverseUserId,
    name: userName,
    roles: Array.isArray(decoded?.roles) ? decoded.roles : [],
    scope: decoded?.scope || '',
    issuer: decoded?.iss || '',
    audience: decoded?.aud || '',
    authTime: decoded?.auth_time || null,
    issuedAt: decoded?.iat || null,
    expiresAt: decoded?.exp || null,
    isExpired: decoded?.exp ? Number(decoded.exp) <= now : null,
    provider: decoded?.firebase?.sign_in_provider || '',
    walletAddress,
  };

  return res.json({
    success: true,
    userLogin: true,
    intraverseUserId,
    walletAddress,
    token: backendToken,
    Intraverse: {
      userId: intraverseUserId,
      userName,
    },
    user,
    intraverseProfile: userGameProfile,
  });
});

router.get('/games', async (req, res) => {
  const query = buildQueryString(req.query, ['size', 'orderBy', 'order', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/public/games${query}`);
});

router.get('/games/:slug', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/public/games/${req.params.slug}`);
});

router.get('/games/:slug/versions', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/public/games/${req.params.slug}/versions`);
});

router.get('/tournaments', async (req, res) => {
  const slug = req.query.slug || DEFAULT_GAME_SLUG;
  const query = buildQueryString(req.query, ['size', 'status', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/tournament/game/${encodeURIComponent(slug)}${query}`);
});

router.get('/tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}`);
});

router.post('/game-point', async (req, res) => {
  await proxyToIntraverse(req, res, '/api/v2/game-point/', {
    method: 'POST',
    auth: { includeServerKey: true },
    body: req.body,
  });
});

router.get('/game-point/:roundId', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/game-point/game-client/${req.params.roundId}`, {
    auth: { includeClientKey: true, includeUserJwt: true },
  });
});

module.exports = router;
