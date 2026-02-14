#!/usr/bin/env python3
"""
Portfolio-Level Walk-Forward ML Backtester  (v2 — modular architecture)

Separated modules following the historical-replay pattern:
  SimulationClock  — single monotonic clock; hard-errors on lookahead
  DataProvider     — canonical dates×tickers panel with explicit missing rules
  SignalModel      — walk-forward ML (pooled GBT/Ridge); produces per-ticker preds
  PortfolioEngine  — ranking + weighting (equal / vol_target) + caps
  ExecutionSimulator — daily P&L, turnover, costs; signal@t -> trade@t+1

Config-driven: slash command args -> BacktestConfig -> deterministic hash -> output.
"""

import sys
import os
import json
import hashlib
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


# ══════════════════════════════════════════════════════════════════════════
#  1. BacktestConfig  — config-driven runs with deterministic hash
# ══════════════════════════════════════════════════════════════════════════

class BacktestConfig:
    """Immutable config compiled from slash command args.
    Serialisable to dict, hashable for dedup/caching."""

    __slots__ = (
        "tickers", "start_date", "end_date", "days",
        "forward", "rebalance", "top_k", "bottom_k",
        "weighting", "max_weight", "max_leverage",
        "cost_bps", "slippage_bps", "vol_window",
        "target_vol_annual", "model_type", "seed", "data_dir",
    )

    def __init__(self, **kw):
        self.tickers = kw.get("tickers", "mega")
        self.start_date = kw.get("start_date")
        self.end_date = kw.get("end_date")
        self.days = kw.get("days")
        self.forward = kw.get("forward", 20)
        self.rebalance = kw.get("rebalance", "W-MON")
        self.top_k = kw.get("top_k", 10)
        self.bottom_k = kw.get("bottom_k", 0)
        self.weighting = kw.get("weighting", "equal")
        self.max_weight = kw.get("max_weight", 0.15)
        self.max_leverage = kw.get("max_leverage", 1.0)
        self.cost_bps = kw.get("cost_bps", 10)
        self.slippage_bps = kw.get("slippage_bps", 0)
        self.vol_window = kw.get("vol_window", 20)
        self.target_vol_annual = kw.get("target_vol_annual", 0.15)
        self.model_type = kw.get("model_type", "gradient_boost")
        self.seed = kw.get("seed", 42)
        self.data_dir = kw.get("data_dir")

    def to_dict(self):
        return {s: getattr(self, s) for s in self.__slots__}

    def config_hash(self):
        """Deterministic SHA-256 of the config for dedup/caching.
        data_dir is excluded (local path artefact, doesn't affect results)."""
        d = self.to_dict()
        d.pop("data_dir", None)
        canonical = json.dumps(d, sort_keys=True, default=str)
        return hashlib.sha256(canonical.encode()).hexdigest()[:12]

    def summary_line(self, n_tickers_loaded):
        return (
            f"{n_tickers_loaded} tickers | fwd={self.forward}d | reb={self.rebalance} | "
            f"top_k={self.top_k} | cost={self.cost_bps}bp | slip={self.slippage_bps}bp | "
            f"wt={self.weighting} | vol_tgt={self.target_vol_annual:.0%} | "
            f"lev_cap={self.max_leverage} | seed={self.seed} | cfg={self.config_hash()}"
        )

    def resolve_tickers(self):
        tickers = self.tickers
        if isinstance(tickers, str):
            if tickers.lower() in UNIVERSES:
                return list(UNIVERSES[tickers.lower()])
            return [t.strip().upper() for t in tickers.split(",") if t.strip()]
        return [t.upper() for t in tickers]


# ══════════════════════════════════════════════════════════════════════════
#  2. SimulationClock — single monotonic asOfDate, anti-lookahead
# ══════════════════════════════════════════════════════════════════════════

class LookaheadError(RuntimeError):
    """Hard error raised when any component attempts to access future data."""
    pass


class SimulationClock:
    """Single monotonic simulation clock.
    Every module checks data access against this clock.
    Violations throw LookaheadError (not a warning — a hard stop)."""

    def __init__(self):
        _ensure_imports()
        self._as_of_date = None
        self._all_dates = None
        self._date_set = None
        self._violation_log = []

    def initialize(self, all_dates):
        """Set the universe of dates the sim can iterate over."""
        self._all_dates = sorted(all_dates)
        self._date_set = set(pd.Timestamp(d) for d in self._all_dates)
        self._as_of_date = None

    @property
    def as_of_date(self):
        return self._as_of_date

    def advance_to(self, date):
        """Advance clock forward.  Cannot go backward."""
        ts = pd.Timestamp(date)
        if self._as_of_date is not None and ts < self._as_of_date:
            raise LookaheadError(
                f"SimulationClock: cannot rewind from {self._as_of_date.date()} to {ts.date()}"
            )
        self._as_of_date = ts

    def guard_data_access(self, requested_date, context=""):
        """Hard-error if any code tries to read data after as_of_date.
        Call this from DataProvider/SignalModel whenever data is sliced."""
        ts = pd.Timestamp(requested_date)
        if self._as_of_date is not None and ts > self._as_of_date:
            msg = (
                f"LOOKAHEAD VIOLATION [{context}]: tried to access data at "
                f"{ts.date()} but clock is at {self._as_of_date.date()}"
            )
            self._violation_log.append(msg)
            raise LookaheadError(msg)

    def guard_training_data(self, train_end_date, signal_date, context=""):
        """Verify training data ends strictly before signal date."""
        te = pd.Timestamp(train_end_date)
        sd = pd.Timestamp(signal_date)
        if te >= sd:
            msg = (
                f"LOOKAHEAD VIOLATION [{context}]: training data ends at "
                f"{te.date()} but signal date is {sd.date()} — train must end < signal"
            )
            self._violation_log.append(msg)
            raise LookaheadError(msg)

    @property
    def violations(self):
        return list(self._violation_log)


