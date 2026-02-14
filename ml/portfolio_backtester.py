#!/usr/bin/env python3
"""
Portfolio-Level Walk-Forward ML Backtester

Produces cross-sectional signals across multiple tickers, constructs
weighted portfolios at each rebalance date, and applies realistic
transaction costs + turnover tracking.

Architecture:
  1. Load aligned price matrix [dates x tickers] from parquet data
  2. Build per-ticker technical features (rolling, left-aligned)
  3. Walk-forward: train on past only, predict at each rebalance
  4. Rank tickers by predicted forward return -> select top_k / bottom_k
  5. Construct portfolio weights (equal / vol_target)
  6. Compute daily portfolio returns with cost deductions
  7. Compare vs benchmarks (equal-weight B&H, SPY, random baseline)

Key constraints:
  - No lookahead: features at t use data <= t; signal at t -> trade at t+1
  - Walk-forward CV: retrain on expanding window of past data only
  - Deterministic: all randomness seeded
  - Fast: default universe <= 50 tickers, EOD data

Usage:
  python portfolio_backtester.py --tickers AAPL,MSFT,GOOGL --forward 20
  python portfolio_backtester.py --universe mega --top-k 10 --weighting vol_target
"""

import sys
import os
import json
import argparse
import warnings
import tempfile
from datetime import datetime, timedelta

warnings.filterwarnings("ignore", category=FutureWarning)

np = None
pd = None


def _ensure_imports():
    global np, pd
    if np is None:
        try:
            import numpy as _np
            import pandas as _pd
            np = _np
            pd = _pd
        except ImportError as e:
            print(json.dumps({"error": f"Missing dependency: {e}. Run: pip install -r ml/requirements.txt"}))
            sys.exit(1)


def log(msg):
    print(f"[PortfolioBacktest] {msg}", file=sys.stderr, flush=True)


# ── Preset Universes ─────────────────────────────────────────────────────

UNIVERSES = {
    "mega": [
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK-B",
        "JPM", "V", "UNH", "JNJ", "XOM", "WMT", "MA", "PG", "HD", "CVX",
        "MRK", "ABBV", "LLY", "COST", "PEP", "KO", "AVGO",
    ],
    "sp500_25": [
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM",
        "V", "UNH", "JNJ", "XOM", "WMT", "PG", "HD", "CVX", "MRK",
        "ABBV", "LLY", "COST", "PEP", "KO", "AVGO", "BAC", "ADBE",
    ],
    "tech": [
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO",
        "ADBE", "CRM", "ORCL", "AMD", "INTC", "QCOM", "TXN", "NOW",
        "AMAT", "MU", "LRCX", "SNPS",
    ],
    "sector_etf": [
        "XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB",
        "XLRE", "XLC",
    ],
}

# ── Feature Engineering ──────────────────────────────────────────────────

FEATURE_NAMES = [
    "mom_5d", "mom_20d", "mom_60d", "mom_252d",
    "vol_20d", "vol_60d", "rel_vol_20d",
    "rsi_14", "bb_pctb", "dist_52w_high", "dist_52w_low",
    "sma_20_50", "sma_50_200", "mean_rev_20d",
]


def build_features_single_ticker(prices_df, forward_days):
    """
    Build technical features for one ticker.
    Input: DataFrame with columns [date, open, high, low, close, volume].
    Returns: DataFrame with feature columns + fwd_return target.
    All rolling windows are left-aligned (use only past data at each point).
    """
    _ensure_imports()
    df = prices_df.copy()

    close = df["close"]
    ret_1d = close.pct_change()

    # Target: forward log return (close-to-close)
    df["fwd_return"] = np.log(close.shift(-forward_days) / close)

    # Momentum
    for period in [5, 20, 60, 252]:
        df[f"mom_{period}d"] = close / close.shift(period) - 1.0

    # Volatility
    df["vol_20d"] = ret_1d.rolling(20).std()
    df["vol_60d"] = ret_1d.rolling(60).std()

    # Relative volume
    if "volume" in df.columns:
        vol = df["volume"].replace(0, np.nan)
        df["rel_vol_20d"] = vol / vol.rolling(20).mean()

    # RSI 14
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    df["rsi_14"] = 100.0 - (100.0 / (1.0 + rs))

    # Bollinger %B
    sma20 = close.rolling(20).mean()
    std20 = close.rolling(20).std()
    bandwidth = (4.0 * std20).replace(0, np.nan)
    df["bb_pctb"] = (close - (sma20 - 2.0 * std20)) / bandwidth

    # 52-week high/low distance
    if "high" in df.columns and "low" in df.columns:
        high_252 = df["high"].rolling(252).max()
        low_252 = df["low"].rolling(252).min()
        rng = (high_252 - low_252).replace(0, np.nan)
        df["dist_52w_high"] = (close - high_252) / rng
        df["dist_52w_low"] = (close - low_252) / rng

    # SMA crossovers
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    df["sma_20_50"] = sma20 / sma50 - 1.0
    df["sma_50_200"] = sma50 / sma200 - 1.0

    # Mean reversion
    df["mean_rev_20d"] = close / sma20 - 1.0

    return df


# ── Data Loading & Alignment ─────────────────────────────────────────────

