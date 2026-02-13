#!/usr/bin/env python3
"""
ML Trading Predictor — MBP-10 Order Book Machine Learning Pipeline

Uses the official Databento Python client to fetch 10-level market depth
(MBP-10) data for CME Globex futures, then trains scikit-learn models
to predict short-term price movements from order book features.

Based on: https://databento.com/blog/hft-sklearn-python
Docs:     https://databento.com/docs/api-reference-historical/client
Schema:   https://databento.com/docs/schemas-and-data-formats/mbp-10

Features (from MBP-10 order book):
  - Skew: log(bid_sz_00) - log(ask_sz_00) — top-of-book depth imbalance
  - Imbalance: log(sum(bid_ct)) - log(sum(ask_ct)) — 10-level order count imbalance
  - Depth pressure: weighted bid/ask size ratio across all 10 levels
  - Spread: (ask_px_00 - bid_px_00) — bid-ask spread
  - Micro price: size-weighted mid price deviation

Models:
  - Linear Regression (baseline, fast)
  - Gradient Boosted Trees (HistGradientBoostingRegressor, captures non-linear patterns)

Usage:
  python predictor.py --product ES --markout 500 --date 2026-02-12
  python predictor.py --product NQ --model gradient_boost
"""

import sys
import os
import json
import argparse
import warnings
import tempfile
from datetime import datetime, timedelta

warnings.filterwarnings("ignore", category=FutureWarning)

# Heavy imports are deferred to first use for faster CLI startup / cleaner errors
np = None
pd = None

def _ensure_imports():
    """Lazy-import numpy, pandas, and other heavy libraries."""
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

# ── Product metadata ─────────────────────────────────────────────────────

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


def log(msg):
    """Print to stderr so stdout stays clean for JSON output."""
    print(f"[ML-Predictor] {msg}", file=sys.stderr, flush=True)


def last_trading_day():
    """Get the most recent weekday (excluding today)."""
    d = datetime.utcnow() - timedelta(days=1)
    while d.weekday() >= 5:  # Saturday=5, Sunday=6
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


# ── Data Fetching ────────────────────────────────────────────────────────

def fetch_mbp10_data(api_key, product, start, end):
    """
    Fetch MBP-10 (10-level order book) data using the official Databento client.

    Returns a pandas DataFrame with columns like:
      bid_px_00..09, ask_px_00..09, bid_sz_00..09, ask_sz_00..09,
      bid_ct_00..09, ask_ct_00..09, action, side, price, size, etc.
    """
    _ensure_imports()
    import databento as db

    meta = PRODUCTS.get(product.upper())
    if not meta:
        raise ValueError(f"Unknown product: {product}. Supported: {', '.join(PRODUCTS.keys())}")

    log(f"Connecting to Databento Historical API...")
    client = db.Historical(api_key)

    symbol = f"{product.upper()}.n.0"
    log(f"Fetching MBP-10 for {symbol} ({meta['name']}) from {start} to {end}")

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


# ── Feature Engineering ──────────────────────────────────────────────────

