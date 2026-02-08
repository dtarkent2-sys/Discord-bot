# Discord AI Bot

An autonomous Discord bot powered by local AI models through [Ollama](https://ollama.com). Features conversation memory, NLP text analysis, self-learning neural networks, and scheduled autonomous actions — all running without external API keys.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dtarkent2-sys/Discord-bot)

---

## Features

- 🤖 **AI Chat** — Conversational responses via Ollama (Mistral, Gemma, Llama, etc.) with automatic rule-based fallback
- 🧠 **Conversation Memory** — SQLite database tracks every message, user profiles, and sentiment history
- 📊 **Sentiment Analysis** — Real-time mood tracking per user using the AFINN lexicon (no API needed)
- 🔍 **NLP Text Analysis** — Extract topics, people, places, and keywords from any text using compromise + natural
- 🧬 **Self-Learning** — brain.js neural network learns engagement patterns from conversations over time
- 📈 **Pre-Market Stock Analysis** — AI-generated market commentary every weekday at 7 AM EST
- 💬 **Daily Discussion Questions** — Auto-posted conversation starters at 10 AM EST
- 📋 **Daily Summaries** — Activity leaderboards, mood bars, and AI closing remarks at 10 PM EST
- 📅 **Weekly Insights** — Trending topics, peak hours, top contributors every Monday at 9 AM EST
- 🎯 **Random Engagement** — Finds quiet channels and drops in with conversation starters every 2 hours
- 👋 **Welcome Messages** — AI-generated personalized greetings for new members
- 💚 **Health Monitoring** — HTTP `/health` endpoint for Railway deployment monitoring

---

## Prerequisites

Before you start, make sure you have:

- **Node.js** v18 or higher — [Download here](https://nodejs.org/)
- **Git** — [Download here](https://git-scm.com/)
- **A Discord Bot Token** — [Create one here](https://discord.com/developers/applications)
- **Ollama** (optional) — [Install here](https://ollama.com/download) for local AI models

> **Don't have Ollama?** No problem — the bot automatically falls back to rule-based NLP responses using compromise and natural. All sentiment analysis, text parsing, and keyword extraction work without Ollama.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/dtarkent2-sys/Discord-bot.git
cd Discord-bot

# 2. Install dependencies
npm install

# 3. Set up your environment
cp .env.example .env
# Edit .env and add your DISCORD_TOKEN

# 4. (Optional) Install Ollama and pull a model
curl -fsSL https://ollama.com/install.sh | sh
ollama pull mistral

# 5. Start the bot
npm start
```

That's it. The bot logs in, initializes the database, connects to Ollama (if available), and starts all scheduled jobs.

---

## Installation (Detailed)

### Step 1: Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to the **Bot** tab and click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**
5. Copy the **Bot Token** — you'll need it for the `.env` file
6. Go to **OAuth2 > URL Generator**, select:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `View Channels`
7. Open the generated URL to invite the bot to your server

### Step 2: Clone and Install

```bash
git clone https://github.com/dtarkent2-sys/Discord-bot.git
cd Discord-bot
npm install
```

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Open `.env` in your editor and set at minimum:

```env
DISCORD_TOKEN=your_actual_bot_token_here
```

### Step 4: Set Up Ollama (Optional)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull your preferred model
ollama pull mistral

# Ollama starts automatically — verify it's running
ollama list
```

### Step 5: Run

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

You should see:

```
[Health] Listening on port 3000
[Bot] Logged in as YourBot#1234
[Memory] Database initialized.
[AI Engine] Ollama connected — model "mistral" ready.
[Bot] AI Engine initialized.
[Autonomous] Started 6 jobs: stockAnalysis, dailyQuestion, dailySummary, weeklyInsights, randomEngage, convoAnalysis (tz: America/New_York)
```

---

## Commands

| Command | Description |
|---|---|
| `!ask <question>` | Ask the AI anything — uses conversation context from memory |
| `!sentiment <text>` | Analyze the sentiment of any text (positive / negative / neutral) |
| `!analyze <text>` | Full NLP breakdown — topics, people, places, sentiment, question detection |
| `!profile [@user]` | View a user's message count, average mood, and last seen time |
| `!topic` | Generate a random discussion topic |
| `!setchannel` | Set the current channel for autonomous bot activity (requires Manage Server) |
| `!help` | Show all available commands |

You can also **@mention** the bot anywhere to chat with it directly.

---

## Configuration

All settings are configured through environment variables. See `.env.example` for the full template.

### Required

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your Discord bot token |

### AI Model

| Variable | Description | Default |
|---|---|---|
| `OLLAMA_URL` | Ollama API endpoint | `http://localhost:11434` |
| `OLLAMA_MODEL` | Which Ollama model to use | `gemma3` |

### Bot Settings

| Variable | Description | Default |
|---|---|---|
| `BOT_PREFIX` | Command prefix | `!` |
| `NODE_ENV` | Environment mode | `production` |
| `HEALTH_PORT` | Port for the health check HTTP server | `3000` |

### Scheduled Actions

All cron expressions run in `SCHEDULE_TIMEZONE` (default: `America/New_York`).

| Variable | Default | When |
|---|---|---|
| `SCHEDULE_STOCK_ANALYSIS` | `0 7 * * 1-5` | 7 AM EST, weekdays |
| `SCHEDULE_DAILY_QUESTION` | `0 10 * * *` | 10 AM EST, daily |
| `SCHEDULE_DAILY_SUMMARY` | `0 22 * * *` | 10 PM EST, daily |
| `SCHEDULE_WEEKLY_INSIGHTS` | `0 9 * * 1` | 9 AM EST, Mondays |
| `SCHEDULE_RANDOM_ENGAGE` | `0 */2 * * *` | Every 2 hours |
| `SCHEDULE_CONVO_ANALYSIS` | `0 */4 * * *` | Every 4 hours |
| `SCHEDULE_TIMEZONE` | `America/New_York` | Timezone for all schedules |

---

## Available Models

Any model that Ollama supports will work. Here are recommended options:

| Model | Size | Best For | Install |
|---|---|---|---|
| **Mistral** | ~4 GB | General chat, fast responses | `ollama pull mistral` |
| **Gemma 3** | ~3.3 GB | Balanced quality and speed | `ollama pull gemma3` |
| **Llama 3.1** | ~4.7 GB | Strong reasoning | `ollama pull llama3.1` |
| **Phi-3** | ~2.2 GB | Lightweight, resource-friendly | `ollama pull phi3` |
| **Qwen 2.5** | ~4.7 GB | Multilingual support | `ollama pull qwen2.5` |
| **DeepSeek R1** | ~4.7 GB | Code and technical questions | `ollama pull deepseek-r1` |

To switch models, change `OLLAMA_MODEL` in your `.env`:

```env
OLLAMA_MODEL=mistral
```

Or pull and test a model directly:

```bash
ollama pull llama3.1
ollama run llama3.1 "Hello, how are you?"
```

---

## Deploy to Railway

### One-Click Deploy

Click the button at the top of this README, or:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dtarkent2-sys/Discord-bot)

### Manual Deploy

1. **Fork this repo** to your GitHub account

2. **Create a Railway project** at [railway.app](https://railway.app)

3. **Connect your GitHub repo** — Railway auto-detects `railway.toml`

4. **Set environment variables** in Railway dashboard:
   ```
   DISCORD_TOKEN=your_token_here
   OLLAMA_URL=http://your-ollama-service:11434
   OLLAMA_MODEL=mistral
   NODE_ENV=production
   ```

5. **Deploy** — Railway builds with Nixpacks, runs `npm install`, starts `node bot.js`

6. **Verify** — Check the `/health` endpoint in your Railway deployment URL:
   ```
   https://your-app.up.railway.app/health
   ```

### Railway + Ollama

Since Ollama needs to run as a separate service, you have two options:

**Option A: Separate Railway service**
- Add a second service in Railway running Ollama
- Set `OLLAMA_URL` to that service's internal URL

**Option B: External Ollama**
- Run Ollama on your own server or VPS
- Set `OLLAMA_URL` to your server's public endpoint

**Option C: No Ollama (rule-based only)**
- Just deploy without setting `OLLAMA_URL`
- The bot falls back to NLP-based responses automatically

---

## Local Development

```bash
# Start with auto-restart on file changes
npm run dev

# The bot connects to Ollama at localhost:11434 by default
# Make sure Ollama is running:
ollama serve
```

### Testing the Health Endpoint

```bash
curl http://localhost:3000/health
```

Response:

```json
{
  "status": "ok",
  "uptime": 120,
  "discord": "connected",
  "ai": "ollama",
  "memory": "connected",
  "guilds": 1,
  "scheduled_jobs": 6
}
```

### Docker (Optional)

```bash
npm run docker-build
npm run docker-run
```

---

## Project Structure

```
discord-ai-bot/
├── bot.js                  # Entry point — Discord client, commands, health server
├── ai-engine.js            # Ollama integration, NLP (natural + compromise), brain.js learning
├── memory-system.js        # SQLite database — conversations, user profiles, sentiment
├── autonomous-actions.js   # 6 scheduled jobs — stocks, questions, summaries, engagement
├── package.json            # Dependencies and scripts
├── railway.toml            # Railway deployment config with health check
├── .env.example            # Environment variable template
├── .gitignore              # Git ignore patterns
└── README.md               # This file
```

### How It All Connects

```
Discord ──> bot.js ──> ai-engine.js ──> Ollama API (or rule-based fallback)
               │              │
               │              ├──> natural (sentiment, TF-IDF keywords)
               │              ├──> compromise (topics, entities, parsing)
               │              └──> brain.js (learns engagement patterns)
               │
               ├──> memory-system.js ──> SQLite (conversations + profiles)
               │
               └──> autonomous-actions.js ──> node-schedule (6 cron jobs)
                        │
                        ├── 7 AM: Stock analysis
                        ├── 10 AM: Daily question
                        ├── 10 PM: Daily summary
                        ├── Mon 9 AM: Weekly insights
                        ├── Every 2h: Random engagement
                        └── Every 4h: Conversation analysis
```

---

## Contributing

Contributions are welcome! Here's how:

1. **Fork** this repository
2. **Create a branch** for your feature:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** and test locally
4. **Commit** with a clear message:
   ```bash
   git commit -m "Add: description of your change"
   ```
5. **Push** and open a Pull Request:
   ```bash
   git push origin feature/your-feature-name
   ```

### Ideas for Contributions

- Slash command support (Discord interactions API)
- Voice channel integration
- Image generation with Ollama multimodal models
- Web dashboard for bot configuration
- More autonomous action types
- Multi-language support

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

**Built with [discord.js](https://discord.js.org/) + [Ollama](https://ollama.com) + [natural](https://naturalnode.github.io/natural/) + [compromise](https://compromise.cool/) + [brain.js](https://brain.js.org/)**
