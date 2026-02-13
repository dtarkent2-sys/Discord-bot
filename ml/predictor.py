#!/usr/bin/env python3
"""
ML Trading Predictor — Stock Backtest on Local Parquet Data

Uses 30 years of EOD pricing + financial fundamentals stored as parquet files
(auto-downloaded from Google Drive on first use). Trains scikit-learn models
with walk-forward chronological split to predict forward returns.

Data sources (parquet):
  - all_prices_yahoo.parquet   — EOD prices (OHLCV) for all tickers
  - all_balance_sheets.parquet — Balance sheet items
  - all_income_statements.parquet — Income statement items
  - all_cash_flow.parquet      — Cash flow items

Technical features (from EOD prices):
  - Momentum: 5d, 20d, 60d, 252d returns
  - Volatility: 20d, 60d rolling std of returns
  - Volume: 20d relative volume ratio
  - RSI (14-day)
  - Bollinger Band %B (20d)
  - Distance from 52-week high / low
  - SMA crossovers: 20/50, 50/200

Fundamental features (from financials, if available):
  - Revenue growth (YoY)
  - Net margin, gross margin
  - ROE, ROA
  - Debt-to-equity
  - Current ratio
  - Free cash flow yield

Models:
  - Linear Regression (baseline)
  - HistGradientBoostingRegressor (non-linear)

Split: Walk-forward chronological (70% train / 30% test). No leakage.

Usage:
  python predictor.py --ticker AAPL --days 1260        # 5 years
  python predictor.py --ticker MSFT --forward 20       # predict 20-day return
  python predictor.py --ticker SPY --start-date 2020-01-01 --end-date 2025-12-31
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

DEFAULT_FORWARD = 20        # predict 20-day forward return
DEFAULT_DAYS = 1260         # ~5 years of trading days
DEFAULT_TRAIN_SPLIT = 0.70
MAX_DAYS_DEFAULT = 10000    # ~40 years — allow full history

def log(msg):
    print(f"[ML-Predictor] {msg}", file=sys.stderr, flush=True)


# ── Feature Engineering ──────────────────────────────────────────────────

def build_technical_features(df, forward_days=20):
    """
    Build technical features from EOD price data.
    Expects columns: date, open, high, low, close, volume (lowercase).
    Returns DataFrame with features + forward return target.
    """
    _ensure_imports()

    df = df.copy()

    # Ensure we have the basics
    close_col = _find_col(df, ["adj close", "adjclose", "adj_close", "close"])
    vol_col = _find_col(df, ["volume", "vol"])
    high_col = _find_col(df, ["high"])
    low_col = _find_col(df, ["low"])
    open_col = _find_col(df, ["open"])

    if not close_col:
        raise ValueError(f"No close price column found. Available: {list(df.columns)}")

    close = df[close_col]
    ret_1d = close.pct_change()

    # ── Target: forward N-day return ──
    df["fwd_return"] = close.shift(-forward_days) / close - 1.0

    # ── Momentum features ──
    for period in [5, 20, 60, 252]:
        df[f"mom_{period}d"] = close / close.shift(period) - 1.0

    # ── Volatility ──
    df["vol_20d"] = ret_1d.rolling(20).std()
    df["vol_60d"] = ret_1d.rolling(60).std()

    # ── Relative volume ──
    if vol_col:
        vol = df[vol_col].replace(0, np.nan)
        df["rel_vol_20d"] = vol / vol.rolling(20).mean()

    # ── RSI (14-day) ──
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    df["rsi_14"] = 100 - (100 / (1 + rs))

    # ── Bollinger Band %B (20-day) ──
    sma20 = close.rolling(20).mean()
    std20 = close.rolling(20).std()
    df["bb_pctb"] = (close - (sma20 - 2 * std20)) / (4 * std20).replace(0, np.nan)

    # ── 52-week high/low distance ──
    if high_col and low_col:
        high_252 = df[high_col].rolling(252).max()
        low_252 = df[low_col].rolling(252).min()
        rng = (high_252 - low_252).replace(0, np.nan)
        df["dist_52w_high"] = (close - high_252) / rng
        df["dist_52w_low"] = (close - low_252) / rng

    # ── SMA crossovers ──
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    df["sma_20_50"] = (sma20 / sma50 - 1.0) if sma50 is not None else 0
    df["sma_50_200"] = (sma50 / sma200 - 1.0) if sma200 is not None else 0

    # ── Mean reversion ──
    df["mean_rev_20d"] = close / sma20 - 1.0

    return df


def build_fundamental_features(fund_df):
    """
    Build fundamental features from financial statements.
    Handles whatever columns are available — skips missing ones gracefully.
    """
    _ensure_imports()

    if fund_df is None or len(fund_df) == 0:
        return None

    df = fund_df.copy()
    features_added = []

    # Revenue growth (YoY) — look for revenue-like columns
    rev_col = _find_col(df, ["revenue", "totalrevenue", "total_revenue"])
    if rev_col:
        df["revenue_growth"] = df[rev_col].pct_change(4)  # 4 periods ~ YoY for quarterly
        features_added.append("revenue_growth")

    # Net margin
    ni_col = _find_col(df, ["netincome", "net_income", "netincomeapplicabletocommonshares"])
    if ni_col and rev_col:
        df["net_margin"] = df[ni_col] / df[rev_col].replace(0, np.nan)
        features_added.append("net_margin")

    # Gross margin
    gp_col = _find_col(df, ["grossprofit", "gross_profit"])
    if gp_col and rev_col:
        df["gross_margin"] = df[gp_col] / df[rev_col].replace(0, np.nan)
        features_added.append("gross_margin")

    # ROE
    eq_col = _find_col(df, ["totalstockholderequity", "total_stockholder_equity",
                             "totalshareholdersequity", "total_equity", "stockholdersequity"])
    if ni_col and eq_col:
        df["roe"] = df[ni_col] / df[eq_col].replace(0, np.nan)
        features_added.append("roe")

    # ROA
    ta_col = _find_col(df, ["totalassets", "total_assets"])
    if ni_col and ta_col:
        df["roa"] = df[ni_col] / df[ta_col].replace(0, np.nan)
        features_added.append("roa")

    # Debt to equity
    debt_col = _find_col(df, ["totaldebt", "total_debt", "longtermdebt", "long_term_debt",
                               "totalliabilities", "total_liabilities"])
    if debt_col and eq_col:
        df["debt_to_equity"] = df[debt_col] / df[eq_col].replace(0, np.nan)
        features_added.append("debt_to_equity")

    # Current ratio
    ca_col = _find_col(df, ["totalcurrentassets", "total_current_assets"])
    cl_col = _find_col(df, ["totalcurrentliabilities", "total_current_liabilities"])
    if ca_col and cl_col:
        df["current_ratio"] = df[ca_col] / df[cl_col].replace(0, np.nan)
        features_added.append("current_ratio")

    # Free cash flow
    ocf_col = _find_col(df, ["operatingcashflow", "totalcashfromoperatingactivities",
                              "operating_cash_flow"])
    capex_col = _find_col(df, ["capitalexpenditures", "capital_expenditures", "capex",
                                "capitalexpenditure"])
    if ocf_col and capex_col:
        df["fcf"] = df[ocf_col] + df[capex_col]  # capex is usually negative
        features_added.append("fcf")

    log(f"  Fundamental features built: {features_added if features_added else 'none (columns not matched)'}")
    return df, features_added


def _find_col(df, candidates):
    cols_lower = {c.lower().replace(" ", "").replace("_", ""): c for c in df.columns}
    for c in candidates:
        key = c.lower().replace(" ", "").replace("_", "")
        if key in cols_lower:
            return cols_lower[key]
    return None


# ── Walk-Forward Training ────────────────────────────────────────────────

def run_walk_forward(df, feature_cols, target_col, train_split, model_type):
    """
    Walk-forward chronological split. First <train_split> fraction = train.
    No data leakage: strict chronological ordering.
    """
    _ensure_imports()
    from sklearn.linear_model import LinearRegression
    from sklearn.ensemble import HistGradientBoostingRegressor

    n = len(df)
    split_idx = int(train_split * n)

    df_train = df.iloc[:split_idx]
    df_test = df.iloc[split_idx:]

    if len(df_train) < 60 or len(df_test) < 20:
        raise ValueError(
            f"Insufficient data: {len(df_train)} train, {len(df_test)} test "
            f"(need at least 60/20). Try a longer date range."
        )

    log(f"Walk-forward split: {len(df_train):,} train / {len(df_test):,} test")

    X_train = df_train[feature_cols].values
    y_train = df_train[target_col].values
    X_test = df_test[feature_cols].values
    y_test = df_test[target_col].values

    # In-sample correlation
    corr_cols = feature_cols + [target_col]
    corr_matrix = df_train[corr_cols].corr()
    corr_data = {}
    for i, ci in enumerate(corr_cols):
        for j, cj in enumerate(corr_cols):
            if j >= i:
                v = corr_matrix.iloc[i, j]
                corr_data[f"{ci}__{cj}"] = round(float(v), 6) if not np.isnan(v) else 0.0

    models = {}

    if model_type in ("linear", "both"):
        reg = LinearRegression()
        reg.fit(X_train, y_train)
        pred = reg.predict(X_test)
        models["linear_all"] = _build_model_result(
            "Linear Regression (all features)",
            {f: round(float(c), 6) for f, c in zip(feature_cols, reg.coef_)},
            pred, y_test, "linear_regression", df_test,
        )

    if model_type in ("gradient_boost", "both"):
        log("Training HistGradientBoostingRegressor...")
        gbr = HistGradientBoostingRegressor(
            max_iter=300, max_depth=4, learning_rate=0.05,
            min_samples_leaf=20, random_state=42,
        )
        gbr.fit(X_train, y_train)
        pred_gbr = gbr.predict(X_test)
        imp = gbr.feature_importances_ if hasattr(gbr, "feature_importances_") else np.zeros(len(feature_cols))
        models["gradient_boost"] = _build_model_result(
            "Gradient Boosted Trees",
            {f: round(float(v), 6) for f, v in zip(feature_cols, imp)},
            pred_gbr, y_test, "gradient_boost", df_test,
        )

    return {
        "train_size": len(df_train),
        "test_size": len(df_test),
        "correlation": corr_data,
        "correlation_columns": corr_cols,
        "models": models,
    }


def _build_model_result(name, coefficients, predictions, actual, model_type, df_test):
    _ensure_imports()

    n = len(predictions)
    # Guard against constant predictions or actual
    if np.std(predictions) < 1e-12 or np.std(actual) < 1e-12:
        oos_corr = 0.0
    else:
        oos_corr = float(np.corrcoef(predictions, actual)[0, 1])
        if np.isnan(oos_corr):
            oos_corr = 0.0

    ss_res = float(np.sum((actual - predictions) ** 2))
    ss_tot = float(np.sum((actual - np.mean(actual)) ** 2))
    r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    # Direction accuracy
    pred_dir = predictions > 0
    actual_dir = actual > 0
    hit_rate = float(np.mean(pred_dir == actual_dir)) if n > 0 else 0.0

    # Signed return PnL (long if pred>0, short if pred<0)
    signed_ret = actual.copy()
    signed_ret[predictions < 0] *= -1
    cumulative_pnl = float(np.sum(signed_ret))

    # Monthly PnL breakdown
    monthly_pnls = _compute_monthly_pnls(predictions, actual, df_test)
    monthly_vals = [m["pnl"] for m in monthly_pnls]
    avg_monthly = float(np.mean(monthly_vals)) if monthly_vals else 0.0
    std_monthly = float(np.std(monthly_vals, ddof=1)) if len(monthly_vals) > 1 else 0.0
    sharpe = (avg_monthly / std_monthly) if std_monthly > 0 else 0.0

    # Max drawdown
    cum = np.cumsum(signed_ret)
    peak = np.maximum.accumulate(cum) if len(cum) > 0 else np.array([0.0])
    dd = cum - peak
    max_dd = float(np.min(dd)) if len(dd) > 0 else 0.0

    # PnL curve for chart
    pnl_curve = list(np.cumsum(signed_ret))

    return {
        "name": name,
        "type": model_type,
        "coefficients": coefficients,
        "oos_correlation": round(oos_corr, 6),
        "r_squared": round(r_squared, 6),
        "hit_rate": round(hit_rate, 4),
        "cumulative_pnl": round(cumulative_pnl, 6),
        "avg_monthly_pnl": round(avg_monthly, 6),
        "std_monthly_pnl": round(std_monthly, 6),
        "sharpe": round(sharpe, 4),
        "max_drawdown": round(max_dd, 6),
        "num_test_periods": len(monthly_pnls),
        "monthly_pnls": monthly_pnls,
        "pnl_curve": [round(float(x), 6) for x in pnl_curve],
    }


def _compute_monthly_pnls(predictions, actual, df_test):
    _ensure_imports()

    date_col = _find_col(df_test, ["date", "datetime"])
    if date_col:
        months = pd.Series(df_test[date_col].values).dt.to_period("M").astype(str).values
    else:
        # Fallback: chunk into ~21-day blocks
        months = [f"block_{i // 21}" for i in range(len(df_test))]

    df_pnl = pd.DataFrame({"pred": predictions, "actual": actual, "month": months})
    df_pnl["signed_ret"] = df_pnl["actual"].copy()
    df_pnl.loc[df_pnl["pred"] < 0, "signed_ret"] *= -1

    result = []
    for month, grp in df_pnl.groupby("month", sort=True):
        corr = 0.0
        if len(grp) > 2 and np.std(grp["pred"]) > 1e-12 and np.std(grp["actual"]) > 1e-12:
            c = np.corrcoef(grp["pred"], grp["actual"])[0, 1]
            corr = float(c) if not np.isnan(c) else 0.0
        result.append({
            "period": str(month),
            "samples": len(grp),
            "pnl": round(float(grp["signed_ret"].sum()), 6),
            "corr": round(corr, 4),
        })
    return result


# ── Chart ────────────────────────────────────────────────────────────────

def render_chart(results, ticker, forward_days, start_date, end_date, chart_path):
    _ensure_imports()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    models = results["models"]
    if not models:
        return

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8), facecolor="#1e1e2e",
                                    gridspec_kw={"height_ratios": [3, 2]})

    colors = {"linear_all": "#3b82f6", "gradient_boost": "#ef4444"}
    labels = {"linear_all": "Linear Regression", "gradient_boost": "Gradient Boost"}

    # Top: cumulative return curve
    ax1.set_facecolor("#1e1e2e")
    for key, m in models.items():
        pnl = m.get("pnl_curve", [])
        if not pnl:
            continue
        c = colors.get(key, "#888")
        lw = 2.5 if key == "gradient_boost" else 1.6
        ax1.plot(range(len(pnl)), pnl, color=c, linewidth=lw,
                 label=labels.get(key, key), alpha=0.9)

    ax1.axhline(0, color="#555", linewidth=0.8, linestyle="--")
    ax1.set_ylabel("Cumulative return", color="#a0a0a0", fontsize=10)
    ax1.set_title(f"{ticker} — Walk-Forward Backtest ({forward_days}d forward return)",
                  color="#e0e0e0", fontsize=13, fontweight="bold", pad=10)
    ax1.text(0.5, 1.02, f"{start_date} to {end_date} | {results['test_size']:,} OOS samples",
             transform=ax1.transAxes, ha="center", color="#888", fontsize=8)
    _style_ax(ax1)
    ax1.legend(loc="upper left", framealpha=0.8, facecolor="#2a2a3e",
               edgecolor="#444", fontsize=9, labelcolor="#c0c0c0")

    # Bottom: monthly PnL bars
    ax2.set_facecolor("#1e1e2e")
    best_key = max(models.keys(), key=lambda k: models[k].get("sharpe", 0))
    monthly = models[best_key].get("monthly_pnls", [])
    if monthly:
        periods = [m["period"] for m in monthly]
        vals = [m["pnl"] for m in monthly]
        bar_colors = ["#22c55e" if v >= 0 else "#ef4444" for v in vals]
        ax2.bar(range(len(vals)), vals, color=bar_colors, alpha=0.8)
        # Label every Nth bar
        step = max(1, len(periods) // 12)
        ax2.set_xticks(range(0, len(periods), step))
        ax2.set_xticklabels([periods[i] for i in range(0, len(periods), step)],
                            rotation=45, fontsize=7, color="#a0a0a0")

    ax2.axhline(0, color="#555", linewidth=0.8, linestyle="--")
    ax2.set_ylabel("Monthly PnL", color="#a0a0a0", fontsize=10)
    ax2.set_title(f"Monthly Returns (best model: {labels.get(best_key, best_key)})",
                  color="#c0c0c0", fontsize=11, pad=6)
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


# ── Main Pipeline ────────────────────────────────────────────────────────

def run_prediction(ticker, start_date=None, end_date=None, forward_days=20,
                   train_split=0.70, model_type="both", data_dir=None):
    _ensure_imports()
    from data_loader import ensure_data, load_prices, load_fundamentals

    ticker = ticker.upper()
    log(f"Running ML backtest for {ticker}")

    # Ensure data is downloaded
    data_dir = ensure_data(data_dir)

    # Load EOD prices
    prices = load_prices(data_dir, ticker=ticker)
    if len(prices) == 0:
        raise ValueError(f"No price data found for {ticker}")

    # Filter date range
    if "date" in prices.columns:
        if start_date:
            prices = prices[prices["date"] >= start_date]
        if end_date:
            prices = prices[prices["date"] <= end_date]

    if len(prices) < 300:
        raise ValueError(f"Only {len(prices)} rows for {ticker} in range. Need at least 300 for meaningful backtest.")

    log(f"Price data: {len(prices):,} rows ({prices['date'].min()} to {prices['date'].max()})" if "date" in prices.columns else f"Price data: {len(prices):,} rows")

    effective_start = str(prices["date"].min().date()) if "date" in prices.columns else start_date or "?"
    effective_end = str(prices["date"].max().date()) if "date" in prices.columns else end_date or "?"

    # Build technical features
    df = build_technical_features(prices, forward_days=forward_days)

    # Try to merge fundamental features
    fund_features = []
    try:
        fund_raw = load_fundamentals(data_dir, ticker=ticker)
        if fund_raw is not None and len(fund_raw) > 0:
            fund_df, fund_features = build_fundamental_features(fund_raw)
            if fund_features and "date" in df.columns and "date" in fund_df.columns:
                # Forward-fill fundamentals to daily frequency (no leakage — uses last known)
                fund_cols_to_merge = ["date"] + fund_features
                fund_daily = fund_df[fund_cols_to_merge].drop_duplicates("date").sort_values("date")
                df = pd.merge_asof(df.sort_values("date"), fund_daily, on="date", direction="backward")
                log(f"  Merged {len(fund_features)} fundamental features")
    except Exception as e:
        log(f"  Fundamental data merge failed (non-fatal): {e}")

    # Identify available feature columns
    technical_features = [c for c in [
        "mom_5d", "mom_20d", "mom_60d", "mom_252d",
        "vol_20d", "vol_60d", "rel_vol_20d",
        "rsi_14", "bb_pctb", "dist_52w_high", "dist_52w_low",
        "sma_20_50", "sma_50_200", "mean_rev_20d",
    ] if c in df.columns]

    feature_cols = technical_features + [f for f in fund_features if f in df.columns]
    target_col = "fwd_return"

    if not feature_cols:
        raise ValueError("No features could be built from the data. Check column names.")

    # Drop NaN rows (from rolling calcs + forward shift)
    df_clean = df[feature_cols + [target_col] + (["date"] if "date" in df.columns else [])].dropna()
    df_clean = df_clean.replace([np.inf, -np.inf], np.nan).dropna()

    log(f"Clean dataset: {len(df_clean):,} rows, {len(feature_cols)} features")

    if len(df_clean) < 100:
        raise ValueError(f"Only {len(df_clean)} usable rows after feature computation. Need at least 100.")

    # Walk-forward training
    results = run_walk_forward(df_clean, feature_cols, target_col, train_split, model_type)

    # Chart
    chart_path = os.path.join(tempfile.gettempdir(), f"ml-predict-{ticker}.png")
    try:
        render_chart(results, ticker, forward_days, effective_start, effective_end, chart_path)
    except Exception as e:
        log(f"Chart rendering failed: {e}")
        chart_path = None

    # Build output
    output = {
        "ticker": ticker,
        "start_date": effective_start,
        "end_date": effective_end,
        "forward_days": forward_days,
        "train_split": train_split,
        "split_type": "walk-forward chronological",
        "feature_columns": feature_cols,
        "technical_features": technical_features,
        "fundamental_features": [f for f in fund_features if f in df.columns],
        "total_price_rows": len(prices),
        "total_clean_samples": len(df_clean),
        "train_size": results["train_size"],
        "test_size": results["test_size"],
        "correlation": results["correlation"],
        "correlation_columns": results["correlation_columns"],
        "models": {},
        "chart_path": chart_path,
    }

    best_key = None
    best_score = -float("inf")
    for key, model in results["models"].items():
        m = {
            "name": model["name"],
            "type": model["type"],
            "coefficients": model["coefficients"],
            "oos_correlation": model["oos_correlation"],
            "r_squared": model["r_squared"],
            "hit_rate": model["hit_rate"],
            "cumulative_pnl": model["cumulative_pnl"],
            "avg_monthly_pnl": model["avg_monthly_pnl"],
            "std_monthly_pnl": model["std_monthly_pnl"],
            "sharpe": model["sharpe"],
            "max_drawdown": model["max_drawdown"],
            "num_test_periods": model["num_test_periods"],
            "monthly_pnls": model["monthly_pnls"],
        }
        output["models"][key] = m
        # Score: Sharpe dominant, with hit rate and correlation as tiebreakers
        score = model["sharpe"] * 0.5 + model["hit_rate"] * 0.3 + model["oos_correlation"] * 0.2
        if score > best_score:
            best_score = score
            best_key = key

    if best_key:
        bm = results["models"][best_key]
        output["best_model"] = best_key
        output["best_model_name"] = bm["name"]
        output["best_pnl"] = bm["cumulative_pnl"]
        output["best_sharpe"] = bm["sharpe"]
        output["best_hit_rate"] = bm["hit_rate"]
    else:
        output["best_model"] = None
        output["best_model_name"] = None
        output["best_pnl"] = 0.0
        output["best_sharpe"] = 0.0
        output["best_hit_rate"] = 0.0

    return output


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    max_days = int(os.environ.get("ML_MAX_DAYS", str(MAX_DAYS_DEFAULT)))

    parser = argparse.ArgumentParser(description="ML Trading Predictor — Stock Backtest on Parquet Data")
    parser.add_argument("--ticker", required=True, help="Stock ticker (e.g. AAPL, MSFT, SPY)")
    parser.add_argument("--start-date", help="Backtest start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="Backtest end date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, help=f"Trading days of history (default: {DEFAULT_DAYS})")
    parser.add_argument("--forward", type=int, default=DEFAULT_FORWARD,
                        help=f"Forward return horizon in trading days (default: {DEFAULT_FORWARD})")
    parser.add_argument("--train-split", type=float, default=DEFAULT_TRAIN_SPLIT)
    parser.add_argument("--model", choices=["linear", "gradient_boost", "both"], default="both")
    parser.add_argument("--data-dir", help="Local directory with parquet files (or set ML_DATA_DIR)")
    parser.add_argument("--inspect", action="store_true", help="Print parquet schemas and exit")
    args = parser.parse_args()

    # Schema inspection mode
    if args.inspect:
        from data_loader import ensure_data, inspect_schema
        data_dir = ensure_data(args.data_dir)
        schema = inspect_schema(data_dir)
        print(json.dumps(schema, indent=2, default=str))
        return

    # Resolve date range
    end_date = args.end_date
    start_date = args.start_date

    if args.days and not start_date:
        if args.days > max_days:
            print(json.dumps({"error": f"days={args.days} exceeds max {max_days}. Set ML_MAX_DAYS to override."}))
            sys.exit(1)
        if not end_date:
            end_date = datetime.utcnow().strftime("%Y-%m-%d")
        ed = datetime.strptime(end_date, "%Y-%m-%d")
        sd = ed - timedelta(days=int(args.days * 1.5))  # 1.5x to account for weekends/holidays
        start_date = sd.strftime("%Y-%m-%d")

    # Validate
    if start_date and end_date:
        try:
            sd_dt = datetime.strptime(start_date, "%Y-%m-%d")
            ed_dt = datetime.strptime(end_date, "%Y-%m-%d")
        except ValueError as e:
            print(json.dumps({"error": f"Invalid date format: {e}. Use YYYY-MM-DD."}))
            sys.exit(1)
        if sd_dt > ed_dt:
            print(json.dumps({"error": f"start_date ({start_date}) is after end_date ({end_date})"}))
            sys.exit(1)

    try:
        result = run_prediction(
            ticker=args.ticker,
            start_date=start_date,
            end_date=end_date,
            forward_days=args.forward,
            train_split=args.train_split,
            model_type=args.model,
            data_dir=args.data_dir,
        )
        print(json.dumps(result))
    except Exception as e:
        log(f"ERROR: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