def build_features(df, markout=500):
    """
    Build ML features from MBP-10 order book data.

    Following the Databento HFT + sklearn methodology:
    1. Filter to trade events only (action == 'T')
    2. Compute midprice and forward returns
    3. Extract order book features:
       - skew: top-of-book bid/ask size imbalance
       - imbalance: 10-level order count imbalance
       - depth_pressure: weighted size ratio across levels
       - spread: bid-ask spread in price units
       - micro_price: size-weighted mid deviation

    Args:
        df: Raw MBP-10 DataFrame from Databento
        markout: Number of trades ahead for forward return (default 500)

    Returns:
        DataFrame with features and target variable
    """
    _ensure_imports()
    log(f"Building features (markout={markout} trades)...")

    # Filter to trade events only
    if "action" in df.columns:
        df_trades = df[df.action == "T"].copy()
    else:
        df_trades = df.copy()

    if len(df_trades) < markout * 3:
        raise ValueError(
            f"Insufficient trade data: {len(df_trades)} trades "
            f"(need at least {markout * 3} for markout={markout})"
        )

    # ── Midprice and forward returns ──
    df_trades["mid"] = (df_trades["bid_px_00"] + df_trades["ask_px_00"]) / 2
    df_trades[f"ret_{markout}t"] = df_trades["mid"].shift(-markout) - df_trades["mid"]

    # ── Feature 1: Top-of-book depth imbalance (skew) ──
    # Classic book imbalance / book pressure signal
    bid_sz = df_trades["bid_sz_00"].clip(lower=1)
    ask_sz = df_trades["ask_sz_00"].clip(lower=1)
    df_trades["skew"] = np.log(bid_sz) - np.log(ask_sz)

    # ── Feature 2: 10-level order count imbalance ──
    # Uses order counts across all depth levels
    bid_ct_cols = [f"bid_ct_{i:02d}" for i in range(10) if f"bid_ct_{i:02d}" in df_trades.columns]
    ask_ct_cols = [f"ask_ct_{i:02d}" for i in range(10) if f"ask_ct_{i:02d}" in df_trades.columns]

    if bid_ct_cols and ask_ct_cols:
        bid_ct_sum = df_trades[bid_ct_cols].sum(axis=1).clip(lower=1)
        ask_ct_sum = df_trades[ask_ct_cols].sum(axis=1).clip(lower=1)
        df_trades["imbalance"] = np.log(bid_ct_sum) - np.log(ask_ct_sum)
    else:
        # Fallback: use sizes if counts not available
        df_trades["imbalance"] = df_trades["skew"]

    # ── Feature 3: Depth pressure (weighted across all 10 levels) ──
    # Deeper levels get exponentially less weight
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

    # ── Feature 4: Bid-ask spread ──
    df_trades["spread"] = df_trades["ask_px_00"] - df_trades["bid_px_00"]

    # ── Feature 5: Microprice deviation ──
    # Size-weighted mid price minus simple mid
    total_top_sz = bid_sz + ask_sz
    microprice = (df_trades["bid_px_00"] * ask_sz + df_trades["ask_px_00"] * bid_sz) / total_top_sz
    df_trades["micro_dev"] = microprice - df_trades["mid"]

    # Drop rows with NaN (from shift and any zero-price records)
    feature_cols = ["skew", "imbalance", "depth_pressure", "spread", "micro_dev"]
    target_col = f"ret_{markout}t"
    keep_cols = feature_cols + [target_col, "mid"]
    df_clean = df_trades[keep_cols].dropna()

    log(f"Feature extraction complete: {len(df_clean):,} valid samples from {len(df_trades):,} trades")
    log(f"Features: {', '.join(feature_cols)}")

    return df_clean, feature_cols, target_col


# ── Model Training ───────────────────────────────────────────────────────

