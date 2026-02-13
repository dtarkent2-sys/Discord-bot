#!/usr/bin/env python3
"""
ML Trading Predictor — Multi-Day Walk-Forward Backtesting Pipeline

Uses the official Databento Python client to fetch 10-level market depth
(MBP-10) data for CME Globex futures across a DATE RANGE, then runs a
walk-forward (chronological, no-leakage) backtest with scikit-learn models.

Based on: https://databento.com/blog/hft-sklearn-python
Docs:     https://databento.com/docs/api-reference-historical/client
Schema:   https://databento.com/docs/schemas-and-data-formats/mbp-10

Features (from MBP-10 order book):
  - Skew: log(bid_sz_00) - log(ask_sz_00)
  - Imbalance: log(sum(bid_ct)) - log(sum(ask_ct))
  - Depth pressure: weighted bid/ask size ratio across 10 levels
  - Spread: ask_px_00 - bid_px_00
  - Micro price deviation: size-weighted mid vs simple mid

Models:
  - Linear Regression (baseline)
  - HistGradientBoostingRegressor (non-linear)

Split: Walk-forward chronological (first 70% train, last 30% test).
       No leakage — features at time t never use future data.

Usage:
  python predictor.py --product ES --days 60
  python predictor.py --product NQ --start-date 2026-01-01 --end-date 2026-02-12
  python predictor.py --product ES --date 2026-02-12  # single-day (deprecated)
"""

import sys
import os
import json
import argparse
import warnings
import tempfile
from datetime import datetime, timedelta

warnings.filterwarnings("ignore", category=FutureWarning)

# Heavy imports deferred for fast CLI startup
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
            print(json.dumps({"error": f"Missing Python dependency: {e}. Run: pip install -r ml/requirements.txt"}))
            sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────────

PRODUCTS = {
    "ES":  {"dataset": "GLBX.MDP3", "name": "E-mini S&P 500"},
    "NQ":  {"dataset": "GLBX.MDP3", "name": "E-mini Nasdaq-100"},
    "YM":  {"dataset": "GLBX.MDP3", "name": "E-mini Dow"},
    "RTY": {"dataset": "GLBX.MDP3", "name": "E-mini Russell 2000"},
    "CL":  {"dataset": "GLBX.MDP3", "name": "Crude Oil"},
    "GC":  {"dataset": "GLBX.MDP3", "name": "Gold"},
    "SI":  {"dataset": "GLBX.MDP3", "name": "Silver"},
    "ZB":  {"dataset": "GLBX.MDP3", "name": "30-Year Treasury Bond"},
    "ZN":  {"dataset": "GLBX.MDP3", "name": "10-Year Treasury Note"},
    "ZF":  {"dataset": "GLBX.MDP3", "name": "5-Year Treasury Note"},
    "HG":  {"dataset": "GLBX.MDP3", "name": "Copper"},
    "NG":  {"dataset": "GLBX.MDP3", "name": "Natural Gas"},
}

DEFAULT_MARKOUT = 300
DEFAULT_DAYS = 60
DEFAULT_TRAIN_SPLIT = 0.70
MAX_DAYS_DEFAULT = 180

RTH_START_UTC = "T14:30"  # 9:30 AM ET
RTH_END_UTC = "T21:00"    # 4:00 PM ET


def log(msg):
    print(f"[ML-Predictor] {msg}", file=sys.stderr, flush=True)


def last_trading_day():
    d = datetime.utcnow() - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def generate_session_ranges(start_date, end_date):
    """Generate (session_start, session_end, date_label) for each weekday in range."""
    _ensure_imports()
    sd = datetime.strptime(start_date, "%Y-%m-%d")
    ed = datetime.strptime(end_date, "%Y-%m-%d")
    sessions = []
    d = sd
    while d <= ed:
        if d.weekday() < 5:  # Mon-Fri
            ds = d.strftime("%Y-%m-%d")
            sessions.append((f"{ds}{RTH_START_UTC}", f"{ds}{RTH_END_UTC}", ds))
        d += timedelta(days=1)
    return sessions


