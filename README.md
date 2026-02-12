# Sprocket - Autonomous Discord Trading Bot

An autonomous, goal-driven Discord trading bot powered by [Ollama](https://ollama.com). Features a personality-driven AI ("Sprocket, The Eager Analyst"), live market analysis with anti-hallucination safeguards, emotional intelligence, a proactive goal system, web search, self-healing code, a safety layer, and a web dashboard.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dtarkent2-sys/Discord-bot)

---

## Features

### Core
- **AI Chat** — Conversational responses via Ollama with streaming, conversation history, and Sprocket's personality
- **Trade Analysis** — `/analyze <ticker>` fetches live market data, builds a structured trade plan with entry/stop/targets
- **Anti-Hallucination Guard** — Three-layer defense: centralized RAG enforcement (date awareness + freshness rules), prompt-level HARD RULES, and code-level regex detection blocks fabricated prices
- **Real-Time Price Fetcher** — yahoo-finance2 integration (free, no API key) provides cross-reference pricing for all analysis pipelines
- **Custom Modelfile** — Ollama Modelfile bakes RAG freshness rules into model behavior (`ollama create sprocket -f Modelfile`)
- **Mood Engine** — Sprocket's mood shifts based on market conditions (7 states from Euphoric to Distressed)
- **Conversation Memory** — Per-user fact extraction, ticker tracking, topic classification, and sentiment history
- **Reaction Learning** — Learns from thumbs up/down reactions on its own messages
- **Image Analysis** — Analyzes images via Ollama vision models when attached to messages
- **Watchlist** — Per-user stock watchlist with live price lookups via Yahoo Finance
- **TradingAgents** — Multi-agent deep analysis pipeline inspired by [TradingAgents](https://github.com/TauricResearch/TradingAgents) — 4 analysts, bull/bear debate, trader decision, risk committee → BUY/SELL/HOLD signal

### Autonomous Agent
- **Agent Core** — Goal-driven decision-making brain that evaluates context, classifies user intent, and chooses actions
- **Proactive Goal System** — Weighted goals (`provide_value`, `foster_engagement`, `self_improve`, `learn_preferences`) with activation conditions and success metrics
- **Web Search** — Live internet search via [SearXNG](https://docs.searxng.org) (free, open-source) with caching
- **Safety & Rate Limits** — Guardrails preventing harmful autonomous actions, API rate limit tracking, and emergency stop
- **Self-Healing** — AI-powered auto-fix for critical bugs via GitHub + Anthropic

### Infrastructure
- **Slash Commands** — 25 Discord slash commands: `/ask`, `/analyze`, `/deepanalysis`, `/price`, `/technicals`, `/gex`, `/screen`, `/macro`, `/sectors`, `/validea`, `/news`, `/social`, `/trending`, `/reddit`, `/research`, `/watchlist`, `/sentiment`, `/topic`, `/profile`, `/memory`, `/model`, `/stats`, `/stream`, `/agent`, `/help`
- **Self-Editing** — Owner-only prefix commands to update, suggest, auto-edit, rollback, and self-heal code via GitHub + Anthropic AI
- **Web Dashboard** — Real-time stats page at `/` with JSON API at `/api/stats` and health check at `/health`
- **Monitoring** — Real-time log viewer, API usage graphs, goal achievement tracking, safety override alerts

---

## Prerequisites

- **Node.js** v22+ — [Download](https://nodejs.org/)
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
| `OLLAMA_MODEL` | Which Ollama model to use (`sprocket` for custom Modelfile) | `qwen2.5:14b` |
| `OLLAMA_API_KEY` | API key for cloud Ollama | — |
| `KIMI_API_KEY` | Moonshot Kimi K2.5 agent mode API key (enables built-in web search) | — |
| `KIMI_BASE_URL` | Kimi API base URL | `https://api.moonshot.ai/v1` |
| `KIMI_MODEL` | Kimi model name | `kimi-k2.5-preview` |
| `FMP_API_KEY` | Financial Modeling Prep API key (market data for `/price`, `/analyze`, etc.) | — |
| `ALPHA_API_KEY` | Alpha Vantage API key (market data, server-side technicals, news sentiment, fundamentals) | — |
| `ALPACA_API_KEY` | Alpaca Markets API key (real-time data, options, WebSocket, trading) | — |
| `ALPACA_API_SECRET` | Alpaca Markets API secret | — |
| `ALPACA_PAPER` | Use paper trading (`true`) or live trading (`false`) | `true` |
| `ALPACA_FEED` | WebSocket feed: `iex` (free) or `sip` (paid) | `iex` |
| `GITHUB_TOKEN` | GitHub PAT (for `!update`, `!suggest`, `!autoedit`, `!rollback`, `!selfheal`) | — |
| `GITHUB_OWNER` | GitHub repo owner | `dtarkent2-sys` |
| `GITHUB_REPO` | GitHub repo name | `Discord-bot` |
| `GITHUB_BRANCH` | GitHub branch for code edits | `main` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for `!suggest`, `!autoedit`, `!selfheal`) | — |
| `SEARXNG_URL` | SearXNG instance URL (for web search — free, no key needed) | — |
| `BOT_OWNER_ID` | Discord user ID of the bot owner (for prefix commands) | — |
| `BOT_PREFIX` | Prefix for owner commands | `!` |
| `PORT` | Dashboard/health check port | `3000` |
| `TRADING_CHANNEL` | Channel name for market updates | `trading-floor` |
| `GENERAL_CHANNEL` | Channel name for general posts | `general` |
| `MODEL_CUTOFF` | Approximate training data cutoff for RAG enforcement | `mid-2024` |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, `error` | `info` |
| `SHARK_AUTO_ENABLE` | Auto-enable SHARK autonomous trading agent on startup | `false` |
| `GEX_INCLUDE_EXPIRIES` | Comma-separated expirations to analyze: `0dte,weekly,monthly` | `0dte,weekly,monthly` |
| `GEX_HOLD_CANDLES` | Consecutive candle closes required for break-and-hold alerts | `3` |
| `GEX_CANDLE_INTERVAL` | Candle interval for break-and-hold: `1Min`, `5Min`, `15Min`, `1Hour` | `5Min` |
| `GEX_MIN_REGIME_CONFIDENCE` | Minimum confidence (0-1) before emitting regime alerts | `0.4` |
| `GEX_MIN_ABS_GEX` | Minimum absolute GEX ($) to consider an expiry dominant | `1000000` |
| `REDIS_URL` | Redis connection string for singleton leader lock (Railway prod) | — |
| `LEADER_LOCK_TTL_SECONDS` | Leader lock TTL in seconds | `60` |
| `LEADER_LOCK_RENEW_SECONDS` | Leader lock renewal interval in seconds | `30` |
| `WEBSEARCH_ENABLED` | Enable/disable WebSearch (default `true` in dev, `false` on Railway) | auto |
| `RATE_LIMITS` | JSON override for per-provider rate limits | — |
| `CACHE_TTLS` | JSON override for endpoint cache TTLs | — |

---

## Singleton Lock (Railway Production)

Railway can briefly run two instances during deploys/restarts. To guarantee only ONE instance connects to Discord, set `REDIS_URL` to a Redis instance. The bot acquires a distributed lock (`discord-bot:leader`) with NX + EX before logging in. If the lock is held by another instance, the new process exits gracefully.

- **With Redis**: Leader election via `SET NX EX`. Renewed every 30s (configurable).
- **Without Redis**: Warning logged, boot proceeds (single-instance fallback).

### Railway Variables

| Variable | Where to set | Value |
|---|---|---|
| `REDIS_URL` | Railway Variables | Your Redis connection string |
| `LEADER_LOCK_TTL_SECONDS` | Railway Variables (optional) | `60` |
| `LEADER_LOCK_RENEW_SECONDS` | Railway Variables (optional) | `30` |
| `WEBSEARCH_ENABLED` | Railway Variables | `false` (recommended for prod) |

---

## Provider Resilience Layer

All outbound API calls (AInvest, FMP, SearXNG) are wrapped with:

1. **Per-provider token bucket rate limiting** — Prevents 429 spam
2. **Endpoint-level TTL cache** — Reduces redundant API calls
3. **Circuit breaker** — Automatically disables failing providers

### Cache TTL Defaults

| Data Type | TTL |
|---|---|
| Profile/company info | 24 hours |
| Insider/ownership/analyst | 12 hours |
| News headlines | 20 minutes |
| 1-min candles | 20 seconds |
| 5-min candles | 90 seconds |

### Circuit Breaker Rules

| Error | Action |
|---|---|
| HTTP 429 | Disable provider/endpoint for 15 minutes |
| AInvest error 4014 | Disable for 60 minutes |
| HTTP 404 for MCP tool | Disable permanently until restart |
| 5 consecutive errors | Disable for 5 minutes |

When the circuit is open, cached data is returned if available; otherwise a `ProviderUnavailableError` is thrown.

---

## Alpha Vantage Integration

Alpha Vantage provides a free API for market data, **server-side technical indicators**, news sentiment, and fundamentals. It serves as a fallback data source when Alpaca and FMP are unavailable.

### Data Priority Chain
```
Alpaca (preferred) → FMP → Alpha Vantage (fallback)
```

### Capabilities

| Feature | Endpoint | Cache TTL |
|---|---|---|
| Real-time quote | `GLOBAL_QUOTE` | 60s |
| Intraday candles | `TIME_SERIES_INTRADAY` (1m/5m/15m/30m/60m) | 20s-10m |
| Daily history | `TIME_SERIES_DAILY` | 1h |
| Server-side RSI | `RSI` | varies by interval |
| Server-side MACD | `MACD` | varies by interval |
| Bollinger Bands | `BBANDS` | varies by interval |
| ATR | `ATR` | varies by interval |
| VWAP (intraday) | `VWAP` | varies by interval |
| News + AI sentiment | `NEWS_SENTIMENT` | 20m |
| Company overview | `OVERVIEW` | 24h |
| Earnings | `EARNINGS` | 12h |
| Top movers | `TOP_GAINERS_LOSERS` | 5m |
| Ticker search | `SYMBOL_SEARCH` | 1h |

### Rate Limits
- Free tier: 25 requests/day — the resilience layer caches aggressively to stay within budget
- Rate limited to ~5 requests/minute via the token bucket
- Circuit breaker trips on 429 responses (15 min cooldown)
- [MCP server](https://mcp.alphavantage.co/) available for AI agent integration

### Setup
1. Get a free API key at https://www.alphavantage.co/support/#api-key
2. Set `ALPHA_API_KEY` in your `.env` or Railway Variables

---

## 0DTE Options Decision Engine

Rule-based dominance hierarchy for 0DTE options trading:

| Gate | Name | Function |
|---|---|---|
| 0 | Safety | Market hours, missing data, wide spreads → NO_TRADE |
| 1 | Macro | Sets allowed directions {CALL, PUT, NO_TRADE} |
| 2 | Gamma | Sets bias; squeeze ONLY if shortGamma≥60% AND netGEX≤-$300M |
| 3 | Trigger | MANDATORY price action confirmation (VWAP, breakout + RSI/MACD) |
| 4 | AI Overlay | Adjusts conviction ±2, cannot flip direction |

### Risk Controls (every trade)
- Premium stop: -40%
- Time stop: 12 minutes (no favorable move)
- VWAP fail exit: 2 rejections
- Price invalidation at support/resistance

### Throttle Controls
- Max 3 trades per symbol per hour
- 2 consecutive losses → 30 min cooldown
- Max 2 correlated positions (SPY, QQQ, IWM, XLF)

### Strike Selection
- Delta: 0.35–0.55
- Distance: ≤0.3% (scalp), ≤0.6% (breakout)
- Spread: ≤3% bid/ask

---

## Gamma Exposure (GEX) Engine

The GEX engine analyzes options gamma exposure across multiple expirations to produce actionable trading signals.

### How GEX is Computed

**Per-strike GEX (dealer perspective):**
```
GEX$ = OI × gamma × 100 (contract multiplier) × spot_price
```

- **Calls** contribute positive GEX (dealers who sold calls are long gamma)
- **Puts** contribute negative GEX (dealers who sold puts are short gamma)
- **Net GEX$** per strike = callGEX$ + putGEX$

Gamma is computed using Black-Scholes when fetching from Yahoo Finance, or taken directly from Alpaca's pre-calculated greeks.

**Multi-expiry aggregation:**
1. **totalNetGEX$** — Sum of netGEX$ across all expirations (0DTE + weekly + monthly)
2. **Dominant expiry** — The expiration contributing the highest absolute GEX share
3. **Strike clustering** — Per-strike GEX aggregated across expirations; strikes that appear in multiple expirations are marked **STACKED**
4. **Call walls** — Top 3 strikes with highest positive aggregated netGEX$
5. **Put walls** — Top 3 strikes with most negative aggregated netGEX$
6. **Gamma flip** — Strike where cumulative aggregated GEX crosses zero

**Regime classification:**
- `totalNetGEX$ > 0` → **Long Gamma** (dealers suppress moves — mean-reversion)
- `totalNetGEX$ < 0` → **Short Gamma** (dealers amplify moves — trend/volatility)
- Near zero or contradicted by per-expiry data → **Mixed/Uncertain**

**Confidence scoring** (0-1): scales with `|totalNetGEX$|` and distance from flip. Reduced when per-expiry regimes disagree with the aggregate.

### How Alerts Work

**Break-and-hold** alerts fire when price action confirms a GEX level break:

1. The engine identifies key levels: primary call wall, put wall, gamma flip
2. Recent 5-minute candles are fetched (configurable interval)
3. A **"hold"** requires `N` consecutive candle closes above (or below) the level (default N=3)
4. Optional **volume confirmation**: average volume during hold must exceed prior-period average
5. Alerts are rate-limited (1 hour cooldown per level per direction)

**Alert triggers:**
- Break above call wall → Upside expansion risk (dealer cover)
- Break below put wall → Downside expansion risk (dealer selling amplifies)
- Cross above gamma flip → Entering long gamma (mean-reversion expected)
- Cross below gamma flip → Entering short gamma (trend/vol expansion expected)

**Commands:**
- `/gex chart <ticker> [expiration]` — Single-expiry GEX bar chart (original view)
- `/gex summary <ticker>` — Multi-expiry aggregated analysis with regime, walls, playbook
- `/gex alerts <ticker>` — Check current break-and-hold conditions

### Example Output: Stacked 593 Call Wall

```
SPY — GEX Summary | Spot: $590
Dominant: 2025-02-21 (78% of GEX)

🟢 Long Gamma █████ (80%)
Net GEX: $255.00M

Call Wall: $593 ($155.00M) STACKED
Put Wall: $580 (-$61.00M) STACKED
Flip: $586.50 (spot ABOVE)

• Below $593 call wall in long gamma: expect pin / mean-reversion toward $593
• Acceptance above $593 call wall: upside expansion risk to $595
• Breakdown below $580 put cluster: downside expansion risk to $575

Mock | 3 expiries
```

The $593 call wall is **STACKED** — it appears as a major level in 0DTE ($7M), weekly ($43M), and monthly ($105M) expirations, making it a high-conviction resistance/magnet level.

---

## Commands

### Slash Commands

| Command | Description |
|---|---|
| `/ask <question>` | Ask the AI anything — uses conversation context and memory |
| `/analyze <ticker>` | AI-powered stock analysis with live market data |
| `/deepanalysis <ticker>` | Multi-agent deep analysis — 4 analysts, debate, trader, risk → BUY/SELL/HOLD |
| `/price <ticker>` | Quick price + key stats lookup (P/E, RSI, moving averages, etc.) |
| `/technicals <ticker>` | Technical analysis — RSI, MACD, Bollinger Bands, SMA/EMA crossovers, ATR |
| `/gex chart <ticker>` | Single-expiry GEX chart with per-strike bars |
| `/gex summary <ticker>` | Multi-expiry aggregated GEX — regime, stacked walls, playbook |
| `/gex alerts <ticker>` | Check break-and-hold conditions on GEX levels |
| `/macro` | Macro environment analysis — market regime, benchmarks, sector breadth |
| `/sectors` | Sector rotation heatmap — performance of 11 sector ETFs |
| `/validea <ticker>` | Validea guru fundamental analysis scores |
| `/news [symbols] [limit]` | Latest market news from Alpaca (optionally filtered by symbols) |
| `/screen <universe> [rules]` | Run a stock screen (e.g. `/screen SP500 PE < 15, MktCap > 1e9`) |
| `/research <query>` | Agent Swarm parallel research — multi-angle analysis with consensus |
| `/social <ticker>` | StockTwits social sentiment + recent posts |
| `/trending` | StockTwits trending tickers |
| `/reddit [ticker]` | Reddit sentiment from r/wallstreetbets, r/stocks, r/investing, r/options |
| `/watchlist [action] [ticker]` | Manage your personal stock watchlist (show/add/remove) |
| `/sentiment <text>` | Analyze text sentiment — score, positive/negative words |
| `/topic` | Generate an AI-powered discussion topic for the server |
| `/profile [@user]` | View user profile — interactions, sentiment, facts, favorite tickers |
| `/memory` | See what the bot remembers about you (facts, tickers, sentiment) |
| `/model <name>` | Switch the Ollama model at runtime |
| `/stats` | View bot statistics, mood, memory usage, and reaction feedback |
| `/agent <action>` | SHARK autonomous trading agent control (status/enable/disable/config/set/reset/trade/logs/kill) |
| `/stream <action> [symbols]` | Real-time Alpaca WebSocket market data (start/stop/list/status) |
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

### Autonomy Commands (Owner Only)

| Command | Description |
|---|---|
| `!autonomy status` | Show current goals, weights, and recent autonomous actions |
| `!autonomy pause <minutes>` | Temporarily disable all autonomous behaviors |
| `!autonomy setgoal <goal> <weight>` | Adjust a goal's priority weight |
| `!autonomy override <action>` | Manually trigger an autonomous action |
| `!safetystatus` | Show current rate limits, safety blocks, and API usage |

### Other

- **@mention** the bot in any channel or send a **DM** to chat directly
- React with :thumbsup: or :thumbsdown: on bot replies to provide feedback

---

## Autonomous Agent Architecture

Sprocket is more than a chatbot — it's a goal-driven autonomous agent that decides when and how to act.

### Agent Core (`agent-core.js`)

The decision-making brain. Evaluates context, classifies user intent, and selects the best action.

- **`evaluateContext(message)`** — Main decision loop. Considers user history, channel activity, time of day, and current goals
- **`analyzeIntent(text)`** — Classifies what the user wants using AI
- **`isChannelQuiet(channel, minutes)`** — Detects idle channels for proactive engagement
- **`chooseActionBasedOnGoal(goal, context)`** — Picks an action aligned with the active goal

Returns action objects like:
```js
{ action: 'execute', tool: 'getStockPrice', args: ['AAPL'] }
{ action: 'respond', content: 'Markets are rallying today...' }
{ action: 'wait', reason: 'Channel is active, no intervention needed' }
```

Available tools: `getStockPrice`, `webSearch`, `selfHeal`, `analyzeStock`, `runScreen`, `generateTopic`

### Proactive Goal System

Goals drive what Sprocket does when no one is asking it a question. Each goal has a weight, activation condition, and success metric.

| Goal | Description | Trigger |
|---|---|---|
| `provide_value` | Post market summaries, react to major news, share insights | 9 AM daily, breaking market moves |
| `foster_engagement` | Detect quiet channels, ask discussion questions, welcome users | Channel idle > 30 min |
| `self_improve` | Monitor error logs, run `!selfheal`, optimize responses | Error rate > threshold |
| `learn_preferences` | Track user interests, personalize responses, adapt tone | Every interaction |

Goals are evaluated on a loop:
- **Every 5 minutes** — Agent core checks if proactive action is needed
- **Every hour** — Goal manager reviews progress and adjusts weights
- **Every 24 hours** — Memory system prunes stale data

### Web Search (`tools/web-search.js`)

Live internet search capability via [SearXNG](https://docs.searxng.org) — a free, open-source metasearch engine. No API key required.

- **`webSearch(query, numResults)`** — Queries a SearXNG instance and returns structured results with titles, links, and snippets
- **`formatResultsForAI(result)`** — Formats search results as context for LLM prompts
- **`formatResultsForDiscord(result)`** — Formats search results for Discord display
- **5-minute cache** — Prevents duplicate queries to the same instance
- **Infobox support** — Extracts knowledge-graph-style infoboxes when available

### Safety & Rate Limits (`safety-system.js`)

A guardrail layer that every autonomous action must pass through before execution.

**Safety rules:**
- Never edit files containing API keys, passwords, or authentication logic
- Maximum 3 GitHub commits per hour
- Never mention specific stock tickers as financial advice
- Never @mention more than 5 users at once
- Maximum 10 web searches per hour
- Never run `!selfheal` more than once per day

**Graceful degradation:**
- If an API fails, switch to fallback mode
- If rate limited, queue actions with exponential backoff
- All safety overrides are logged for review

**Emergency stop:** `emergencyStop()` immediately halts all autonomous actions.

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

## Memory & Personalization

Sprocket maintains a multi-layer memory system for contextual, personalized interactions.

### Per-User Memory
- **Facts** — Extracted from conversation (name, job, interests, preferences)
- **Tickers** — Tracks which stocks a user discusses most frequently
- **Topics** — Classifies conversations (options, technical, fundamental, crypto, macro, risk)
- **Watchlist** — Personal stock watchlist with add/remove/show
- **Sentiment** — Per-user sentiment history with rolling average and trend detection

### Long-Term Memory
- **User Preferences** — Interests, interaction style, trust level
- **Conversation Contexts** — Summaries of past conversations with key points
- **Decision Outcomes** — What actions the bot took, whether they succeeded, and what it learned

### Learning Loop
1. User interacts with the bot
2. Bot records the interaction, sentiment, and any extracted facts
3. Bot's response is tracked — did the user give a :thumbsup: or :thumbsdown:?
4. Outcome is saved to memory: `saveDecisionOutcome(decisionId, wasSuccessful, whatWorked)`
5. Next time a similar context appears, `findSimilarContexts()` retrieves past outcomes to inform the response

---

## TradingAgents — Multi-Agent Analysis Pipeline

Inspired by [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), Sprocket implements a full multi-agent LLM trading analysis pipeline natively in Node.js. No Python required — uses the existing Ollama integration and Yahoo Finance data.

### Pipeline

```
┌─────────────────────────────────────────────────────────┐
│ /deepanalysis AAPL                                       │
├─────────────────────────────────────────────────────────┤
│ Stage 1: Four Analyst Agents (parallel)                  │
│   ├── Market/Technical Analyst (price action, RSI, SMA) │
│   ├── Fundamentals Analyst (P/E, EPS, margins, growth)  │
│   ├── Sentiment Analyst (crowd psychology, fear/greed)   │
│   └── News/Macro Analyst (sector trends, catalysts)      │
├─────────────────────────────────────────────────────────┤
│ Stage 2: Bull vs Bear Debate                             │
│   ├── Bull Advocate (strongest case FOR buying)          │
│   └── Bear Advocate (strongest case AGAINST buying)      │
├─────────────────────────────────────────────────────────┤
│ Stage 3: Trader Decision                                 │
│   └── Senior Trader makes BUY/SELL/HOLD decision         │
├─────────────────────────────────────────────────────────┤
│ Stage 4: Risk Management Committee (parallel)            │
│   ├── Aggressive Risk Manager                            │
│   ├── Moderate Risk Manager                              │
│   └── Conservative Risk Manager                          │
├─────────────────────────────────────────────────────────┤
│ Stage 5: Final Signal                                    │
│   └── Head of Trading → BUY/SELL/HOLD + confidence 1-10 │
└─────────────────────────────────────────────────────────┘
```

### How It Works

1. **Data Fetch** — Yahoo Finance provides real-time price, volume, technicals (RSI, SMA50/200), fundamentals (P/E, EPS, margins), and 52-week range
2. **Analyst Agents** — Four specialized LLM agents analyze the data from different angles simultaneously, each producing a BULLISH/BEARISH/NEUTRAL rating with confidence
3. **Debate** — A bull advocate and bear advocate argue for/against the stock, citing specific data points and countering each other's arguments
4. **Trader** — Reviews all analyst reports and the debate, then makes a decisive BUY/SELL/HOLD call with timeframe
5. **Risk Committee** — Three risk managers (aggressive, moderate, conservative) independently review the trade proposal and vote APPROVE/REJECT
6. **Final Signal** — Head of trading synthesizes everything into a final signal with confidence level

### Output

The command produces a formatted Discord message showing:
- Signal (BUY/SELL/HOLD) with confidence bar
- Summary rationale
- Individual analyst ratings
- Bull/Bear debate highlights
- Risk committee verdicts (APPROVE/REJECT from each manager)
- Full detailed report as an ephemeral follow-up message

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
├── index.js                        # Entry point — Discord client, event routing, autonomy loop
├── bot.js                          # Legacy entry point (simpler, prefix-only)
├── package.json                    # Dependencies and scripts
├── railway.toml                    # Railway deployment config
├── nixpacks.toml                   # Nixpacks build config
├── Dockerfile                      # Container deployment (Railway/DigitalOcean)
├── docker-compose.yml              # Local dev with optional PostgreSQL + Redis
├── Modelfile                       # Custom Ollama model with baked-in RAG rules
├── .env.example                    # Environment variable template
├── .gitignore
├── data/                           # Persistent JSON storage (git-ignored)
└── src/
    ├── config.js                   # Environment config loader
    ├── date-awareness.js           # Centralized RAG enforcement & date injection utilities
    ├── logger.js                   # Structured logging with level filtering
    ├── personality.js              # Bot identity, speech patterns, quirks
    ├── github-client.js            # GitHub API integration (file read/update/rollback)
    ├── ai-coder.js                 # Anthropic API wrapper for code generation
    ├── commands/
    │   ├── register.js             # Slash command registration (25 commands)
    │   ├── handlers.js             # Slash command handlers
    │   ├── prefix.js               # Owner prefix commands (!update, !suggest, !autoedit, !rollback, !selfheal)
    │   └── self-heal.js            # Self-healing — AI auto-fix for critical bugs
    ├── tools/
    │   ├── web-search.js           # SearXNG web search with caching + formatting
    │   └── price-fetcher.js        # Real-time price fetcher via yahoo-finance2 (free, no key)
    ├── dashboard/
    │   ├── server.js               # Express dashboard — /health, /api/stats, /api/safety, /api/audit
    │   └── monitor.html            # Real-time monitoring UI
    ├── data/
    │   ├── freshness.js            # Data freshness gate (assertFresh)
    │   └── market.js               # Market context provider (Alpaca + FMP fallback)
    ├── services/
    │   ├── ai.js                   # Core AI — Ollama + Kimi K2.5 agent mode, web search
    │   ├── autonomous.js           # Scheduled behaviors engine (briefings, alerts, GEX monitor)
    │   ├── commentary.js           # AI-powered personality inflection with fallbacks
    │   ├── images.js               # Image analysis via Ollama vision models
    │   ├── memory.js               # Per-user memory — facts, tickers, topics, watchlist
    │   ├── mood.js                 # Mood engine — 7 states, P&L-driven, decay
    │   ├── trading-agents.js       # Multi-agent analysis (4 analysts, debate, trader, risk committee)
    │   ├── agent-swarm.js          # Parallel research agent swarm
    │   ├── yahoo.js                # FMP market data client (stocks + crypto)
    │   ├── alpaca.js               # Alpaca API (real-time quotes, options, news, trading)
    │   ├── technicals.js           # Technical indicators (RSI, MACD, Bollinger, SMA/EMA, ATR)
    │   ├── gamma.js                # Gamma Exposure (GEX) analysis with chart
    │   ├── macro.js                # Macro environment analysis
    │   ├── sectors.js              # Sector rotation heatmap
    │   ├── stocktwits.js           # StockTwits sentiment API
    │   ├── reddit.js               # Reddit sentiment scraping
    │   ├── validea.js              # Validea guru fundamental analysis
    │   ├── mahoraga.js             # SHARK autonomous trading agent
    │   ├── policy.js               # Trading policy & risk management config
    │   ├── stream.js               # Alpaca WebSocket real-time data
    │   ├── reactions.js            # Reaction-based learning and pattern tracking
    │   ├── sentiment.js            # Sentiment analysis with per-user trend tracking
    │   ├── stats.js                # Uptime, message count, error tracking
    │   ├── storage.js              # JSON file-based persistent storage
    │   ├── audit-log.js            # Event audit trail
    │   └── circuit-breaker.js      # Safety circuit breaker
    └── trading/
        ├── analyze.js              # Trade analysis orchestrator
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

### Docker Deployment

```bash
# Build and run with Docker
docker build -t sprocket-bot .
docker run -d --env-file .env sprocket-bot

# Or use docker-compose for local dev with full stack
docker-compose up -d
```

The `docker-compose.yml` includes:
- **Bot service** — The Discord bot
- **PostgreSQL** (optional) — Production-grade memory storage
- **Redis** (optional) — Response caching and rate limit tracking

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

### Monitoring Dashboard

Access the monitoring UI at `http://localhost:3000/monitor` for:
- Real-time bot logs
- API usage graphs (Ollama, Yahoo Finance, SearXNG, GitHub)
- Goal achievement tracking
- Safety override alerts

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
