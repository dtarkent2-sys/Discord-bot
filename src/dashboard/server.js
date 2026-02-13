const express = require('express');
const config = require('../config');
const stats = require('../services/stats');
const reactions = require('../services/reactions');
const ai = require('../services/ai');
const auditLog = require('../services/audit-log');
const circuitBreaker = require('../services/circuit-breaker');
const mood = require('../services/mood');

// S3 backup — lazy-loaded on first API hit so the heavy @aws-sdk/client-s3
// import never blocks the health server from starting.
let _s3Backup = null;
let _s3Loaded = false;
function getS3Backup() {
  if (!_s3Loaded) {
    _s3Loaded = true;
    try { _s3Backup = require('../services/s3-backup'); } catch { _s3Backup = null; }
  }
  return _s3Backup;
}

// Discord client ref — set after client is ready via setDiscordClient()
let discordClient = null;

// SPY alerts module — loaded defensively
let spyAlerts = null;
try {
  spyAlerts = require('../services/spy-alerts');
} catch {
  spyAlerts = null;
}

function setDiscordClient(client) {
  discordClient = client;
  console.log('[Dashboard] Discord client registered for webhook handling');
}

function startDashboard() {
  const app = express();

  // Parse JSON bodies (for TradingView webhook POSTs)
  app.use(express.json({ limit: '1mb' }));

  // ── GEX Gamma Heat Map interactive dashboard ──────────────────────────
  const { registerGEXHeatmapRoutes } = require('./gex-heatmap');
  registerGEXHeatmapRoutes(app);

  // ── Billy Command Center (full interactive dashboard) ─────────────────
  const { registerDashboardRoutes } = require('./app');
  registerDashboardRoutes(app);

  // Also accept plain text (some TradingView configs send text/plain)
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));

  // ── TradingView Webhook Endpoint ──────────────────────────────────────
  // URL to set in TradingView: https://your-app.up.railway.app/webhook/tradingview
  // Optional: add ?secret=YOUR_SECRET for authentication
  app.post('/webhook/tradingview', async (req, res) => {
    // Authenticate if WEBHOOK_SECRET is set
    if (config.webhookSecret) {
      const secret = req.query.secret || req.headers['x-webhook-secret'] || req.body?.secret;
      if (secret !== config.webhookSecret) {
        console.warn('[Webhook] Unauthorized request (bad secret)');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Need Discord client and SPY channel
    if (!discordClient) {
      console.warn('[Webhook] Discord client not ready yet');
      return res.status(503).json({ error: 'Bot not ready' });
    }

    if (!config.spyChannelId) {
      console.warn('[Webhook] SPY_CHANNEL_ID not configured');
      return res.status(500).json({ error: 'SPY_CHANNEL_ID not set' });
    }

    const channel = discordClient.channels.cache.get(config.spyChannelId);
    if (!channel) {
      console.warn(`[Webhook] Channel ${config.spyChannelId} not found in cache`);
      return res.status(500).json({ error: 'Channel not found' });
    }

    // Log the raw payload for debugging
    const body = req.body;
    console.log(`[Webhook] TradingView alert received:`, typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200));

    if (!spyAlerts) {
      console.warn('[Webhook] spy-alerts module not loaded');
      return res.status(500).json({ error: 'Alert handler not loaded' });
    }

    // Respond to TradingView immediately (it times out after ~3s)
    // Analysis + Discord posting happens in the background
    res.status(200).json({ ok: true, status: 'processing' });

    // Run the full pipeline: parse → fetch data → AI analysis → post to Discord
    spyAlerts.handleHttpAlert(channel, body).catch(err => {
      console.error(`[Webhook] Alert pipeline failed:`, err.message);
    });
  });

  // Health check endpoint (for Railway / monitoring)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: stats.getUptime() });
  });

  // Stats API endpoint
  app.get('/api/stats', (req, res) => {
    const summary = stats.getSummary();
    const reactionStats = reactions.getStats();
    res.json({
      ...summary,
      model: ai.getModel(),
      reactions: reactionStats,
    });
  });

  // Trading safety status — circuit breaker, mood, audit log summary, data sources
  app.get('/api/safety', (req, res) => {
    let databentoStatus = null;
    try { const db = require('../services/databento'); databentoStatus = db.getStatus(); } catch { /* skip */ }
    let liveStatus = null;
    try { const live = require('../services/databento-live'); liveStatus = live.getStatus(); } catch { /* skip */ }

    res.json({
      circuitBreaker: circuitBreaker.getStatus(),
      mood: mood.getSummary(),
      auditLog: auditLog.getStats(),
      databento: databentoStatus,
      databentoLive: liveStatus,
    });
  });

  // S3 backup status and management
  app.get('/api/backups', async (req, res) => {
    try {
      const s3 = getS3Backup();
      if (!s3) return res.json({ enabled: false, backups: [] });
      const status = s3.getStatus();
      const backups = status.enabled ? await s3.listBackups() : [];
      res.json({ ...status, backups: backups.slice(0, 20) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Options order flow (Databento OPRA tick-level trade data)
  // Prefers live streaming data when available, falls back to historical API
  app.get('/api/flow/:ticker', async (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');

      // Try live data first (real-time, zero API cost)
      try {
        const live = require('../services/databento-live');
        const liveFlow = live.getFlow(ticker);
        if (liveFlow && liveFlow.tradeCount > 0) {
          return res.json(liveFlow);
        }
      } catch { /* live not available */ }

      // Fall back to historical API
      const db = require('../services/databento');
      if (!db.enabled) return res.json({ enabled: false, error: 'Databento not configured' });
      const minutes = Math.min(Math.max(parseInt(req.query.minutes) || 15, 1), 60);
      const flow = await db.getOrderFlow(ticker, minutes);
      res.json(flow);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Recent audit log entries (JSON)
  app.get('/api/audit', (req, res) => {
    const count = Math.min(parseInt(req.query.count) || 50, 200);
    const category = req.query.cat || null;
    res.json({
      entries: auditLog.getRecent(count, category),
      stats: auditLog.getStats(),
    });
  });

  // Root redirects to the full dashboard
  app.get('/', (req, res) => {
    res.redirect('/dashboard');
  });

  const server = app.listen(config.port, () => {
    console.log(`Dashboard running at http://localhost:${config.port}`);
  });

  server.on('error', (err) => {
    console.error(`[Dashboard] Failed to bind port ${config.port}:`, err.message);
  });

  return app;
}

module.exports = { startDashboard, setDiscordClient };
