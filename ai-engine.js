const axios = require('axios');
const natural = require('natural');
const nlp = require('compromise');
const { NeuralNetwork } = require('brain.js');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'https://ollama.com';
const OLLAMA_MODEL_PREF = process.env.OLLAMA_MODEL || 'gemma3:4b-cloud';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

class AIEngine {
  constructor() {
    this.ollamaAvailable = false;
    this.ready = false;

    // NLP tools (always available — no external API needed)
    this.tokenizer = new natural.WordTokenizer();
    this.sentimentAnalyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn');
    this.tfidf = new natural.TfIdf();

    // Brain.js network for learning response patterns
    this.net = new NeuralNetwork({ hiddenLayers: [10] });
    this.trained = false;
    this.trainingData = [];

    // Axios config for Ollama requests (adds auth header when API key is set)
    this.axiosConfig = OLLAMA_API_KEY
      ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } }
      : {};
  }

  async initialize() {
    console.log(`[AI Engine] Initializing... (Ollama URL: ${OLLAMA_BASE}, model: ${OLLAMA_MODEL_PREF}, API key: ${OLLAMA_API_KEY ? 'set' : 'NOT SET'})`);

    // Check if Ollama is reachable and resolve full model name
    try {
      const res = await axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: 15000, ...this.axiosConfig });
      const models = res.data.models || [];

      // Find exact match first, then prefix match (e.g. "gemma3" -> "gemma3:4b")
      const exact = models.find(m => m.name === OLLAMA_MODEL_PREF);
      const prefix = models.find(m => m.name.startsWith(OLLAMA_MODEL_PREF));
      const match = exact || prefix;

      if (match) {
        this.ollamaModel = match.name;
        this.ollamaAvailable = true;
        console.log(`[AI Engine] Ollama connected — using model "${this.ollamaModel}".`);
      } else {
        console.log(`[AI Engine] Ollama running but model "${OLLAMA_MODEL_PREF}" not found. Using rule-based fallback.`);
        console.log(`[AI Engine] Available models: ${models.map(m => m.name).join(', ') || 'none'}`);
      }
    } catch (err) {
      console.error(`[AI Engine] Ollama not reachable: ${err.message}`);
      if (err.response) console.error(`[AI Engine] Response status: ${err.response.status}, data:`, err.response.data);
      console.log('[AI Engine] Using rule-based fallback.');
    }

    this.ready = true;
    console.log('[AI Engine] Ready.');
  }

  // --- Main generation ---

  async generateResponse(prompt, context = '') {
    if (!this.ready) throw new Error('AI Engine not initialized');

    if (this.ollamaAvailable) {
      return this._ollamaGenerate(prompt, context);
    }
    return this._ruleBasedResponse(prompt);
  }

  async _ollamaGenerate(prompt, context = '') {
    const systemPrompt = 'You are a helpful and friendly Discord bot. Keep responses concise (under 300 words). Be conversational and engaging.';

    const userContent = context
      ? `Previous conversation:\n${context}\n\nUser: ${prompt}`
      : prompt;

    try {
      const res = await axios.post(`${OLLAMA_BASE}/api/chat`, {
        model: this.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 300,
        },
      }, { timeout: 60000, ...this.axiosConfig });

      return res.data.message.content.trim();
    } catch (err) {
      console.error('[AI Engine] Ollama generation failed:', err.message);
      return this._ruleBasedResponse(prompt);
    }
  }

  _ruleBasedResponse(prompt) {
    const doc = nlp(prompt);
    const isQuestion = doc.questions().length > 0;
    const topics = doc.topics().out('array');
    const nouns = doc.nouns().out('array');

    if (isQuestion) {
      if (topics.length > 0) {
        return `That's an interesting question about ${topics[0]}! I'd love to discuss that further. What specifically would you like to know?`;
      }
      return "Great question! I'm running in offline mode right now, so my answers are limited. Try again when my AI model is connected!";
    }

    if (nouns.length > 0) {
      return `I see you're talking about ${nouns.slice(0, 2).join(' and ')}. Tell me more!`;
    }

    const fallbacks = [
      "That's interesting! Tell me more.",
      "I hear you! What else is on your mind?",
      "Cool! Want to explore that topic further?",
      "Thanks for sharing! I'm all ears.",
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  // --- Sentiment analysis (local NLP — always works) ---

  analyzeSentiment(text) {
    const tokens = this.tokenizer.tokenize(text);
    const score = this.sentimentAnalyzer.getSentiment(tokens);

    // Normalize: natural returns roughly -5 to +5, map to label + confidence
    const label = score > 0.05 ? 'POSITIVE' : score < -0.05 ? 'NEGATIVE' : 'NEUTRAL';
    const confidence = Math.min(Math.abs(score) / 2, 1);

    return { label, score: confidence, raw: score };
  }

  // --- Topic generation ---

  async generateTopic() {
    if (!this.ready) throw new Error('AI Engine not initialized');

    if (this.ollamaAvailable) {
      try {
        const res = await axios.post(`${OLLAMA_BASE}/api/chat`, {
          model: this.ollamaModel,
          messages: [
            { role: 'user', content: 'Generate one interesting discussion topic or thought-provoking question for a Discord server. Just the topic, nothing else.' },
          ],
          stream: false,
          options: { temperature: 0.9, num_predict: 80 },
        }, { timeout: 30000, ...this.axiosConfig });

        return res.data.message.content.trim();
      } catch {
        // fall through to rule-based
      }
    }

    const topics = [
      "If you could have dinner with any person in history, who would it be and why?",
      "What technology do you think will change the world the most in the next 10 years?",
      "If you could instantly master any skill, what would you pick?",
      "What's a book, movie, or game that genuinely changed your perspective?",
      "Do you think AI will create more jobs than it replaces? Why or why not?",
      "What's the most underrated thing about your daily routine?",
      "If you could live in any fictional universe, which one and why?",
      "What's a small act of kindness that stuck with you?",
    ];
    return topics[Math.floor(Math.random() * topics.length)];
  }

  // --- Brain.js learning ---

  addTrainingExample(input, output) {
    // input/output are objects with numeric keys, e.g. { positive: 1, greeting: 0.8 }
    this.trainingData.push({ input, output });

    // Retrain every 50 examples
    if (this.trainingData.length % 50 === 0 && this.trainingData.length > 0) {
      this._trainNetwork();
    }
  }

  _trainNetwork() {
    if (this.trainingData.length < 10) return;

    try {
      this.net.train(this.trainingData, {
        iterations: 1000,
        errorThresh: 0.01,
        log: false,
      });
      this.trained = true;
      console.log(`[AI Engine] Neural network trained on ${this.trainingData.length} examples.`);
    } catch (err) {
      console.error('[AI Engine] Training error:', err.message);
    }
  }

  predictResponseType(input) {
    if (!this.trained) return null;
    return this.net.run(input);
  }

  // --- Text analysis helpers ---

  extractKeywords(text) {
    this.tfidf.addDocument(text);
    const terms = [];
    this.tfidf.listTerms(this.tfidf.documents.length - 1).forEach(item => {
      if (item.tfidf > 1) terms.push(item.term);
    });
    return terms.slice(0, 5);
  }

  analyzeText(text) {
    const doc = nlp(text);
    return {
      topics: doc.topics().out('array'),
      people: doc.people().out('array'),
      places: doc.places().out('array'),
      nouns: doc.nouns().out('array'),
      verbs: doc.verbs().out('array'),
      sentiment: this.analyzeSentiment(text),
      isQuestion: doc.questions().length > 0,
    };
  }
}

module.exports = AIEngine;