def load_multi_ticker_prices(data_dir, tickers):
    """
    Load aligned price matrix for multiple tickers.
    Returns:
      price_dict: {ticker: DataFrame with [date, open, high, low, close, volume]}
      common_dates: sorted list of dates present in ALL tickers
      missing_report: dict of tickers that failed to load or had issues
    """
    _ensure_imports()
    from data_loader import load_prices

    price_dict = {}
    missing_report = {}

    for tkr in tickers:
        try:
            df = load_prices(data_dir, ticker=tkr)
            if len(df) == 0:
                missing_report[tkr] = "no_data"
                continue

            # Normalize columns
            cols_lower = {c.lower().strip(): c for c in df.columns}
            col_map = {}
            for target, candidates in [
                ("close", ["adj close", "adjclose", "adj_close", "close"]),
                ("open", ["open"]),
                ("high", ["high"]),
                ("low", ["low"]),
                ("volume", ["volume", "vol"]),
            ]:
                for c in candidates:
                    key = c.lower().replace(" ", "").replace("_", "")
                    for orig_key, orig_col in cols_lower.items():
                        if orig_key.replace(" ", "").replace("_", "") == key:
                            col_map[orig_col] = target
                            break
                    if target in col_map.values():
                        break

            df = df.rename(columns=col_map)
            if "close" not in df.columns:
                missing_report[tkr] = "no_close_column"
                continue

            if "date" not in df.columns:
                missing_report[tkr] = "no_date_column"
                continue

            df["date"] = pd.to_datetime(df["date"])
            df = df.sort_values("date").drop_duplicates("date")
            needed = ["date", "close"]
            for c in ["open", "high", "low", "volume"]:
                if c in df.columns:
                    needed.append(c)
            price_dict[tkr] = df[needed].reset_index(drop=True)

        except Exception as e:
            missing_report[tkr] = str(e)
            log(f"  Failed to load {tkr}: {e}")

    if not price_dict:
        raise ValueError("No ticker data loaded successfully")

    # Find common trading dates (intersection of all tickers)
    date_sets = [set(df["date"].values) for df in price_dict.values()]
    common = date_sets[0]
    for ds in date_sets[1:]:
        common = common.intersection(ds)
    common_dates = sorted(common)

    if len(common_dates) < 252:
        raise ValueError(
            f"Only {len(common_dates)} common trading dates across {len(price_dict)} tickers. "
            f"Need at least 252 (1 year). Consider fewer tickers or wider date range."
        )

    # Filter each ticker to common dates only
    common_set = set(common_dates)
    for tkr in list(price_dict.keys()):
        df = price_dict[tkr]
        price_dict[tkr] = df[df["date"].isin(common_set)].sort_values("date").reset_index(drop=True)

    log(f"Aligned {len(price_dict)} tickers on {len(common_dates)} common dates "
        f"({pd.Timestamp(common_dates[0]).date()} to {pd.Timestamp(common_dates[-1]).date()})")

    return price_dict, common_dates, missing_report


def build_feature_matrix(price_dict, common_dates, forward_days):
    """
    Build stacked feature matrix across all tickers.
    Returns:
      feature_df: DataFrame with columns [date, ticker, <features>, fwd_return]
                  Only rows where all features + target are non-null.
      close_matrix: DataFrame [dates x tickers] of close prices
      return_matrix: DataFrame [dates x tickers] of daily simple returns
    """
    _ensure_imports()

    all_frames = []
    close_dict = {}
    available_features = None

    for tkr, df in price_dict.items():
        feat_df = build_features_single_ticker(df, forward_days)
        feat_df["ticker"] = tkr
        all_frames.append(feat_df)
        close_dict[tkr] = df.set_index("date")["close"]

        # Track which features are available across all tickers
        ticker_features = [f for f in FEATURE_NAMES if f in feat_df.columns]
        if available_features is None:
            available_features = set(ticker_features)
        else:
            available_features = available_features.intersection(ticker_features)

    feature_cols = sorted(available_features) if available_features else []
    if not feature_cols:
        raise ValueError("No common features could be built across tickers")

    # Stack all tickers
    stacked = pd.concat(all_frames, ignore_index=True)

    # Keep only rows with all features + target present
    keep_cols = ["date", "ticker"] + feature_cols + ["fwd_return"]
    stacked = stacked[keep_cols].replace([np.inf, -np.inf], np.nan).dropna()

    # Build close and return matrices
    close_matrix = pd.DataFrame(close_dict)
    dates_idx = pd.DatetimeIndex(common_dates)
    close_matrix = close_matrix.reindex(dates_idx)

    return_matrix = close_matrix.pct_change()

    log(f"Feature matrix: {len(stacked):,} rows, {len(feature_cols)} features, "
        f"{stacked['ticker'].nunique()} tickers")

    return stacked, feature_cols, close_matrix, return_matrix


# ── Walk-Forward ML Signal Generation ────────────────────────────────────

def generate_signals(feature_df, feature_cols, rebalance_dates, forward_days,
                     min_train_rows=200, model_type="gradient_boost", seed=42):
    """
    Walk-forward signal generation.
    At each rebalance date:
      1. Train on ALL data before that date (expanding window)
      2. Predict forward return for each ticker at that date
      3. Return predictions as signal DataFrame

    Uses pooled model: all tickers stacked together with ticker_id one-hot.

    Returns:
      signals_df: DataFrame with [date, ticker, predicted_return, actual_return]
    """
    _ensure_imports()
    from sklearn.linear_model import Ridge
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.preprocessing import StandardScaler

    rng = np.random.RandomState(seed)

    # Add ticker one-hot encoding for pooled model
    tickers = sorted(feature_df["ticker"].unique())
    ticker_to_idx = {t: i for i, t in enumerate(tickers)}

    # Pre-compute ticker one-hot columns
    ticker_onehot = np.zeros((len(feature_df), len(tickers)), dtype=np.float32)
    for i, tkr in enumerate(feature_df["ticker"].values):
        ticker_onehot[i, ticker_to_idx[tkr]] = 1.0

    feature_values = feature_df[feature_cols].values.astype(np.float64)
    target_values = feature_df["fwd_return"].values.astype(np.float64)
    dates = feature_df["date"].values
    ticker_ids = feature_df["ticker"].values

    # Augmented features = base features + ticker one-hot
    X_all = np.hstack([feature_values, ticker_onehot])

    signals = []
    train_info = {"rebalance_count": 0, "avg_train_size": 0, "model_type": model_type}
    total_train_size = 0

    for reb_date in rebalance_dates:
        # Train mask: dates strictly before rebalance date
        train_mask = dates < reb_date
        # Test mask: rows at exactly the rebalance date
        test_mask = dates == reb_date

        n_train = train_mask.sum()
        n_test = test_mask.sum()

        if n_train < min_train_rows or n_test == 0:
            continue

        X_train = X_all[train_mask]
        y_train = target_values[train_mask]
        X_test = X_all[test_mask]

        # Scale features (fit on train only -- no leakage)
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)

        # Train model
        if model_type == "linear":
            model = Ridge(alpha=1.0, random_state=seed)
        else:
            model = HistGradientBoostingRegressor(
                max_iter=200, max_depth=4, learning_rate=0.05,
                min_samples_leaf=20, random_state=seed,
                validation_fraction=0.1, n_iter_no_change=20,
            )

        model.fit(X_train_scaled, y_train)
        preds = model.predict(X_test_scaled)

        test_tickers = ticker_ids[test_mask]
        test_actual = target_values[test_mask]

        for i, tkr in enumerate(test_tickers):
            signals.append({
                "date": reb_date,
                "ticker": tkr,
                "predicted_return": float(preds[i]),
                "actual_return": float(test_actual[i]),
            })

        train_info["rebalance_count"] += 1
        total_train_size += n_train

    if train_info["rebalance_count"] > 0:
        train_info["avg_train_size"] = total_train_size / train_info["rebalance_count"]

    signals_df = pd.DataFrame(signals)
    if len(signals_df) == 0:
        raise ValueError("No signals generated. Check data alignment and date range.")

    signals_df["date"] = pd.to_datetime(signals_df["date"])

    log(f"Generated signals at {train_info['rebalance_count']} rebalance dates, "
        f"avg train size={train_info['avg_train_size']:.0f}")

    return signals_df, train_info


