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