# ── Data Fetching ────────────────────────────────────────────────────────

def fetch_mbp10_data(api_key, product, start, end):
    _ensure_imports()
    import databento as db

    meta = PRODUCTS.get(product.upper())
    if not meta:
        raise ValueError(f"Unknown product: {product}. Supported: {', '.join(PRODUCTS.keys())}")

    client = db.Historical(api_key)
    symbol = f"{product.upper()}.n.0"
    log(f"Fetching MBP-10 for {symbol} from {start} to {end}")

    data = client.timeseries.get_range(
        dataset=meta["dataset"],
        schema="mbp-10",
        symbols=[symbol],
        stype_in="continuous",
        start=start,
        end=end,
    )

    df = data.to_df()
    log(f"Received {len(df):,} raw MBP-10 records")
    return df


def fetch_range_data(api_key, product, sessions):
    """Fetch data for multiple sessions. Returns list of (date_label, DataFrame)."""
    results = []
    for sess_start, sess_end, date_label in sessions:
        try:
            df = fetch_mbp10_data(api_key, product, sess_start, sess_end)
            if len(df) > 0:
                results.append((date_label, df))
                log(f"  {date_label}: {len(df):,} records")
            else:
                log(f"  {date_label}: no data (market holiday?)")
        except Exception as e:
            log(f"  {date_label}: fetch failed — {e}")
    return results


# ── Feature Engineering ──────────────────────────────────────────────────

def build_features(df, markout=300):
    _ensure_imports()

    if "action" in df.columns:
        df_trades = df[df.action == "T"].copy()
    else:
        df_trades = df.copy()

    if len(df_trades) < markout * 3:
        return None, None, None  # signal caller to skip this day

    df_trades["mid"] = (df_trades["bid_px_00"] + df_trades["ask_px_00"]) / 2
    target_col = f"ret_{markout}t"
    df_trades[target_col] = df_trades["mid"].shift(-markout) - df_trades["mid"]

    bid_sz = df_trades["bid_sz_00"].clip(lower=1)
    ask_sz = df_trades["ask_sz_00"].clip(lower=1)
    df_trades["skew"] = np.log(bid_sz) - np.log(ask_sz)

    bid_ct_cols = [f"bid_ct_{i:02d}" for i in range(10) if f"bid_ct_{i:02d}" in df_trades.columns]
    ask_ct_cols = [f"ask_ct_{i:02d}" for i in range(10) if f"ask_ct_{i:02d}" in df_trades.columns]
    if bid_ct_cols and ask_ct_cols:
        bid_ct_sum = df_trades[bid_ct_cols].sum(axis=1).clip(lower=1)
        ask_ct_sum = df_trades[ask_ct_cols].sum(axis=1).clip(lower=1)
        df_trades["imbalance"] = np.log(bid_ct_sum) - np.log(ask_ct_sum)
    else:
        df_trades["imbalance"] = df_trades["skew"]

    bid_sz_cols = [f"bid_sz_{i:02d}" for i in range(10) if f"bid_sz_{i:02d}" in df_trades.columns]
    ask_sz_cols = [f"ask_sz_{i:02d}" for i in range(10) if f"ask_sz_{i:02d}" in df_trades.columns]
    if len(bid_sz_cols) >= 5 and len(ask_sz_cols) >= 5:
        weights = np.array([1.0, 0.8, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08, 0.05])[:len(bid_sz_cols)]
        weighted_bid = (df_trades[bid_sz_cols].values * weights).sum(axis=1)
        weighted_ask = (df_trades[ask_sz_cols].values * weights).sum(axis=1)
        total = np.clip(weighted_bid + weighted_ask, 1, None)
        df_trades["depth_pressure"] = (weighted_bid - weighted_ask) / total
    else:
        df_trades["depth_pressure"] = df_trades["skew"] * 0.5

    df_trades["spread"] = df_trades["ask_px_00"] - df_trades["bid_px_00"]

    total_top_sz = bid_sz + ask_sz
    microprice = (df_trades["bid_px_00"] * ask_sz + df_trades["ask_px_00"] * bid_sz) / total_top_sz
    df_trades["micro_dev"] = microprice - df_trades["mid"]

    feature_cols = ["skew", "imbalance", "depth_pressure", "spread", "micro_dev"]
    keep_cols = feature_cols + [target_col, "mid"]
    df_clean = df_trades[keep_cols].dropna()

    return df_clean, feature_cols, target_col


