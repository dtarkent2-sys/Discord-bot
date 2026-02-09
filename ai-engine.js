const axios = require('axios');
const natural = require('natural');
const nlp = require('compromise');
const { NeuralNetwork } = require('brain.js');

const OLLAMA_BASE = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://ollama.railway.internal:11434';
const OLLAMA_MODEL_PREF = process.env.OLLAMA_MODEL || 'llama3.2:3b';

class AIEngine {
  constructor(stocks) {
    this.stocks = stocks || null;
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

    // Cache for frequently accessed data
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes

    // Retry configuration
    this.maxRetries = 3;
    this.baseDelay = 1000; // 1 second
  }

  async initialize() {
    console.log(`[AI Engine] Initializing... (Ollama URL: ${OLLAMA_BASE}, model: ${OLLAMA_MODEL_PREF})`);

    // Check if Ollama is reachable and resolve full model name
    try {
      const res = await this._retryRequest(async () => {
        return axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: 15000,  });
      });

      if (!res.data || !Array.isArray(res.data.models)) {
        throw new Error('Invalid response format from Ollama API');
      }