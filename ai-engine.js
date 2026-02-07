const { pipeline, env } = require('@xenova/transformers');

// Configure transformers.js to use local cache
env.cacheDir = './.cache';
env.allowRemoteModels = true;

class AIEngine {
  constructor() {
    this.textGenerator = null;
    this.sentimentAnalyzer = null;
    this.ready = false;
  }

  async initialize() {
    console.log('[AI Engine] Loading models...');

    try {
      this.textGenerator = await pipeline(
        'text2text-generation',
        'Xenova/LaMini-Flan-T5-248M'
      );
      console.log('[AI Engine] Text generation model loaded.');

      this.sentimentAnalyzer = await pipeline(
        'sentiment-analysis',
        'Xenova/distilbert-base-uncased-finetuned-sst-2-english'
      );
      console.log('[AI Engine] Sentiment analysis model loaded.');

      this.ready = true;
      console.log('[AI Engine] All models ready.');
    } catch (err) {
      console.error('[AI Engine] Failed to load models:', err.message);
      throw err;
    }
  }

  async generateResponse(prompt, context = '') {
    if (!this.ready) throw new Error('AI Engine not initialized');

    const fullPrompt = context
      ? `Context: ${context}\n\nUser: ${prompt}\n\nAssistant:`
      : `User: ${prompt}\n\nAssistant:`;

    const result = await this.textGenerator(fullPrompt, {
      max_new_tokens: 200,
      temperature: 0.7,
      do_sample: true,
    });

    return result[0].generated_text.trim();
  }

  async analyzeSentiment(text) {
    if (!this.ready) throw new Error('AI Engine not initialized');

    const result = await this.sentimentAnalyzer(text);
    return result[0]; // { label: 'POSITIVE'|'NEGATIVE', score: 0-1 }
  }

  async generateTopic() {
    if (!this.ready) throw new Error('AI Engine not initialized');

    const prompts = [
      'Generate an interesting discussion topic about technology.',
      'Suggest a fun question to ask a group of friends.',
      'Come up with a thought-provoking question about science.',
      'Suggest a creative writing prompt.',
      'Generate an interesting fact or trivia question.',
    ];

    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const result = await this.textGenerator(prompt, {
      max_new_tokens: 100,
      temperature: 0.9,
      do_sample: true,
    });

    return result[0].generated_text.trim();
  }
}

module.exports = AIEngine;
