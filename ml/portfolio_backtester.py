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

# US stock presets from per-symbol EOD parquets (Google Drive: eod_by_symbol/).
# "mega" = 30 large-cap US stocks, "sp50" = 50 diversified large-caps.
# "local" = dynamically load all locally-cached per-symbol parquets.
UNIVERSES = {
    "mega": [
        "AAPL", "AMZN", "AVGO", "ADBE", "AMD", "ACN", "ABBV", "ABT",
        "AMAT", "AMGN", "ANET", "AXP", "BA", "BAC", "BLK", "BMY",
        "C", "CAT", "CMCSA", "COP", "COST", "CRM", "CRWD", "CSCO",
        "CDNS", "CEG", "CI", "CME", "CMG", "COF",
    ],
    "sp50": [
        "A", "AAPL", "ABBV", "ABT", "ACN", "ADBE", "ADI", "ADP",
        "AFL", "AIG", "ALGN", "ALL", "AMAT", "AMD", "AMGN", "AMZN",
        "ANET", "APD", "APH", "APTV", "AVGO", "AXP", "AZO",
        "BA", "BAC", "BDX", "BK", "BKR", "BLK", "BMY", "BSX", "BX",
        "C", "CAT", "CB", "CDNS", "CEG", "CHTR", "CI", "CL",
        "CMCSA", "CME", "CMG", "CNC", "COF", "COP", "COST", "CPRT",
        "CRM", "CRWD", "CSCO", "CSGP",
    ],
    "local": None,  # Dynamic: load all locally-cached per-symbol parquets
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
        "debug",
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
        self.debug = kw.get("debug", False)

    def to_dict(self):
        return {s: getattr(self, s) for s in self.__slots__}

    def config_hash(self):
        """Deterministic SHA-256 of the config for dedup/caching.
        data_dir is excluded (local path artefact, doesn't affect results)."""
        d = self.to_dict()
        d.pop("data_dir", None)
        d.pop("debug", None)
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
        """Resolve ticker spec to a list of ticker symbols.
        Supports: preset name (mega, sp50, local), comma-sep list, or list."""
        tickers = self.tickers
        if isinstance(tickers, str):
            key = tickers.lower()
            if key in UNIVERSES:
                preset = UNIVERSES[key]
                if preset is not None:
                    return list(preset)
                # Dynamic: load all locally-cached per-symbol parquets
                return self._discover_local()
            return [t.strip().upper() for t in tickers.split(",") if t.strip()]
        return [t.upper() for t in tickers]

    def _discover_local(self):
        """Return all locally-cached per-symbol parquet tickers."""
        from data_loader import list_available_eod_symbols
        tickers = list_available_eod_symbols(data_dir=self.data_dir)
        log(f"Local discovery: {len(tickers)} tickers available")
        return tickers


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
        from data_loader import load_eod_by_symbol

        ticker_list = cfg.resolve_tickers()

        if not ticker_list:
            raise ValueError("No tickers provided")
        log(f"Universe: requested {len(ticker_list)} tickers: "
            f"{ticker_list[:15]}{'...' if len(ticker_list) > 15 else ''}")

        # Load per-symbol parquets (downloads from Google Drive on demand)
        raw_dict = load_eod_by_symbol(data_dir=cfg.data_dir, tickers=ticker_list)

        price_dict = {}
        missing_report = {}

        for tkr in ticker_list:
            if tkr not in raw_dict:
                missing_report[tkr] = "no_data"
                continue

            try:
                df = raw_dict[tkr]
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

        found_tickers = sorted(price_dict.keys())
        not_found = sorted(set(ticker_list) - set(found_tickers) - set(missing_report.keys()))
        log(f"  Data found for {len(found_tickers)}/{len(ticker_list)} tickers: {found_tickers[:15]}")
        if not_found:
            log(f"  Not in data source: {not_found}")
            for t in not_found:
                missing_report[t] = "not_in_data_source"

        # ── Robust majority-calendar alignment ──
        # Step 1: Drop tickers with too few rows (can't build features)
        MIN_ROWS = 252
        for tkr in list(price_dict.keys()):
            n = price_dict[tkr]["close"].notna().sum()
            if n < MIN_ROWS:
                missing_report[tkr] = f"too_few_rows ({n}<{MIN_ROWS})"
                log(f"  Dropping {tkr}: only {n} valid close prices (<{MIN_ROWS})")
                del price_dict[tkr]

        if not price_dict:
            raise ValueError(
                f"No tickers have at least {MIN_ROWS} trading days. "
                f"Dropped: {list(missing_report.keys())}"
            )

        # Step 2: Find robust overlapping range (median start, median end)
        # Using medians avoids one outlier ticker collapsing the range to zero.
        ranges = {}
        for tkr, df in price_dict.items():
            valid = df.loc[df["close"].notna(), "date"]
            ranges[tkr] = (valid.min(), valid.max())

        starts = sorted(r[0] for r in ranges.values())
        ends = sorted(r[1] for r in ranges.values())
        range_start = starts[len(starts) // 2]   # median start
        range_end = ends[len(ends) // 2]          # median end

        # Extend end to latest if the median end is close (within 60 days)
        if (max(ends) - range_end).days <= 60:
            range_end = max(ends)

        if range_start >= range_end:
            raise ValueError(
                f"No overlapping date range across {len(price_dict)} tickers. "
                f"Median start={range_start.date()}, median end={range_end.date()}."
            )

        calendar = pd.bdate_range(range_start, range_end)
        log(f"  Majority calendar: {range_start.date()} to {range_end.date()} ({len(calendar)} bdays)")

        # Step 3: Drop tickers with >20% missing within the calendar
        cal_set = set(calendar)
        for tkr in list(price_dict.keys()):
            ticker_dates = set(price_dict[tkr].loc[price_dict[tkr]["close"].notna(), "date"])
            overlap = len(ticker_dates.intersection(cal_set))
            coverage = overlap / len(calendar) if len(calendar) > 0 else 0
            if coverage < 0.80:
                missing_report[tkr] = f"insufficient_coverage ({coverage:.0%}, {overlap}/{len(calendar)})"
                log(f"  Dropping {tkr}: only {coverage:.0%} coverage in calendar")
                del price_dict[tkr]

        if not price_dict:
            raise ValueError(
                f"All tickers dropped due to insufficient coverage. "
                f"Report: {missing_report}"
            )

        # Step 4: Build common dates = calendar dates where >= 50% of surviving tickers have data
        ticker_date_sets = {tkr: set(df.loc[df["close"].notna(), "date"])
                           for tkr, df in price_dict.items()}
        n_tickers = len(price_dict)
        common_dates = sorted(
            d for d in calendar
            if sum(1 for s in ticker_date_sets.values() if d in s) >= max(1, n_tickers // 2)
        )

        if len(common_dates) < 252:
            raise ValueError(
                f"Only {len(common_dates)} trading dates with >=50% ticker coverage "
                f"across {n_tickers} tickers. Need at least 252. "
                f"Loaded: {list(price_dict.keys())}. Dropped: {[k for k,v in missing_report.items()]}"
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

        if missing_report:
            log(f"  Dropped tickers: {missing_report}")
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
        n_tickers_loaded = len(self.price_dict)
        n_tickers_active = self.feature_df["ticker"].nunique() if self.feature_df is not None else 0
        n_dates = len(self.common_dates)
        total_cells = n_tickers_loaded * n_dates
        non_null = sum(
            self.close_matrix[t].notna().sum() for t in self.close_matrix.columns
        ) if self.close_matrix is not None else 0
        fill_rate = non_null / total_cells if total_cells > 0 else 0
        return {
            "tickers_loaded": n_tickers_loaded,
            "tickers_active": n_tickers_active,
            "dates": n_dates,
            "fill_rate": round(fill_rate, 4),
            "dropped_tickers": len(self.missing_report),
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

    # Maximum training rows to keep training fast (subsample oldest data)
    MAX_TRAIN_ROWS = 20_000

    def generate_signals(self, rebalance_dates, cfg: BacktestConfig):
        """Produce signals_df: [date, ticker, predicted_return, actual_return].
        Uses pooled model with ticker one-hot encoding.
        Clock advances to each rebalance date; hard-errors on lookahead.

        Performance: model is retrained only when a new calendar month starts
        (or on the first rebalance). Between retrains the cached model is reused
        for prediction.  Training set is capped at MAX_TRAIN_ROWS to keep late
        windows fast."""
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
        train_info = {"rebalance_count": 0, "avg_train_size": 0, "model_type": cfg.model_type,
                      "retrain_count": 0}
        total_train_size = 0

        # Cache model + scaler; retrain only on new month boundary
        cached_model = None
        cached_scaler = None
        last_train_month = None

        for i_reb, reb_date in enumerate(rebalance_dates):
            # Progress heartbeat every 50 rebalances
            if i_reb > 0 and i_reb % 50 == 0:
                log(f"  Signal generation progress: {i_reb}/{len(rebalance_dates)} rebalances")

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

            # Decide whether to retrain (new month or first time)
            reb_ts = pd.Timestamp(reb_date)
            reb_month = (reb_ts.year, reb_ts.month)
            need_retrain = (cached_model is None or reb_month != last_train_month)

            if need_retrain:
                X_train = X_all[train_mask]
                y_train = target_values[train_mask]

                # Cap training size (keep most recent rows)
                if len(X_train) > self.MAX_TRAIN_ROWS:
                    X_train = X_train[-self.MAX_TRAIN_ROWS:]
                    y_train = y_train[-self.MAX_TRAIN_ROWS:]

                scaler = StandardScaler()
                X_train_scaled = scaler.fit_transform(X_train)

                try:
                    if cfg.model_type == "linear":
                        model = Ridge(alpha=1.0, random_state=cfg.seed)
                    else:
                        model = HistGradientBoostingRegressor(
                            max_iter=150, max_depth=4, learning_rate=0.08,
                            min_samples_leaf=20, random_state=cfg.seed,
                            validation_fraction=0.1, n_iter_no_change=15,
                        )

                    model.fit(X_train_scaled, y_train)
                except Exception as e:
                    log(f"  ERROR training model at {reb_date}: {e} "
                        f"(X_train shape={X_train_scaled.shape})")
                    raise

                cached_model = model
                cached_scaler = scaler
                last_train_month = reb_month
                train_info["retrain_count"] += 1
                total_train_size += len(X_train)

            X_test = X_all[test_mask]
            X_test_scaled = cached_scaler.transform(X_test)
            preds = cached_model.predict(X_test_scaled)

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

        if train_info["retrain_count"] > 0:
            train_info["avg_train_size"] = total_train_size / train_info["retrain_count"]

        signals_df = pd.DataFrame(signals)
        if len(signals_df) == 0:
            raise ValueError("No signals generated. Check data alignment and date range.")
        signals_df["date"] = pd.to_datetime(signals_df["date"])

        log(f"Generated signals at {train_info['rebalance_count']} rebalance dates "
            f"({train_info['retrain_count']} retrains), "
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
        """Rank by predicted return, select top_k/bottom_k, weight, cap.
        If fewer tickers have signals than top_k, uses all available."""
        if len(signals_at_date) == 0:
            return {}

        ranked = signals_at_date.sort_values("predicted_return", ascending=False)

        avail = len(ranked)
        eff_top_k = min(cfg.top_k, avail)
        eff_bottom_k = min(cfg.bottom_k, max(0, avail - eff_top_k))

        long_tickers = list(ranked.head(eff_top_k)["ticker"].values)
        short_tickers = (list(ranked.tail(eff_bottom_k)["ticker"].values)
                         if eff_bottom_k > 0 else [])
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

def compute_benchmarks(return_matrix, common_dates, all_tickers,
                       investable_tickers, top_k, rebalance_freq,
                       cost_bps, slippage_bps, seed):
    """Compute benchmark return series.

    Benchmarks use the SAME rebalance frequency as the strategy (rebalance_freq)
    so comparisons are apples-to-apples.

    Args:
        all_tickers: tickers in the close/return matrix (for equal-weight benchmark)
        investable_tickers: tickers with feature data (for random baseline — same
                            universe as the strategy)
        rebalance_freq: same freq as the strategy (e.g. 'W-MON')
    """
    _ensure_imports()
    rng = np.random.RandomState(seed + 1)
    cost_rate = (cost_bps + slippage_bps) / 10000.0
    dates = pd.DatetimeIndex(common_dates)
    benchmarks = {}

    # Build a rebalance schedule matching the strategy frequency
    reb_schedule = set()
    if len(dates) > 1:
        freq_map = {
            "W-MON": "W-MON", "W": "W-MON",
            "M": "MS", "MS": "MS", "ME": "ME",
            "2W": "2W-MON", "BM": "BMS",
        }
        freq = freq_map.get(rebalance_freq, rebalance_freq)
        sched = pd.date_range(start=dates[0], end=dates[-1], freq=freq)
        for s_date in sched:
            candidates = dates[dates >= s_date]
            if len(candidates) > 0:
                reb_schedule.add(candidates[0])

    # ── Equal-weight benchmark (same rebalance freq as strategy) ─────────
    ew_tickers = [t for t in all_tickers if t in return_matrix.columns]
    if ew_tickers:
        n = len(ew_tickers)
        weights = {t: 1.0 / n for t in ew_tickers}
        ew_returns = []
        for i, date in enumerate(dates):
            if i == 0:
                ew_returns.append(0.0)
                continue
            # Rebalance on schedule dates: reset to 1/n
            if date in reb_schedule:
                weights = {t: 1.0 / n for t in ew_tickers}
            # Daily return = sum(w_i * r_i)
            day_ret = 0.0
            if date in return_matrix.index:
                for t in ew_tickers:
                    r = return_matrix.loc[date, t]
                    if not np.isnan(r):
                        day_ret += weights[t] * r
            ew_returns.append(day_ret)
            # Drift weights by today's returns
            gross_val = 0.0
            for t in ew_tickers:
                r = return_matrix.loc[date, t] if date in return_matrix.index else 0.0
                r = r if not np.isnan(r) else 0.0
                weights[t] *= (1.0 + r)
                gross_val += abs(weights[t])
            if gross_val > 0:
                weights = {t: w / gross_val for t, w in weights.items()}

        benchmarks["equal_weight_bh"] = {
            "name": f"Equal-Weight {n}-stock ({rebalance_freq} reb.)",
            "daily_returns": ew_returns,
        }

    # ── SPY Buy & Hold ───────────────────────────────────────────────────
    if "SPY" in return_matrix.columns:
        spy_returns = []
        for date in dates:
            if date in return_matrix.index:
                r = return_matrix.loc[date, "SPY"]
                spy_returns.append(r if not np.isnan(r) else 0.0)
            else:
                spy_returns.append(0.0)
        benchmarks["spy_bh"] = {"name": "SPY Buy & Hold", "daily_returns": spy_returns}

    # ── Random baseline (same rebalance cadence, from INVESTABLE tickers) ─
    rand_pool = [t for t in investable_tickers if t in return_matrix.columns]
    rand_k = min(top_k, max(1, len(rand_pool) - 1))  # at least 1 fewer than pool
    if len(rand_pool) >= 2 and rand_k >= 1:
        rand_returns = []
        current_picks = []
        rand_log = []  # log first 5 selections
        for i, date in enumerate(dates):
            # Rebalance on the same schedule as strategy
            if date in reb_schedule or i == 0:
                old_picks = set(current_picks)
                current_picks = list(rng.choice(rand_pool,
                                                size=rand_k, replace=False))
                new_picks = set(current_picks)
                if len(rand_log) < 5:
                    rand_log.append(f"  {date.date()}: random={sorted(current_picks)}")
                if old_picks:
                    all_t = old_picks.union(new_picks)
                    w_per = 1.0 / len(current_picks) if current_picks else 0
                    turnover = sum(abs((w_per if t in new_picks else 0) -
                                       (w_per if t in old_picks else 0)) for t in all_t)
                else:
                    turnover = 0
            else:
                turnover = 0

            if i == 0 or not current_picks:
                rand_returns.append(0.0)
                continue

            w_per = 1.0 / len(current_picks)
            day_ret = 0.0
            if date in return_matrix.index:
                for t in current_picks:
                    if t in return_matrix.columns:
                        r = return_matrix.loc[date, t]
                        if not np.isnan(r):
                            day_ret += w_per * r

            cost_today = turnover * cost_rate if turnover > 0 else 0
            rand_returns.append(day_ret - cost_today)

        if rand_log:
            log("Random baseline picks (first 5):")
            for line in rand_log:
                log(line)

        benchmarks["random_baseline"] = {
            "name": f"Random {rand_k}-pick ({rebalance_freq}, net)",
            "daily_returns": rand_returns,
        }

    return benchmarks


ABSURD_DAILY_RETURN = 0.50  # ±50% — flag as data error, do NOT clip
# If a ticker has more than this many absurd days, drop it entirely
ABSURD_MAX_EVENTS = 3


def validate_returns(return_matrix, close_matrix=None, daily_dates=None, label="Strategy"):
    """Scan return matrix for absurd daily returns (>±50%).

    When close_matrix is provided, logs prev_close and curr_close alongside
    the return for forensic debugging.

    Tickers with <= ABSURD_MAX_EVENTS are kept (events logged as warnings).
    Tickers with > ABSURD_MAX_EVENTS are flagged for dropping.

    Returns (flagged_tickers, detail_log) — tickers that should be dropped."""
    _ensure_imports()
    flagged = {}  # ticker -> list of events
    warned = {}   # ticker -> list of events (kept, just warned)
    if return_matrix is None or return_matrix.empty:
        return flagged, []

    detail_log = []
    for ticker in return_matrix.columns:
        col = return_matrix[ticker].dropna()
        absurd_mask = col.abs() > ABSURD_DAILY_RETURN
        if not absurd_mask.any():
            continue

        events = []
        for dt in col[absurd_mask].index:
            ret_val = float(col.loc[dt])
            event = {
                "date": str(dt.date()) if hasattr(dt, 'date') else str(dt)[:10],
                "return": ret_val,
            }

            # Add close prices if available
            if close_matrix is not None and ticker in close_matrix.columns:
                idx = close_matrix.index.get_loc(dt)
                curr_close = float(close_matrix.iloc[idx][ticker]) if not np.isnan(close_matrix.iloc[idx][ticker]) else None
                prev_close = float(close_matrix.iloc[idx - 1][ticker]) if idx > 0 and not np.isnan(close_matrix.iloc[idx - 1][ticker]) else None
                event["prev_close"] = prev_close
                event["curr_close"] = curr_close
                close_str = f" prev={prev_close} curr={curr_close}" if prev_close is not None else ""
            else:
                close_str = ""

            events.append(event)
            detail_log.append(
                f"  ABSURD {ticker} @ {event['date']}: "
                f"return={ret_val:+.4f} ({ret_val*100:+.1f}%){close_str}"
            )

        n_events = len(events)
        if n_events > ABSURD_MAX_EVENTS:
            flagged[ticker] = events
            detail_log.append(
                f"  -> DROP {ticker}: {n_events} absurd days (>{ABSURD_MAX_EVENTS})"
            )
        else:
            warned[ticker] = events
            detail_log.append(
                f"  -> KEEP {ticker}: only {n_events} absurd day(s) (<={ABSURD_MAX_EVENTS})"
            )

    return flagged, detail_log


def compute_metrics(daily_returns, daily_dates=None, label="Strategy"):
    _ensure_imports()
    rets = np.array(daily_returns, dtype=np.float64)
    rets = np.nan_to_num(rets, nan=0.0)
    n_days = len(rets)
    if n_days < 2:
        return {"label": label, "total_return_pct": 0.0, "equity_start": 1.0,
                "equity_end": 1.0, "cagr": 0.0, "vol": 0.0,
                "sharpe": 0.0, "sortino": 0.0, "max_dd": 0.0, "calmar": 0.0,
                "n_days": 0, "equity_curve": []}

    # NO clipping — absurd returns are caught upstream by validate_returns()
    # and the offending ticker is dropped from the universe entirely.

    # Build equity curve: E_t = E_{t-1} * (1 + r_t)
    equity = np.cumprod(1.0 + rets)

    assert np.all(equity > 0), (
        f"Negative equity detected in {label}: min={equity.min():.6f}")

    equity_start = 1.0
    equity_end = float(equity[-1])
    total_return_pct = (equity_end - 1.0) * 100.0  # percent, not fraction

    n_years = n_days / 252.0
    # CAGR = equity_end ^ (252 / n_days) - 1
    cagr = (equity_end ** (252.0 / n_days) - 1.0
            if n_days > 0 and equity_end > 0 else 0.0)

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
        "equity_start": round(float(equity_start), 6),
        "equity_end": round(float(equity_end), 6),
        "total_return_pct": round(float(total_return_pct), 4),
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
    requested_tickers = cfg.resolve_tickers()

    # Universe reporting
    log(f"Universe: requested={len(requested_tickers)}, loaded(close)={len(active_tickers)}")

    # 1b. Validate returns — detect and DROP tickers with absurd daily returns
    flagged_tickers, absurd_log = validate_returns(
        data.return_matrix, close_matrix=data.close_matrix
    )
    dropped_absurd = []
    if flagged_tickers:
        for line in absurd_log:
            log(line)
        for bad_ticker in flagged_tickers:
            if bad_ticker in data.price_dict:
                log(f"  DROPPING {bad_ticker}: {len(flagged_tickers[bad_ticker])} absurd daily returns")
                del data.price_dict[bad_ticker]
                data.missing_report[bad_ticker] = (
                    f"absurd_returns ({len(flagged_tickers[bad_ticker])} days >±{ABSURD_DAILY_RETURN:.0%})"
                )
                dropped_absurd.append(bad_ticker)
        if dropped_absurd:
            # Rebuild matrices without the bad tickers
            if data.return_matrix is not None:
                keep_cols = [c for c in data.return_matrix.columns if c not in dropped_absurd]
                data.close_matrix = data.close_matrix[keep_cols]
                data.return_matrix = data.return_matrix[keep_cols]
            if data.feature_df is not None:
                data.feature_df = data.feature_df[~data.feature_df["ticker"].isin(dropped_absurd)]
            active_tickers = sorted(data.price_dict.keys())
            log(f"  After absurd-return cleanup: {len(active_tickers)} tickers remain")

    if not active_tickers:
        raise ValueError("All tickers dropped due to absurd daily returns.")

    MIN_ACTIVE_TICKERS = 25
    if len(active_tickers) < MIN_ACTIVE_TICKERS:
        raise ValueError(
            f"Insufficient universe: only {len(active_tickers)} active tickers "
            f"(need >={MIN_ACTIVE_TICKERS}). Loaded: {active_tickers}. "
            f"Dropped: {list(data.missing_report.keys())}. "
            f"Try tickers='sp50' for a 50-stock universe."
        )

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

    # Investable tickers = those with feature data (the strategy can trade these)
    investable_tickers = sorted(data.feature_df["ticker"].unique())

    # 3b. Validate top_k vs active tickers
    original_top_k = cfg.top_k
    if len(investable_tickers) <= cfg.top_k:
        # If top_k >= active, strategy holds everything => degenerate.
        # Cap at active - 1 (minimum 1) so there's actual selection.
        new_top_k = max(1, len(investable_tickers) - 1)
        log(f"  WARNING: top_k={cfg.top_k} >= active tickers ({len(investable_tickers)}). "
            f"Auto-setting top_k={new_top_k} to enable selection.")
        object.__setattr__(cfg, 'top_k', new_top_k)

    log(f"Universe: active(features)={len(investable_tickers)}: {investable_tickers}")
    log(f"Rebalance schedule: {len(rebalance_dates)} dates, freq={cfg.rebalance}")

    # 4. Generate ML signals (clock advances through rebalance dates)
    signals_df, train_info = signal_model.generate_signals(rebalance_dates, cfg)

    # Log first 5 strategy selections
    if len(signals_df) > 0:
        strat_log_dates = sorted(signals_df["date"].unique())[:5]
        for sd in strat_log_dates:
            picks = signals_df[signals_df["date"] == sd].sort_values(
                "predicted_return", ascending=False
            )
            top = list(picks.head(cfg.top_k)["ticker"].values)
            log(f"  {sd.date() if hasattr(sd, 'date') else str(sd)[:10]}: "
                f"strategy top-{cfg.top_k}={top}")

    # 5. Reset clock for execution phase (start fresh from OOS period)
    oos_start = rebalance_dates[0]
    oos_dates = [d for d in data.common_dates
                 if pd.Timestamp(d) >= pd.Timestamp(oos_start)]

    clock_exec = SimulationClock()
    clock_exec.initialize(oos_dates)
    execution_sim.clock = clock_exec
    portfolio_engine.clock = clock_exec

    backtest_result = execution_sim.run(signals_df, cfg, oos_dates)

    # 5b. Forensic sanity dump (--debug=1)
    debug_dump = None
    if cfg.debug:
        debug_dump = _forensic_dump(signals_df, backtest_result, data, cfg)

    # 6. Metrics
    strategy_gross = compute_metrics(backtest_result["daily_returns_gross"],
                                     backtest_result["daily_dates"], "Strategy (gross)")
    strategy_net = compute_metrics(backtest_result["daily_returns_net"],
                                   backtest_result["daily_dates"], "Strategy (net)")

    # 7. Benchmarks — pass rebalance_freq so benchmarks match strategy cadence
    benchmarks_raw = compute_benchmarks(
        data.return_matrix, oos_dates,
        all_tickers=active_tickers,
        investable_tickers=investable_tickers,
        top_k=cfg.top_k,
        rebalance_freq=cfg.rebalance,
        cost_bps=cfg.cost_bps, slippage_bps=cfg.slippage_bps, seed=cfg.seed,
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
        miss_pct = len(data.missing_report) / len(requested_tickers) * 100
        if miss_pct > 20:
            warnings_list.append(f"Missing data: {miss_pct:.0f}% of requested tickers")
    if original_top_k != cfg.top_k:
        warnings_list.append(
            f"top_k auto-reduced from {original_top_k} to {cfg.top_k} "
            f"(only {len(investable_tickers)} active tickers)"
        )
    if dropped_absurd:
        warnings_list.append(
            f"Dropped {len(dropped_absurd)} tickers with absurd daily returns "
            f"(>±{ABSURD_DAILY_RETURN:.0%}): {dropped_absurd}"
        )
    if clock.violations:
        warnings_list.append(f"LOOKAHEAD VIOLATIONS: {len(clock.violations)}")

    # 10. Chart
    config_line = cfg.summary_line(len(investable_tickers))
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

    # 11. Assemble output — clear universe reporting
    eff_start = backtest_result["daily_dates"][0] if backtest_result["daily_dates"] else "?"
    eff_end = backtest_result["daily_dates"][-1] if backtest_result["daily_dates"] else "?"

    config_dict = cfg.to_dict()
    config_dict["config_hash"] = cfg.config_hash()
    config_dict["tickers"] = investable_tickers
    config_dict["tickers_requested"] = len(requested_tickers)
    config_dict["tickers_loaded"] = len(active_tickers)
    config_dict["tickers_active"] = len(investable_tickers)
    config_dict["tickers_missing"] = data.missing_report
    config_dict["start_date"] = eff_start
    config_dict["end_date"] = eff_end
    if original_top_k != cfg.top_k:
        config_dict["top_k_original"] = original_top_k

    result = {
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

    if debug_dump:
        result["debug"] = debug_dump

    return result


def _forensic_dump(signals_df, backtest_result, data, cfg):
    """Build forensic sanity dump: first 3 rebalance dates with tickers+weights,
    first 5 daily steps with per-ticker returns, portfolio return, equity."""
    _ensure_imports()
    dump = {"rebalances": [], "daily_steps": []}

    # First 3 rebalance dates with selected tickers + weights
    reb_dates = sorted(signals_df["date"].unique())[:3]
    for rd in reb_dates:
        picks = signals_df[signals_df["date"] == rd].sort_values(
            "predicted_return", ascending=False
        )
        top_picks = picks.head(cfg.top_k)
        n_selected = min(cfg.top_k, len(picks))
        w = 1.0 / n_selected if n_selected > 0 else 0
        entry = {
            "date": str(rd.date()) if hasattr(rd, 'date') else str(rd)[:10],
            "tickers": list(top_picks["ticker"].values),
            "predicted_returns": [round(float(x), 6) for x in top_picks["predicted_return"].values],
            "weight_each": round(w, 4),
        }
        dump["rebalances"].append(entry)
        log(f"  [DEBUG] Rebalance {entry['date']}: "
            f"tickers={entry['tickers']} weights={entry['weight_each']}")

    # First 5 daily steps with per-ticker returns
    daily_dates = backtest_result["daily_dates"]
    daily_rets_net = backtest_result["daily_returns_net"]
    daily_rets_gross = backtest_result["daily_returns_gross"]
    return_matrix = data.return_matrix

    equity = 1.0
    for i in range(min(5, len(daily_dates))):
        dt_str = daily_dates[i]
        dt = pd.Timestamp(dt_str)
        per_ticker = {}
        if dt in return_matrix.index:
            for tkr in return_matrix.columns:
                r = return_matrix.loc[dt, tkr]
                if not np.isnan(r):
                    per_ticker[tkr] = round(float(r), 6)

        equity_before = equity
        equity *= (1.0 + daily_rets_net[i])
        step = {
            "date": dt_str,
            "portfolio_return_gross": round(daily_rets_gross[i], 6),
            "portfolio_return_net": round(daily_rets_net[i], 6),
            "equity_before": round(equity_before, 6),
            "equity_after": round(equity, 6),
            "per_ticker_returns": per_ticker,
            "holdings": backtest_result["holdings_count"][i] if i < len(backtest_result["holdings_count"]) else 0,
        }
        dump["daily_steps"].append(step)
        log(f"  [DEBUG] Day {dt_str}: gross={daily_rets_gross[i]:+.6f} "
            f"net={daily_rets_net[i]:+.6f} equity={equity:.6f}")

    return dump


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
    parser.add_argument("--debug", type=int, default=0,
                        help="1=forensic sanity dump (first 3 rebalances, first 5 daily steps)")

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
            debug=bool(args.debug),
        )
        print(json.dumps(result))
        sys.stdout.flush()
    except Exception as e:
        log(f"ERROR: {e}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        print(json.dumps({"error": str(e)}))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
