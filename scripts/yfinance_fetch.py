#!/usr/bin/env python3
"""
yfinance helper script for the Discord bot.
Called from Node.js via child_process. Outputs JSON to stdout.

Usage:
  python3 yfinance_fetch.py quote AAPL
  python3 yfinance_fetch.py quotes AAPL,MSFT,GOOG
  python3 yfinance_fetch.py snapshot AAPL
  python3 yfinance_fetch.py history AAPL 30
  python3 yfinance_fetch.py search "apple inc"
  python3 yfinance_fetch.py trending
"""

import sys
import json
import yfinance as yf


def safe_val(v):
    """Convert numpy/pandas types to JSON-safe Python types."""
    if v is None:
        return None
    try:
        import numpy as np
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            return float(v) if not np.isnan(v) else None
        if isinstance(v, (np.bool_,)):
            return bool(v)
    except ImportError:
        pass
    if isinstance(v, float):
        return None if v != v else v  # NaN check
    return v


def cmd_quote(ticker):
    """Get basic quote data for a single ticker."""
    t = yf.Ticker(ticker)
    info = t.info
    return {
        "symbol": ticker.upper(),
        "shortName": safe_val(info.get("shortName")),
        "longName": safe_val(info.get("longName")),
        "price": safe_val(info.get("regularMarketPrice") or info.get("currentPrice")),
        "previousClose": safe_val(info.get("regularMarketPreviousClose") or info.get("previousClose")),
        "open": safe_val(info.get("regularMarketOpen") or info.get("open")),
        "dayHigh": safe_val(info.get("regularMarketDayHigh") or info.get("dayHigh")),
        "dayLow": safe_val(info.get("regularMarketDayLow") or info.get("dayLow")),
        "volume": safe_val(info.get("regularMarketVolume") or info.get("volume")),
        "marketCap": safe_val(info.get("marketCap")),
        "change": safe_val(info.get("regularMarketChange")),
        "changePercent": safe_val(info.get("regularMarketChangePercent")),
        "pe": safe_val(info.get("trailingPE")),
        "forwardPE": safe_val(info.get("forwardPE")),
        "pb": safe_val(info.get("priceToBook")),
        "eps": safe_val(info.get("trailingEps")),
        "divYield": safe_val(info.get("dividendYield")),
        "beta": safe_val(info.get("beta")),
        "fiftyTwoWeekHigh": safe_val(info.get("fiftyTwoWeekHigh")),
        "fiftyTwoWeekLow": safe_val(info.get("fiftyTwoWeekLow")),
        "fiftyDayAverage": safe_val(info.get("fiftyDayAverage")),
        "twoHundredDayAverage": safe_val(info.get("twoHundredDayAverage")),
    }


def cmd_quotes(tickers_str):
    """Get basic quotes for multiple tickers (comma-separated)."""
    tickers = [t.strip().upper() for t in tickers_str.split(",") if t.strip()]
    results = []
    for ticker in tickers:
        try:
            results.append(cmd_quote(ticker))
        except Exception as e:
            results.append({"symbol": ticker, "error": str(e)})
    return results


