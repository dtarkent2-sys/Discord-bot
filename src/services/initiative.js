const SaveTrades = require('./save-trades');
const directory = require('appdirectory');

class Bot extends DiscordBot {
  constructor() {
    super();
    this.storedTrades = [];
  }

  async onMessage(message) {
    if (!message.guild) return;
    const prefix = '!';
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command === 'trade') {
      if (!message.author.bot) {
        const trade = { symbol: args[0], action: args[1], quantity: args[2], price: args[3], timestamp: new Date() };
        this.storedTrades.push(trade);
        SaveTrades.write(trade);
        await message.channel.send(`Stored trade: ${trade.symbol} ${trade.action} ${trade.quantity} @ ${trade.price}`);
      }
    }
  }
}