# ══════════════════════════════════════════════════════════════════════════
#  3. DataProvider  — canonical dates×tickers panel, missing-data rules
# ══════════════════════════════════════════════════════════════════════════

FEATURE_NAMES = [
    "mom_5d", "mom_20d", "mom_60d", "mom_252d",
    "vol_20d", "vol_60d", "rel_vol_20d",
    "rsi_14", "bb_pctb", "dist_52w_high", "dist_52w_low",
    "sma_20_50", "sma_50_200", "mean_rev_20d",
]


class DataProvider:
    """Loads, aligns, and serves price/feature data.
    Builds the canonical dates×tickers panel with explicit missing-data rules:
      - Intersection calendar: only dates where ALL tickers have prices
      - Forward-fill: up to 5 days for holidays/halts per ticker before intersection
      - Drop: tickers with >20% missing after ffill
      - NaN masking: features with NaN are dropped row-wise after rolling warm-up
    """

    def __init__(self, clock: SimulationClock):
        _ensure_imports()
        self.clock = clock
        self.price_dict = {}
        self.common_dates = []
        self.missing_report = {}
        self.close_matrix = None       # dates × tickers
        self.return_matrix = None      # dates × tickers
        self.feature_df = None         # stacked [date, ticker, features..., fwd_return]
        self.feature_cols = []
        self._data_loaded = False

    def load(self, cfg: BacktestConfig):
        """Load all data for the given config."""
        from data_loader import ensure_data, load_prices

        data_dir = ensure_data(cfg.data_dir)
        ticker_list = cfg.resolve_tickers()

        if not ticker_list:
            raise ValueError("No tickers provided")
        log(f"Universe: {len(ticker_list)} tickers: {ticker_list[:10]}{'...' if len(ticker_list) > 10 else ''}")

        # Load per-ticker prices
        price_dict = {}
        missing_report = {}

        for tkr in ticker_list:
            try:
                df = load_prices(data_dir, ticker=tkr)
                if len(df) == 0:
                    missing_report[tkr] = "no_data"
                    continue

                df = self._normalize_columns(df)
                if df is None:
                    missing_report[tkr] = "missing_required_columns"
                    continue

                # Forward-fill up to 5 days for minor gaps (holidays/halts)
                df = df.set_index("date").asfreq("B").ffill(limit=5).reset_index()
                df = df.rename(columns={"index": "date"})
                price_dict[tkr] = df

            except Exception as e:
                missing_report[tkr] = str(e)
                log(f"  Failed to load {tkr}: {e}")

        if not price_dict:
            raise ValueError("No ticker data loaded successfully")

        # Build intersection calendar
        date_sets = [set(df["date"].dropna().values) for df in price_dict.values()]
        common = date_sets[0]
        for ds in date_sets[1:]:
            common = common.intersection(ds)
        common_dates = sorted(common)

        # Drop tickers that lost >20% of dates after intersection
        total_dates = len(common_dates)
        for tkr in list(price_dict.keys()):
            ticker_dates = set(price_dict[tkr]["date"].values)
            overlap = len(ticker_dates.intersection(common))
            if total_dates > 0 and overlap / total_dates < 0.80:
                missing_report[tkr] = f"insufficient_overlap ({overlap}/{total_dates})"
                del price_dict[tkr]

        # Recalculate intersection after drops
        if price_dict:
            date_sets = [set(df["date"].dropna().values) for df in price_dict.values()]
            common = date_sets[0]
            for ds in date_sets[1:]:
                common = common.intersection(ds)
            common_dates = sorted(common)

        if len(common_dates) < 252:
            raise ValueError(
                f"Only {len(common_dates)} common trading dates across {len(price_dict)} tickers. "
                f"Need at least 252. Consider fewer tickers or wider date range."
            )

        # Filter by date range from config
        if cfg.start_date:
            sd = pd.Timestamp(cfg.start_date)
            common_dates = [d for d in common_dates if pd.Timestamp(d) >= sd]
        if cfg.end_date:
            ed = pd.Timestamp(cfg.end_date)
            common_dates = [d for d in common_dates if pd.Timestamp(d) <= ed]
        if cfg.days and not cfg.start_date:
            if len(common_dates) > cfg.days:
                common_dates = common_dates[-cfg.days:]

        if len(common_dates) < 300:
            raise ValueError(f"Only {len(common_dates)} common dates in range. Need >= 300.")

        # Filter price dicts to common dates
        common_set = set(common_dates)
        for tkr in list(price_dict.keys()):
            price_dict[tkr] = (price_dict[tkr][price_dict[tkr]["date"].isin(common_set)]
                               .sort_values("date").reset_index(drop=True))

        self.price_dict = price_dict
        self.common_dates = common_dates
        self.missing_report = missing_report

        log(f"Canonical panel: {len(price_dict)} tickers × {len(common_dates)} dates "
            f"({pd.Timestamp(common_dates[0]).date()} to {pd.Timestamp(common_dates[-1]).date()})")

        # Build matrices
        self._build_matrices(cfg.forward)
        self._data_loaded = True

    def _normalize_columns(self, df):
        """Normalize column names to [date, open, high, low, close, volume]."""
        df.columns = [c.lower().strip() for c in df.columns]
        col_map = {}
        for target, candidates in [
            ("close", ["adj close", "adjclose", "adj_close", "close"]),
            ("open", ["open"]),
            ("high", ["high"]),
            ("low", ["low"]),
            ("volume", ["volume", "vol"]),
        ]:
            for c in candidates:
                key = c.replace(" ", "").replace("_", "")
                for orig in df.columns:
                    if orig.replace(" ", "").replace("_", "") == key:
                        col_map[orig] = target
                        break
                if target in col_map.values():
                    break

        df = df.rename(columns=col_map)
        if "close" not in df.columns or "date" not in df.columns:
            return None

        df["date"] = pd.to_datetime(df["date"])
        df = df.sort_values("date").drop_duplicates("date")
        needed = ["date", "close"]
        for c in ["open", "high", "low", "volume"]:
            if c in df.columns:
                needed.append(c)
        return df[needed].reset_index(drop=True)

    def _build_matrices(self, forward_days):
        """Build close matrix, return matrix, and stacked feature DataFrame."""
        all_frames = []
        close_dict = {}
        available_features = None

        for tkr, df in self.price_dict.items():
            feat_df = self._build_features_single(df, forward_days)
            feat_df["ticker"] = tkr
            all_frames.append(feat_df)
            close_dict[tkr] = df.set_index("date")["close"]

            ticker_features = [f for f in FEATURE_NAMES if f in feat_df.columns]
            if available_features is None:
                available_features = set(ticker_features)
            else:
                available_features = available_features.intersection(ticker_features)

        feature_cols = sorted(available_features) if available_features else []
        if not feature_cols:
            raise ValueError("No common features could be built across tickers")

        stacked = pd.concat(all_frames, ignore_index=True)
        keep_cols = ["date", "ticker"] + feature_cols + ["fwd_return"]
        stacked = stacked[keep_cols].replace([np.inf, -np.inf], np.nan).dropna()

        close_matrix = pd.DataFrame(close_dict)
        close_matrix = close_matrix.reindex(pd.DatetimeIndex(self.common_dates))
        return_matrix = close_matrix.pct_change()

        self.feature_df = stacked
        self.feature_cols = feature_cols
        self.close_matrix = close_matrix
        self.return_matrix = return_matrix

        log(f"Feature matrix: {len(stacked):,} rows, {len(feature_cols)} features, "
            f"{stacked['ticker'].nunique()} tickers")

    @staticmethod
    def _build_features_single(prices_df, forward_days):
        """Build technical features for one ticker. All windows left-aligned."""
        df = prices_df.copy()
        close = df["close"]
        ret_1d = close.pct_change()

        df["fwd_return"] = np.log(close.shift(-forward_days) / close)

        for period in [5, 20, 60, 252]:
            df[f"mom_{period}d"] = close / close.shift(period) - 1.0

        df["vol_20d"] = ret_1d.rolling(20).std()
        df["vol_60d"] = ret_1d.rolling(60).std()

        if "volume" in df.columns:
            vol = df["volume"].replace(0, np.nan)
            df["rel_vol_20d"] = vol / vol.rolling(20).mean()

        delta = close.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss.replace(0, np.nan)
        df["rsi_14"] = 100.0 - (100.0 / (1.0 + rs))

        sma20 = close.rolling(20).mean()
        std20 = close.rolling(20).std()
        bandwidth = (4.0 * std20).replace(0, np.nan)
        df["bb_pctb"] = (close - (sma20 - 2.0 * std20)) / bandwidth

        if "high" in df.columns and "low" in df.columns:
            high_252 = df["high"].rolling(252).max()
            low_252 = df["low"].rolling(252).min()
            rng = (high_252 - low_252).replace(0, np.nan)
            df["dist_52w_high"] = (close - high_252) / rng
            df["dist_52w_low"] = (close - low_252) / rng

        sma50 = close.rolling(50).mean()
        sma200 = close.rolling(200).mean()
        df["sma_20_50"] = sma20 / sma50 - 1.0
        df["sma_50_200"] = sma50 / sma200 - 1.0
        df["mean_rev_20d"] = close / sma20 - 1.0

        return df

    def get_training_data(self, before_date, feature_cols):
        """Return (X, y, dates, tickers) for rows strictly before `before_date`.
        Clock-guarded: the latest row returned is < before_date."""
        self.clock.guard_data_access(before_date, context="DataProvider.get_training_data")
        mask = self.feature_df["date"] < before_date
        df = self.feature_df[mask]
        return df

    def get_signal_data(self, at_date, feature_cols):
        """Return feature rows at exactly `at_date` for prediction.
        Clock-guarded."""
        self.clock.guard_data_access(at_date, context="DataProvider.get_signal_data")
        mask = self.feature_df["date"] == at_date
        return self.feature_df[mask]

    def get_return_matrix_up_to(self, date):
        """Return return matrix up to and including `date`. Clock-guarded."""
        self.clock.guard_data_access(date, context="DataProvider.get_return_matrix")
        ts = pd.Timestamp(date)
        return self.return_matrix.loc[:ts]

    @property
    def panel_stats(self):
        """Summary stats for the canonical panel."""
        n_tickers = len(self.price_dict)
        n_dates = len(self.common_dates)
        total_cells = n_tickers * n_dates
        non_null = sum(
            self.close_matrix[t].notna().sum() for t in self.close_matrix.columns
        ) if self.close_matrix is not None else 0
        fill_rate = non_null / total_cells if total_cells > 0 else 0
        return {
            "tickers": n_tickers,
            "dates": n_dates,
            "fill_rate": round(fill_rate, 4),
            "missing_tickers": len(self.missing_report),
        }


