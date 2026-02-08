# Sprocket - Discord Trading Bot

An autonomous Discord trading bot powered by [Ollama](https://ollama.com). Features a personality-driven AI ("Sprocket, The Eager Analyst"), live market analysis with anti-hallucination safeguards, emotional intelligence, scheduled autonomous behaviors, and a web dashboard.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dtarkent2-sys/Discord-bot)

---

## Features

- **AI Chat** — Conversational responses via Ollama with streaming, conversation history, and Sprocket's personality
- **Trade Analysis** — `/analyze <ticker>` fetches live market data, builds a structured trade plan with entry/stop/targets
- **Anti-Hallucination Guard** — Two-layer defense: prompt-level HARD RULES + code-level regex detection blocks fabricated prices
- **Mood Engine** — Sprocket's mood shifts based on market conditions (7 states from Euphoric to Distressed)
- **Conversation Memory** — Per-user fact extraction, ticker tracking, topic classification, and sentiment history
- **Autonomous Behaviors** — Scheduled pre-market briefings, sector heatmaps, unusual activity alerts, and weekend reviews
- **Reaction Learning** — Learns from thumbs up/down reactions on its own messages
- **Image Analysis** — Analyzes images via Ollama vision models when attached to messages
- **Web Dashboard** — Real-time stats page at `/` with JSON API at `/api/stats` and health check at `/health`
- **Slash Commands** — 12 Discord slash commands: `/ask`, `/analyze`, `/price`, `/screen`, `/watchlist`, `/sentiment`, `/topic`, `/profile`, `/memory`, `/model`, `/stats`, `/help`
- **Self-Editing** — Owner-only prefix commands to update, suggest, auto-edit, rollback, and self-heal code via GitHub + Anthropic AI
- **Watchlist** — Per-user stock watchlist with live price lookups via Portfolio123

---

## Prerequisites

- **Node.js** v18+ — [Download](https://nodejs.org/)
- **A Discord Bot Token** — [Create one](https://discord.com/developers/applications)
- **Ollama** — [Install](https://ollama.com/download) (local or cloud)

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/dtarkent2-sys/Discord-bot.git
cd Discord-bot

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your DISCORD_TOKEN and DISCORD_CLIENT_ID

# (Optional) Pull a model
ollama pull gemma4b

# Start the bot
npm start
```

---

## Configuration

All settings are configured through environment variables. See `.env.example`.

| Variable | Description | Default |
|---|---|---|
| `DISCORD_TOKEN` | **Required.** Your Discord bot token | — |
| `DISCORD_CLIENT_ID` | **Required.** Your bot's application/client ID | — |
| `OLLAMA_HOST` | Ollama API endpoint | `https://ollama.com` |
| `OLLAMA_MODEL` | Which Ollama model to use | `gemma4b` |
| `OLLAMA_API_KEY` | API key for cloud Ollama | — |
| `P123_API_ID` | Portfolio123 API ID (for `/price`, `/analyze`, `/screen`, `/watchlist`) | — |
| `P123_API_KEY` | Portfolio123 API Key | — |
| `GITHUB_TOKEN` | GitHub PAT (for `!update`, `!suggest`, `!autoedit`, `!rollback`, `!selfheal`) | — |
| `GITHUB_OWNER` | GitHub repo owner | `dtarkent2-sys` |
| `GITHUB_REPO` | GitHub repo name | `Discord-bot` |
| `GITHUB_BRANCH` | GitHub branch for code edits | `main` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for `!suggest`, `!autoedit`, `!selfheal`) | — |
| `BOT_OWNER_ID` | Discord user ID of the bot owner (for prefix commands) | — |
| `BOT_PREFIX` | Prefix for owner commands | `!` |
| `PORT` | Dashboard/health check port | `3000` |
| `TRADING_CHANNEL` | Channel name for market updates | `trading-floor` |
| `GENERAL_CHANNEL` | Channel name for general posts | `general` |

---

## Commands

### Slash Commands

| Command | Description |
|---|---|
| `/ask <question>` | Ask the AI anything — uses conversation context and memory |
| `/analyze <ticker>` | AI-powered stock analysis with live Portfolio123 market data |
| `/price <ticker>` | Quick price + key stats lookup (P/E, RSI, moving averages, etc.) |
| `/screen <universe> [rules]` | Run a stock screen (e.g. `/screen SP500 PE < 15, MktCap > 1e9`) |
| `/watchlist [action] [ticker]` | Manage your personal stock watchlist (show/add/remove) |
| `/sentiment <text>` | Analyze text sentiment — score, positive/negative words |
| `/topic` | Generate an AI-powered discussion topic for the server |
| `/profile [@user]` | View user profile — interactions, sentiment, facts, favorite tickers |
| `/memory` | See what the bot remembers about you (facts, tickers, sentiment) |
| `/model <name>` | Switch the Ollama model at runtime |
| `/stats` | View bot statistics, mood, memory usage, and reaction feedback |
| `/help` | Show all available commands |

### Prefix Commands (Owner Only)

These require `BOT_OWNER_ID` to be set and are restricted to the bot owner.

| Command | Description |
|---|---|
| `!update <file>` | Push code to GitHub from a Discord code block |
| `!suggest <file> <instruction>` | AI generates a code suggestion (requires Anthropic API) |
| `!autoedit <file> <instruction>` | AI auto-applies safe code changes with safety checks |
| `!rollback <file>` | Revert a file to its previous commit version via GitHub API |
| `!selfheal <file>` | AI finds and auto-fixes one critical bug in a file |
| `!help` | Show all commands |

### Other

- **@mention** the bot in any channel or send a **DM** to chat directly
- React with :thumbsup: or :thumbsdown: on bot replies to provide feedback

---

## Autonomous Behaviors

Sprocket runs 4 scheduled behaviors (all times Eastern):

| Schedule | Behavior |
|---|---|
| 8:30 AM Mon-Fri | **Pre-Market Briefing** — SPY movement, mood update, AI commentary |
| 10 AM, 12 PM, 2 PM, 4 PM Mon-Fri | **Sector Pulse** — Heatmap of 11 sector ETFs |
| 11 AM Mon-Fri (30% chance) | **Unusual Activity** — Scans watchlist for >3% movers |
| Saturday 10 AM | **Weekend Review** — Bot stats and weekly summary |

---

## Anti-Hallucination Architecture

Sprocket uses a two-layer defense to prevent fabricated market data:

1. **Prompt Layer** — HARD RULES in the system prompt forbid citing any data not present in the FEEDS section. When no feeds are loaded, a CRITICAL block instructs the model to refuse all price/analysis requests.
2. **Code Layer** — `_detectHallucinatedData()` uses regex pattern matching to detect price-like patterns (`$123.45`, `trades at`, etc.) in responses when no feed data was provided. Detected hallucinations are blocked and replaced with an in-character refusal.

---

## Mood Engine

Sprocket's mood ranges across 7 states based on a 0-10 score:

| Score | Mood |
|---|---|
| 9-10 | Euphoric |
| 7-8 | Optimistically Bullish |
| 5-6 | Content |
| 4-5 | Neutral |
| 3-4 | Cautious |
| 1-2 | Measuredly Concerned |
| 0-1 | Distressed |

Mood is updated by market P&L data and market signals, and decays toward neutral over time. The current mood is injected into the AI system prompt and displayed in status updates.

---

## Project Structure

```
Discord-bot/
├── index.js                        # Entry point — Discord client, message/reaction handlers
├── package.json                    # Dependencies and scripts
├── railway.toml                    # Railway deployment config
├── .env.example                    # Environment variable template
├── .gitignore
├── data/                           # Persistent JSON storage (git-ignored)
└── src/
    ├── config.js                   # Environment config loader
    ├── personality.js              # Bot identity, speech patterns, quirks
    ├── github-client.js            # GitHub API integration (file read/update/rollback)
    ├── ai-coder.js                 # Anthropic API wrapper for code generation
    ├── commands/
    │   ├── register.js             # Slash command registration with Discord API
    │   ├── handlers.js             # Slash command handlers (12 commands)
    │   ├── prefix.js               # Prefix command handlers (!update, !suggest, !autoedit, !rollback, !selfheal, !help)
    │   └── self-heal.js            # Self-healing command — AI auto-fix for critical bugs
    ├── dashboard/
    │   └── server.js               # Express web dashboard with /health, /api/stats, /
    ├── data/
    │   ├── freshness.js            # Data freshness gate (assertFresh)
    │   └── market.js               # Market context provider (getMarketContext)
    ├── services/
    │   ├── ai.js                   # Core AI service — system prompt, chat/complete
    │   ├── autonomous.js           # Scheduled behaviors engine (4 cron jobs)
    │   ├── commentary.js           # AI-powered personality inflection with fallbacks
    │   ├── images.js               # Image analysis via Ollama vision models
    │   ├── memory.js               # Per-user memory — facts, tickers, topics, watchlist, context building
    │   ├── mood.js                 # Mood engine — 7 states, P&L-driven, decay, market signals
    │   ├── p123.js                 # Portfolio123 API client (prices, screens, rankings)
    │   ├── reactions.js            # Reaction-based learning and pattern tracking
    │   ├── sentiment.js            # Sentiment analysis with per-user trend tracking
    │   ├── stats.js                # Uptime, message count, error tracking, memory usage
    │   └── storage.js              # JSON file-based persistent storage
    └── trading/
        ├── analyze.js              # Trade analysis orchestrator (fetch → prompt → AI → validate)
        ├── prompt.js               # Anti-hallucination trade analysis prompt builder
        ├── validator.js            # Trade plan JSON schema validator
        └── trade_plan.schema.json  # Trade plan JSON schema definition
```

---

## Deploy to Railway

### One-Click Deploy

Click the deploy button at the top of this README.

### Manual Deploy

1. Fork this repo to your GitHub account
2. Create a Railway project at [railway.app](https://railway.app)
3. Connect your GitHub repo — Railway auto-detects `railway.toml`
4. Set environment variables in Railway dashboard:
   ```
   DISCORD_TOKEN=your_token_here
   DISCORD_CLIENT_ID=your_client_id_here
   OLLAMA_HOST=http://your-ollama-service:11434
   OLLAMA_MODEL=gemma4b
   ```
5. Deploy — Railway builds with Nixpacks, installs dependencies, starts `node index.js`
6. Verify the `/health` endpoint at your Railway deployment URL

### Railway + Ollama

Since Ollama runs as a separate service, your options are:

- **Separate Railway service** — Add a second service running Ollama, point `OLLAMA_HOST` to its internal URL
- **External Ollama** — Run Ollama on your own server, set `OLLAMA_HOST` to its public endpoint
- **Ollama Cloud** — Use an Ollama cloud model variant (e.g. `gemma4b:cloud`)

---

## Local Development

```bash
# Start with auto-restart on file changes
npm run dev

# Make sure Ollama is running
ollama serve
```

### Testing the Health Endpoint

```bash
curl http://localhost:3000/health
```

---

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and name it
3. Go to **Bot** tab > **Add Bot**
4. Enable **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent
5. Copy the **Bot Token** for your `.env`
6. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: Send Messages, Read Message History, View Channels, Add Reactions
7. Open the generated URL to invite the bot to your server

---

## License

MIT
