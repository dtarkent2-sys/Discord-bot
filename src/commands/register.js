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
    .setDescription('Gamma Exposure (GEX) analysis — options gamma by strike with chart')
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
    .setDescription('Unusual options flow — sweeps, big premium, smart money (Unusual Whales)')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA) — omit for market-wide flow')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('filter')
        .setDescription('Filter type')
        .setRequired(false)
        .addChoices(
          { name: 'All unusual flow', value: 'all' },
          { name: 'Calls only', value: 'calls' },
          { name: 'Puts only', value: 'puts' },
          { name: 'Sweeps only (aggressive)', value: 'sweeps' },
        )
    ),

  new SlashCommandBuilder()
    .setName('darkpool')
    .setDescription('Dark pool / off-exchange prints for a ticker (Unusual Whales)')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('whales')
    .setDescription('Whale activity dashboard — flow + dark pool + shorts + insider (Unusual Whales)')
    .addStringOption(opt =>
      opt.setName('ticker')
        .setDescription('Stock symbol (e.g. AAPL, TSLA, SPY)')
        .setRequired(true)
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