# ── Walk-Forward Training ────────────────────────────────────────────────

def run_walk_forward(all_features_df, feature_cols, target_col, train_split, model_type, markout):
    """
    Walk-forward chronological split across the full concatenated dataset.
    First <train_split> fraction = train, remainder = test.
    No data leakage: strict chronological ordering.
    """
    _ensure_imports()
    from sklearn.linear_model import LinearRegression
    from sklearn.ensemble import HistGradientBoostingRegressor

    n = len(all_features_df)
    split_idx = int(train_split * n)
    split_idx -= split_idx % 100

    df_train = all_features_df.iloc[:split_idx]
    df_test = all_features_df.iloc[split_idx:]

    if len(df_train) < 200 or len(df_test) < 100:
        raise ValueError(
            f"Insufficient data for walk-forward split: "
            f"{len(df_train):,} train, {len(df_test):,} test (need 200/100 minimum)"
        )

    log(f"Walk-forward split: {len(df_train):,} train / {len(df_test):,} test (split at row {split_idx:,})")

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
                corr_data[f"{ci}__{cj}"] = round(corr_matrix.iloc[i, j], 6)

    models = {}
    skew_idx = feature_cols.index("skew") if "skew" in feature_cols else 0
    imb_idx = feature_cols.index("imbalance") if "imbalance" in feature_cols else 1

    if model_type in ("linear", "both"):
        # Skew only
        reg_skew = LinearRegression(fit_intercept=False)
        reg_skew.fit(X_train[:, [skew_idx]], y_train)
        pred_skew = reg_skew.predict(X_test[:, [skew_idx]])
        models["skew"] = _build_model_result(
            "Skew (top-of-book depth)", {"skew": float(reg_skew.coef_[0])},
            pred_skew, y_test, "linear_regression", df_test
        )

        # Imbalance only
        reg_imb = LinearRegression(fit_intercept=False)
        reg_imb.fit(X_train[:, [imb_idx]], y_train)
        pred_imb = reg_imb.predict(X_test[:, [imb_idx]])
        models["imbalance"] = _build_model_result(
            "Imbalance (10-level count)", {"imbalance": float(reg_imb.coef_[0])},
            pred_imb, y_test, "linear_regression", df_test
        )

        # Combined linear
        reg_combo = LinearRegression(fit_intercept=False)
        reg_combo.fit(X_train[:, [skew_idx, imb_idx]], y_train)
        pred_combo = reg_combo.predict(X_test[:, [skew_idx, imb_idx]])
        models["combined_linear"] = _build_model_result(
            "Combined Linear (skew+imb)", {n: float(c) for n, c in zip(["skew", "imbalance"], reg_combo.coef_)},
            pred_combo, y_test, "linear_regression", df_test
        )

        # All features linear
        reg_all = LinearRegression(fit_intercept=False)
        reg_all.fit(X_train, y_train)
        pred_all = reg_all.predict(X_test)
        models["all_features_linear"] = _build_model_result(
            "All Features Linear", {n: float(c) for n, c in zip(feature_cols, reg_all.coef_)},
            pred_all, y_test, "linear_regression", df_test
        )

    if model_type in ("gradient_boost", "both"):
        log("Training HistGradientBoostingRegressor...")
        gbr = HistGradientBoostingRegressor(
            max_iter=200, max_depth=4, learning_rate=0.05,
            min_samples_leaf=50, random_state=42,
        )
        gbr.fit(X_train, y_train)
        pred_gbr = gbr.predict(X_test)
        importances = gbr.feature_importances_ if hasattr(gbr, "feature_importances_") else np.zeros(len(feature_cols))
        models["gradient_boost"] = _build_model_result(
            "Gradient Boosted Trees", {n: float(v) for n, v in zip(feature_cols, importances)},
            pred_gbr, y_test, "gradient_boost", df_test
        )

    return {
        "train_size": len(df_train),
        "test_size": len(df_test),
        "correlation": corr_data,
        "correlation_columns": corr_cols,
        "models": models,
    }


