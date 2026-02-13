/**
 * Billy Command Center — Full Interactive Dashboard
 *
 * Single-page app with sidebar navigation covering all of Billy's capabilities.
 * Pages: Home, Performance, GEX Heatmap, Positions, SHARK, Alerts
 *
 * All data loaded via /api/* endpoints, auto-refreshes via polling.
 * Dark theme matching Discord aesthetic.
 */

const stats = require('../services/stats');
const reactions = require('../services/reactions');
const ai = require('../services/ai');
const auditLog = require('../services/audit-log');
const circuitBreaker = require('../services/circuit-breaker');
const mood = require('../services/mood');
const policy = require('../services/policy');

// Lazy-loaded services (avoid startup cost)
let _shark = null, _optionsEngine = null;
function getShark() { if (!_shark) try { _shark = require('../services/mahoraga'); } catch { _shark = null; } return _shark; }
function getOptionsEngine() { if (!_optionsEngine) try { _optionsEngine = require('../services/options-engine'); } catch { _optionsEngine = null; } return _optionsEngine; }

/**
 * Register all dashboard routes on the Express app.
 * @param {import('express').Express} app
 */
function registerDashboardRoutes(app) {

  // ── API: Agent Status ─────────────────────────────────────────────────
  app.get('/api/agent', async (req, res) => {
    try {
      const shark = getShark();
      if (!shark) return res.json({ error: 'SHARK not loaded' });
      const status = await shark.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Agent Config Update ──────────────────────────────────────────
  app.post('/api/agent/config', (req, res) => {
    try {
      const shark = getShark();
      if (!shark) return res.json({ error: 'SHARK not loaded' });
      const updates = req.body;
      if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid body' });
      shark.updateConfig(updates);
      res.json({ ok: true, config: shark.getConfig() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Agent Logs ───────────────────────────────────────────────────
  app.get('/api/agent/logs', (req, res) => {
    try {
      const shark = getShark();
      if (!shark) return res.json({ logs: [] });
      const count = Math.min(parseInt(req.query.count) || 50, 200);
      const logs = shark.getLogs().slice(-count);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Options Status ───────────────────────────────────────────────
  app.get('/api/options', async (req, res) => {
    try {
      const engine = getOptionsEngine();
      if (!engine) return res.json({ error: 'Options engine not loaded' });
      const status = await engine.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Trade Journal ────────────────────────────────────────────────
  app.get('/api/trades', (req, res) => {
    try {
      const engine = getOptionsEngine();
      if (!engine) return res.json({ trades: [], stats: {} });
      const count = Math.min(parseInt(req.query.count) || 100, 500);
      const journal = engine.getTradeJournal(count);

      // Compute stats
      const wins = journal.filter(t => t.won).length;
      const losses = journal.length - wins;
      const totalPnl = journal.reduce((s, t) => s + (t.pnl || 0), 0);
      const avgWin = wins > 0 ? journal.filter(t => t.won).reduce((s, t) => s + (t.pnl || 0), 0) / wins : 0;
      const avgLoss = losses > 0 ? journal.filter(t => !t.won).reduce((s, t) => s + (t.pnl || 0), 0) / losses : 0;
      const maxWin = journal.reduce((m, t) => Math.max(m, t.pnl || 0), 0);
      const maxLoss = journal.reduce((m, t) => Math.min(m, t.pnl || 0), 0);
      const avgHold = journal.length > 0 ? journal.reduce((s, t) => s + (t.holdMinutes || 0), 0) / journal.length : 0;

      // By underlying
      const byUnderlying = {};
      for (const t of journal) {
        const u = t.underlying || 'unknown';
        if (!byUnderlying[u]) byUnderlying[u] = { wins: 0, losses: 0, pnl: 0 };
        if (t.won) byUnderlying[u].wins++; else byUnderlying[u].losses++;
        byUnderlying[u].pnl += t.pnl || 0;
      }

      // By direction
      const byDirection = { call: { wins: 0, losses: 0, pnl: 0 }, put: { wins: 0, losses: 0, pnl: 0 } };
      for (const t of journal) {
        const d = t.direction || 'call';
        if (!byDirection[d]) byDirection[d] = { wins: 0, losses: 0, pnl: 0 };
        if (t.won) byDirection[d].wins++; else byDirection[d].losses++;
        byDirection[d].pnl += t.pnl || 0;
      }

      // By conviction level
      const byConviction = {};
      for (const t of journal) {
        const c = t.conviction || 0;
        if (!byConviction[c]) byConviction[c] = { wins: 0, losses: 0, pnl: 0 };
        if (t.won) byConviction[c].wins++; else byConviction[c].losses++;
        byConviction[c].pnl += t.pnl || 0;
      }

      // Loss pattern analysis
      const lossPatterns = {};
      for (const t of journal.filter(t => !t.won)) {
        const pm = t.postMortem || [];
        for (const line of pm) {
          // Extract key patterns
          if (/vwap/i.test(line)) lossPatterns.vwapConflict = (lossPatterns.vwapConflict || 0) + 1;
          if (/volume/i.test(line)) lossPatterns.lowVolume = (lossPatterns.lowVolume || 0) + 1;
          if (/chop/i.test(line)) lossPatterns.choppy = (lossPatterns.choppy || 0) + 1;
          if (/theta|decay/i.test(line)) lossPatterns.thetaDecay = (lossPatterns.thetaDecay || 0) + 1;
          if (/momentum.*fad/i.test(line)) lossPatterns.momentumFade = (lossPatterns.momentumFade || 0) + 1;
          if (/spread|wide/i.test(line)) lossPatterns.wideSpread = (lossPatterns.wideSpread || 0) + 1;
        }
      }

      // Daily P&L series (for chart)
      const dailyPnl = {};
      for (const t of journal) {
        const day = (t.date || t.entryTime || '').slice(0, 10);
        if (!day) continue;
        if (!dailyPnl[day]) dailyPnl[day] = { pnl: 0, wins: 0, losses: 0 };
        dailyPnl[day].pnl += t.pnl || 0;
        if (t.won) dailyPnl[day].wins++; else dailyPnl[day].losses++;
      }

      res.json({
        trades: journal,
        stats: {
          total: journal.length,
          wins, losses,
          winRate: journal.length > 0 ? (wins / journal.length * 100).toFixed(1) : '0',
          totalPnl: totalPnl.toFixed(2),
          avgWin: avgWin.toFixed(2),
          avgLoss: avgLoss.toFixed(2),
          maxWin: maxWin.toFixed(2),
          maxLoss: maxLoss.toFixed(2),
          avgHoldMinutes: avgHold.toFixed(1),
          profitFactor: Math.abs(avgLoss) > 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A',
        },
        byUnderlying,
        byDirection,
        byConviction,
        lossPatterns,
        dailyPnl,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Today's Losers (for loss analysis) ───────────────────────────
  app.get('/api/trades/losers', (req, res) => {
    try {
      const engine = getOptionsEngine();
      if (!engine) return res.json({ losers: [] });
      res.json({ losers: engine.getTodayLosers() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Overview (combines key data for home page) ───────────────────
  app.get('/api/overview', async (req, res) => {
    try {
      const summary = stats.getSummary();
      const reactionStats = reactions.getStats();
      const moodSummary = mood.getSummary();
      const cbStatus = circuitBreaker.getStatus();
      const auditStats = auditLog.getStats();
      const policyConfig = policy.getConfig();

      let agentStatus = null;
      const shark = getShark();
      if (shark) {
        try { agentStatus = await shark.getStatus(); } catch { /* skip */ }
      }

      let optionsStatus = null;
      const engine = getOptionsEngine();
      if (engine) {
        try { optionsStatus = await engine.getStatus(); } catch { /* skip */ }
      }

      // Data sources status
      let databento = null;
      try { const db = require('../services/databento'); databento = db.enabled ? db.getStatus() : null; } catch { /* skip */ }
      let tradier = null;
      try { const t = require('../services/tradier'); tradier = t.enabled ? { enabled: true } : null; } catch { /* skip */ }

      res.json({
        bot: { ...summary, model: ai.getModel(), reactions: reactionStats },
        mood: moodSummary,
        circuitBreaker: cbStatus,
        audit: auditStats,
        policy: {
          killSwitch: policy.killSwitch,
          dailyPnL: policy.dailyPnL,
          dailyStartEquity: policy.dailyStartEquity,
        },
        agent: agentStatus ? {
          enabled: agentStatus.agent_enabled,
          paper: agentStatus.paper,
          positionCount: agentStatus.positions?.length || 0,
          equity: agentStatus.account?.equity,
          buyingPower: agentStatus.account?.buying_power,
        } : null,
        options: optionsStatus ? {
          enabled: optionsStatus.enabled,
          activePositions: optionsStatus.activePositions,
          dailyLoss: optionsStatus.dailyLoss,
          discipline: optionsStatus.discipline,
        } : null,
        dataSources: {
          databento,
          tradier,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Main Dashboard SPA ────────────────────────────────────────────────
  app.get('/dashboard', (_req, res) => {
    res.send(_dashboardHTML());
  });

  console.log('[Dashboard] Command Center routes registered: /dashboard, /api/agent, /api/options, /api/trades, /api/overview');
}

// ── Dashboard HTML ────────────────────────────────────────────────────────

function _dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Billy — Command Center</title>
<style>
:root {
  --bg: #0d1117; --bg2: #161b22; --bg3: #1c2128; --bg4: #21262d;
  --border: #30363d; --border2: #3d444d;
  --text: #e6edf3; --text-dim: #8b949e; --text-muted: #484f58;
  --accent: #58a6ff; --green: #3fb950; --red: #f85149;
  --cyan: #39d2c0; --yellow: #d29922; --purple: #bc8cff;
  --green-dim: rgba(63,185,80,0.15); --red-dim: rgba(248,81,73,0.15);
  --accent-dim: rgba(88,166,255,0.15); --yellow-dim: rgba(210,153,34,0.15);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }

/* ── Sidebar ── */
.sidebar { width: 220px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-brand { padding: 16px 16px 12px; border-bottom: 1px solid var(--border); }
.sidebar-brand h1 { font-size: 18px; font-weight: 800; }
.sidebar-brand h1 span { color: var(--accent); }
.sidebar-brand .subtitle { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-top: 2px; }
.nav { flex: 1; padding: 8px; overflow-y: auto; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text-dim); transition: all 0.15s; margin-bottom: 2px; border: none; background: none; width: 100%; text-align: left; }
.nav-item:hover { background: var(--bg3); color: var(--text); }
.nav-item.active { background: var(--accent-dim); color: var(--accent); font-weight: 600; }
.nav-item .icon { font-size: 16px; width: 22px; text-align: center; }
.nav-section { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); padding: 16px 12px 6px; }
.nav-badge { margin-left: auto; font-size: 10px; padding: 2px 6px; border-radius: 8px; font-weight: 700; }
.nav-badge.green { background: var(--green-dim); color: var(--green); }
.nav-badge.red { background: var(--red-dim); color: var(--red); }
.nav-badge.yellow { background: var(--yellow-dim); color: var(--yellow); }

.sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-muted); }
.status-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.status-indicator.online { background: var(--green); }
.status-indicator.offline { background: var(--red); }

/* ── Main Content ── */
.main { flex: 1; overflow-y: auto; }
.page { display: none; padding: 24px; }
.page.active { display: block; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-header h2 { font-size: 20px; font-weight: 700; }
.page-header .subtitle { font-size: 12px; color: var(--text-dim); margin-top: 2px; }

/* ── Cards ── */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.card .label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
.card .sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.card .value.green { color: var(--green); }
.card .value.red { color: var(--red); }
.card .value.accent { color: var(--accent); }
.card .value.yellow { color: var(--yellow); }
.card .value.cyan { color: var(--cyan); }
.card-wide { grid-column: 1 / -1; }

/* ── Table ── */
.tbl-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 20px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th { background: var(--bg2); padding: 10px 12px; text-align: left; font-weight: 600; color: var(--text-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
.tbl td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.tbl tr:hover { background: var(--bg3); }
.tbl .pnl-pos { color: var(--green); font-weight: 600; }
.tbl .pnl-neg { color: var(--red); font-weight: 600; }
.mono { font-family: 'SF Mono', 'Fira Code', monospace; }

/* ── Section ── */
.section { margin-bottom: 24px; }
.section-title { font-size: 14px; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.section-title .icon { font-size: 16px; }

/* ── Tags ── */
.tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; }
.tag-green { background: var(--green-dim); color: var(--green); }
.tag-red { background: var(--red-dim); color: var(--red); }
.tag-yellow { background: var(--yellow-dim); color: var(--yellow); }
.tag-accent { background: var(--accent-dim); color: var(--accent); }

/* ── Bars ── */
.bar-group { margin-bottom: 12px; }
.bar-label { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.bar-track { height: 8px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s; }
.bar-fill.green { background: var(--green); }
.bar-fill.red { background: var(--red); }
.bar-fill.accent { background: var(--accent); }

/* ── Log ── */
.log { font-family: 'SF Mono', monospace; font-size: 11px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-height: 400px; overflow-y: auto; }
.log-entry { padding: 3px 0; border-bottom: 1px solid rgba(48,54,61,0.3); }
.log-time { color: var(--text-muted); }
.log-trade { color: var(--cyan); }
.log-warning { color: var(--yellow); }
.log-error { color: var(--red); }
.log-info { color: var(--text-dim); }

/* ── Split Layout ── */
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }

/* ── Loading ── */
.loading { display: flex; align-items: center; justify-content: center; padding: 40px; color: var(--text-dim); gap: 8px; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Empty State ── */
.empty { text-align: center; padding: 40px; color: var(--text-muted); font-size: 13px; }

/* ── Btn ── */
.btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
.btn:hover { background: var(--border); }
.btn-sm { padding: 4px 10px; font-size: 11px; }
.btn-accent { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.btn-green { background: var(--green-dim); border-color: var(--green); color: var(--green); }
.btn-red { background: var(--red-dim); border-color: var(--red); color: var(--red); }
</style>
</head>
<body>

<!-- Sidebar -->
<div class="sidebar">
  <div class="sidebar-brand">
    <h1><span>BILLY</span></h1>
    <div class="subtitle">Command Center</div>
  </div>
  <div class="nav">
    <div class="nav-section">Overview</div>
    <button class="nav-item active" data-page="home" onclick="nav('home')">
      <span class="icon">&#x1F3E0;</span> Home
    </button>
    <button class="nav-item" data-page="performance" onclick="nav('performance')">
      <span class="icon">&#x1F4CA;</span> Performance
      <span class="nav-badge green" id="navWinRate">—</span>
    </button>

    <div class="nav-section">Trading</div>
    <button class="nav-item" data-page="positions" onclick="nav('positions')">
      <span class="icon">&#x1F4B0;</span> Positions
      <span class="nav-badge yellow" id="navPositions">0</span>
    </button>
    <button class="nav-item" data-page="shark" onclick="nav('shark')">
      <span class="icon">&#x1F988;</span> SHARK
      <span class="nav-badge" id="navSharkBadge">—</span>
    </button>

    <div class="nav-section">Analysis</div>
    <button class="nav-item" data-page="gex" onclick="window.open('/gex','_blank')">
      <span class="icon">&#x1F525;</span> GEX Heatmap
      <span class="nav-badge accent">&#x2197;</span>
    </button>

    <div class="nav-section">System</div>
    <button class="nav-item" data-page="logs" onclick="nav('logs')">
      <span class="icon">&#x1F4DD;</span> Logs
    </button>
  </div>
  <div class="sidebar-footer">
    <span class="status-indicator online" id="statusDot"></span>
    <span id="statusText">Connecting...</span>
  </div>
</div>

<!-- Main Content -->
<div class="main">

  <!-- HOME PAGE -->
  <div class="page active" id="page-home">
    <div class="page-header">
      <div><h2>Dashboard</h2><div class="subtitle">Real-time overview</div></div>
      <button class="btn" onclick="refreshAll()">Refresh</button>
    </div>

    <div class="cards" id="homeCards">
      <div class="loading"><div class="spinner"></div> Loading...</div>
    </div>

    <div class="split">
      <div class="section">
        <div class="section-title"><span class="icon">&#x1F6E1;</span> Risk &amp; Safety</div>
        <div id="homeSafety"><div class="loading"><div class="spinner"></div></div></div>
      </div>
      <div class="section">
        <div class="section-title"><span class="icon">&#x1F4CB;</span> Recent Activity</div>
        <div id="homeActivity"><div class="loading"><div class="spinner"></div></div></div>
      </div>
    </div>
  </div>

  <!-- PERFORMANCE PAGE -->
  <div class="page" id="page-performance">
    <div class="page-header">
      <div><h2>Performance</h2><div class="subtitle">Trade journal &amp; win rate analytics</div></div>
      <button class="btn" onclick="loadPerformance()">Refresh</button>
    </div>

    <div class="cards" id="perfCards">
      <div class="loading"><div class="spinner"></div> Loading...</div>
    </div>

    <div class="split">
      <div class="section">
        <div class="section-title"><span class="icon">&#x1F4C8;</span> By Underlying</div>
        <div id="perfByUnderlying"></div>
      </div>
      <div class="section">
        <div class="section-title"><span class="icon">&#x26A0;</span> Loss Patterns</div>
        <div id="perfLossPatterns"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><span class="icon">&#x1F4D3;</span> Trade Journal</div>
      <div class="tbl-wrap" id="perfJournal"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <!-- POSITIONS PAGE -->
  <div class="page" id="page-positions">
    <div class="page-header">
      <div><h2>Live Positions</h2><div class="subtitle">Real-time P&amp;L tracking</div></div>
      <button class="btn" onclick="loadPositions()">Refresh</button>
    </div>

    <div class="cards" id="posCards">
      <div class="loading"><div class="spinner"></div> Loading...</div>
    </div>

    <div class="section">
      <div class="section-title"><span class="icon">&#x1F4B5;</span> Open Positions</div>
      <div class="tbl-wrap" id="posTable"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <!-- SHARK PAGE -->
  <div class="page" id="page-shark">
    <div class="page-header">
      <div><h2>SHARK Control Panel</h2><div class="subtitle">Autonomous trading agent</div></div>
      <button class="btn" onclick="loadShark()">Refresh</button>
    </div>

    <div class="cards" id="sharkCards">
      <div class="loading"><div class="spinner"></div> Loading...</div>
    </div>

    <div class="split">
      <div class="section">
        <div class="section-title"><span class="icon">&#x2699;</span> Configuration</div>
        <div id="sharkConfig"></div>
      </div>
      <div class="section">
        <div class="section-title"><span class="icon">&#x1F4CB;</span> Options Discipline</div>
        <div id="sharkDiscipline"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><span class="icon">&#x1F4DD;</span> Agent Logs</div>
      <div class="log" id="sharkLogs"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <!-- LOGS PAGE -->
  <div class="page" id="page-logs">
    <div class="page-header">
      <div><h2>Audit Logs</h2><div class="subtitle">System activity log</div></div>
      <button class="btn" onclick="loadLogs()">Refresh</button>
    </div>
    <div class="log" id="auditLogs" style="max-height:calc(100vh - 120px)"><div class="loading"><div class="spinner"></div></div></div>
  </div>

</div>

<script>
// ── State ──
let currentPage = 'home';
let refreshTimer = null;

// ── Navigation ──
function nav(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  const navEl = document.querySelector('[data-page="' + page + '"]');
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
  loadPage(page);
}

function loadPage(page) {
  if (page === 'home') loadHome();
  else if (page === 'performance') loadPerformance();
  else if (page === 'positions') loadPositions();
  else if (page === 'shark') loadShark();
  else if (page === 'logs') loadLogs();
}

// ── API Helper ──
async function api(path) {
  try {
    const r = await fetch(path);
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

// ── HOME PAGE ──
async function loadHome() {
  const data = await api('/api/overview');
  if (data.error) return;

  const bot = data.bot || {};
  const m = data.mood || {};
  const cb = data.circuitBreaker || {};
  const pol = data.policy || {};
  const agent = data.agent || {};
  const opts = data.options || {};

  // Status
  document.getElementById('statusDot').className = 'status-indicator online';
  document.getElementById('statusText').textContent = 'Online \\u2022 ' + (bot.uptime || '');

  // Cards
  let html = '';
  html += card('Account Equity', agent.equity ? '$' + Number(agent.equity).toLocaleString(undefined,{maximumFractionDigits:0}) : 'N/A', 'accent');
  html += card('Buying Power', agent.buyingPower ? '$' + Number(agent.buyingPower).toLocaleString(undefined,{maximumFractionDigits:0}) : 'N/A', '');
  html += card('Daily P&L', pol.dailyPnL != null ? '$' + Number(pol.dailyPnL).toFixed(2) : 'N/A', pol.dailyPnL >= 0 ? 'green' : 'red');
  html += card('Mood', m.mood || '—', m.mood === 'Euphoric' || m.mood === 'Confident' ? 'green' : m.mood === 'Distressed' ? 'red' : 'yellow');
  html += card('SHARK', agent.enabled ? 'ENABLED' : 'DISABLED', agent.enabled ? 'green' : 'red');
  html += card('Options', opts.enabled ? opts.activePositions + ' pos' : 'DISABLED', opts.enabled ? 'cyan' : 'red');

  document.getElementById('homeCards').innerHTML = html;

  // Nav badges
  document.getElementById('navSharkBadge').textContent = agent.enabled ? 'ON' : 'OFF';
  document.getElementById('navSharkBadge').className = 'nav-badge ' + (agent.enabled ? 'green' : 'red');
  if (opts.discipline) {
    document.getElementById('navWinRate').textContent = opts.discipline.winRate || '—';
  }
  document.getElementById('navPositions').textContent = (agent.positionCount || 0) + (opts.activePositions || 0);

  // Safety
  let safetyHtml = '';
  safetyHtml += '<div class="card"><div class="label">Kill Switch</div><div class="value ' + (pol.killSwitch ? 'red' : 'green') + '">' + (pol.killSwitch ? 'ACTIVE' : 'OFF') + '</div></div>';
  safetyHtml += '<div class="card"><div class="label">Circuit Breaker</div><div class="value ' + (cb.isPaused ? 'yellow' : 'green') + '">' + (cb.isPaused ? 'PAUSED' : 'OK') + '</div>';
  safetyHtml += '<div class="sub">Bad trades: ' + (cb.consecutiveBadTrades || 0) + '/3 | Trips: ' + (cb.totalTrips || 0) + '</div></div>';
  safetyHtml += '<div class="card"><div class="label">Options Daily Loss</div><div class="value ' + ((opts.dailyLoss || 0) > 0 ? 'red' : 'green') + '">$' + (opts.dailyLoss || 0).toFixed(0) + '</div></div>';
  document.getElementById('homeSafety').innerHTML = '<div class="cards">' + safetyHtml + '</div>';

  // Activity
  const auditData = await api('/api/audit?count=15');
  let actHtml = '<div class="log">';
  for (const e of (auditData.entries || []).slice(0, 15)) {
    const cls = e.type === 'trade' ? 'log-trade' : e.type === 'error' ? 'log-error' : e.type === 'warning' ? 'log-warning' : 'log-info';
    actHtml += '<div class="log-entry"><span class="log-time">' + (e.timestamp || '').slice(11, 19) + '</span> <span class="' + cls + '">[' + e.type + ']</span> ' + esc(e.message || '') + '</div>';
  }
  actHtml += '</div>';
  document.getElementById('homeActivity').innerHTML = actHtml;
}

// ── PERFORMANCE PAGE ──
async function loadPerformance() {
  const data = await api('/api/trades?count=200');
  if (data.error) return;

  const s = data.stats || {};

  let html = '';
  html += card('Win Rate', s.winRate + '%', parseFloat(s.winRate) >= 50 ? 'green' : 'red');
  html += card('Total P&L', '$' + s.totalPnl, parseFloat(s.totalPnl) >= 0 ? 'green' : 'red');
  html += card('Trades', s.total, 'accent', s.wins + 'W / ' + s.losses + 'L');
  html += card('Avg Win', '$' + s.avgWin, 'green');
  html += card('Avg Loss', '$' + s.avgLoss, 'red');
  html += card('Profit Factor', s.profitFactor, parseFloat(s.profitFactor) >= 1 ? 'green' : 'red');
  html += card('Max Win', '$' + s.maxWin, 'green');
  html += card('Max Loss', '$' + s.maxLoss, 'red');
  html += card('Avg Hold', s.avgHoldMinutes + ' min', '');
  document.getElementById('perfCards').innerHTML = html;

  // By underlying
  let uHtml = '';
  for (const [sym, d] of Object.entries(data.byUnderlying || {})) {
    const total = d.wins + d.losses;
    const wr = total > 0 ? (d.wins / total * 100).toFixed(0) : 0;
    uHtml += '<div class="bar-group">';
    uHtml += '<div class="bar-label"><span>' + sym + ' <span class="tag ' + (d.pnl >= 0 ? 'tag-green' : 'tag-red') + '">$' + d.pnl.toFixed(0) + '</span></span><span>' + wr + '% (' + d.wins + 'W/' + d.losses + 'L)</span></div>';
    uHtml += '<div class="bar-track"><div class="bar-fill ' + (d.pnl >= 0 ? 'green' : 'red') + '" style="width:' + wr + '%"></div></div>';
    uHtml += '</div>';
  }
  document.getElementById('perfByUnderlying').innerHTML = uHtml || '<div class="empty">No trades yet</div>';

  // Loss patterns
  let lpHtml = '';
  const patterns = data.lossPatterns || {};
  const sortedPatterns = Object.entries(patterns).sort((a, b) => b[1] - a[1]);
  const patternLabels = { vwapConflict: 'VWAP Conflict', lowVolume: 'Low Volume', choppy: 'Choppy Market', thetaDecay: 'Theta Decay', momentumFade: 'Momentum Fade', wideSpread: 'Wide Spread' };
  const totalLosses = data.stats.losses || 1;
  for (const [key, count] of sortedPatterns) {
    const pct = (count / totalLosses * 100).toFixed(0);
    lpHtml += '<div class="bar-group">';
    lpHtml += '<div class="bar-label"><span>' + (patternLabels[key] || key) + '</span><span>' + count + ' (' + pct + '% of losses)</span></div>';
    lpHtml += '<div class="bar-track"><div class="bar-fill red" style="width:' + pct + '%"></div></div>';
    lpHtml += '</div>';
  }
  document.getElementById('perfLossPatterns').innerHTML = lpHtml || '<div class="empty">No loss patterns detected</div>';

  // Trade journal table
  const trades = data.trades || [];
  if (trades.length === 0) {
    document.getElementById('perfJournal').innerHTML = '<div class="empty">No trades in journal</div>';
    return;
  }
  let tHtml = '<table class="tbl"><thead><tr><th>Date</th><th>Ticker</th><th>Dir</th><th>Conv</th><th>Entry</th><th>P&L</th><th>Hold</th><th>Exit Reason</th></tr></thead><tbody>';
  for (const t of trades.slice().reverse()) {
    const pnlCls = (t.pnl || 0) >= 0 ? 'pnl-pos' : 'pnl-neg';
    tHtml += '<tr>';
    tHtml += '<td class="mono">' + (t.date || t.entryTime || '').slice(0, 16).replace('T', ' ') + '</td>';
    tHtml += '<td><strong>' + (t.underlying || '—') + '</strong></td>';
    tHtml += '<td><span class="tag ' + (t.direction === 'call' ? 'tag-green' : 'tag-red') + '">' + (t.direction || '').toUpperCase() + '</span></td>';
    tHtml += '<td>' + (t.conviction || '—') + '/10</td>';
    tHtml += '<td class="mono">$' + (t.entryPrice || 0).toFixed(2) + '</td>';
    tHtml += '<td class="mono ' + pnlCls + '">$' + (t.pnl || 0).toFixed(2) + '</td>';
    tHtml += '<td>' + (t.holdMinutes || 0).toFixed(0) + 'm</td>';
    tHtml += '<td>' + esc(t.exitReason || '—') + '</td>';
    tHtml += '</tr>';
  }
  tHtml += '</tbody></table>';
  document.getElementById('perfJournal').innerHTML = tHtml;
}

// ── POSITIONS PAGE ──
async function loadPositions() {
  const data = await api('/api/agent');
  if (data.error) { document.getElementById('posCards').innerHTML = '<div class="empty">' + data.error + '</div>'; return; }

  const acct = data.account || {};
  const positions = data.positions || [];
  const optData = await api('/api/options');
  const optPositions = optData.positions || [];
  const allPositions = [...positions, ...optPositions];

  const totalUnrealized = allPositions.reduce((s, p) => s + (Number(p.unrealized_pl || p.unrealizedPL) || 0), 0);

  let html = '';
  html += card('Account Equity', '$' + Number(acct.equity || 0).toLocaleString(undefined,{maximumFractionDigits:0}), 'accent');
  html += card('Unrealized P&L', '$' + totalUnrealized.toFixed(2), totalUnrealized >= 0 ? 'green' : 'red');
  html += card('Equity Positions', positions.length, '');
  html += card('Options Positions', optPositions.length, '');
  document.getElementById('posCards').innerHTML = html;

  // Position table
  if (allPositions.length === 0) {
    document.getElementById('posTable').innerHTML = '<div class="empty">No open positions</div>';
    return;
  }

  let tHtml = '<table class="tbl"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg Entry</th><th>Market Value</th><th>Unrealized P&L</th><th>P&L %</th><th>Type</th></tr></thead><tbody>';
  for (const p of allPositions) {
    const pnl = Number(p.unrealized_pl || p.unrealizedPL) || 0;
    const pnlPct = Number(p.unrealized_plpc || p.unrealizedPLPct) || 0;
    const cls = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const sym = p.symbol || '—';
    const isOption = sym.length > 6;
    tHtml += '<tr>';
    tHtml += '<td><strong>' + sym + '</strong></td>';
    tHtml += '<td>' + (p.qty || p.quantity || 0) + '</td>';
    tHtml += '<td class="mono">$' + Number(p.avg_entry_price || p.avgEntry || 0).toFixed(2) + '</td>';
    tHtml += '<td class="mono">$' + Number(p.market_value || p.marketValue || 0).toFixed(2) + '</td>';
    tHtml += '<td class="mono ' + cls + '">$' + pnl.toFixed(2) + '</td>';
    tHtml += '<td class="mono ' + cls + '">' + (pnlPct * 100).toFixed(1) + '%</td>';
    tHtml += '<td><span class="tag ' + (isOption ? 'tag-yellow' : 'tag-accent') + '">' + (isOption ? 'OPT' : 'EQ') + '</span></td>';
    tHtml += '</tr>';
  }
  tHtml += '</tbody></table>';
  document.getElementById('posTable').innerHTML = tHtml;
}

// ── SHARK PAGE ──
async function loadShark() {
  const [agentData, logsData, optData] = await Promise.all([
    api('/api/agent'),
    api('/api/agent/logs?count=80'),
    api('/api/options'),
  ]);

  if (agentData.error) { document.getElementById('sharkCards').innerHTML = '<div class="empty">' + agentData.error + '</div>'; return; }

  const cfg = agentData.config || {};
  const risk = agentData.risk || {};
  const cb = agentData.circuitBreaker || {};

  let html = '';
  html += card('SHARK Agent', agentData.agent_enabled ? 'ENABLED' : 'DISABLED', agentData.agent_enabled ? 'green' : 'red');
  html += card('Mode', agentData.paper ? 'Paper' : 'LIVE', agentData.paper ? 'yellow' : 'green');
  html += card('Kill Switch', risk.kill_switch ? 'ACTIVE' : 'OFF', risk.kill_switch ? 'red' : 'green');
  html += card('Circuit Breaker', cb.isPaused ? 'PAUSED' : 'OK', cb.isPaused ? 'yellow' : 'green');
  html += card('Daily P&L', '$' + (risk.daily_pnl || 0).toFixed(2), (risk.daily_pnl || 0) >= 0 ? 'green' : 'red');
  html += card('Positions', (agentData.positions || []).length + '/' + (cfg.max_positions || 5), '');
  document.getElementById('sharkCards').innerHTML = html;

  // Config
  const cfgKeys = ['max_positions', 'max_notional_per_trade', 'position_size_pct', 'stop_loss_pct', 'take_profit_pct',
    'cooldown_minutes', 'max_daily_loss_pct', 'options_enabled', 'options_max_positions', 'options_max_premium_per_trade',
    'options_min_conviction', 'options_scalp_take_profit_pct', 'options_scalp_stop_loss_pct', 'dangerous_mode'];
  let cfgHtml = '<table class="tbl"><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>';
  for (const k of cfgKeys) {
    if (cfg[k] === undefined) continue;
    let v = cfg[k];
    if (typeof v === 'number' && k.includes('pct')) v = (v * 100).toFixed(1) + '%';
    else if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
    else if (typeof v === 'number') v = v.toLocaleString();
    cfgHtml += '<tr><td>' + k.replace(/_/g, ' ') + '</td><td class="mono">' + v + '</td></tr>';
  }
  cfgHtml += '</tbody></table>';
  document.getElementById('sharkConfig').innerHTML = cfgHtml;

  // Options discipline
  const disc = optData.discipline || {};
  let dHtml = '<div class="cards">';
  dHtml += card('Trades Today', (disc.tradesToday || 0) + '/' + (disc.maxTradesPerDay || 6), '');
  dHtml += card('Win Rate', disc.winRate || 'N/A', (parseInt(disc.winRate) || 0) >= 50 ? 'green' : 'red');
  dHtml += card('Net P&L', disc.netPnl || '$0', '');
  dHtml += '</div>';
  if (disc.pausedSymbols && disc.pausedSymbols.length > 0) {
    dHtml += '<div style="margin-top:8px"><span class="tag tag-red">PAUSED</span> ' + disc.pausedSymbols.join(', ') + '</div>';
  }
  document.getElementById('sharkDiscipline').innerHTML = dHtml;

  // Logs
  const logs = (logsData.logs || []).slice().reverse();
  let logHtml = '';
  for (const l of logs) {
    const cls = l.type === 'trade' ? 'log-trade' : l.type === 'error' ? 'log-error' : l.type === 'warning' || l.type === 'skip' ? 'log-warning' : 'log-info';
    logHtml += '<div class="log-entry"><span class="log-time">' + (l.timestamp || '').slice(11, 19) + '</span> <span class="' + cls + '">[' + l.type + ']</span> ' + esc(l.message || '') + '</div>';
  }
  document.getElementById('sharkLogs').innerHTML = logHtml || '<div class="empty">No logs yet</div>';
}

// ── LOGS PAGE ──
async function loadLogs() {
  const data = await api('/api/audit?count=100');
  const entries = data.entries || [];
  let html = '';
  for (const e of entries) {
    const cls = e.type === 'trade' ? 'log-trade' : e.type === 'error' ? 'log-error' : e.type === 'warning' ? 'log-warning' : 'log-info';
    html += '<div class="log-entry"><span class="log-time">' + (e.timestamp || '').slice(0, 19).replace('T', ' ') + '</span> <span class="' + cls + '">[' + (e.type || 'info') + ']</span> ' + esc(e.message || '') + '</div>';
  }
  document.getElementById('auditLogs').innerHTML = html || '<div class="empty">No audit entries</div>';
}

// ── Helpers ──
function card(label, value, colorClass, sub) {
  return '<div class="card"><div class="label">' + label + '</div><div class="value ' + (colorClass || '') + '">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function refreshAll() { loadPage(currentPage); }

// ── Init ──
loadHome();
refreshTimer = setInterval(() => loadPage(currentPage), 30000);
</script>
</body>
</html>`;
}

module.exports = { registerDashboardRoutes };
