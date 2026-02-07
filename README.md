# Discord AI Bot

Autonomous Discord bot powered by local AI models via [Transformers.js](https://huggingface.co/docs/transformers.js). Runs entirely without external API keys for AI inference.

## Features

- **AI Chat** - Responds to questions and mentions using a local text generation model (LaMini-Flan-T5-248M)
- **Sentiment Analysis** - Tracks message sentiment per user with DistilBERT
- **Conversation Memory** - SQLite-backed message history and user profiles
- **Autonomous Actions** - Scheduled conversation starters, mood detection, and daily summaries
- **New Member Welcomes** - AI-generated welcome messages

## Commands

| Command | Description |
|---------|-------------|
| `!ask <question>` | Ask the AI a question |
| `!sentiment <text>` | Analyze text sentiment |
| `!profile [@user]` | View user profile and stats |
| `!topic` | Generate a discussion topic |
| `!setchannel` | Set the channel for autonomous activity (requires Manage Server) |
| `!help` | Show available commands |

You can also **@mention** the bot to chat with it directly.

## Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your Discord bot token
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the bot:
   ```bash
   npm start
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Discord bot token (required) | - |
| `BOT_PREFIX` | Command prefix | `!` |
| `AUTONOMOUS_INTERVAL_MINUTES` | Minutes between auto-generated topics | `30` |

## Deploy to Railway

1. Connect your GitHub repo to Railway
2. Set `DISCORD_TOKEN` in Railway environment variables
3. Railway auto-deploys on push via `railway.toml`

## Architecture

- `bot.js` - Entry point, Discord event handling, command routing
- `ai-engine.js` - Model loading and inference (Transformers.js)
- `memory-system.js` - SQLite conversation storage and user profiles
- `autonomous-actions.js` - Cron-scheduled autonomous behaviors

## Required Discord Bot Permissions

- Send Messages
- Read Message History
- View Channels
- Manage Messages (optional, for future features)

Enable these **Gateway Intents** in the Discord Developer Portal:
- Server Members Intent
- Message Content Intent