def _build_model_result(name, coefficients, predictions, actual, model_type, df_test):
    """Build result dict with aggregated metrics including daily PnL breakdown."""
    _ensure_imports()

    n = len(predictions)
    oos_corr = float(np.corrcoef(predictions, actual)[0, 1]) if n > 1 else 0.0
    ss_res = float(np.sum((actual - predictions) ** 2))
    ss_tot = float(np.sum((actual - np.mean(actual)) ** 2))
    r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    # Cumulative markout PnL (sorted by predictor)
    pnl_curve = _cumulative_markout_pnl(predictions, actual)
    final_pnl = float(pnl_curve[-1]) if len(pnl_curve) > 0 else 0.0

    # ── Daily PnL breakdown ──
    # Assign a calendar date to each test row from the index
    daily_pnls = _compute_daily_pnls(predictions, actual, df_test)
    daily_vals = [d["pnl"] for d in daily_pnls]

    avg_daily_pnl = float(np.mean(daily_vals)) if daily_vals else 0.0
    std_daily_pnl = float(np.std(daily_vals, ddof=1)) if len(daily_vals) > 1 else 0.0
    sharpe = (avg_daily_pnl / std_daily_pnl) if std_daily_pnl > 0 else 0.0

    # Max drawdown on cumulative daily equity
    cum_daily = np.cumsum(daily_vals)
    peak = np.maximum.accumulate(cum_daily) if len(cum_daily) > 0 else np.array([0.0])
    drawdowns = cum_daily - peak
    max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

    return {
        "name": name,
        "type": model_type,
        "coefficients": coefficients,
        "oos_correlation": round(oos_corr, 6),
        "r_squared": round(r_squared, 6),
        "final_pnl": round(final_pnl, 4),
        "avg_daily_pnl": round(avg_daily_pnl, 4),
        "std_daily_pnl": round(std_daily_pnl, 4),
        "sharpe": round(sharpe, 4),
        "max_drawdown": round(max_dd, 4),
        "num_test_days": len(daily_pnls),
        "daily_pnls": daily_pnls,
        "pnl_curve": [round(float(x), 4) for x in pnl_curve],
    }


def _compute_daily_pnls(predictions, actual, df_test):
    """Compute signed PnL per calendar date in the test set."""
    _ensure_imports()

    # Build a date column from the DataFrame index
    idx = df_test.index
    if hasattr(idx, 'date'):
        dates = pd.Series([d.date() for d in idx], index=df_test.index)
    else:
        # Fallback: treat entire test as one "day"
        dates = pd.Series(["all"] * len(df_test), index=df_test.index)

    df_pnl = pd.DataFrame({
        "pred": predictions,
        "actual": actual,
        "date": dates.values,
    })
    # Signed return: if pred < 0, flip sign (we'd be short)
    df_pnl["signed_ret"] = df_pnl["actual"].copy()
    df_pnl.loc[df_pnl["pred"] < 0, "signed_ret"] *= -1

    daily = []
    for date_val, grp in df_pnl.groupby("date", sort=True):
        daily.append({
            "date": str(date_val),
            "trades": len(grp),
            "pnl": round(float(grp["signed_ret"].sum()), 4),
            "corr": round(float(np.corrcoef(grp["pred"], grp["actual"])[0, 1]), 4) if len(grp) > 2 else 0.0,
        })
    return daily


