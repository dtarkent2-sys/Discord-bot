const VALIDEA_HOST = 'https://www.validea.com';
const VALIDEA_BASE = `${VALIDEA_HOST}/guru-analysis`;
// Known guru strategies and their common identifiers in Validea's HTML
const GURU_STRATEGIES = [
  { id: 'twin_momentum', guru: 'Dashan Huang', name: 'Twin Momentum Investor', keywords: ['twin momentum'] },
  { id: 'patient_investor', guru: 'Warren Buffett', name: 'Patient Investor', keywords: ['patient investor', 'buffett'] },
  { id: 'pe_growth', guru: 'Peter Lynch', name: 'P/E/Growth Investor', keywords: ['p/e/growth', 'peter lynch', 'lynch'] },
  { id: 'price_sales', guru: 'Kenneth Fisher', name: 'Price/Sales Investor', keywords: ['price/sales', 'kenneth fisher', 'fisher'] },
  { id: 'low_pe', guru: 'John Neff', name: 'Low P/E Investor', keywords: ['low p/e', 'john neff', 'neff'] },
  { id: 'growth_value', guru: "James O'Shaughnessy", name: 'Growth/Value Investor', keywords: ['growth/value', "o'shaughnessy"] },
  { id: 'value_composite', guru: "James O'Shaughnessy", name: 'Value Composite Investor', keywords: ['value composite'] },
  { id: 'book_market', guru: 'Joseph Piotroski', name: 'Book/Market Investor', keywords: ['book/market', 'piotroski'] },
  { id: 'contrarian', guru: 'David Dreman', name: 'Contrarian Investor', keywords: ['contrarian', 'dreman'] },
  { id: 'earnings_yield', guru: 'Joel Greenblatt', name: 'Earnings Yield Investor', keywords: ['earnings yield', 'greenblatt', 'magic formula'] },
  { id: 'pb_growth', guru: 'Partha Mohanram', name: 'P/B Growth Investor', keywords: ['p/b growth', 'mohanram'] },
  { id: 'multi_factor', guru: 'Pim van Vliet', name: 'Multi-Factor Investor', keywords: ['multi-factor', 'van vliet'] },
  { id: 'millennial', guru: "Patrick O'Shaughnessy", name: 'Millennial Investor', keywords: ['millennial'] },
  { id: 'earnings_revision', guru: 'Wayne Thorp', name: 'Earnings Revision Investor', keywords: ['earnings revision', 'thorp'] },
  { id: 'quantitative_momentum', guru: 'Wesley Gray', name: 'Quantitative Momentum Investor', keywords: ['quantitative momentum', 'wesley gray'] },
  { id: 'shareholder_yield', guru: 'Meb Faber', name: 'Shareholder Yield Investor', keywords: ['shareholder yield', 'faber'] },
  { id: 'acquirers_multiple', guru: 'Tobias Carlisle', name: "Acquirer's Multiple Investor", keywords: ["acquirer", 'carlisle'] },
  { id: 'momentum', guru: 'Validea', name: 'Momentum Investor', keywords: ['momentum investor'] },
  { id: 'graham_defensive', guru: 'Benjamin Graham', name: 'Defensive Investor', keywords: ['defensive investor', 'graham'] },
  { id: 'graham_enterprising', guru: 'Benjamin Graham', name: 'Enterprising Investor', keywords: ['enterprising investor'] },
  { id: 'small_cap_growth', guru: 'Motley Fool', name: 'Small-Cap Growth Investor', keywords: ['small-cap growth', 'motley fool'] },
  { id: 'top_gurus', guru: 'Validea', name: 'Top Guru Composite', keywords: ['guru composite', 'top guru'] },
];
// Simple cookie parser — handles basic format
_valideaService._parseCookies = this._parseCookies.bind(_valideaService);
_valideaService._parseCookies(setCookieHeaders);
_valideaService._mergeCookies = this._mergeCookies.bind(_valideaService);
_valideaService._fetchPage = this._fetchPage.bind(_valideaService);
_valideaService._parseScores = this._parseScores.bind(_valideaService);
_valideaService._extractScoresFromJson = this._extractScoresFromJson.bind(_valideaService);
_valideaService._matchStrategy = this._matchStrategy.bind(_valideaService);
_valideaService._buildResult = this._buildResult.bind(_valideaService);
_valideaService._buildFallback = this._buildFallback.bind(_valideaService);
_valideaService._buildFallback = this._buildFallback.bind(_valideaService);
_valideaService.formatForDiscord = this.formatForDiscord.bind(_valideaService);
_valideaService.getScore = this.getScore.bind(_valideaService);
_valideaService.clearCache = this.clearCache.bind(_valideaService);
_valideaService.resetSession = this.resetSession.bind(_valideaService);
(void 0, module.exports) = _valideaService;