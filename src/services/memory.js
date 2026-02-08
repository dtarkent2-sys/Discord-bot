const Storage = require('./storage');

class MemoryService {
  constructor() {
    this.store = new Storage('memory.json');
  }

  // Get memory for a specific user
  getUser(userId) {
    return this.store.get(userId, {
      facts: [],
      preferences: {},
      interactionCount: 0,
      firstSeen: null,
      lastSeen: null,
    });
  }

  // Record an interaction and extract facts
  recordInteraction(userId, username, message) {
    const user = this.getUser(userId);
    user.interactionCount++;
    user.lastSeen = new Date().toISOString();
    if (!user.firstSeen) {
      user.firstSeen = user.lastSeen;
    }
    if (!user.username || user.username !== username) {
      user.username = username;
    }

    // Extract basic facts from messages
    const facts = this._extractFacts(message);
    for (const fact of facts) {
      if (!user.facts.includes(fact)) {
        user.facts.push(fact);
      }
    }

    // Keep facts list manageable
    if (user.facts.length > 50) {
      user.facts = user.facts.slice(-50);
    }

    this.store.set(userId, user);
    return user;
  }

  // Add a specific fact about a user
  addFact(userId, fact) {
    const user = this.getUser(userId);
    if (!user.facts.includes(fact)) {
      user.facts.push(fact);
      this.store.set(userId, user);
    }
  }

  // Set a user preference
  setPreference(userId, key, value) {
    const user = this.getUser(userId);
    user.preferences[key] = value;
    this.store.set(userId, user);
  }

  // Build a context string for AI prompts
  buildContext(userId) {
    const user = this.getUser(userId);
    if (user.facts.length === 0 && Object.keys(user.preferences).length === 0) {
      return '';
    }

    const parts = [];
    if (user.username) {
      parts.push(`User's name: ${user.username}`);
    }
    if (user.facts.length > 0) {
      parts.push(`Known facts: ${user.facts.join('; ')}`);
    }
    if (Object.keys(user.preferences).length > 0) {
      parts.push(`Preferences: ${JSON.stringify(user.preferences)}`);
    }
    parts.push(`Interactions: ${user.interactionCount}`);
    return parts.join('\n');
  }

  _extractFacts(message) {
    const facts = [];
    const lower = message.toLowerCase();

    const patterns = [
      { regex: /my name is (\w+)/i, template: (m) => `Name is ${m[1]}` },
      { regex: /i (?:work|am working) (?:as|in) (.+?)(?:\.|$)/i, template: (m) => `Works as/in ${m[1]}` },
      { regex: /i live in (.+?)(?:\.|$)/i, template: (m) => `Lives in ${m[1]}` },
      { regex: /i (?:like|love|enjoy) (.+?)(?:\.|$)/i, template: (m) => `Likes ${m[1]}` },
      { regex: /i (?:hate|dislike|don't like) (.+?)(?:\.|$)/i, template: (m) => `Dislikes ${m[1]}` },
      { regex: /i'm (?:a |an )?(\w+ (?:developer|engineer|designer|student|teacher|artist|musician))/i, template: (m) => `Is a ${m[1]}` },
      { regex: /my favorite (\w+) is (.+?)(?:\.|$)/i, template: (m) => `Favorite ${m[1]} is ${m[2]}` },
    ];

    for (const { regex, template } of patterns) {
      const match = message.match(regex);
      if (match) {
        facts.push(template(match));
      }
    }

    return facts;
  }
}

module.exports = new MemoryService();