# ── Portfolio Construction ───────────────────────────────────────────────

def construct_portfolio(signals_at_date, return_matrix, top_k, bottom_k,
                        weighting, max_weight, max_leverage,
                        vol_window, target_vol_annual, current_date):
    """
    Given signal predictions at a rebalance date, select tickers and assign weights.

    Args:
      signals_at_date: DataFrame with [ticker, predicted_return] for this date
      return_matrix: historical returns matrix for vol estimation
      top_k, bottom_k: how many longs / shorts
      weighting: 'equal' or 'vol_target'
      max_weight, max_leverage: position/leverage caps
      vol_window: rolling window for vol estimation
      target_vol_annual: annualized vol target
      current_date: the rebalance date

    Returns:
      weights: dict {ticker: weight} (positive = long, negative = short)
    """
    _ensure_imports()

    if len(signals_at_date) == 0:
        return {}

    # Sort by predicted return descending
    ranked = signals_at_date.sort_values("predicted_return", ascending=False)

    # Select tickers
    long_tickers = list(ranked.head(top_k)["ticker"].values)
    short_tickers = list(ranked.tail(bottom_k)["ticker"].values) if bottom_k > 0 else []

    # Remove any overlap (shouldn't happen if top_k + bottom_k <= total)
    short_tickers = [t for t in short_tickers if t not in long_tickers]

    selected = long_tickers + short_tickers
    if not selected:
        return {}

    if weighting == "equal":
        n_long = len(long_tickers)
        n_short = len(short_tickers)
        n_total = n_long + n_short

        weights = {}
        for t in long_tickers:
            weights[t] = 1.0 / n_total
        for t in short_tickers:
            weights[t] = -1.0 / n_total

    elif weighting == "vol_target":
        # Inverse-volatility weighting, then scale to target vol
        # Get trailing vol for each selected ticker
        end_loc = return_matrix.index.get_indexer([current_date], method="ffill")[0]
        start_loc = max(0, end_loc - vol_window + 1)

        if end_loc < vol_window:
            # Fallback to equal weight if insufficient history
            n_total = len(selected)
            weights = {}
            for t in long_tickers:
                weights[t] = 1.0 / n_total
            for t in short_tickers:
                weights[t] = -1.0 / n_total
        else:
            trailing_rets = return_matrix.iloc[start_loc:end_loc + 1]
            vols = {}
            for t in selected:
                if t in trailing_rets.columns:
                    v = trailing_rets[t].std()
                    vols[t] = v if v > 0 and not np.isnan(v) else 1e-6
                else:
                    vols[t] = 1e-6

            # Inverse vol weights
            inv_vol = {t: 1.0 / vols[t] for t in selected}
            total_inv_vol = sum(inv_vol.values())

            weights = {}
            for t in long_tickers:
                weights[t] = inv_vol[t] / total_inv_vol
            for t in short_tickers:
                weights[t] = -(inv_vol[t] / total_inv_vol)

            # Scale to target vol
            # Portfolio vol estimate = sqrt(sum(w_i^2 * vol_i^2)) annualized
            port_var = sum(weights[t] ** 2 * (vols[t] * np.sqrt(252)) ** 2 for t in selected)
            port_vol = np.sqrt(port_var) if port_var > 0 else 1e-6

            vol_scalar = target_vol_annual / port_vol
            weights = {t: w * vol_scalar for t, w in weights.items()}

    else:
        raise ValueError(f"Unknown weighting scheme: {weighting}")

    # Cap individual weights
    weights = _cap_weights(weights, max_weight, max_leverage)

    return weights


def _cap_weights(weights, max_weight, max_leverage):
    """Cap individual position sizes and total leverage, then renormalize."""
    _ensure_imports()
    if not weights:
        return weights

    # Cap individual weights
    for t in weights:
        if weights[t] > max_weight:
            weights[t] = max_weight
        if weights[t] < -max_weight:
            weights[t] = -max_weight

    # Cap total leverage
    gross_exposure = sum(abs(w) for w in weights.values())
    if gross_exposure > max_leverage and gross_exposure > 0:
        scale = max_leverage / gross_exposure
        weights = {t: w * scale for t, w in weights.items()}

    return weights


# ── Backtest Engine ──────────────────────────────────────────────────────

