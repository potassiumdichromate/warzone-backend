const express = require('express');
const https = require('https');
const crypto = require('crypto');

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

router.post('/auth/user-login', (req, res) => {
  const authHeader = String(req.headers.authorization || '').trim();
  const bodyToken = String(req.body?.idToken || req.body?.token || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : bodyToken;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'Missing idToken/token. Provide Authorization: Bearer <token> or { idToken } in body.',
    });
  }

  return res.json({
    success: true,
    userLogin: true,
    tokenPreview: `${token.slice(0, 12)}...`,
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
