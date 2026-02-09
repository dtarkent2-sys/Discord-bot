const axios = require('axios');
const natural = require('natural');
const nlp = require('compromise');
const { NeuralNetwork } = require('brain.js');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'https://ollama.com';
const OLLAMA_MODEL_PREF = process.env.OLLAMA_MODEL || 'kimi-k2.5:cloud';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

// Kimi K2.5 agent mode config (Moonshot AI — built-in web search)
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.5-preview';

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

    // Axios config for Ollama requests (adds auth header when API key is set)
    this.axiosConfig = OLLAMA_API_KEY
      ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } }
      : {};

    // Cache for frequently accessed data
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes

    // Retry configuration
    this.maxRetries = 3;
    this.baseDelay = 1000; // 1 second
  }

  async initialize() {
    console.log(`[AI Engine] Initializing... (Ollama URL: ${OLLAMA_BASE}, model: ${OLLAMA_MODEL_PREF.substring(0, 20)}..., API key: ${OLLAMA_API_KEY ? 'configured' : 'NOT SET'})`);

    // Check if Ollama is reachable and resolve full model name
    try {
      const res = await this._retryRequest(async () => {
        return axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: 15000, ...this.axiosConfig });
      });

      if (!res.data || !Array.isArray(res.data.models)) {
        throw new Error('Invalid response format from Ollama API');
      }