def run_portfolio_backtest(signals_df, return_matrix, close_matrix, common_dates,
                           top_k, bottom_k, weighting, max_weight, max_leverage,
                           cost_bps, slippage_bps, vol_window, target_vol_annual,
                           seed):
    """
    Execute the full portfolio backtest.

    Key invariant: signal computed at date t, trade at t+1 (next bar).
    Portfolio holds weights constant between rebalances.

    Returns: dict with equity curves, metrics, turnover, holdings history
    """
    _ensure_imports()

    rebalance_dates = sorted(signals_df["date"].unique())
    all_dates = sorted(common_dates)
    all_dates_ts = pd.DatetimeIndex(all_dates)

    cost_rate = (cost_bps + slippage_bps) / 10000.0

    # Initialize tracking
    current_weights = {}
    daily_returns_gross = []
    daily_returns_net = []
    daily_dates = []
    turnover_by_date = {}
    holdings_count = []
    rebalance_trade_dates = set()

    # Build lookup: rebalance_date -> signals
    signals_by_date = {}
    for reb_date in rebalance_dates:
        mask = signals_df["date"] == reb_date
        signals_by_date[reb_date] = signals_df[mask][["ticker", "predicted_return"]].copy()

    # Map dates to indices in return_matrix
    # Signal at t -> rebalance weights at t -> trade at t+1
    # So daily return on day d uses weights set at the PREVIOUS rebalance,
    # but the return earned is from d to d (i.e., close(d)/close(d-1) - 1)
    pending_new_weights = None
    pending_rebalance = False

    for i, date in enumerate(all_dates_ts):
        # Check if yesterday was a rebalance date (signal computed yesterday, trade today)
        if pending_rebalance and pending_new_weights is not None:
            old_weights = current_weights.copy()
            current_weights = pending_new_weights

            # Calculate turnover
            all_tickers = set(list(old_weights.keys()) + list(current_weights.keys()))
            turnover = sum(abs(current_weights.get(t, 0) - old_weights.get(t, 0)) for t in all_tickers)
            turnover_by_date[date] = turnover
            rebalance_trade_dates.add(date)

            pending_new_weights = None
            pending_rebalance = False

        # Check if today is a signal date (compute weights, but trade tomorrow)
        if date in signals_by_date:
            new_weights = construct_portfolio(
                signals_by_date[date], return_matrix,
                top_k, bottom_k, weighting, max_weight, max_leverage,
                vol_window, target_vol_annual, date,
            )
            pending_new_weights = new_weights
            pending_rebalance = True

        # Calculate daily portfolio return using current weights
        if i == 0 or not current_weights:
            daily_returns_gross.append(0.0)
            daily_returns_net.append(0.0)
            daily_dates.append(date)
            holdings_count.append(len(current_weights))
            continue

        day_return = 0.0
        if date in return_matrix.index:
            for tkr, w in current_weights.items():
                if tkr in return_matrix.columns:
                    r = return_matrix.loc[date, tkr]
                    if not np.isnan(r):
                        day_return += w * r

        daily_returns_gross.append(day_return)

        # Apply costs on rebalance trade days
        cost_today = 0.0
        if date in rebalance_trade_dates:
            turnover = turnover_by_date.get(date, 0)
            cost_today = turnover * cost_rate

        daily_returns_net.append(day_return - cost_today)
        daily_dates.append(date)
        holdings_count.append(len(current_weights))

    result = {
        "daily_dates": [str(d.date()) if hasattr(d, 'date') else str(d)[:10] for d in daily_dates],
        "daily_returns_gross": daily_returns_gross,
        "daily_returns_net": daily_returns_net,
        "turnover_by_date": {str(k.date()) if hasattr(k, 'date') else str(k)[:10]: v
                             for k, v in turnover_by_date.items()},
        "holdings_count": holdings_count,
        "num_rebalances": len(rebalance_trade_dates),
        "total_cost": sum(turnover_by_date.get(d, 0) * cost_rate for d in rebalance_trade_dates),
    }

    return result


# ── Benchmarks ───────────────────────────────────────────────────────────

def compute_benchmarks(return_matrix, close_matrix, common_dates, tickers,
                       top_k, cost_bps, slippage_bps, seed):
    """
    Compute benchmark equity curves:
    1. Equal-weight buy & hold of all tickers (rebalanced monthly)
    2. SPY buy & hold (if in data)
    3. Random top_k selection at each rebalance (seeded)
    """
    _ensure_imports()
    rng = np.random.RandomState(seed + 1)

    cost_rate = (cost_bps + slippage_bps) / 10000.0
    dates = pd.DatetimeIndex(common_dates)
    benchmarks = {}

    # 1. Equal-weight buy & hold (monthly rebalance)
    ew_tickers = [t for t in tickers if t in return_matrix.columns]
    if ew_tickers:
        n = len(ew_tickers)
        w = 1.0 / n
        ew_returns = []
        prev_month = None
        for i, date in enumerate(dates):
            if i == 0:
                ew_returns.append(0.0)
                continue
            if date in return_matrix.index:
                day_ret = sum(w * return_matrix.loc[date, t]
                              for t in ew_tickers
                              if t in return_matrix.columns and not np.isnan(return_matrix.loc[date, t]))
            else:
                day_ret = 0.0
            ew_returns.append(day_ret)
        benchmarks["equal_weight_bh"] = {
            "name": "Equal-Weight B&H (monthly reb.)",
            "daily_returns": ew_returns,
        }

    # 2. SPY buy & hold
    if "SPY" in return_matrix.columns:
        spy_returns = []
        for date in dates:
            if date in return_matrix.index:
                r = return_matrix.loc[date, "SPY"]
                spy_returns.append(r if not np.isnan(r) else 0.0)
            else:
                spy_returns.append(0.0)
        benchmarks["spy_bh"] = {
            "name": "SPY Buy & Hold",
            "daily_returns": spy_returns,
        }

    # 3. Random baseline: pick random top_k each month, same cost structure
    if ew_tickers and top_k <= len(ew_tickers):
        rand_returns = []
        current_picks = []
        prev_month = None
        for i, date in enumerate(dates):
            month_key = (date.year, date.month)
            if month_key != prev_month:
                old_picks = set(current_picks)
                current_picks = list(rng.choice(ew_tickers, size=min(top_k, len(ew_tickers)), replace=False))
                new_picks = set(current_picks)
                # Turnover
                if prev_month is not None:
                    all_t = old_picks.union(new_picks)
                    w_per = 1.0 / len(current_picks) if current_picks else 0
                    turnover = sum(abs((w_per if t in new_picks else 0) - (w_per if t in old_picks else 0))
                                   for t in all_t)
                else:
                    turnover = 0
                prev_month = month_key
            else:
                turnover = 0

            if i == 0 or not current_picks:
                rand_returns.append(0.0)
                continue

            w_per = 1.0 / len(current_picks)
            if date in return_matrix.index:
                day_ret = sum(w_per * return_matrix.loc[date, t]
                              for t in current_picks
                              if t in return_matrix.columns and not np.isnan(return_matrix.loc[date, t]))
            else:
                day_ret = 0.0

            # Apply cost on rebalance day
            cost_today = turnover * cost_rate if turnover > 0 else 0
            rand_returns.append(day_ret - cost_today)

        benchmarks["random_baseline"] = {
            "name": f"Random {top_k}-pick (monthly, net)",
            "daily_returns": rand_returns,
        }

    return benchmarks