def cmd_snapshot(ticker):
    """Get comprehensive snapshot: fundamentals + technicals + price history."""
    t = yf.Ticker(ticker.upper())
    info = t.info

    # Get 200 days of history for technical indicators
    hist = t.history(period="1y")

    # Compute technicals from history
    closes = hist["Close"].dropna().tolist() if not hist.empty else []
    sma50 = round(sum(closes[-50:]) / 50, 2) if len(closes) >= 50 else None
    sma200 = round(sum(closes[-200:]) / 200, 2) if len(closes) >= 200 else None
    rsi14 = _compute_rsi(closes, 14) if len(closes) >= 15 else None

    # Recent 30 days of price history
    recent_hist = []
    if not hist.empty:
        last_30 = hist.tail(30)
        for date, row in last_30.iterrows():
            recent_hist.append({
                "date": date.strftime("%Y-%m-%d"),
                "open": safe_val(row.get("Open")),
                "high": safe_val(row.get("High")),
                "low": safe_val(row.get("Low")),
                "close": safe_val(row.get("Close")),
                "volume": safe_val(row.get("Volume")),
            })

    # Financial data
    roe = safe_val(info.get("returnOnEquity"))
    profit_margin = safe_val(info.get("profitMargins"))
    revenue_growth = safe_val(info.get("revenueGrowth"))

    return {
        "ticker": ticker.upper(),
        "name": safe_val(info.get("shortName") or info.get("longName")),
        "price": safe_val(info.get("regularMarketPrice") or info.get("currentPrice")),
        "previousClose": safe_val(info.get("regularMarketPreviousClose") or info.get("previousClose")),
        "open": safe_val(info.get("regularMarketOpen") or info.get("open")),
        "dayHigh": safe_val(info.get("regularMarketDayHigh") or info.get("dayHigh")),
        "dayLow": safe_val(info.get("regularMarketDayLow") or info.get("dayLow")),
        "volume": safe_val(info.get("regularMarketVolume") or info.get("volume")),
        "marketCap": safe_val(info.get("marketCap")),
        "change": safe_val(info.get("regularMarketChange")),
        "changePercent": safe_val(info.get("regularMarketChangePercent")),

        # Fundamentals
        "pe": safe_val(info.get("trailingPE")),
        "forwardPE": safe_val(info.get("forwardPE")),
        "pb": safe_val(info.get("priceToBook")),
        "eps": safe_val(info.get("trailingEps")),
        "divYield": safe_val(info.get("dividendYield")),
        "roe": round(roe * 100, 2) if roe else None,
        "profitMargin": round(profit_margin * 100, 2) if profit_margin else None,
        "revenueGrowth": round(revenue_growth * 100, 2) if revenue_growth else None,
        "beta": safe_val(info.get("beta")),
        "fiftyTwoWeekHigh": safe_val(info.get("fiftyTwoWeekHigh")),
        "fiftyTwoWeekLow": safe_val(info.get("fiftyTwoWeekLow")),

        # Technicals (computed)
        "sma50": sma50,
        "sma200": sma200,
        "rsi14": rsi14,

        # Price history
        "priceHistory": recent_hist,
    }


def cmd_history(ticker, days=30):
    """Get price history for a ticker."""
    t = yf.Ticker(ticker.upper())
    hist = t.history(period=f"{days}d")
    results = []
    for date, row in hist.iterrows():
        results.append({
            "date": date.strftime("%Y-%m-%d"),
            "open": safe_val(row.get("Open")),
            "high": safe_val(row.get("High")),
            "low": safe_val(row.get("Low")),
            "close": safe_val(row.get("Close")),
            "volume": safe_val(row.get("Volume")),
        })
    return results


def cmd_search(query):
    """Search for tickers by name."""
    results = yf.Search(query)
    quotes = []
    for q in (results.quotes or []):
        if q.get("quoteType") in ("EQUITY", "ETF"):
            quotes.append({
                "symbol": q.get("symbol"),
                "shortName": q.get("shortname") or q.get("longname"),
                "exchange": q.get("exchange"),
                "quoteType": q.get("quoteType"),
            })
    return quotes[:10]


def cmd_trending():
    """Get trending/popular tickers."""
    try:
        trending = yf.Tickers(
            "SPY QQQ AAPL MSFT GOOG AMZN NVDA TSLA META AMD "
            "JPM V MA BA DIS NFLX"
        )
        results = []
        for sym, t in trending.tickers.items():
            try:
                info = t.info
                results.append({
                    "symbol": sym,
                    "shortName": safe_val(info.get("shortName")),
                    "price": safe_val(info.get("regularMarketPrice") or info.get("currentPrice")),
                    "changePercent": safe_val(info.get("regularMarketChangePercent")),
                    "volume": safe_val(info.get("regularMarketVolume") or info.get("volume")),
                    "marketCap": safe_val(info.get("marketCap")),
                })
            except Exception:
                pass
        return results
    except Exception as e:
        return {"error": str(e)}


def _compute_rsi(prices, period=14):
    """Compute RSI from a list of closing prices."""
    if len(prices) < period + 1:
        return None
    gains = 0.0
    losses = 0.0
    for i in range(len(prices) - period, len(prices)):
        diff = prices[i] - prices[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses -= diff
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: yfinance_fetch.py <command> [args...]"}))
        sys.exit(1)

    command = sys.argv[1].lower()

    try:
        if command == "quote" and len(sys.argv) >= 3:
            result = cmd_quote(sys.argv[2])
        elif command == "quotes" and len(sys.argv) >= 3:
            result = cmd_quotes(sys.argv[2])
        elif command == "snapshot" and len(sys.argv) >= 3:
            result = cmd_snapshot(sys.argv[2])
        elif command == "history" and len(sys.argv) >= 3:
            days = int(sys.argv[3]) if len(sys.argv) >= 4 else 30
            result = cmd_history(sys.argv[2], days)
        elif command == "search" and len(sys.argv) >= 3:
            result = cmd_search(sys.argv[2])
        elif command == "trending":
            result = cmd_trending()
        else:
            result = {"error": f"Unknown command: {command}"}
    except Exception as e:
        result = {"error": str(e)}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
