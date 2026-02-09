const express = require('express');
const config = require('../config');
const stats = require('../services/stats');
const reactions = require('../services/reactions');
const ai = require('../services/ai');
const auditLog = require('../services/audit-log');
const circuitBreaker = require('../services/circuit-breaker');
const mood = require('../services/mood');

function startDashboard() {
  const app = express();

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

  // Trading safety status — circuit breaker, mood, audit log summary
  app.get('/api/safety', (req, res) => {
    res.json({
      circuitBreaker: circuitBreaker.getStatus(),
      mood: mood.getSummary(),
      auditLog: auditLog.getStats(),
    });
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

  // Basic stats page
  app.get('/', (req, res) => {
    const summary = stats.getSummary();
    const reactionStats = reactions.getStats();

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Discord Bot Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0; padding: 2rem;
    }
    h1 { color: #7289da; margin-bottom: 1.5rem; }
    h2 { color: #7289da; margin: 1.5rem 0 0.75rem; font-size: 1.2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .card {
      background: #16213e; border-radius: 8px; padding: 1.25rem;
      border: 1px solid #0f3460;
    }
    .card .label { font-size: 0.85rem; color: #888; text-transform: uppercase; }
    .card .value { font-size: 1.5rem; font-weight: bold; margin-top: 0.25rem; }
    .positive { color: #43b581; }
    .info { color: #7289da; }
    .warn { color: #faa61a; }
    .bar { background: #0f3460; border-radius: 4px; height: 8px; margin-top: 0.5rem; }
    .bar-fill { background: #7289da; height: 100%; border-radius: 4px; }
    footer { margin-top: 2rem; color: #555; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Discord Bot Dashboard</h1>

  <div class="grid">
    <div class="card">
      <div class="label">Status</div>
      <div class="value positive">Online</div>
    </div>
    <div class="card">
      <div class="label">Uptime</div>
      <div class="value info">${summary.uptime}</div>
    </div>
    <div class="card">
      <div class="label">Servers</div>
      <div class="value">${summary.guilds}</div>
    </div>
    <div class="card">
      <div class="label">AI Model</div>
      <div class="value info">${ai.getModel()}</div>
    </div>
  </div>

  <h2>Activity</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Messages Processed</div>
      <div class="value">${summary.messagesProcessed}</div>
    </div>
    <div class="card">
      <div class="label">Commands Run</div>
      <div class="value">${summary.commandsRun}</div>
    </div>
    <div class="card">
      <div class="label">Errors</div>
      <div class="value ${summary.errors > 0 ? 'warn' : ''}">${summary.errors}</div>
    </div>
    <div class="card">
      <div class="label">Feedback Score</div>
      <div class="value ${reactionStats.ratio >= 50 ? 'positive' : 'warn'}">${reactionStats.ratio}%</div>
      <div style="font-size:0.85rem;margin-top:0.25rem">
        ${reactionStats.positive} 👍 / ${reactionStats.negative} 👎
      </div>
    </div>
  </div>

  <h2>Memory Usage</h2>
  <div class="grid">
    <div class="card">
      <div class="label">RSS</div>
      <div class="value">${summary.memory.rss} MB</div>
    </div>
    <div class="card">
      <div class="label">Heap Used / Total</div>
      <div class="value">${summary.memory.heapUsed} / ${summary.memory.heapTotal} MB</div>
      <div class="bar">
        <div class="bar-fill" style="width:${Math.round((summary.memory.heapUsed / summary.memory.heapTotal) * 100)}%"></div>
      </div>
    </div>
  </div>

  <h2>Trading Safety</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Mood</div>
      <div class="value info">${mood.getSummary().mood}</div>
      <div style="font-size:0.85rem;margin-top:0.25rem">
        Score: ${mood.getSummary().score} | Rolling PNL: ${(mood.getSummary().rollingAvgPnL || 0).toFixed(2)}%
      </div>
    </div>
    <div class="card">
      <div class="label">Circuit Breaker</div>
      <div class="value ${circuitBreaker.isPaused() ? 'warn' : 'positive'}">${circuitBreaker.isPaused() ? 'PAUSED' : 'OK'}</div>
      <div style="font-size:0.85rem;margin-top:0.25rem">
        Bad trades: ${circuitBreaker.getStatus().consecutiveBadTrades}/3 | Trips: ${circuitBreaker.getStatus().totalTrips}
      </div>
    </div>
    <div class="card">
      <div class="label">Audit Log</div>
      <div class="value">${auditLog.getStats().total}</div>
      <div style="font-size:0.85rem;margin-top:0.25rem">entries today</div>
    </div>
  </div>

  <footer>Auto-refreshes every 30s &bull; <a href="/api/stats" style="color:#7289da">Stats API</a> &bull; <a href="/api/safety" style="color:#7289da">Safety API</a> &bull; <a href="/api/audit" style="color:#7289da">Audit Log</a></footer>
  <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`);
  });

  const server = app.listen(config.port, () => {
    console.log(`Dashboard running at http://localhost:${config.port}`);
  });

  server.on('error', (err) => {
    console.error(`[Dashboard] Failed to bind port ${config.port}:`, err.message);
  });

  return app;
}

module.exports = { startDashboard };