def train_models(df, feature_cols, target_col, train_split=0.66, model_type="both"):
    """
    Train ML models on order book features.

    Models:
      1. Linear Regression (per Databento blog methodology)
      2. HistGradientBoosting (captures non-linear patterns in order book data)

    Args:
        df: Feature DataFrame
        feature_cols: List of feature column names
        target_col: Target column name
        train_split: Fraction for in-sample (default 0.66)
        model_type: "linear", "gradient_boost", or "both"

    Returns:
        dict with model results, predictions, and PnL curves
    """
    _ensure_imports()
    from sklearn.linear_model import LinearRegression
    from sklearn.ensemble import HistGradientBoostingRegressor

    # Train/test split
    split = int(train_split * len(df))
    split -= split % 100  # Round down to nearest 100
    df_in = df.iloc[:split]
    df_out = df.iloc[split:]

    if len(df_in) < 200 or len(df_out) < 100:
        raise ValueError(
            f"Insufficient data for train/test split: "
            f"{len(df_in)} train, {len(df_out)} test (need 200/100 minimum)"
        )

    log(f"Train/test split: {len(df_in):,} in-sample / {len(df_out):,} out-of-sample")

    X_train = df_in[feature_cols].values
    y_train = df_in[target_col].values
    X_test = df_out[feature_cols].values
    y_test = df_out[target_col].values

    # ── Correlation analysis (in-sample) ──
    corr_cols = feature_cols + [target_col]
    corr_matrix = df_in[corr_cols].corr()
    # Extract upper triangle as dict
    corr_data = {}
    for i, col_i in enumerate(corr_cols):
        for j, col_j in enumerate(corr_cols):
            if j >= i:
                corr_data[f"{col_i}__{col_j}"] = round(corr_matrix.iloc[i, j], 6)

    models = {}

    # ── Model A: Skew only (linear) ──
    if model_type in ("linear", "both"):
        skew_idx = feature_cols.index("skew") if "skew" in feature_cols else 0
        imb_idx = feature_cols.index("imbalance") if "imbalance" in feature_cols else 1

        reg_skew = LinearRegression(fit_intercept=False)
        reg_skew.fit(X_train[:, [skew_idx]], y_train)
        pred_skew = reg_skew.predict(X_test[:, [skew_idx]])
        models["skew"] = _build_model_result(
            "Skew (top-of-book depth)",
            {"skew": float(reg_skew.coef_[0])},
            pred_skew, y_test, "linear_regression"
        )

        # ── Model B: Imbalance only (linear) ──
        reg_imb = LinearRegression(fit_intercept=False)
        reg_imb.fit(X_train[:, [imb_idx]], y_train)
        pred_imb = reg_imb.predict(X_test[:, [imb_idx]])
        models["imbalance"] = _build_model_result(
            "Imbalance (10-level order count)",
            {"imbalance": float(reg_imb.coef_[0])},
            pred_imb, y_test, "linear_regression"
        )

        # ── Model C: Combined linear (skew + imbalance) ──
        reg_combo = LinearRegression(fit_intercept=False)
        reg_combo.fit(X_train[:, [skew_idx, imb_idx]], y_train)
        pred_combo = reg_combo.predict(X_test[:, [skew_idx, imb_idx]])
        coef_names = ["skew", "imbalance"]
        models["combined_linear"] = _build_model_result(
            "Combined Linear (skew + imbalance)",
            {name: float(c) for name, c in zip(coef_names, reg_combo.coef_)},
            pred_combo, y_test, "linear_regression"
        )

        # ── Model D: All features linear ──
        reg_all = LinearRegression(fit_intercept=False)
        reg_all.fit(X_train, y_train)
        pred_all = reg_all.predict(X_test)
        models["all_features_linear"] = _build_model_result(
            "All Features Linear",
            {name: float(c) for name, c in zip(feature_cols, reg_all.coef_)},
            pred_all, y_test, "linear_regression"
        )

    # ── Model E: Gradient Boosted Trees (all features) ──
    if model_type in ("gradient_boost", "both"):
        log("Training HistGradientBoostingRegressor...")
        gbr = HistGradientBoostingRegressor(
            max_iter=200,
            max_depth=4,
            learning_rate=0.05,
            min_samples_leaf=50,
            random_state=42,
        )
        gbr.fit(X_train, y_train)
        pred_gbr = gbr.predict(X_test)
        models["gradient_boost"] = _build_model_result(
            "Gradient Boosted Trees (all features)",
            {name: float(imp) for name, imp in zip(feature_cols, _get_feature_importance(gbr, feature_cols))},
            pred_gbr, y_test, "gradient_boost"
        )

    return {
        "train_size": len(df_in),
        "test_size": len(df_out),
        "correlation": corr_data,
        "correlation_columns": corr_cols,
        "models": models,
    }


def _build_model_result(name, coefficients, predictions, actual, model_type):
    """Build standardized model result dict."""
    oos_corr = float(np.corrcoef(predictions, actual)[0, 1]) if len(predictions) > 1 else 0.0
    pnl = _cumulative_markout_pnl(predictions, actual)
    r_squared = 1.0 - (np.sum((actual - predictions) ** 2) / np.sum((actual - np.mean(actual)) ** 2))

    return {
        "name": name,
        "type": model_type,
        "coefficients": coefficients,
        "oos_correlation": round(oos_corr, 6),
        "r_squared": round(float(r_squared), 6),
        "final_pnl": round(float(pnl[-1]), 4) if len(pnl) > 0 else 0.0,
        "pnl_curve": [round(float(x), 4) for x in pnl],
        "predictions_sample": [round(float(x), 6) for x in predictions[:20]],
    }


