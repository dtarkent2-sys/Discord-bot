const AutonomousBehaviorEngine = require('./autonomous.js'); // Adjust import path as needed

#line 107
function _runGEXMonitor() {
  const cooldown = 2 * 60 * 60 * 1000; // 2h cooldown per ticker between regime alerts
  let consecutiveFailures = 0;

  for (const ticker of this.gexWatchlist) {
    if (consecutiveFailures >= 3) {
      console.warn(`[Sprocket] GEX monitor: 3 consecutive failures, skipping remaining tickers`);
      break;
    }

    try {
      // Use multi-expiry engine for richer analysis
      const summary = await this._gexEngine.analyze(ticker);
      consecutiveFailures = 0;

      const { spot, regime, gammaFlip } = summary;

      const prev = this.gexState.get(ticker);
      const now = Date.now();

      // First run — record state, don't alert
      if (!prev) {
        this.gexState.set(ticker, {
          flipStrike: gammaFlip,
          regime: regime.label,
          spotPrice: spot,
          lastAlertTime: 0,
        });
        continue;
      }

      // Check for regime change
      const regimeChanged = prev.regime !== regime.label;
      const flipMoved = prev.flipStrike && gammaFlip
        ? Math.abs(prev.flipStrike - gammaFlip) / prev.flipStrike > 0.02
        : false;

      if ((regimeChanged || flipMoved) && (now - prev.lastAlertTime) > cooldown) {
        const emoji = regime.label === 'Long Gamma' ? '🟢'
          : regime.label === 'Short Gamma' ? '🔴' : '🟡';
        const confPct = (regime.confidence * 100).toFixed(0);

        const callWall = summary.walls.callWalls[0];
        const putWall = summary.walls.putWalls[0];

        const alert = [
          `⚡ **GEX ALERT — ${ticker}**`,
          ``,
          `${emoji} **Regime: ${regime.label}** (${confPct}% confidence)`,
          `Spot: \`$${spot}\` | Flip: \`$${gammaFlip || '—'}\``,
          regimeChanged
            ? `📢 Regime changed: **${prev.regime}** → **${regime.label}**`
            : `📢 Gamma flip shifted: \`$${prev.flipStrike}\` → \`$${gammaFlip}\``,
          callWall ? `Call Wall: \`$${callWall.strike}\`${callWall.stacked ? ' **STACKED**' : ''}` : '',
          putWall ? `Put Wall: \`$${putWall.strike}\`${putWall.stacked ? ' **STACKED**' : ''}` : '',
          ``,
          `_/gex summary ${ticker} for full multi-expiry breakdown_`,
        ].filter(Boolean).join('\n');

        await this.postToChannel(config.tradingChannelName, alert);
        auditLog.log('gex', `GEX alert: ${ticker} regime=${regime.label} conf=${confPct}%`);

        this.gexState.set(ticker, {
          flipStrike: gammaFlip,
          regime: regime.label,
          spotPrice: spot,
          lastAlertTime: now,
        });
      } else {
        this.gexState.set(ticker, { ...prev, flipStrike: gammaFlip, regime: regime.label, spotPrice: spot });
      }

      // Break-and-hold alert check (uses intraday candle data if available)
      try {
        const alpacaSvc = require('./alpaca');
        if (alpacaSvc.enabled) {
          const bars = await alpacaSvc.getIntradayBars(ticker, {
            timeframe: this._gexAlerts.candleInterval,
            limit: 20,
          });
          const candles = (bars || []).map(b => ({
            close: b.close,
            volume: b.volume,
          }));

          const breakAlerts = this._gexAlerts.evaluate(ticker, candles, summary);
          for (const ba of breakAlerts) {
            await this.postToChannel(config.tradingChannelName, ba.message);
            auditLog.log('gex_alert', `Break-and-hold: ${ticker} ${ba.type} $${ba.level} ${ba.direction}`);
          }
        }
      } catch (candleErr) {
        // Non-fatal: candle data not available
        if (!candleErr.message?.includes('not configured')) {
          console.warn(`[Sprocket] GEX break-hold check failed for ${ticker}: ${candleErr.message}`);
        }
      }
    } catch (err) {
      consecutiveFailures++;
      if (!err.message?.includes('No options data')) {
        console.warn(`[Sprocket] GEX monitor error for ${ticker}:`, err.message);
      }
    }
  }
}