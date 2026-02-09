/**
 * MAHORAGA Agent Controller
 *
 * Wraps the MAHORAGA autonomous trading agent REST API.
 * Allows the Discord bot to control, monitor, and configure
 * a deployed MAHORAGA instance running on Cloudflare Workers.
 *
 * Setup:
 *   1. Deploy MAHORAGA to Cloudflare Workers (https://github.com/ygwyg/MAHORAGA)
 *   2. Set MAHORAGA_URL and MAHORAGA_TOKEN in your .env
 *   3. Use /agent commands in Discord to control it
 *
 * Docs: https://mahoraga.dev/
 */

const config = require('../config');

class MahoragaService {
  get enabled() {
    return !!(config.mahoragaUrl && config.mahoragaToken);
  }

  async _fetch(path, method = 'GET', body = null) {
    if (!this.enabled) throw new Error('MAHORAGA not configured — set MAHORAGA_URL and MAHORAGA_TOKEN in .env');

    const url = `${config.mahoragaUrl}${path}`;
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${config.mahoragaToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MAHORAGA ${res.status}: ${text.slice(0, 300)}`);
    }

    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  // ── Agent Control ─────────────────────────────────────────────────

  /** Get full agent status (account, positions, risk state) */
  async getStatus() {
    return this._fetch('/agent/status');
  }

  /** Enable the autonomous trading agent */
  async enable() {
    return this._fetch('/agent/enable', 'POST');
  }

  /** Disable the autonomous trading agent */
  async disable() {
    return this._fetch('/agent/disable', 'POST');
  }

  /** Emergency kill switch */
  async kill() {
    return this._fetch('/agent/kill', 'POST');
  }

  // ── Configuration ─────────────────────────────────────────────────

  /** Get current agent configuration */
  async getConfig() {
    return this._fetch('/agent/config');
  }

  /** Update agent configuration */
  async updateConfig(updates) {
    return this._fetch('/agent/config', 'PUT', updates);
  }

  // ── Logs ──────────────────────────────────────────────────────────

  /** Get recent activity logs */
  async getLogs() {
    return this._fetch('/agent/logs');
  }

  // ── Health ────────────────────────────────────────────────────────

  /** Health check (no auth required) */
  async health() {
    const url = `${config.mahoragaUrl}/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  }

  // ── Discord Formatting ────────────────────────────────────────────

  formatStatusForDiscord(status) {
    if (!status) return '_Could not fetch agent status._';

    const lines = [`**MAHORAGA Agent Status**`, ``];

    // Account info
    if (status.account) {
      const a = status.account;
      lines.push(`**Account**`);
      lines.push(`Portfolio: \`$${Number(a.portfolio_value || a.equity || 0).toLocaleString()}\``);
      lines.push(`Buying Power: \`$${Number(a.buying_power || 0).toLocaleString()}\``);
      lines.push(`Cash: \`$${Number(a.cash || 0).toLocaleString()}\``);
      lines.push(`Day Trades: \`${a.daytrade_count || 0}\``);
      lines.push(``);
    }

    // Positions
    if (status.positions && status.positions.length > 0) {
      lines.push(`**Open Positions** (${status.positions.length})`);
      for (const p of status.positions.slice(0, 10)) {
        const pnl = Number(p.unrealized_pl || 0);
        const pnlPct = Number(p.unrealized_plpc || 0) * 100;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        lines.push(`${emoji} **${p.symbol}**: ${p.qty} shares @ $${Number(p.avg_entry_price || 0).toFixed(2)} | P/L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
      }
      if (status.positions.length > 10) {
        lines.push(`_...and ${status.positions.length - 10} more_`);
      }
      lines.push(``);
    } else {
      lines.push(`_No open positions_`);
      lines.push(``);
    }

    // Agent state
    if (status.agent_enabled !== undefined) {
      lines.push(`Agent: ${status.agent_enabled ? '🟢 **ENABLED**' : '🔴 **DISABLED**'}`);
    }

    if (status.risk) {
      const r = status.risk;
      lines.push(`Kill Switch: ${r.kill_switch ? '🛑 **ACTIVE**' : '🟢 OK'}`);
      if (r.daily_loss_pct !== undefined) {
        lines.push(`Daily P/L: \`${(r.daily_loss_pct * 100).toFixed(2)}%\``);
      }
    }

    return lines.join('\n');
  }

  formatConfigForDiscord(cfg) {
    if (!cfg) return '_Could not fetch agent config._';

    const lines = [`**MAHORAGA Configuration**`, ``];

    const keys = [
      ['max_positions', 'Max Positions'],
      ['max_notional_per_trade', 'Max $ Per Trade'],
      ['max_daily_loss_pct', 'Max Daily Loss %'],
      ['cooldown_minutes', 'Trade Cooldown (min)'],
      ['take_profit_pct', 'Take Profit %'],
      ['stop_loss_pct', 'Stop Loss %'],
      ['min_sentiment_score', 'Min Sentiment Score'],
      ['min_analyst_confidence', 'Min AI Confidence'],
    ];

    for (const [key, label] of keys) {
      if (cfg[key] !== undefined) {
        let val = cfg[key];
        if (key.includes('pct')) val = `${(val * 100).toFixed(1)}%`;
        else if (key.includes('notional')) val = `$${Number(val).toLocaleString()}`;
        lines.push(`**${label}:** \`${val}\``);
      }
    }

    return lines.join('\n');
  }

  formatLogsForDiscord(logs) {
    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return '_No recent agent logs._';
    }

    const lines = [`**MAHORAGA Recent Activity**`, ``];

    for (const log of logs.slice(0, 15)) {
      const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : '?';
      const emoji = log.type === 'trade' ? '💰' : log.type === 'signal' ? '📡' : log.type === 'error' ? '❌' : '📋';
      lines.push(`\`${time}\` ${emoji} ${log.message || log.action || JSON.stringify(log).slice(0, 100)}`);
    }

    return lines.join('\n');
  }
}

module.exports = new MahoragaService();
