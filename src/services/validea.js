const ValideaBase = (() => {
  const strategies = [
    { id: 'twin_momentum', keywords: ['twin momentum'] },
    { id: 'patient_investor', keywords: ['patient investor', 'buffett'] },
    { id: 'pe_growth', keywords: ['p/e/growth', 'peter lynch', 'lynch'] },
    { id: 'price_sales', keywords: ['price/sales', 'kenneth fisher', 'fisher'] },
    { id: 'low_pe', keywords: ['low p/e', 'john neff', 'neff'] },
    { id: 'growth_value', keywords: ['growth/value', "o'shaughnessy"] },
    { id: 'value_composite', keywords: ['value composite'] },
    { id: 'book_market', keywords: ['book/market', 'piotroski'] },
    { id: 'contrarian', keywords: ['contrarian', 'dreman'] },
    { id: 'earnings_yield', keywords: ['earnings yield', 'greenblatt', 'magic formula'] },
    { id: 'pb_growth', keywords: ['p/b growth', 'mohanram'] },
    { id: 'multi_factor', keywords: ['multi-factor', 'van vliet'] },
    { id: 'millennial', keywords: ['millennial'] },
    { id: 'earnings_revision', keywords: ['earnings revision', 'thorp'] },
    { id: 'quantitative_momentum', keywords: ['quantitative momentum', 'wesley gray'] },
    { id: 'shareholder_yield', keywords: ['shareholder yield', 'faber'] },
    { id: 'acquirers_multiple', keywords: ["acquirer", 'carlisle'] },
    { id: 'momentum', keywords: ['momentum investor'] },
    { id: 'graham_defensive', keywords: ['defensive investor', 'graham'] },
    { id: 'graham_enterprising', keywords: ['enterprising investor'] },
    { id: 'small_cap_growth', keywords: ['small-cap growth', 'motley fool'] },
    { id: 'top_gurus', keywords: ['guru composite', 'top guru'] },
  ];

  const normalize = (s) => s.toLowerCase();

  const findStrategy = (text) => {
    const lower = normalize(text);
    for (const strat of strategies) {
      for (const kw of strat.keywords) {
        if (lower.includes(normalize(kw))) return strat;
      }
    }
    return null;
  };

  const containsScore = (text) => /\d{1,3}\s*%/.test(text);

  const extractScores = (html = '') => {
    const scores = [];
    const blocks = html
      .replace(/<\/tr>/g, '\n')
      .replace(/<\/div>/g, '\n')
      .replace(/<\/li>/g, '\n')
      .replace(/<br\s*\/?>/g, '\n');
    for (const strat of strategies) {
      for (const kw of strat.keywords) {
        const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
          new RegExp(`${esc}[^\\n]{0,200}?(\\d{1,3})\\s*%`, 'i'),
          new RegExp(`(\\d{1,3})\\s*%[^\\n]{0,100}?${esc}`, 'i'),
          new RegExp(`${esc}[^\\n]{0,200}?score[^\\d]{0,20}(\\d{1,3})`, 'i'),
        ];
        for (const pat of patterns) {
          const match = blocks.match(pat);
          if (match) {
            const score = parseInt(match[1], 10);
            if (score >= 0 && score <= 100) {
              scores.push({
                id: strat.id,
                guru: strat.id.split('_')[0],
                name: strat.id,
                score,
                interest: score >= 90 ? 'Strong Interest' : score >= 80 ? 'Some Interest' : score >= 60 ? 'Neutral' : 'Fail',
                indicator: score >= 90 ? '[++]' : score >= 80 ? '[+ ]' : score >= 60 ? '[ +]' : '[--]',
              });
              break;
            }
          }
        }
        if (scores.find(s => s.id === strat.id)) break;
      }
    }
    return scores.slice(0, 8);
  };

  return { extractScores };
})();

module.exports = ValideaBase;