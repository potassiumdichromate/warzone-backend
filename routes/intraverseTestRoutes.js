const express = require('express');
const router = express.Router();
const https = require('https');

const BASE_URL = 'https://api-stage.intraverse.io';
const GAME_SLUG = 'kult-games';

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
      res.on('data', (chunk) => { data += chunk; });
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

// Master test route — hits ALL Intraverse APIs and returns results
router.get('/', async (req, res) => {
  const SERVER_KEY = process.env.INTRAVERSE_SERVER_KEY;
  const CLIENT_KEY = process.env.INTRAVERSE_CLIENT_KEY;
  const results = {};

  // --- Games ---
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games?size=5`);
    results['GET /api/v2/public/games'] = { status: r.status, body: r.body };
  } catch (e) {
    results['GET /api/v2/public/games'] = { error: e.message };
  }

  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games/${GAME_SLUG}`);
    results[`GET /api/v2/public/games/${GAME_SLUG}`] = { status: r.status, body: r.body };
  } catch (e) {
    results[`GET /api/v2/public/games/${GAME_SLUG}`] = { error: e.message };
  }

  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games/${GAME_SLUG}/versions`);
    results[`GET /api/v2/public/games/${GAME_SLUG}/versions`] = { status: r.status, body: r.body };
  } catch (e) {
    results[`GET /api/v2/public/games/${GAME_SLUG}/versions`] = { error: e.message };
  }

  // --- Tournaments ---
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/tournament/game/${GAME_SLUG}?size=5`);
    results[`GET /api/v2/tournament/game/${GAME_SLUG}`] = { status: r.status, body: r.body };
  } catch (e) {
    results[`GET /api/v2/tournament/game/${GAME_SLUG}`] = { error: e.message };
  }

  // --- Guilds ---
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/guilds/public?size=5`);
    results['GET /api/v2/guilds/public'] = { status: r.status, body: r.body };
  } catch (e) {
    results['GET /api/v2/guilds/public'] = { error: e.message };
  }

  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/guilds/slug/${GAME_SLUG}`);
    results[`GET /api/v2/guilds/slug/${GAME_SLUG}`] = { status: r.status, body: r.body };
  } catch (e) {
    results[`GET /api/v2/guilds/slug/${GAME_SLUG}`] = { error: e.message };
  }

  // --- Game Point (server key) — with walletAddress instead of userId ---
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/game-point/`, {
      method: 'POST',
      headers: { 'x-game-server-key': SERVER_KEY },
      body: {
        roundId: 'test-round-001',
        walletAddress: '0x0000000000000000000000000000000000000001',
        score: 100,
        roomId: 'test-room-001',
      },
    });
    results['POST /api/v2/game-point/'] = { status: r.status, body: r.body };
  } catch (e) {
    results['POST /api/v2/game-point/'] = { error: e.message };
  }

  // --- Game Point GET (client key — no user JWT so expect 401, tests endpoint reach) ---
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/game-point/game-client/test-round-001`, {
      headers: { 'x-game-key': CLIENT_KEY },
    });
    results['GET /api/v2/game-point/game-client/test-round-001'] = { status: r.status, body: r.body };
  } catch (e) {
    results['GET /api/v2/game-point/game-client/test-round-001'] = { error: e.message };
  }

  console.log('\n========== INTRAVERSE API TEST RESULTS ==========');
  for (const [endpoint, result] of Object.entries(results)) {
    console.log(`\n[${endpoint}]`);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('\n=================================================\n');

  res.json({
    note: 'All Intraverse API calls made. Check server logs for full output.',
    keysLoaded: {
      serverKey: SERVER_KEY ? `${SERVER_KEY.slice(0, 8)}...` : 'MISSING',
      clientKey: CLIENT_KEY ? `${CLIENT_KEY.slice(0, 8)}...` : 'MISSING',
    },
    results,
  });
});

// --- Games ---

router.get('/games', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games?size=10`);
    console.log('[intraverse] GET /api/v2/public/games', r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/games/:slug', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games/${req.params.slug}`);
    console.log(`[intraverse] GET /api/v2/public/games/${req.params.slug}`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/games/:slug/versions', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/public/games/${req.params.slug}/versions`);
    console.log(`[intraverse] GET /api/v2/public/games/${req.params.slug}/versions`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Tournaments ---

router.get('/tournaments', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/tournament/game/${GAME_SLUG}?size=10`);
    console.log('[intraverse] GET /api/v2/tournament/game/' + GAME_SLUG, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tournaments/:id', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/tournament/${req.params.id}`);
    console.log(`[intraverse] GET /api/v2/tournament/${req.params.id}`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Guilds ---

router.get('/guilds', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/guilds/public?size=10`);
    console.log('[intraverse] GET /api/v2/guilds/public', r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/guilds/slug/:slug', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/guilds/slug/${req.params.slug}`);
    console.log(`[intraverse] GET /api/v2/guilds/slug/${req.params.slug}`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/guilds/:id', async (req, res) => {
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/guilds/public/${req.params.id}`);
    console.log(`[intraverse] GET /api/v2/guilds/public/${req.params.id}`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Drop ---

router.get('/drop/:dropId/wallet-nfts', async (req, res) => {
  const { walletAddress } = req.query;
  try {
    const query = walletAddress ? `?walletAddress=${encodeURIComponent(walletAddress)}` : '';
    const r = await fetchJSON(`${BASE_URL}/api/v2/drop/${req.params.dropId}/walletNFTs${query}`);
    console.log(`[intraverse] GET /api/v2/drop/${req.params.dropId}/walletNFTs`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Game Point ---

// POST — server key, supports walletAddress OR userId
router.post('/game-point', async (req, res) => {
  const SERVER_KEY = process.env.INTRAVERSE_SERVER_KEY;
  try {
    const r = await fetchJSON(`${BASE_URL}/api/v2/game-point/`, {
      method: 'POST',
      headers: { 'x-game-server-key': SERVER_KEY },
      body: req.body,
    });
    console.log('[intraverse] POST /api/v2/game-point/', r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET — client key + user JWT (forward Authorization header if present)
router.get('/game-point/:roundId', async (req, res) => {
  const CLIENT_KEY = process.env.INTRAVERSE_CLIENT_KEY;
  const userJwt = req.headers['x-user-jwt'] || '';
  try {
    const headers = { 'x-game-key': CLIENT_KEY };
    if (userJwt) headers['Authorization'] = `Bearer ${userJwt}`;
    const r = await fetchJSON(`${BASE_URL}/api/v2/game-point/game-client/${req.params.roundId}`, { headers });
    console.log(`[intraverse] GET /api/v2/game-point/game-client/${req.params.roundId}`, r.status, JSON.stringify(r.body, null, 2));
    res.json({ status: r.status, body: r.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