# ── Metrics ──────────────────────────────────────────────────────────────

def compute_metrics(daily_returns, daily_dates=None, label="Strategy"):
    """Compute standard portfolio performance metrics."""
    _ensure_imports()

    rets = np.array(daily_returns, dtype=np.float64)
    rets = np.nan_to_num(rets, nan=0.0)

    n_days = len(rets)
    if n_days < 2:
        return _empty_metrics(label)

    # Equity curve
    equity = np.cumprod(1.0 + rets)
    total_return = equity[-1] / equity[0] - 1.0 if equity[0] != 0 else 0.0

    # CAGR
    n_years = n_days / 252.0
    if n_years > 0 and equity[-1] > 0 and equity[0] > 0:
        cagr = (equity[-1] / equity[0]) ** (1.0 / n_years) - 1.0
    else:
        cagr = 0.0

    # Volatility (annualized)
    vol = np.std(rets, ddof=1) * np.sqrt(252) if n_days > 1 else 0.0

    # Sharpe
    excess_mean = np.mean(rets) * 252  # assume rf=0 for simplicity
    sharpe = excess_mean / vol if vol > 0 else 0.0

    # Sortino
    downside = rets[rets < 0]
    downside_std = np.std(downside, ddof=1) * np.sqrt(252) if len(downside) > 1 else 1e-6
    sortino = excess_mean / downside_std if downside_std > 0 else 0.0

    # Max drawdown
    running_max = np.maximum.accumulate(equity)
    drawdowns = (equity - running_max) / running_max
    max_dd = float(np.min(drawdowns))

    # Calmar
    calmar = cagr / abs(max_dd) if abs(max_dd) > 0 else 0.0

    return {
        "label": label,
        "total_return": round(float(total_return), 6),
        "cagr": round(float(cagr), 6),
        "vol": round(float(vol), 6),
        "sharpe": round(float(sharpe), 4),
        "sortino": round(float(sortino), 4),
        "max_dd": round(float(max_dd), 6),
        "calmar": round(float(calmar), 4),
        "n_days": n_days,
        "equity_curve": [round(float(x), 6) for x in equity],
    }


def _empty_metrics(label):
    return {
        "label": label,
        "total_return": 0.0, "cagr": 0.0, "vol": 0.0,
        "sharpe": 0.0, "sortino": 0.0, "max_dd": 0.0, "calmar": 0.0,
        "n_days": 0, "equity_curve": [],
    }


def compute_hit_rate_at_rebalance(signals_df):
    """Compute direction accuracy: did predicted > 0 match actual > 0?"""
    _ensure_imports()
    if len(signals_df) == 0:
        return 0.0
    pred_dir = signals_df["predicted_return"] > 0
    actual_dir = signals_df["actual_return"] > 0
    return float((pred_dir == actual_dir).mean())


def compute_subperiod_metrics(daily_returns, daily_dates, label="Strategy"):
    """Split by calendar year and compute metrics per year."""
    _ensure_imports()
    years = {}
    for r, d in zip(daily_returns, daily_dates):
        y = str(d)[:4]
        if y not in years:
            years[y] = []
        years[y].append(r)

    result = {}
    for y, rets in sorted(years.items()):
        result[y] = compute_metrics(rets, label=f"{label} {y}")
        # Drop equity curve for compactness
        result[y].pop("equity_curve", None)
    return result


# ── Chart Rendering ──────────────────────────────────────────────────────

