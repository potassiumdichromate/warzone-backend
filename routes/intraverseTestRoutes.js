const express = require('express');
const https = require('https');

const router = express.Router();

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api.intraverse.io';
const DEFAULT_GAME_SLUG = process.env.INTRAVERSE_GAME_SLUG || 'kult-games';

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

function maskKey(key) {
  return key ? `${key.slice(0, 8)}...` : 'MISSING';
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

router.get('/meta', (req, res) => {
  res.json({
    baseUrl: BASE_URL,
    defaultGameSlug: DEFAULT_GAME_SLUG,
    keysLoaded: {
      serverKey: maskKey(process.env.INTRAVERSE_SERVER_KEY),
      clientKey: maskKey(process.env.INTRAVERSE_CLIENT_KEY),
    },
    frontendNeeds: {
      userJwtForProtectedEndpoints: true,
      gameKeysInFrontend: false,
    },
  });
});

router.get('/', async (req, res) => {
  const results = {};
  const userJwt = getUserJwt(req);

  const run = async (label, path, options = {}) => {
    try {
      const response = await fetchJSON(`${BASE_URL}${path}`, {
        method: options.method || 'GET',
        headers: {
          ...buildAuthHeaders(req, options.auth),
          ...(options.headers || {}),
        },
        body: options.body,
      });

      results[label] = {
        status: response.status,
        body: response.body,
      };
    } catch (error) {
      results[label] = { error: error.message };
    }
  };

  await run('GET /api/v2/public/games', '/api/v2/public/games?size=5');
  await run(`GET /api/v2/public/games/${DEFAULT_GAME_SLUG}`, `/api/v2/public/games/${DEFAULT_GAME_SLUG}`);
  await run(`GET /api/v2/public/games/${DEFAULT_GAME_SLUG}/versions`, `/api/v2/public/games/${DEFAULT_GAME_SLUG}/versions`);
  await run('GET /api/v2/guilds/public', '/api/v2/guilds/public?size=5');
  await run(`GET /api/v2/guilds/slug/${DEFAULT_GAME_SLUG}`, `/api/v2/guilds/slug/${DEFAULT_GAME_SLUG}`);
  await run(`GET /api/v2/tournament/game/${DEFAULT_GAME_SLUG}`, `/api/v2/tournament/game/${DEFAULT_GAME_SLUG}?size=5`);

  if (process.env.INTRAVERSE_SERVER_KEY) {
    await run('POST /api/v2/game-point/', '/api/v2/game-point/', {
      method: 'POST',
      auth: { includeServerKey: true },
      body: {
        roundId: 'test-round-001',
        walletAddress: '0x0000000000000000000000000000000000000001',
        score: 100,
        roomId: 'test-room-001',
      },
    });
  } else {
    results['POST /api/v2/game-point/'] = { skipped: 'Missing INTRAVERSE_SERVER_KEY' };
  }

  if (process.env.INTRAVERSE_CLIENT_KEY) {
    await run('GET /api/v2/game-point/game-client/test-round-001', '/api/v2/game-point/game-client/test-round-001', {
      auth: { includeClientKey: true, includeUserJwt: true },
    });
  } else {
    results['GET /api/v2/game-point/game-client/test-round-001'] = { skipped: 'Missing INTRAVERSE_CLIENT_KEY' };
  }

  if (userJwt) {
    await run('GET /api/v2/guilds/me', '/api/v2/guilds/me', {
      auth: { includeUserJwt: true },
    });
    await run('GET /api/v2/guild-tournaments/my', '/api/v2/guild-tournaments/my?size=5', {
      auth: { includeUserJwt: true },
    });
  } else {
    results['GET /api/v2/guilds/me'] = { skipped: 'Provide a user JWT to test protected guild endpoints' };
    results['GET /api/v2/guild-tournaments/my'] = { skipped: 'Provide a user JWT to test protected guild endpoints' };
  }

  res.json({
    note: 'Smoke test completed for configured Intraverse APIs. Use the individual endpoint cards for ID-based and body-heavy flows.',
    keysLoaded: {
      serverKey: maskKey(process.env.INTRAVERSE_SERVER_KEY),
      clientKey: maskKey(process.env.INTRAVERSE_CLIENT_KEY),
    },
    results,
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

router.get('/guilds', async (req, res) => {
  const query = buildQueryString(req.query, ['size', 'name', 'orderBy', 'order', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/guilds/public${query}`);
});

router.get('/guilds/me', async (req, res) => {
  await proxyToIntraverse(req, res, '/api/v2/guilds/me', {
    auth: { includeUserJwt: true },
  });
});

router.get('/guilds/slug/:slug', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guilds/slug/${req.params.slug}`);
});

router.get('/guilds/:guildId/members/:userId', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guilds/${req.params.guildId}/members/${req.params.userId}`, {
    auth: { includeUserJwt: true },
  });
});

router.get('/guilds/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guilds/public/${req.params.id}`);
});

router.post('/guild-tournaments', async (req, res) => {
  await proxyToIntraverse(req, res, '/api/v2/guild-tournaments', {
    method: 'POST',
    auth: { includeUserJwt: true },
    body: req.body,
  });
});

router.get('/guild-tournaments/my', async (req, res) => {
  const query = buildQueryString(req.query, ['size', 'status', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/my${query}`, {
    auth: { includeUserJwt: true },
  });
});

router.get('/guild-tournaments/:id/treasury', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}/treasury`, {
    auth: { includeUserJwt: true },
  });
});

router.post('/guild-tournaments/:id/launch', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}/launch`, {
    method: 'POST',
    auth: { includeUserJwt: true },
  });
});

router.get('/guild-tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}`, {
    auth: { includeUserJwt: true },
  });
});

router.patch('/guild-tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}`, {
    method: 'PATCH',
    auth: { includeUserJwt: true },
    body: req.body,
  });
});

router.get('/drop/:dropId/wallet-nfts', async (req, res) => {
  const query = buildQueryString(req.query, ['walletAddress']);
  await proxyToIntraverse(req, res, `/api/v2/drop/${req.params.dropId}/walletNFTs${query}`);
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
