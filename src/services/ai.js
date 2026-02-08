const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');

class AIService {
  constructor() {
    this.ollama = new Ollama({ host: config.ollamaHost });
    this.model = config.ollamaModel;
    this.conversationHistory = new Map(); // userId -> messages[]
    this.maxHistory = 20;
  }

  setModel(modelName) {
    this.model = modelName;
  }

  getModel() {
    return this.model;
  }

  // Generate a response with context
  async chat(userId, username, userMessage, options = {}) {
    const { sentiment, imageDescription } = options;

    // Record interaction in memory
    memory.recordInteraction(userId, username, userMessage);

    // Build system prompt
    const memoryContext = memory.buildContext(userId);
    let systemPrompt = `You are a helpful, friendly Discord bot assistant. Keep responses concise (under 2000 characters for Discord limits). Be conversational and natural.`;

    if (memoryContext) {
      systemPrompt += `\n\nUser context:\n${memoryContext}`;
    }

    if (sentiment) {
      if (sentiment.score < -2) {
        systemPrompt += `\n\nThe user seems upset or frustrated. Be extra empathetic and supportive.`;
      } else if (sentiment.score > 2) {
        systemPrompt += `\n\nThe user seems happy and positive. Match their energy.`;
      }
    }

    // Get or initialize conversation history
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    const history = this.conversationHistory.get(userId);

    // Build the user message content
    let fullMessage = userMessage;
    if (imageDescription) {
      fullMessage = `[Image in message: ${imageDescription}]\n${userMessage}`;
    }

    // Add user message to history
    history.push({ role: 'user', content: fullMessage });

    // Trim history
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }

    try {
      // Use streaming to collect the response
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
        ],
        stream: true,
      });

      let assistantMessage = '';
      for await (const part of stream) {
        assistantMessage += part.message.content;
      }

      // Add assistant response to history
      history.push({ role: 'assistant', content: assistantMessage });

      // Trim to Discord limit
      if (assistantMessage.length > 1990) {
        return assistantMessage.slice(0, 1990) + '...';
      }

      return assistantMessage;
    } catch (err) {
      console.error('Ollama error:', err.message);
      if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
        return "I can't reach the AI model right now. Make sure Ollama is running (`ollama serve`).";
      }
      return `Something went wrong with the AI: ${err.message}`;
    }
  }

  // Stream-based completion without conversation context
  async complete(prompt) {
    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      });

      let result = '';
      for await (const part of stream) {
        result += part.message.content;
      }
      return result;
    } catch (err) {
      console.error('Ollama completion error:', err.message);
      return null;
    }
  }
}

module.exports = new AIService();