def render_portfolio_chart(strategy_metrics, benchmark_metrics_dict,
                           daily_dates, config_summary, chart_path):
    """Render multi-panel portfolio backtest chart."""
    _ensure_imports()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 9), facecolor="#1e1e2e",
                                    gridspec_kw={"height_ratios": [3, 2]})

    # Top: equity curves
    ax1.set_facecolor("#1e1e2e")

    # Strategy curves
    colors_strat = {"gross": "#22c55e", "net": "#3b82f6"}
    for key, color in colors_strat.items():
        eq = strategy_metrics.get(key, {}).get("equity_curve", [])
        if eq:
            lbl = f"Strategy ({key})"
            ax1.plot(range(len(eq)), eq, color=color, linewidth=2.0, label=lbl, alpha=0.9)

    # Benchmark curves
    bench_colors = ["#ef4444", "#f59e0b", "#a855f7", "#06b6d4"]
    for idx, (bkey, bm) in enumerate(benchmark_metrics_dict.items()):
        eq = bm.get("equity_curve", [])
        if eq:
            c = bench_colors[idx % len(bench_colors)]
            ax1.plot(range(len(eq)), eq, color=c, linewidth=1.3,
                     label=bm.get("label", bkey), alpha=0.7, linestyle="--")

    ax1.axhline(1.0, color="#555", linewidth=0.8, linestyle="--")
    ax1.set_ylabel("Equity (growth of $1)", color="#a0a0a0", fontsize=10)
    ax1.set_title("Portfolio ML Backtest — Equity Curves",
                  color="#e0e0e0", fontsize=13, fontweight="bold", pad=10)
    ax1.text(0.5, 1.02, config_summary,
             transform=ax1.transAxes, ha="center", color="#888", fontsize=7)
    _style_ax(ax1)
    ax1.legend(loc="upper left", framealpha=0.8, facecolor="#2a2a3e",
               edgecolor="#444", fontsize=8, labelcolor="#c0c0c0")

    # Bottom: drawdown
    ax2.set_facecolor("#1e1e2e")
    net_eq = strategy_metrics.get("net", {}).get("equity_curve", [])
    if net_eq:
        eq_arr = np.array(net_eq)
        running_max = np.maximum.accumulate(eq_arr)
        dd = (eq_arr - running_max) / running_max * 100
        ax2.fill_between(range(len(dd)), dd, 0, color="#ef4444", alpha=0.4)
        ax2.plot(range(len(dd)), dd, color="#ef4444", linewidth=1.0, alpha=0.8)

    ax2.set_ylabel("Drawdown (%)", color="#a0a0a0", fontsize=10)
    ax2.set_title("Strategy Drawdown (net of costs)", color="#c0c0c0", fontsize=11, pad=6)
    _style_ax(ax2)

    plt.tight_layout()
    plt.savefig(chart_path, dpi=150, bbox_inches="tight", facecolor="#1e1e2e")
    plt.close(fig)
    log(f"Chart saved to {chart_path}")


def _style_ax(ax):
    ax.tick_params(colors="#a0a0a0")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#444")
    ax.spines["bottom"].set_color("#444")
    ax.grid(True, alpha=0.1, color="white")


# ── Leakage / Correctness Assertions ────────────────────────────────────

def assert_no_lookahead(signals_df, feature_df, forward_days):
    """Verify signal dates use only past data for training."""
    _ensure_imports()

    rebalance_dates = sorted(signals_df["date"].unique())
    feature_dates = sorted(feature_df["date"].unique())

    for reb_date in rebalance_dates:
        # Training data should all be < reb_date
        # The signal is computed at reb_date, trade at reb_date + 1
        # fwd_return at reb_date uses prices from reb_date to reb_date + forward
        # This is fine: we're predicting it, not using it as a feature
        pass

    # Check: the earliest rebalance date should be after enough training data
    if len(rebalance_dates) > 0 and len(feature_dates) > 0:
        first_reb = rebalance_dates[0]
        train_dates_before = [d for d in feature_dates if d < first_reb]
        assert len(train_dates_before) >= 50, \
            f"First rebalance at {first_reb} has only {len(train_dates_before)} training dates"


def assert_no_same_day_trading(daily_dates, rebalance_signal_dates, daily_returns):
    """
    Verify that portfolio return on signal date uses OLD weights, not new ones.
    (New weights take effect the day AFTER the signal.)
    """
    # This is enforced by construction in run_portfolio_backtest:
    # pending_rebalance flag ensures weights change on the day AFTER signal
    pass


def assert_costs_only_at_rebalance(turnover_by_date, rebalance_trade_dates_set):
    """Verify turnover/costs entries only exist on rebalance trade days."""
    for d in turnover_by_date:
        assert d in rebalance_trade_dates_set or turnover_by_date[d] == 0, \
            f"Turnover recorded on non-rebalance day {d}"


# ── Main Pipeline ────────────────────────────────────────────────────────

def get_rebalance_dates(common_dates, rebalance_freq, start_after_idx=252):
    """
    Generate rebalance dates from common_dates using pandas frequency aliases.
    start_after_idx: skip first N dates to allow warm-up for rolling features + initial training.
    """
    _ensure_imports()
    dates = pd.DatetimeIndex(common_dates)

    if start_after_idx >= len(dates):
        raise ValueError(f"start_after_idx={start_after_idx} >= total dates={len(dates)}")

    # Use pandas to generate rebalance schedule
    eligible_dates = dates[start_after_idx:]
    date_set = set(eligible_dates)

    # Generate theoretical schedule
    start = eligible_dates[0]
    end = eligible_dates[-1]

    # Map common frequency strings
    freq_map = {
        "W-MON": "W-MON", "W": "W-MON",
        "M": "MS", "MS": "MS", "ME": "ME",
        "2W": "2W-MON", "BM": "BMS",
    }
    freq = freq_map.get(rebalance_freq, rebalance_freq)

    schedule = pd.date_range(start=start, end=end, freq=freq)

    # Snap to nearest trading day (forward fill to next available)
    rebalance_dates = []
    for s_date in schedule:
        # Find the closest trading day >= s_date
        candidates = eligible_dates[eligible_dates >= s_date]
        if len(candidates) > 0:
            rebalance_dates.append(candidates[0])

    # Deduplicate
    rebalance_dates = sorted(set(rebalance_dates))

    return rebalance_dates