# ══════════════════════════════════════════════════════════════════════════
#  4. SignalModel  — walk-forward ML, pooled GBT/Ridge
# ══════════════════════════════════════════════════════════════════════════

class SignalModel:
    """Walk-forward ML signal generator.
    At each rebalance: train on expanding window of past data -> predict."""

    def __init__(self, clock: SimulationClock, data: DataProvider):
        _ensure_imports()
        self.clock = clock
        self.data = data

    def generate_signals(self, rebalance_dates, cfg: BacktestConfig):
        """Produce signals_df: [date, ticker, predicted_return, actual_return].
        Uses pooled model with ticker one-hot encoding.
        Clock advances to each rebalance date; hard-errors on lookahead."""
        from sklearn.linear_model import Ridge
        from sklearn.ensemble import HistGradientBoostingRegressor
        from sklearn.preprocessing import StandardScaler

        feature_cols = self.data.feature_cols
        feature_df = self.data.feature_df

        # Pre-compute ticker one-hot
        tickers = sorted(feature_df["ticker"].unique())
        ticker_to_idx = {t: i for i, t in enumerate(tickers)}

        ticker_onehot = np.zeros((len(feature_df), len(tickers)), dtype=np.float32)
        for i, tkr in enumerate(feature_df["ticker"].values):
            ticker_onehot[i, ticker_to_idx[tkr]] = 1.0

        feature_values = feature_df[feature_cols].values.astype(np.float64)
        target_values = feature_df["fwd_return"].values.astype(np.float64)
        dates_arr = feature_df["date"].values
        ticker_ids = feature_df["ticker"].values
        X_all = np.hstack([feature_values, ticker_onehot])

        signals = []
        train_info = {"rebalance_count": 0, "avg_train_size": 0, "model_type": cfg.model_type}
        total_train_size = 0

        for reb_date in rebalance_dates:
            # Advance the clock — this IS the point in simulated time
            self.clock.advance_to(reb_date)

            # Train mask: strictly before reb_date
            train_mask = dates_arr < reb_date
            test_mask = dates_arr == reb_date

            n_train = train_mask.sum()
            n_test = test_mask.sum()

            if n_train < 200 or n_test == 0:
                continue

            # Anti-lookahead: verify max training date < reb_date
            max_train_date = dates_arr[train_mask].max()
            self.clock.guard_training_data(max_train_date, reb_date,
                                           context="SignalModel.generate_signals")

            X_train = X_all[train_mask]
            y_train = target_values[train_mask]
            X_test = X_all[test_mask]

            # Scale (fit on train only)
            scaler = StandardScaler()
            X_train_scaled = scaler.fit_transform(X_train)
            X_test_scaled = scaler.transform(X_test)

            if cfg.model_type == "linear":
                model = Ridge(alpha=1.0, random_state=cfg.seed)
            else:
                model = HistGradientBoostingRegressor(
                    max_iter=200, max_depth=4, learning_rate=0.05,
                    min_samples_leaf=20, random_state=cfg.seed,
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


# ══════════════════════════════════════════════════════════════════════════
#  5. PortfolioEngine  — ranking, weighting, caps
# ══════════════════════════════════════════════════════════════════════════

class PortfolioEngine:
    """Converts signals -> portfolio weights at each rebalance."""

    def __init__(self, clock: SimulationClock, data: DataProvider):
        _ensure_imports()
        self.clock = clock
        self.data = data

    def construct(self, signals_at_date, cfg: BacktestConfig, current_date):
        """Rank by predicted return, select top_k/bottom_k, weight, cap."""
        if len(signals_at_date) == 0:
            return {}

        ranked = signals_at_date.sort_values("predicted_return", ascending=False)

        long_tickers = list(ranked.head(cfg.top_k)["ticker"].values)
        short_tickers = (list(ranked.tail(cfg.bottom_k)["ticker"].values)
                         if cfg.bottom_k > 0 else [])
        short_tickers = [t for t in short_tickers if t not in long_tickers]

        selected = long_tickers + short_tickers
        if not selected:
            return {}

        if cfg.weighting == "equal":
            weights = self._equal_weight(long_tickers, short_tickers)
        elif cfg.weighting == "vol_target":
            weights = self._vol_target_weight(
                long_tickers, short_tickers, cfg, current_date
            )
        else:
            raise ValueError(f"Unknown weighting: {cfg.weighting}")

        return self._cap_weights(weights, cfg.max_weight, cfg.max_leverage)

    @staticmethod
    def _equal_weight(long_tickers, short_tickers):
        n = len(long_tickers) + len(short_tickers)
        weights = {}
        for t in long_tickers:
            weights[t] = 1.0 / n
        for t in short_tickers:
            weights[t] = -1.0 / n
        return weights

    def _vol_target_weight(self, long_tickers, short_tickers, cfg, current_date):
        selected = long_tickers + short_tickers
        ret_matrix = self.data.get_return_matrix_up_to(current_date)
        end_loc = ret_matrix.index.get_indexer([current_date], method="ffill")[0]
        start_loc = max(0, end_loc - cfg.vol_window + 1)

        if end_loc < cfg.vol_window:
            return self._equal_weight(long_tickers, short_tickers)

        trailing = ret_matrix.iloc[start_loc:end_loc + 1]
        vols = {}
        for t in selected:
            if t in trailing.columns:
                v = trailing[t].std()
                vols[t] = v if v > 0 and not np.isnan(v) else 1e-6
            else:
                vols[t] = 1e-6

        inv_vol = {t: 1.0 / vols[t] for t in selected}
        total_inv_vol = sum(inv_vol.values())

        weights = {}
        for t in long_tickers:
            weights[t] = inv_vol[t] / total_inv_vol
        for t in short_tickers:
            weights[t] = -(inv_vol[t] / total_inv_vol)

        port_var = sum(weights[t] ** 2 * (vols[t] * np.sqrt(252)) ** 2 for t in selected)
        port_vol = np.sqrt(port_var) if port_var > 0 else 1e-6
        vol_scalar = cfg.target_vol_annual / port_vol

        return {t: w * vol_scalar for t, w in weights.items()}

    @staticmethod
    def _cap_weights(weights, max_weight, max_leverage):
        if not weights:
            return weights
        for t in weights:
            weights[t] = max(-max_weight, min(max_weight, weights[t]))
        gross = sum(abs(w) for w in weights.values())
        if gross > max_leverage and gross > 0:
            scale = max_leverage / gross
            weights = {t: w * scale for t, w in weights.items()}
        return weights


# ══════════════════════════════════════════════════════════════════════════
#  6. ExecutionSimulator — daily P&L, turnover, costs
# ══════════════════════════════════════════════════════════════════════════

class ExecutionSimulator:
    """Simulates daily portfolio returns.
    KEY INVARIANT: signal at t -> new weights take effect at t+1.
    Uses pending_rebalance flag (never same-bar trading)."""

    def __init__(self, clock: SimulationClock, data: DataProvider,
                 portfolio_engine: PortfolioEngine):
        _ensure_imports()
        self.clock = clock
        self.data = data
        self.portfolio_engine = portfolio_engine

    def run(self, signals_df, cfg: BacktestConfig, oos_dates):
        """Execute the backtest over oos_dates."""
        return_matrix = self.data.return_matrix
        cost_rate = (cfg.cost_bps + cfg.slippage_bps) / 10000.0

        rebalance_dates = sorted(signals_df["date"].unique())
        all_dates_ts = pd.DatetimeIndex(sorted(oos_dates))

        signals_by_date = {}
        for reb_date in rebalance_dates:
            mask = signals_df["date"] == reb_date
            signals_by_date[reb_date] = signals_df[mask][["ticker", "predicted_return"]].copy()

        current_weights = {}
        daily_returns_gross = []
        daily_returns_net = []
        daily_dates = []
        turnover_by_date = {}
        holdings_count = []
        rebalance_trade_dates = set()

        pending_new_weights = None
        pending_rebalance = False

        for i, date in enumerate(all_dates_ts):
            # Advance clock to this date
            self.clock.advance_to(date)

            # Apply pending weights (signal was yesterday -> trade today)
            if pending_rebalance and pending_new_weights is not None:
                old_weights = current_weights.copy()
                current_weights = pending_new_weights

                all_tickers = set(list(old_weights.keys()) + list(current_weights.keys()))
                turnover = sum(abs(current_weights.get(t, 0) - old_weights.get(t, 0))
                               for t in all_tickers)
                turnover_by_date[date] = turnover
                rebalance_trade_dates.add(date)

                pending_new_weights = None
                pending_rebalance = False

            # If today is a signal date, compute new weights (applied TOMORROW)
            if date in signals_by_date:
                new_weights = self.portfolio_engine.construct(
                    signals_by_date[date], cfg, date
                )
                pending_new_weights = new_weights
                pending_rebalance = True

            # Daily return using CURRENT weights (pre-rebalance for today's signal)
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

            cost_today = 0.0
            if date in rebalance_trade_dates:
                cost_today = turnover_by_date.get(date, 0) * cost_rate

            daily_returns_net.append(day_return - cost_today)
            daily_dates.append(date)
            holdings_count.append(len(current_weights))

        # Verify costs only at rebalance (hard assertion)
        for d, tv in turnover_by_date.items():
            if d not in rebalance_trade_dates and tv > 0:
                raise LookaheadError(f"Turnover on non-rebalance day {d}")

        return {
            "daily_dates": [str(d.date()) if hasattr(d, 'date') else str(d)[:10]
                            for d in daily_dates],
            "daily_returns_gross": daily_returns_gross,
            "daily_returns_net": daily_returns_net,
            "turnover_by_date": {str(k.date()) if hasattr(k, 'date') else str(k)[:10]: v
                                 for k, v in turnover_by_date.items()},
            "holdings_count": holdings_count,
            "num_rebalances": len(rebalance_trade_dates),
            "total_cost": sum(tv * cost_rate for tv in turnover_by_date.values()),
        }


# ══════════════════════════════════════════════════════════════════════════
#  Benchmarks & Metrics  (stateless utilities, unchanged)
# ══════════════════════════════════════════════════════════════════════════

def compute_benchmarks(return_matrix, common_dates, tickers, top_k,
                       cost_bps, slippage_bps, seed):
    _ensure_imports()
    rng = np.random.RandomState(seed + 1)
    cost_rate = (cost_bps + slippage_bps) / 10000.0
    dates = pd.DatetimeIndex(common_dates)
    benchmarks = {}

    ew_tickers = [t for t in tickers if t in return_matrix.columns]
    if ew_tickers:
        n = len(ew_tickers)
        w = 1.0 / n
        ew_returns = []
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

    if "SPY" in return_matrix.columns:
        spy_returns = []
        for date in dates:
            if date in return_matrix.index:
                r = return_matrix.loc[date, "SPY"]
                spy_returns.append(r if not np.isnan(r) else 0.0)
            else:
                spy_returns.append(0.0)
        benchmarks["spy_bh"] = {"name": "SPY Buy & Hold", "daily_returns": spy_returns}

    if ew_tickers and top_k <= len(ew_tickers):
        rand_returns = []
        current_picks = []
        prev_month = None
        for i, date in enumerate(dates):
            month_key = (date.year, date.month)
            if month_key != prev_month:
                old_picks = set(current_picks)
                current_picks = list(rng.choice(ew_tickers,
                                                size=min(top_k, len(ew_tickers)), replace=False))
                new_picks = set(current_picks)
                if prev_month is not None:
                    all_t = old_picks.union(new_picks)
                    w_per = 1.0 / len(current_picks) if current_picks else 0
                    turnover = sum(abs((w_per if t in new_picks else 0) -
                                       (w_per if t in old_picks else 0)) for t in all_t)
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
                              if t in return_matrix.columns
                              and not np.isnan(return_matrix.loc[date, t]))
            else:
                day_ret = 0.0

            cost_today = turnover * cost_rate if turnover > 0 else 0
            rand_returns.append(day_ret - cost_today)

        benchmarks["random_baseline"] = {
            "name": f"Random {top_k}-pick (monthly, net)",
            "daily_returns": rand_returns,
        }

    return benchmarks