def _cumulative_markout_pnl(predictions, actual):
    _ensure_imports()
    df_pnl = pd.DataFrame({"pred": predictions, "ret": actual.copy()})
    df_pnl.loc[df_pnl["pred"] < 0, "ret"] *= -1
    df_pnl = df_pnl.sort_values(by="pred")
    return df_pnl["ret"].cumsum().values


# ── Chart Rendering ──────────────────────────────────────────────────────

def render_chart(results, product, product_name, markout, start_date, end_date, chart_path):
    _ensure_imports()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    models = results["models"]
    num_models = len(models)
    if num_models == 0:
        return

    # Two-panel chart: cumulative markout PnL (top) + daily equity (bottom)
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8), facecolor="#1e1e2e",
                                    gridspec_kw={"height_ratios": [3, 2]})

    colors = {
        "skew": "#3b82f6", "imbalance": "#facc15", "combined_linear": "#22c55e",
        "all_features_linear": "#a855f7", "gradient_boost": "#ef4444",
    }
    short_labels = {
        "skew": "Skew", "imbalance": "Imbalance", "combined_linear": "Combined LR",
        "all_features_linear": "All Features LR", "gradient_boost": "Gradient Boost",
    }

    # ── Top panel: cumulative markout PnL ──
    ax1.set_facecolor("#1e1e2e")
    for key, mdata in models.items():
        pnl = mdata.get("pnl_curve", [])
        if not pnl:
            continue
        pct = np.linspace(0, 100, len(pnl))
        c = colors.get(key, "#888")
        lw = 2.5 if key == "gradient_boost" else 1.6
        ax1.plot(pct, pnl, color=c, linewidth=lw, label=short_labels.get(key, key), alpha=0.9)

    ax1.set_xlabel("Predictor value (percentile)", color="#a0a0a0", fontsize=10)
    ax1.set_ylabel("Cumulative return (ticks)", color="#a0a0a0", fontsize=10)
    ax1.set_title(
        f"{product} ({product_name}) — Walk-Forward Backtest",
        color="#e0e0e0", fontsize=13, fontweight="bold", pad=10,
    )
    ax1.text(0.5, 1.02, f"MBP-10 | {start_date} to {end_date} | {markout}s markout | {results['test_size']:,} OOS samples",
             transform=ax1.transAxes, ha="center", color="#888", fontsize=8)
    _style_ax(ax1)
    ax1.legend(loc="upper left", framealpha=0.8, facecolor="#2a2a3e", edgecolor="#444", fontsize=8, labelcolor="#c0c0c0")

    # ── Bottom panel: daily cumulative equity ──
    ax2.set_facecolor("#1e1e2e")
    for key, mdata in models.items():
        daily = mdata.get("daily_pnls", [])
        if not daily:
            continue
        daily_vals = [d["pnl"] for d in daily]
        cum_equity = np.cumsum(daily_vals)
        dates = list(range(len(cum_equity)))
        c = colors.get(key, "#888")
        lw = 2.5 if key == "gradient_boost" else 1.4
        ax2.plot(dates, cum_equity, color=c, linewidth=lw, label=short_labels.get(key, key), alpha=0.9)

    ax2.set_xlabel("Test day #", color="#a0a0a0", fontsize=10)
    ax2.set_ylabel("Cumulative daily PnL", color="#a0a0a0", fontsize=10)
    ax2.set_title("Daily Equity Curve (OOS)", color="#c0c0c0", fontsize=11, pad=6)
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