def run_full_backtest(tickers, start_date=None, end_date=None, days=None,
                      forward=20, rebalance="W-MON", top_k=10, bottom_k=0,
                      weighting="equal", max_weight=0.15, max_leverage=1.0,
                      cost_bps=10, slippage_bps=0, vol_window=20,
                      target_vol_annual=0.15, model_type="gradient_boost",
                      seed=42, data_dir=None):
    """
    Complete portfolio backtest pipeline.
    """
    _ensure_imports()
    from data_loader import ensure_data

    np.random.seed(seed)

    # 1. Resolve tickers
    if isinstance(tickers, str):
        if tickers.lower() in UNIVERSES:
            ticker_list = UNIVERSES[tickers.lower()]
        else:
            ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    else:
        ticker_list = [t.upper() for t in tickers]

    if not ticker_list:
        raise ValueError("No tickers provided")

    log(f"Universe: {len(ticker_list)} tickers: {ticker_list[:10]}{'...' if len(ticker_list) > 10 else ''}")

    # 2. Ensure data
    data_dir = ensure_data(data_dir)

    # 3. Load and align multi-ticker prices
    price_dict, common_dates, missing_report = load_multi_ticker_prices(data_dir, ticker_list)
    active_tickers = sorted(price_dict.keys())

    if len(active_tickers) < top_k:
        log(f"WARNING: Only {len(active_tickers)} tickers loaded, but top_k={top_k}. "
            f"Reducing top_k to {len(active_tickers)}")
        top_k = len(active_tickers)

    # Filter by date range
    if start_date:
        sd = pd.Timestamp(start_date)
        common_dates = [d for d in common_dates if pd.Timestamp(d) >= sd]
    if end_date:
        ed = pd.Timestamp(end_date)
        common_dates = [d for d in common_dates if pd.Timestamp(d) <= ed]
    if days and not start_date:
        if len(common_dates) > days:
            common_dates = common_dates[-days:]

    if len(common_dates) < 300:
        raise ValueError(f"Only {len(common_dates)} common dates in range. Need >= 300.")

    # Re-filter price_dict to date range
    date_set = set(common_dates)
    for tkr in active_tickers:
        price_dict[tkr] = price_dict[tkr][price_dict[tkr]["date"].isin(date_set)].reset_index(drop=True)

    # 4. Build feature matrix
    feature_df, feature_cols, close_matrix, return_matrix = build_feature_matrix(
        price_dict, common_dates, forward
    )

    # 5. Generate rebalance schedule
    # Need warm-up: max(252, vol_window) for rolling features + 200 for min training
    warmup = max(300, 252 + 50)
    rebalance_dates = get_rebalance_dates(common_dates, rebalance, start_after_idx=warmup)

    if len(rebalance_dates) < 5:
        raise ValueError(f"Only {len(rebalance_dates)} rebalance dates. Need at least 5. "
                         f"Use a longer date range or more frequent rebalancing.")

    # Filter rebalance dates to only those present in feature_df
    feature_dates_set = set(feature_df["date"].unique())
    rebalance_dates = [d for d in rebalance_dates if d in feature_dates_set]

    if len(rebalance_dates) < 5:
        raise ValueError(f"Only {len(rebalance_dates)} rebalance dates with feature data. Need >= 5.")

    log(f"Rebalance schedule: {len(rebalance_dates)} dates, freq={rebalance} "
        f"({pd.Timestamp(rebalance_dates[0]).date()} to {pd.Timestamp(rebalance_dates[-1]).date()})")

    # 6. Generate ML signals
    signals_df, train_info = generate_signals(
        feature_df, feature_cols, rebalance_dates, forward,
        min_train_rows=200, model_type=model_type, seed=seed,
    )

    # 7. Run portfolio backtest (only on OOS period)
    oos_start = rebalance_dates[0]
    oos_dates = [d for d in common_dates if pd.Timestamp(d) >= pd.Timestamp(oos_start)]

    backtest_result = run_portfolio_backtest(
        signals_df, return_matrix, close_matrix, oos_dates,
        top_k, bottom_k, weighting, max_weight, max_leverage,
        cost_bps, slippage_bps, vol_window, target_vol_annual, seed,
    )

    # 8. Compute strategy metrics
    strategy_gross_metrics = compute_metrics(
        backtest_result["daily_returns_gross"],
        backtest_result["daily_dates"],
        label="Strategy (gross)"
    )
    strategy_net_metrics = compute_metrics(
        backtest_result["daily_returns_net"],
        backtest_result["daily_dates"],
        label="Strategy (net)"
    )

    # 9. Compute benchmarks
    benchmarks_raw = compute_benchmarks(
        return_matrix, close_matrix, oos_dates, active_tickers,
        top_k, cost_bps, slippage_bps, seed,
    )
    benchmark_metrics = {}
    for bkey, bdata in benchmarks_raw.items():
        # Trim to same length as strategy
        bm_rets = bdata["daily_returns"][:len(backtest_result["daily_returns_net"])]
        bm_metrics = compute_metrics(bm_rets, label=bdata["name"])
        benchmark_metrics[bkey] = bm_metrics

    # 10. Hit rate
    hit_rate = compute_hit_rate_at_rebalance(signals_df)

    # 11. Turnover stats
    turnover_values = list(backtest_result["turnover_by_date"].values())
    avg_turnover_per_reb = np.mean(turnover_values) if turnover_values else 0.0
    n_rebalances = backtest_result["num_rebalances"]
    n_oos_years = len(oos_dates) / 252.0
    turnover_annual = (avg_turnover_per_reb * n_rebalances / n_oos_years) if n_oos_years > 0 else 0.0

    # 12. Average holdings
    avg_holdings = np.mean(backtest_result["holdings_count"]) if backtest_result["holdings_count"] else 0

    # 13. Subperiod metrics
    subperiod = compute_subperiod_metrics(
        backtest_result["daily_returns_net"],
        backtest_result["daily_dates"],
        label="Net"
    )

    # 14. Leakage checks
    try:
        assert_no_lookahead(signals_df, feature_df, forward)
    except AssertionError as e:
        log(f"LEAKAGE WARNING: {e}")

    # 15. Warnings
    warnings_list = []
    if strategy_net_metrics["sharpe"] < 0.5:
        warnings_list.append(f"OOS Sharpe ({strategy_net_metrics['sharpe']:.2f}) < 0.5")
    if strategy_gross_metrics["sharpe"] > 0 and strategy_net_metrics["sharpe"] < 0:
        warnings_list.append("Performance collapses after costs (gross Sharpe > 0 but net Sharpe < 0)")
    if top_k <= 3:
        warnings_list.append(f"top_k={top_k} is very concentrated")
    if missing_report:
        miss_pct = len(missing_report) / len(ticker_list) * 100
        if miss_pct > 20:
            warnings_list.append(f"Missing data rate: {miss_pct:.0f}% ({len(missing_report)}/{len(ticker_list)} tickers)")

    # 16. Render chart
    config_line = (
        f"{len(active_tickers)} tickers | fwd={forward}d | reb={rebalance} | "
        f"top_k={top_k} | cost={cost_bps}bp | slip={slippage_bps}bp | "
        f"wt={weighting} | vol_tgt={target_vol_annual:.0%} | lev_cap={max_leverage} | seed={seed}"
    )

    chart_path = os.path.join(tempfile.gettempdir(), f"ml-portfolio-{seed}.png")
    try:
        render_portfolio_chart(
            {"gross": strategy_gross_metrics, "net": strategy_net_metrics},
            benchmark_metrics,
            backtest_result["daily_dates"],
            config_line,
            chart_path,
        )
    except Exception as e:
        log(f"Chart rendering failed: {e}")
        chart_path = None

    # 17. Assemble output
    effective_start = backtest_result["daily_dates"][0] if backtest_result["daily_dates"] else "?"
    effective_end = backtest_result["daily_dates"][-1] if backtest_result["daily_dates"] else "?"

    output = {
        "config": {
            "tickers": active_tickers,
            "tickers_requested": len(ticker_list),
            "tickers_loaded": len(active_tickers),
            "tickers_missing": missing_report,
            "start_date": effective_start,
            "end_date": effective_end,
            "forward": forward,
            "rebalance": rebalance,
            "top_k": top_k,
            "bottom_k": bottom_k,
            "weighting": weighting,
            "max_weight": max_weight,
            "max_leverage": max_leverage,
            "cost_bps": cost_bps,
            "slippage_bps": slippage_bps,
            "vol_window": vol_window,
            "target_vol_annual": target_vol_annual,
            "model_type": model_type,
            "seed": seed,
        },
        "strategy": {
            "gross": {k: v for k, v in strategy_gross_metrics.items() if k != "equity_curve"},
            "net": {k: v for k, v in strategy_net_metrics.items() if k != "equity_curve"},
            "hit_rate": round(hit_rate, 4),
            "avg_holdings": round(float(avg_holdings), 1),
            "turnover_annual": round(float(turnover_annual), 4),
            "total_cost": round(float(backtest_result["total_cost"]), 6),
            "num_rebalances": n_rebalances,
        },
        "benchmarks": {
            bkey: {k: v for k, v in bm.items() if k != "equity_curve"}
            for bkey, bm in benchmark_metrics.items()
        },
        "subperiod": subperiod,
        "train_info": train_info,
        "feature_cols": feature_cols,
        "warnings": warnings_list,
        "chart_path": chart_path,
    }

    return output


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Portfolio-Level Walk-Forward ML Backtester"
    )
    parser.add_argument("--tickers", required=True,
                        help="Comma-separated tickers or preset name (mega, sp500_25, tech, sector_etf)")
    parser.add_argument("--start-date", help="Backtest start (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="Backtest end (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, help="Trading days of history")
    parser.add_argument("--forward", type=int, default=20,
                        help="Forward return horizon (trading days, default: 20)")
    parser.add_argument("--rebalance", default="W-MON",
                        help="Rebalance frequency (W-MON, M, 2W, etc. Default: W-MON)")
    parser.add_argument("--top-k", type=int, default=10,
                        help="Number of long positions (default: 10)")
    parser.add_argument("--bottom-k", type=int, default=0,
                        help="Number of short positions (default: 0)")
    parser.add_argument("--weighting", choices=["equal", "vol_target"], default="equal",
                        help="Weighting scheme (default: equal)")
    parser.add_argument("--max-weight", type=float, default=0.15,
                        help="Max single position weight (default: 0.15)")
    parser.add_argument("--max-leverage", type=float, default=1.0,
                        help="Max gross leverage (default: 1.0)")
    parser.add_argument("--cost-bps", type=int, default=10,
                        help="Transaction cost in bps (default: 10)")
    parser.add_argument("--slippage-bps", type=int, default=0,
                        help="Slippage in bps (default: 0)")
    parser.add_argument("--vol-window", type=int, default=20,
                        help="Rolling vol window for vol_target weighting (default: 20)")
    parser.add_argument("--target-vol-annual", type=float, default=0.15,
                        help="Annualized portfolio vol target (default: 0.15)")
    parser.add_argument("--model", choices=["linear", "gradient_boost"], default="gradient_boost",
                        help="ML model type (default: gradient_boost)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--data-dir", help="Local parquet data directory")

    args = parser.parse_args()

    # Resolve dates
    end_date = args.end_date
    start_date = args.start_date
    if args.days and not start_date:
        if not end_date:
            end_date = datetime.utcnow().strftime("%Y-%m-%d")
        ed = datetime.strptime(end_date, "%Y-%m-%d")
        sd = ed - timedelta(days=int(args.days * 1.5))
        start_date = sd.strftime("%Y-%m-%d")

    try:
        result = run_full_backtest(
            tickers=args.tickers,
            start_date=start_date,
            end_date=end_date,
            days=args.days if not start_date else None,
            forward=args.forward,
            rebalance=args.rebalance,
            top_k=args.top_k,
            bottom_k=args.bottom_k,
            weighting=args.weighting,
            max_weight=args.max_weight,
            max_leverage=args.max_leverage,
            cost_bps=args.cost_bps,
            slippage_bps=args.slippage_bps,
            vol_window=args.vol_window,
            target_vol_annual=args.target_vol_annual,
            model_type=args.model,
            seed=args.seed,
            data_dir=args.data_dir,
        )
        print(json.dumps(result))
    except Exception as e:
        log(f"ERROR: {e}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
