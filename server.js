const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
// Ensure env is loaded before importing modules that read it
dotenv.config();
const profileRoutes = require('./routes/profileRoutes');
const app = express();
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 2000);
const SLOW_MONGO_MS = Number(process.env.SLOW_MONGO_MS || 200);
const ENABLE_MONGOOSE_DEBUG =
  String(process.env.MONGOOSE_DEBUG_LOGS || '').trim().toLowerCase() === 'true';

// Trust reverse proxy headers so req.ip resolves the real client IP.
// Default is 1 hop (common with Nginx/Cloudflare -> Node).
const trustProxyEnv = String(process.env.TRUST_PROXY ?? '1').trim().toLowerCase();
if (trustProxyEnv === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyEnv === 'false') {
  app.set('trust proxy', false);
} else if (!Number.isNaN(Number(trustProxyEnv))) {
  app.set('trust proxy', Number(trustProxyEnv));
} else {
  app.set('trust proxy', trustProxyEnv);
}

const allowedOrigins = [
  'https://www.warzonewarriors.xyz',
  'https://warzonewarriors.xyz',
  'http://www.warzonewarriors.xyz',
  'http://warzonewarriors.xyz',
  'http://localhost:3000',
  'http://localhost:3001',
  'https://warzonewarrior.vercel.app/',
  'https://warzonewarrior.vercel.app',
  'https://warzone-admin.vercel.app/',
  'https://pub-2c48e58780b648b7a2a77316f7b0aa2c.r2.dev'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control',
    'pragma',
    'expires',              // ← Add this
    'if-modified-since',    // Unity caching headers
    'X-HTTP-Method-Override'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};


app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request latency logging to identify slow APIs
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
    };
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn('[http][slow]', payload);
    } else {
      console.log('[http]', payload);
    }
  });
  next();
});

app.use('/warzone', profileRoutes);


// Routes

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// DB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  dbName: process.env.MONGO_DB_NAME || 'new-warzone',
  monitorCommands: ENABLE_MONGOOSE_DEBUG,
}).then(() => {
  console.log('MongoDB connected successfully');

  // Optional DB command logging with real durations.
  if (ENABLE_MONGOOSE_DEBUG) {
    const commandStartTimes = new Map();
    const client = mongoose.connection.getClient();

    client.on('commandStarted', (event) => {
      commandStartTimes.set(event.requestId, process.hrtime.bigint());
    });

    client.on('commandSucceeded', (event) => {
      const startedAt = commandStartTimes.get(event.requestId);
      commandStartTimes.delete(event.requestId);
      if (!startedAt) return;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const payload = {
        commandName: event.commandName,
        database: event.databaseName,
        durationMs: Number(durationMs.toFixed(2)),
      };

      if (durationMs >= SLOW_MONGO_MS) {
        console.warn('[mongo][slow]', payload);
      } else {
        console.log('[mongo]', payload);
      }
    });

    client.on('commandFailed', (event) => {
      const startedAt = commandStartTimes.get(event.requestId);
      commandStartTimes.delete(event.requestId);
      const durationMs = startedAt
        ? Number(process.hrtime.bigint() - startedAt) / 1e6
        : undefined;
      console.error('[mongo][failed]', {
        commandName: event.commandName,
        database: event.databaseName,
        durationMs: durationMs != null ? Number(durationMs.toFixed(2)) : null,
        failure: event.failure,
      });
    });

    console.log('Mongo command timing logs enabled (MONGOOSE_DEBUG_LOGS=true)');
  }
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3300;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // console.log(`🌐 Accepting requests from: warzonewarriors.xyz`);
  // console.log(`📡 CORS enabled for cross-origin requests`);
});
