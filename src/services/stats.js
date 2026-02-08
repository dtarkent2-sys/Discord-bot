class StatsService {
  constructor() {
    this.startTime = Date.now();
    this.messagesProcessed = 0;
    this.commandsRun = 0;
    this.errors = 0;
    this.guilds = 0;
  }

  recordMessage() {
    this.messagesProcessed++;
  }

  recordCommand() {
    this.commandsRun++;
  }

  recordError() {
    this.errors++;
  }

  setGuildCount(count) {
    this.guilds = count;
  }

  getUptime() {
    const ms = Date.now() - this.startTime;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m ${seconds % 60}s`;
  }

  getMemoryUsage() {
    const mem = process.memoryUsage();
    return {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    };
  }

  getSummary() {
    const mem = this.getMemoryUsage();
    return {
      uptime: this.getUptime(),
      messagesProcessed: this.messagesProcessed,
      commandsRun: this.commandsRun,
      errors: this.errors,
      guilds: this.guilds,
      memory: mem,
    };
  }
}

module.exports = new StatsService();