def compute_metrics(daily_returns, daily_dates=None, label="Strategy"):
    _ensure_imports()
    rets = np.array(daily_returns, dtype=np.float64)
    rets = np.nan_to_num(rets, nan=0.0)
    n_days = len(rets)
    if n_days < 2:
        return {"label": label, "total_return": 0.0, "cagr": 0.0, "vol": 0.0,
                "sharpe": 0.0, "sortino": 0.0, "max_dd": 0.0, "calmar": 0.0,
                "n_days": 0, "equity_curve": []}

    equity = np.cumprod(1.0 + rets)
    total_return = equity[-1] / equity[0] - 1.0 if equity[0] != 0 else 0.0

    n_years = n_days / 252.0
    cagr = ((equity[-1] / equity[0]) ** (1.0 / n_years) - 1.0
            if n_years > 0 and equity[-1] > 0 and equity[0] > 0 else 0.0)

    vol = np.std(rets, ddof=1) * np.sqrt(252) if n_days > 1 else 0.0
    excess_mean = np.mean(rets) * 252
    sharpe = excess_mean / vol if vol > 0 else 0.0

    downside = rets[rets < 0]
    downside_std = np.std(downside, ddof=1) * np.sqrt(252) if len(downside) > 1 else 1e-6
    sortino = excess_mean / downside_std if downside_std > 0 else 0.0

    running_max = np.maximum.accumulate(equity)
    drawdowns = (equity - running_max) / running_max
    max_dd = float(np.min(drawdowns))
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


