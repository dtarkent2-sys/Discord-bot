// Updated _aggregate function with optimized strike clustering
  _aggregate(canonical) {
    // 1) Total net GEX across all expirations
    const totalNetGEX = canonical.expirations.reduce(
      (sum, exp) => sum + exp['netGEX$'], 0
    );

    // 2) By-expiry with share calculation
    const totalAbsGEX = canonical.expirations.reduce(
      (sum, exp) => sum + Math.abs(exp['netGEX$']), 0
    );

    const byExpiry = canonical.expirations.map(exp => ({
      expiry: exp.expiry,
      'netGEX$': exp['netGEX$'],
      absShare: totalAbsGEX > 0 ? Math.abs(exp['netGEX$']) / totalAbsGEX : 0,
    }));

    // 3) Dominant expiry = highest absolute netGEX$ share
    const dominantExpiry = byExpiry.reduce(
      (best, e) => Math.abs(e['netGEX$']) > Math.abs(best['netGEX$']) ? e : best,
      byExpiry[0]
    );

    // 4) Strike clustering: optimize by using object with string keys instead of Map
    const strikeObj = {};
    for (const exp of canonical.expirations) {
      for (const s of exp.strikes) {
        const key = s.strike.toString(); // canonical key format
        if (strikeObj[key]) {
          strikeObj[key].callOI += s.callOI;
          strikeObj[key].putOI += s.putOI;
          strikeObj[key]['callGEX$'] += s['callGEX$'];
          strikeObj[key]['putGEX$'] += s['putGEX$'];
          strikeObj[key]['netGEX$'] += s['netGEX$'];
          strikeObj[key].expiryCount++;
          strikeObj[key].expiries.push(exp.expiry);
        } else {
          strikeObj[key] = {
            strike: s.strike,
            callOI: s.callOI,
            putOI: s.putOI,
            'callGEX$': s['callGEX$'],
            'putGEX$': s['putGEX$'],
            'netGEX$': s['netGEX$'],
            expiryCount: 1,
            expiries: [exp.expiry],
          };
        }
      }
    }

    const byStrike = Object.values(strikeObj).sort((a, b) => a.strike - b.strike);

    return { totalNetGEX, totalAbsGEX, byExpiry, dominantExpiry, byStrike };
  }