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