def compute_hit_rate_at_rebalance(signals_df):
    if len(signals_df) == 0:
        return 0.0
    return float(((signals_df["predicted_return"] > 0) ==
                   (signals_df["actual_return"] > 0)).mean())


def compute_subperiod_metrics(daily_returns, daily_dates, label="Strategy"):
    years = {}
    for r, d in zip(daily_returns, daily_dates):
        y = str(d)[:4]
        years.setdefault(y, []).append(r)
    result = {}
    for y, rets in sorted(years.items()):
        m = compute_metrics(rets, label=f"{label} {y}")
        m.pop("equity_curve", None)
        result[y] = m
    return result


# ── Chart Rendering ──────────────────────────────────────────────────────

def render_portfolio_chart(strategy_metrics, benchmark_metrics_dict,
                           daily_dates, config_summary, chart_path):
    _ensure_imports()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 9), facecolor="#1e1e2e",
                                    gridspec_kw={"height_ratios": [3, 2]})
    ax1.set_facecolor("#1e1e2e")

    for key, color in {"gross": "#22c55e", "net": "#3b82f6"}.items():
        eq = strategy_metrics.get(key, {}).get("equity_curve", [])
        if eq:
            ax1.plot(range(len(eq)), eq, color=color, linewidth=2.0,
                     label=f"Strategy ({key})", alpha=0.9)

    bench_colors = ["#ef4444", "#f59e0b", "#a855f7", "#06b6d4"]
    for idx, (bkey, bm) in enumerate(benchmark_metrics_dict.items()):
        eq = bm.get("equity_curve", [])
        if eq:
            ax1.plot(range(len(eq)), eq, color=bench_colors[idx % len(bench_colors)],
                     linewidth=1.3, label=bm.get("label", bkey), alpha=0.7, linestyle="--")

    ax1.axhline(1.0, color="#555", linewidth=0.8, linestyle="--")
    ax1.set_ylabel("Equity (growth of $1)", color="#a0a0a0", fontsize=10)
    ax1.set_title("Portfolio ML Backtest — Equity Curves",
                  color="#e0e0e0", fontsize=13, fontweight="bold", pad=10)
    ax1.text(0.5, 1.02, config_summary,
             transform=ax1.transAxes, ha="center", color="#888", fontsize=7)
    _style_ax(ax1)
    ax1.legend(loc="upper left", framealpha=0.8, facecolor="#2a2a3e",
               edgecolor="#444", fontsize=8, labelcolor="#c0c0c0")

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