def _get_feature_importance(model, feature_names):
    """Extract feature importance, handling different model types."""
    if hasattr(model, "feature_importances_"):
        return model.feature_importances_
    if hasattr(model, "coef_"):
        return np.abs(model.coef_)
    return np.zeros(len(feature_names))


def _cumulative_markout_pnl(predictions, actual):
    """
    Compute cumulative markout PnL sorted by predictor value.

    This follows the Databento blog methodology:
    - Sort trades by predicted signal strength
    - Flip the sign of actual returns for negative predictions
    - Accumulate returns to show predictive value
    """
    df_pnl = pd.DataFrame({"pred": predictions, "ret": actual})
    df_pnl.loc[df_pnl["pred"] < 0, "ret"] *= -1
    df_pnl = df_pnl.sort_values(by="pred")
    return df_pnl["ret"].cumsum().values


# ── Chart Rendering ──────────────────────────────────────────────────────

def render_chart(results, product, product_name, markout, chart_path):
    """
    Render PnL chart using matplotlib.

    Generates a dark-themed chart showing cumulative markout PnL
    curves for each model, saved as PNG.
    """
    import matplotlib
    matplotlib.use("Agg")  # Non-interactive backend for server
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 6), facecolor="#1e1e2e")
    ax.set_facecolor("#1e1e2e")

    colors = {
        "skew": "#3b82f6",            # Blue
        "imbalance": "#facc15",       # Yellow
        "combined_linear": "#22c55e", # Green
        "all_features_linear": "#a855f7",  # Purple
        "gradient_boost": "#ef4444",  # Red
    }

    labels = {
        "skew": "Skew (top-of-book)",
        "imbalance": "Imbalance (10-level)",
        "combined_linear": "Combined Linear",
        "all_features_linear": "All Features Linear",
        "gradient_boost": "Gradient Boost",
    }

    test_size = results["test_size"]
    models = results["models"]

    for model_key, model_data in models.items():
        pnl = model_data["pnl_curve"]
        if not pnl:
            continue
        pct = np.linspace(0, 100, len(pnl))
        color = colors.get(model_key, "#888888")
        label = labels.get(model_key, model_data["name"])
        lw = 2.5 if model_key == "gradient_boost" else 1.8
        ax.plot(pct, pnl, color=color, linewidth=lw, label=label, alpha=0.9)

    ax.set_xlabel("Predictor value (percentile)", color="#a0a0a0", fontsize=11)
    ax.set_ylabel("Cumulative return (ticks)", color="#a0a0a0", fontsize=11)
    ax.set_title(
        f"{product} ({product_name}) — ML Order Book Forecast",
        color="#e0e0e0", fontsize=14, fontweight="bold", pad=12,
    )
    ax.text(
        0.5, 1.02,
        f"MBP-10 schema | {markout}-trade markout | {test_size:,} test samples",
        transform=ax.transAxes, ha="center", color="#888888", fontsize=9,
    )

    ax.tick_params(colors="#a0a0a0")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#444")
    ax.spines["bottom"].set_color("#444")
    ax.grid(True, alpha=0.1, color="white")

    ax.legend(
        loc="upper left", framealpha=0.8, facecolor="#2a2a3e",
        edgecolor="#444", fontsize=9, labelcolor="#c0c0c0",
    )

    plt.tight_layout()
    plt.savefig(chart_path, dpi=150, bbox_inches="tight", facecolor="#1e1e2e")
    plt.close(fig)
    log(f"Chart saved to {chart_path}")


# ── Main Pipeline ────────────────────────────────────────────────────────