def run_prediction(api_key, product, start_date, end_date, markout=300,
                   train_split=0.70, model_type="both", single_date=None):
    """
    Multi-day walk-forward backtesting pipeline.

    If single_date is set, fetches only that day (backward-compat, deprecated).
    Otherwise fetches [start_date .. end_date] range and concatenates sessions.
    """
    _ensure_imports()

    product = product.upper()
    meta = PRODUCTS.get(product)
    if not meta:
        raise ValueError(f"Unknown product: {product}")

    # Determine sessions
    if single_date:
        sessions = [(f"{single_date}{RTH_START_UTC}", f"{single_date}{RTH_END_UTC}", single_date)]
        effective_start = single_date
        effective_end = single_date
    else:
        sessions = generate_session_ranges(start_date, end_date)
        effective_start = start_date
        effective_end = end_date

    if not sessions:
        raise ValueError(f"No trading sessions in range {start_date} to {end_date}")

    log(f"Fetching {len(sessions)} session(s) for {product}: {effective_start} to {effective_end}")

    # Fetch all session data
    day_data = fetch_range_data(api_key, product, sessions)
    if not day_data:
        raise ValueError("No data returned for any session in the range")

    # Build features per day, then concatenate
    all_features = []
    per_day_stats = []
    total_raw = 0

    for date_label, df_raw in day_data:
        total_raw += len(df_raw)
        df_feat, fcols, tcol = build_features(df_raw, markout=markout)
        if df_feat is None or len(df_feat) == 0:
            log(f"  {date_label}: skipped (insufficient trades for markout={markout})")
            per_day_stats.append({"date": date_label, "raw_records": len(df_raw), "trade_samples": 0, "status": "skipped"})
            continue
        per_day_stats.append({"date": date_label, "raw_records": len(df_raw), "trade_samples": len(df_feat), "status": "ok"})
        all_features.append(df_feat)

    if not all_features:
        raise ValueError("No sessions had enough trade data for the given markout")

    feature_cols = fcols
    target_col = tcol
    combined_df = pd.concat(all_features, axis=0)
    # Keep chronological order (the index is ts_event from Databento)
    combined_df = combined_df.sort_index()

    log(f"Combined dataset: {len(combined_df):,} trade samples across {len(all_features)} session(s)")

    # Walk-forward training
    results = run_walk_forward(combined_df, feature_cols, target_col, train_split, model_type, markout)

    # Chart
    chart_path = os.path.join(tempfile.gettempdir(), f"ml-predict-{product}.png")
    try:
        render_chart(results, product, meta["name"], markout, effective_start, effective_end, chart_path)
    except Exception as e:
        log(f"Chart rendering failed: {e}")
        chart_path = None

    # Build output
    output = {
        "product": product,
        "product_name": meta["name"],
        "schema": "mbp-10",
        "start_date": effective_start,
        "end_date": effective_end,
        "num_sessions": len(all_features),
        "total_sessions_attempted": len(sessions),
        "markout": markout,
        "train_split": train_split,
        "split_type": "walk-forward chronological",
        "feature_columns": feature_cols,
        "total_raw_records": total_raw,
        "total_trade_samples": len(combined_df),
        "train_size": results["train_size"],
        "test_size": results["test_size"],
        "correlation": results["correlation"],
        "correlation_columns": results["correlation_columns"],
        "per_day_stats": per_day_stats,
        "models": {},
        "chart_path": chart_path,
    }

    # Serialize model results (strip pnl_curve to keep JSON small)
    best_model_key = None
    best_score = -float("inf")
    for key, model in results["models"].items():
        m = {
            "name": model["name"],
            "type": model["type"],
            "coefficients": model["coefficients"],
            "oos_correlation": model["oos_correlation"],
            "r_squared": model["r_squared"],
            "final_pnl": model["final_pnl"],
            "avg_daily_pnl": model["avg_daily_pnl"],
            "std_daily_pnl": model["std_daily_pnl"],
            "sharpe": model["sharpe"],
            "max_drawdown": model["max_drawdown"],
            "num_test_days": model["num_test_days"],
            "daily_pnls": model["daily_pnls"],
        }
        output["models"][key] = m
        # Best model: score = sharpe * 0.5 + (pnl > 0) * 0.5 — rewards stability AND profitability
        score = model["sharpe"] * 0.5 + (1.0 if model["final_pnl"] > 0 else -0.5) * 0.3 + model["oos_correlation"] * 0.2
        if score > best_score:
            best_score = score
            best_model_key = key

    output["best_model"] = best_model_key
    output["best_model_name"] = results["models"][best_model_key]["name"] if best_model_key else None
    output["best_pnl"] = round(results["models"][best_model_key]["final_pnl"], 4) if best_model_key else 0.0
    output["best_sharpe"] = round(results["models"][best_model_key]["sharpe"], 4) if best_model_key else 0.0

    if single_date:
        output["_deprecated_single_date"] = True

    return output


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    max_days = int(os.environ.get("ML_MAX_DAYS", str(MAX_DAYS_DEFAULT)))

    parser = argparse.ArgumentParser(description="ML Trading Predictor — Multi-Day Walk-Forward Backtest")
    parser.add_argument("--product", required=True, help="Futures product (ES, NQ, CL, GC, etc.)")
    parser.add_argument("--start-date", help="Backtest start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="Backtest end date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, help=f"Number of calendar days back from end-date (default: {DEFAULT_DAYS})")
    parser.add_argument("--date", help="[DEPRECATED] Single trading date (YYYY-MM-DD). Use --start-date/--end-date instead.")
    parser.add_argument("--markout", type=int, default=DEFAULT_MARKOUT, help=f"Forward trade count for returns (default: {DEFAULT_MARKOUT})")
    parser.add_argument("--train-split", type=float, default=DEFAULT_TRAIN_SPLIT, help=f"In-sample fraction (default: {DEFAULT_TRAIN_SPLIT})")
    parser.add_argument("--model", choices=["linear", "gradient_boost", "both"], default="both")
    parser.add_argument("--api-key", help="Databento API key (or set DATABENTO_API_KEY env var)")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("DATABENTO_API_KEY", "")
    if not api_key:
        print(json.dumps({"error": "No Databento API key. Set DATABENTO_API_KEY or pass --api-key"}))
        sys.exit(1)

    # ── Resolve date range ──
    single_date = None

    if args.date and not args.start_date and not args.end_date and not args.days:
        # Deprecated single-day mode
        single_date = args.date
        start_date = args.date
        end_date = args.date
        log(f"WARNING: --date is deprecated. Use --start-date/--end-date for multi-day backtesting.")
    else:
        end_date = args.end_date
        if not end_date:
            end_date = last_trading_day()

        if args.days:
            days_back = args.days
        elif args.start_date:
            days_back = None  # explicit start
        else:
            days_back = DEFAULT_DAYS

        if days_back is not None:
            if days_back > max_days:
                print(json.dumps({"error": f"days={days_back} exceeds maximum {max_days}. Set ML_MAX_DAYS env var to override."}))
                sys.exit(1)
            ed = datetime.strptime(end_date, "%Y-%m-%d")
            sd = ed - timedelta(days=days_back)
            start_date = sd.strftime("%Y-%m-%d")
        else:
            start_date = args.start_date

    # Validate
    try:
        sd_dt = datetime.strptime(start_date, "%Y-%m-%d")
        ed_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError as e:
        print(json.dumps({"error": f"Invalid date format: {e}. Use YYYY-MM-DD."}))
        sys.exit(1)

    if sd_dt > ed_dt:
        print(json.dumps({"error": f"start_date ({start_date}) is after end_date ({end_date})"}))
        sys.exit(1)

    delta_days = (ed_dt - sd_dt).days
    if delta_days > max_days:
        print(json.dumps({"error": f"Date range spans {delta_days} days, exceeds max {max_days}. Set ML_MAX_DAYS to override."}))
        sys.exit(1)

    try:
        result = run_prediction(
            api_key=api_key,
            product=args.product,
            start_date=start_date,
            end_date=end_date,
            markout=args.markout,
            train_split=args.train_split,
            model_type=args.model,
            single_date=single_date,
        )
        print(json.dumps(result))
    except Exception as e:
        log(f"ERROR: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