# ── Rebalance schedule ───────────────────────────────────────────────────

def get_rebalance_dates(common_dates, rebalance_freq, start_after_idx=252):
    _ensure_imports()
    dates = pd.DatetimeIndex(common_dates)
    if start_after_idx >= len(dates):
        raise ValueError(f"start_after_idx={start_after_idx} >= total dates={len(dates)}")

    eligible_dates = dates[start_after_idx:]
    start = eligible_dates[0]
    end = eligible_dates[-1]

    freq_map = {
        "W-MON": "W-MON", "W": "W-MON",
        "M": "MS", "MS": "MS", "ME": "ME",
        "2W": "2W-MON", "BM": "BMS",
    }
    freq = freq_map.get(rebalance_freq, rebalance_freq)
    schedule = pd.date_range(start=start, end=end, freq=freq)

    rebalance_dates = []
    for s_date in schedule:
        candidates = eligible_dates[eligible_dates >= s_date]
        if len(candidates) > 0:
            rebalance_dates.append(candidates[0])

    return sorted(set(rebalance_dates))


# ══════════════════════════════════════════════════════════════════════════
#  Orchestrator  — wires the modules together
# ══════════════════════════════════════════════════════════════════════════

def run_full_backtest(**kwargs):
    """Main entry point.  Compiles config, runs all modules, returns result dict."""
    _ensure_imports()

    cfg = BacktestConfig(**kwargs)
    np.random.seed(cfg.seed)

    log(f"Config hash: {cfg.config_hash()}")

    # Wire modules
    clock = SimulationClock()
    data = DataProvider(clock)
    signal_model = SignalModel(clock, data)
    portfolio_engine = PortfolioEngine(clock, data)
    execution_sim = ExecutionSimulator(clock, data, portfolio_engine)

    # 1. Load data
    data.load(cfg)
    active_tickers = sorted(data.price_dict.keys())

    if len(active_tickers) < cfg.top_k:
        log(f"WARNING: Only {len(active_tickers)} tickers loaded, reducing top_k")
        cfg.top_k = len(active_tickers)

    # 2. Initialize clock with all dates
    clock.initialize(data.common_dates)

    # 3. Rebalance schedule
    warmup = max(300, 252 + 50)
    rebalance_dates = get_rebalance_dates(data.common_dates, cfg.rebalance,
                                          start_after_idx=warmup)
    if len(rebalance_dates) < 5:
        raise ValueError(f"Only {len(rebalance_dates)} rebalance dates. Need >= 5.")

    feature_dates_set = set(data.feature_df["date"].unique())
    rebalance_dates = [d for d in rebalance_dates if d in feature_dates_set]
    if len(rebalance_dates) < 5:
        raise ValueError(f"Only {len(rebalance_dates)} rebalance dates with feature data.")

    log(f"Rebalance schedule: {len(rebalance_dates)} dates, freq={cfg.rebalance}")

    # 4. Generate ML signals (clock advances through rebalance dates)
    signals_df, train_info = signal_model.generate_signals(rebalance_dates, cfg)

    # 5. Reset clock for execution phase (start fresh from OOS period)
    oos_start = rebalance_dates[0]
    oos_dates = [d for d in data.common_dates
                 if pd.Timestamp(d) >= pd.Timestamp(oos_start)]

    clock_exec = SimulationClock()
    clock_exec.initialize(oos_dates)
    execution_sim.clock = clock_exec
    portfolio_engine.clock = clock_exec

    backtest_result = execution_sim.run(signals_df, cfg, oos_dates)

    # 6. Metrics
    strategy_gross = compute_metrics(backtest_result["daily_returns_gross"],
                                     backtest_result["daily_dates"], "Strategy (gross)")
    strategy_net = compute_metrics(backtest_result["daily_returns_net"],
                                   backtest_result["daily_dates"], "Strategy (net)")

    # 7. Benchmarks
    benchmarks_raw = compute_benchmarks(
        data.return_matrix, oos_dates, active_tickers,
        cfg.top_k, cfg.cost_bps, cfg.slippage_bps, cfg.seed,
    )
    benchmark_metrics = {}
    for bkey, bdata in benchmarks_raw.items():
        bm_rets = bdata["daily_returns"][:len(backtest_result["daily_returns_net"])]
        benchmark_metrics[bkey] = compute_metrics(bm_rets, label=bdata["name"])

    # 8. Stats
    hit_rate = compute_hit_rate_at_rebalance(signals_df)
    turnover_values = list(backtest_result["turnover_by_date"].values())
    avg_turnover = np.mean(turnover_values) if turnover_values else 0.0
    n_oos_years = len(oos_dates) / 252.0
    turnover_annual = ((avg_turnover * backtest_result["num_rebalances"] / n_oos_years)
                       if n_oos_years > 0 else 0.0)
    avg_holdings = (np.mean(backtest_result["holdings_count"])
                    if backtest_result["holdings_count"] else 0)

    subperiod = compute_subperiod_metrics(
        backtest_result["daily_returns_net"], backtest_result["daily_dates"], "Net"
    )

    # 9. Warnings
    warnings_list = []
    if strategy_net["sharpe"] < 0.5:
        warnings_list.append(f"OOS Sharpe ({strategy_net['sharpe']:.2f}) < 0.5")
    if strategy_gross["sharpe"] > 0 and strategy_net["sharpe"] < 0:
        warnings_list.append("Edge disappears after costs (gross Sharpe > 0 but net < 0)")
    cost_drag = strategy_gross.get("cagr", 0) - strategy_net.get("cagr", 0)
    if cost_drag > 0.02:
        warnings_list.append(f"Cost drag = {cost_drag*100:.1f}% CAGR — consider lower turnover")
    if cfg.top_k <= 3:
        warnings_list.append(f"top_k={cfg.top_k} is very concentrated")
    if data.missing_report:
        miss_pct = len(data.missing_report) / len(cfg.resolve_tickers()) * 100
        if miss_pct > 20:
            warnings_list.append(f"Missing data: {miss_pct:.0f}% of requested tickers")
    if clock.violations:
        warnings_list.append(f"LOOKAHEAD VIOLATIONS: {len(clock.violations)}")

    # 10. Chart
    config_line = cfg.summary_line(len(active_tickers))
    chart_path = os.path.join(tempfile.gettempdir(), f"ml-portfolio-{cfg.config_hash()}.png")
    try:
        render_portfolio_chart(
            {"gross": strategy_gross, "net": strategy_net},
            benchmark_metrics, backtest_result["daily_dates"],
            config_line, chart_path,
        )
    except Exception as e:
        log(f"Chart rendering failed: {e}")
        chart_path = None

    # 11. Assemble output
    eff_start = backtest_result["daily_dates"][0] if backtest_result["daily_dates"] else "?"
    eff_end = backtest_result["daily_dates"][-1] if backtest_result["daily_dates"] else "?"

    config_dict = cfg.to_dict()
    config_dict["config_hash"] = cfg.config_hash()
    config_dict["tickers"] = active_tickers
    config_dict["tickers_requested"] = len(cfg.resolve_tickers())
    config_dict["tickers_loaded"] = len(active_tickers)
    config_dict["tickers_missing"] = data.missing_report
    config_dict["start_date"] = eff_start
    config_dict["end_date"] = eff_end

    return {
        "config": config_dict,
        "strategy": {
            "gross": {k: v for k, v in strategy_gross.items() if k != "equity_curve"},
            "net": {k: v for k, v in strategy_net.items() if k != "equity_curve"},
            "hit_rate": round(hit_rate, 4),
            "avg_holdings": round(float(avg_holdings), 1),
            "turnover_annual": round(float(turnover_annual), 4),
            "total_cost": round(float(backtest_result["total_cost"]), 6),
            "num_rebalances": backtest_result["num_rebalances"],
        },
        "benchmarks": {
            bkey: {k: v for k, v in bm.items() if k != "equity_curve"}
            for bkey, bm in benchmark_metrics.items()
        },
        "panel_stats": data.panel_stats,
        "subperiod": subperiod,
        "train_info": train_info,
        "feature_cols": data.feature_cols,
        "warnings": warnings_list,
        "chart_path": chart_path,
    }


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Portfolio ML Backtester v2")
    parser.add_argument("--tickers", required=True)
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--days", type=int)
    parser.add_argument("--forward", type=int, default=20)
    parser.add_argument("--rebalance", default="W-MON")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--bottom-k", type=int, default=0)
    parser.add_argument("--weighting", choices=["equal", "vol_target"], default="equal")
    parser.add_argument("--max-weight", type=float, default=0.15)
    parser.add_argument("--max-leverage", type=float, default=1.0)
    parser.add_argument("--cost-bps", type=int, default=10)
    parser.add_argument("--slippage-bps", type=int, default=0)
    parser.add_argument("--vol-window", type=int, default=20)
    parser.add_argument("--target-vol-annual", type=float, default=0.15)
    parser.add_argument("--model", choices=["linear", "gradient_boost"], default="gradient_boost")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data-dir")

    args = parser.parse_args()

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
