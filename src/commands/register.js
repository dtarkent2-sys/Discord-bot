const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('../config');

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the AI a question')
    .addStringOption(opt =>
      opt.setName('question')
        .setDescription('Your question')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('See what the bot remembers about you'),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch the AI model')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Model name (e.g. llama3.2, mistral, llava)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Get bot statistics'),

  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze a stock or crypto with real market data')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock or crypto symbol (e.g. AAPL, TSLA, BTC, ETH)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('price')
    .setDescription('Get current price and key stats for a stock or crypto')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock or crypto symbol (e.g. AAPL, TSLA, BTC, ETH)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('news')
    .setDescription('Fetch the latest market news from Alpaca')
    .addStringOption(opt =>
      opt.setName('symbols')
        .setDescription('Comma-separated tickers (e.g. AAPL,TSLA) — optional')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('limit')
        .setDescription('Number of articles (1-10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)
    ),

  new SlashCommandBuilder()
    .setName('screen')
    .setDescription('Run a stock screen on a universe')
    .addStringOption(opt =>
      opt.setName('universe')
        .setDescription('Universe (e.g. SP500, nasdaq100, DJIA)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('rules')
        .setDescription('Filter rules, comma-separated (e.g. "PE < 15, MktCap > 1e9")')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  new SlashCommandBuilder()
    .setName('sentiment')
    .setDescription('Analyze the sentiment of a piece of text')
    .addStringOption(opt =>
      opt.setName('text')
        .setDescription('The text to analyze')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('topic')
    .setDescription('Generate an AI-powered discussion topic'),

  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('Manage your personal stock/crypto watchlist')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('Action to perform')
        .setRequired(false)
        .addChoices(
          { name: 'show', value: 'show' },
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
        )
    )
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock or crypto symbol (for add/remove, e.g. AAPL, BTC)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View user profile and activity')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('User to view (defaults to you)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('deepanalysis')
    .setDescription('Multi-agent deep analysis (TradingAgents) — BUY/SELL/HOLD signal')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock or crypto symbol (e.g. AAPL, TSLA, BTC, ETH)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('research')
    .setDescription('Agent Swarm — parallel AI agents research any complex topic')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Your research question (e.g. "Top 10 tech stocks for Q1 2026")')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('gex')
    .setDescription('Gamma Exposure (GEX) analysis — single chart, multi-expiry summary, or alerts')
    .addSubcommand(sub =>
      sub.setName('chart')
        .setDescription('Single-expiry GEX chart with per-strike bars')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY, QQQ)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('expiration')
            .setDescription('Expiration to analyze (default: 0DTE)')
            .setRequired(false)
            .addChoices(
              { name: '0DTE (today)', value: '0dte' },
              { name: 'Weekly (this Friday)', value: 'weekly' },
              { name: 'Monthly OPEX (3rd Friday)', value: 'monthly' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('summary')
        .setDescription('Multi-expiry aggregated GEX — regime, stacked walls, playbook')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. SPY, QQQ, AAPL)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('alerts')
        .setDescription('Check break-and-hold conditions on GEX levels')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. SPY, QQQ)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('heatmap')
        .setDescription('Gamma heat map — GEX by strike × expiration with color intensity')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. SPY, QQQ, AAPL)')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('range')
            .setDescription('Number of strikes above/below spot (default: 20)')
            .setRequired(false)
            .setMinValue(5)
            .setMaxValue(40)
        )
    ),

  new SlashCommandBuilder()
    .setName('technicals')
    .setDescription('Technical analysis — RSI, MACD, Bollinger, SMA/EMA, ATR + signal detection')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('social')
    .setDescription('Social sentiment from StockTwits — bullish/bearish score + recent posts')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, NVDA)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('trending')
    .setDescription('See what tickers are trending on StockTwits right now'),

  new SlashCommandBuilder()
    .setName('reddit')
    .setDescription('Reddit social sentiment — trending tickers and per-symbol discussion from 4 subreddits')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL) — omit to see trending tickers')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('validea')
    .setDescription('Validea guru fundamental analysis — scores from Buffett, Lynch, Graham & more')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, MSFT)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('macro')
    .setDescription('Macro environment — market regime, benchmarks, breadth, risk signals'),

  new SlashCommandBuilder()
    .setName('sectors')
    .setDescription('Sector rotation heatmap — leading/lagging sectors with multi-timeframe returns'),

  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Control the SHARK autonomous trading agent')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('Action to perform')
        .setRequired(true)
        .addChoices(
          { name: 'status', value: 'status' },
          { name: 'enable', value: 'enable' },
          { name: 'disable', value: 'disable' },
          { name: 'config — view current settings', value: 'config' },
          { name: 'set — change a config value', value: 'set' },
          { name: 'reset — restore default settings', value: 'reset' },
          { name: 'dangerous — toggle aggressive trading mode', value: 'dangerous' },
          { name: 'trade — manually trigger a trade', value: 'trade' },
          { name: 'logs', value: 'logs' },
          { name: 'kill', value: 'kill' },
        )
    )
    .addStringOption(opt =>
      opt.setName('key')
        .setDescription('Config key to set (e.g. max_positions, stop_loss_pct, crypto_enabled)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('value')
        .setDescription('New value for the config key')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Real-time Alpaca WebSocket market data stream')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: 'start — Subscribe to live data', value: 'start' },
          { name: 'stop — Unsubscribe symbols', value: 'stop' },
          { name: 'list — Show active subscriptions', value: 'list' },
          { name: 'status — Connection status', value: 'status' },
        )
    )
    .addStringOption(opt =>
      opt.setName('symbols')
        .setDescription('Comma-separated tickers (e.g. AAPL,TSLA,SPY)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('predict')
    .setDescription('Search Kalshi prediction markets + AI betting recommendations')
    .addStringOption(opt =>
      opt.setName('topic')
        .setDescription('What to search (e.g. "inflation", "bitcoin", "election", "recession")')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('odds')
    .setDescription('Deep dive on a Kalshi prediction market — price, trades, AI analysis')
    .addStringOption(opt =>
      opt.setName('market')
        .setDescription('Kalshi market ticker (e.g. KXBTC-26FEB14-T98000)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('bets')
    .setDescription('Browse trending/hot Kalshi prediction markets by category')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Category to browse')
        .setRequired(false)
        .addChoices(
          { name: 'Trending (most volume)', value: 'trending' },
          { name: 'Economics (inflation, GDP, Fed)', value: 'economics' },
          { name: 'Crypto (BTC, ETH, SOL)', value: 'crypto' },
          { name: 'Politics (elections, policy)', value: 'politics' },
          { name: 'Tech (AI, FAANG)', value: 'tech' },
          { name: 'Markets (S&P, Nasdaq, indices)', value: 'markets' },
          { name: 'Sports', value: 'sports' },
        )
    ),

  new SlashCommandBuilder()
    .setName('flow')
    .setDescription('Smart money flow — insider trades + congress trades (AInvest)')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('whales')
    .setDescription('Market intelligence — analyst ratings, fundamentals, insider + congress trades (AInvest)')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('options')
    .setDescription('0DTE Options Trading — autonomous scalping & swing trades on SPY, QQQ & more')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('Action to perform')
        .setRequired(true)
        .addChoices(
          { name: 'status — view options engine status', value: 'status' },
          { name: 'trade — manually trigger options trade', value: 'trade' },
          { name: 'close — close all options positions', value: 'close' },
          { name: 'logs — recent options activity', value: 'logs' },
        )
    )
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Underlying symbol for trade (e.g. SPY, QQQ, AAPL)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('direction')
        .setDescription('Force direction (optional — AI picks if omitted)')
        .setRequired(false)
        .addChoices(
          { name: 'call — bullish', value: 'call' },
          { name: 'put — bearish', value: 'put' },
        )
    )
    .addStringOption(opt =>
      opt.setName('strategy')
        .setDescription('Trading strategy — 0DTE scalp only')
        .setRequired(false)
        .addChoices(
          { name: 'scalp — quick in/out, tight stops (0DTE)', value: 'scalp' },
        )
    ),
  new SlashCommandBuilder()
    .setName('brain')
    .setDescription('Initiative Engine — autonomous brain status, journal, and self-tuning history')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What to view')
        .setRequired(true)
        .addChoices(
          { name: 'status — brain status + stats', value: 'status' },
          { name: 'journal — recent autonomous decisions', value: 'journal' },
          { name: 'tuning — self-tuning history', value: 'tuning' },
        )
    ),

  new SlashCommandBuilder()
    .setName('squeeze')
    .setDescription('Gamma squeeze monitor — live squeeze detection, sector GEX, dealer positioning')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What to view')
        .setRequired(true)
        .addChoices(
          { name: 'status — all watched tickers', value: 'status' },
          { name: 'detail — deep dive on one ticker', value: 'detail' },
          { name: 'sectors — sector gamma exposure', value: 'sectors' },
        )
    )
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (for detail view, e.g. SPY, QQQ)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('ingest')
    .setDescription('Read channel history into memory — Billy learns from past conversations')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Channel to ingest (omit to ingest all text channels)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('limit')
        .setDescription('Max messages to read per channel (default 2000)')
        .setRequired(false)
        .setMinValue(100)
        .setMaxValue(5000)
    ),

  new SlashCommandBuilder()
    .setName('yolo')
    .setDescription('YOLO Mode — autonomous self-improvement engine that makes the bot better on its own')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('Action to perform')
        .setRequired(true)
        .addChoices(
          { name: 'status — current YOLO mode state', value: 'status' },
          { name: 'enable — activate autonomous self-improvement', value: 'enable' },
          { name: 'disable — stop autonomous self-improvement', value: 'disable' },
          { name: 'run — manually trigger an improvement cycle', value: 'run' },
          { name: 'history — recent improvements made', value: 'history' },
          { name: 'logs — journal of all YOLO decisions', value: 'logs' },
        )
    ),

  new SlashCommandBuilder()
    .setName('algo')
    .setDescription('Algo Trading — Databento HFT signals, pairs trading, VWAP/TWAP, ML predictions')
    .addSubcommand(sub =>
      sub.setName('signals')
        .setDescription('Live algo signals — book skew, OBI, VWAP, ML prediction for a ticker')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. SPY, QQQ, AAPL)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('pairs')
        .setDescription('Pairs trading — cointegration, z-scores, stat-arb signals')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Add pair: TICKER1/TICKER2 (e.g. SPY/QQQ) — omit to see all pairs')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('vwap')
        .setDescription('VWAP/TWAP analysis — execution benchmarks, volume profile, bands')
        .addStringOption(opt =>
          opt.setName('ticker')
            .setDescription('Stock symbol (e.g. SPY, QQQ, AAPL)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('pnl')
        .setDescription('Algo trading P&L — strategy performance, positions, recent signals')
    ),

  new SlashCommandBuilder()
    .setName('mlpredict')
    .setDescription('ML walk-forward backtest — stock price + fundamentals via scikit-learn')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock ticker (e.g. AAPL, MSFT, SPY, TSLA)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Trading days of history (default: 1260 ≈ 5 years)')
        .setRequired(false)
        .setMinValue(300)
        .setMaxValue(10000)
    )
    .addStringOption(opt =>
      opt.setName('start_date')
        .setDescription('Backtest start date (YYYY-MM-DD)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('end_date')
        .setDescription('Backtest end date (YYYY-MM-DD, default: latest)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('forward')
        .setDescription('Forward return horizon in trading days (default: 20)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(252)
    )
    .addStringOption(opt =>
      opt.setName('model')
        .setDescription('Model type to train (default: both)')
        .setRequired(false)
        .addChoices(
          { name: 'Both — Linear Regression + Gradient Boost', value: 'both' },
          { name: 'Linear — LinearRegression only (fast)', value: 'linear' },
          { name: 'Gradient Boost — HistGradientBoosting only', value: 'gradient_boost' },
        )
    ),

  // ── ML Portfolio Backtester ──────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('mlportfolio')
    .setDescription('ML portfolio walk-forward backtest — cross-sectional ranking + portfolio construction')
    .addStringOption(opt =>
      opt.setName('tickers')
        .setDescription('Comma-separated tickers or preset: mega, sp500_25, tech, sector_etf')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Trading days of history (default: 2520 ≈ 10 years)')
        .setRequired(false)
        .setMinValue(500)
        .setMaxValue(10000)
    )
    .addStringOption(opt =>
      opt.setName('start_date')
        .setDescription('Backtest start date (YYYY-MM-DD)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('end_date')
        .setDescription('Backtest end date (YYYY-MM-DD)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('forward')
        .setDescription('Forward return horizon in trading days (default: 20)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(252)
    )
    .addStringOption(opt =>
      opt.setName('rebalance')
        .setDescription('Rebalance frequency: W-MON (weekly Mon), M (monthly), 2W (default: W-MON)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('top_k')
        .setDescription('Number of long positions (default: 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50)
    )
    .addIntegerOption(opt =>
      opt.setName('bottom_k')
        .setDescription('Number of short positions (default: 0)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(50)
    )
    .addStringOption(opt =>
      opt.setName('weighting')
        .setDescription('Portfolio weighting scheme (default: equal)')
        .setRequired(false)
        .addChoices(
          { name: 'Equal Weight — 1/N allocation', value: 'equal' },
          { name: 'Vol Target — inverse-vol scaled to target', value: 'vol_target' },
        )
    )
    .addNumberOption(opt =>
      opt.setName('max_weight')
        .setDescription('Max single position weight (default: 0.15 = 15%)')
        .setRequired(false)
        .setMinValue(0.01)
        .setMaxValue(1.0)
    )
    .addNumberOption(opt =>
      opt.setName('max_leverage')
        .setDescription('Max gross leverage (default: 1.0)')
        .setRequired(false)
        .setMinValue(0.1)
        .setMaxValue(3.0)
    )
    .addIntegerOption(opt =>
      opt.setName('cost_bps')
        .setDescription('Transaction cost in basis points (default: 10)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(100)
    )
    .addIntegerOption(opt =>
      opt.setName('slippage_bps')
        .setDescription('Slippage in basis points (default: 0)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(100)
    )
    .addIntegerOption(opt =>
      opt.setName('seed')
        .setDescription('Random seed for reproducibility (default: 42)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(999999)
    ),
];

async function registerCommands() {
  if (!config.token || !config.clientId) {
    console.warn('Skipping slash command registration: DISCORD_TOKEN or DISCORD_CLIENT_ID not set.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}

module.exports = { registerCommands };