def run_prediction(api_key, product, start, end, markout=500, train_split=0.66, model_type="both"):
    """
    Run the full ML prediction pipeline.

    1. Fetch MBP-10 data via Databento Python client
    2. Extract order book features (skew, imbalance, depth, spread, microprice)
    3. Train linear regression + gradient boosted trees
    4. Evaluate on out-of-sample data
    5. Render PnL chart
    6. Return JSON results

    Returns:
        dict with all results (serializable to JSON)
    """
    product = product.upper()
    meta = PRODUCTS.get(product)
    if not meta:
        raise ValueError(f"Unknown product: {product}")

    # Fetch data
    df = fetch_mbp10_data(api_key, product, start, end)

    # Build features
    df_features, feature_cols, target_col = build_features(df, markout=markout)

    # Train models
    results = train_models(
        df_features, feature_cols, target_col,
        train_split=train_split, model_type=model_type,
    )

    # Render chart
    chart_path = os.path.join(tempfile.gettempdir(), f"ml-predict-{product}.png")
    try:
        render_chart(results, product, meta["name"], markout, chart_path)
    except Exception as e:
        log(f"Chart rendering failed: {e}")
        chart_path = None

    # Build output
    output = {
        "product": product,
        "product_name": meta["name"],
        "schema": "mbp-10",
        "start": start,
        "end": end,
        "markout": markout,
        "train_split": train_split,
        "feature_columns": feature_cols,
        "total_raw_records": len(df),
        "total_trade_samples": len(df_features),
        "train_size": results["train_size"],
        "test_size": results["test_size"],
        "correlation": results["correlation"],
        "correlation_columns": results["correlation_columns"],
        "models": {},
        "chart_path": chart_path,
    }

    # Include model results (without full PnL curve to keep JSON manageable)
    best_model = None
    best_pnl = -float("inf")
    for key, model in results["models"].items():
        output["models"][key] = {
            "name": model["name"],
            "type": model["type"],
            "coefficients": model["coefficients"],
            "oos_correlation": model["oos_correlation"],
            "r_squared": model["r_squared"],
            "final_pnl": model["final_pnl"],
        }
        if model["final_pnl"] > best_pnl:
            best_pnl = model["final_pnl"]
            best_model = key

    output["best_model"] = best_model
    output["best_model_name"] = results["models"][best_model]["name"] if best_model else None
    output["best_pnl"] = round(best_pnl, 4)

    return output


# ── CLI Entry Point ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ML Trading Predictor — MBP-10 Order Book Analysis")
    parser.add_argument("--product", required=True, help="Futures product (ES, NQ, CL, GC, etc.)")
    parser.add_argument("--start", help="Start time (ISO 8601 or YYYY-MM-DD)")
    parser.add_argument("--end", help="End time (ISO 8601 or YYYY-MM-DD)")
    parser.add_argument("--date", help="Trading date (YYYY-MM-DD, shortcut for start/end)")
    parser.add_argument("--markout", type=int, default=500, help="Forward trade count for returns (default: 500)")
    parser.add_argument("--train-split", type=float, default=0.66, help="In-sample fraction (default: 0.66)")
    parser.add_argument("--model", choices=["linear", "gradient_boost", "both"], default="both",
                       help="Model type to train (default: both)")
    parser.add_argument("--api-key", help="Databento API key (or set DATABENTO_API_KEY env var)")
    args = parser.parse_args()

    # Resolve API key
    api_key = args.api_key or os.environ.get("DATABENTO_API_KEY", "")
    if not api_key:
        print(json.dumps({"error": "No Databento API key. Set DATABENTO_API_KEY or pass --api-key"}))
        sys.exit(1)

    # Resolve time range
    if args.date:
        start = f"{args.date}T14:30"
        end = f"{args.date}T21:00"
    elif args.start and args.end:
        start = args.start
        end = args.end
    else:
        date = last_trading_day()
        start = f"{date}T14:30"
        end = f"{date}T21:00"

    try:
        result = run_prediction(
            api_key=api_key,
            product=args.product,
            start=start,
            end=end,
            markout=args.markout,
            train_split=args.train_split,
            model_type=args.model,
        )
        # Output JSON to stdout (Node.js reads this)
        print(json.dumps(result))
    except Exception as e:
        log(f"ERROR: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
