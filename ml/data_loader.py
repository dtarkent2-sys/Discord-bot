"""
Data loader for ML predictor — reads parquet files from local cache,
auto-downloads from Google Drive on first use.

Supports two data layouts:
  1. Per-symbol parquets (preferred):
     <data_dir>/eod_by_symbol/AAPL.parquet, MSFT.parquet, ...
     Downloaded from Google Drive folder: 1WH3G0BKcaDtmpRaOutdgAsiPlMm5K1C2

  2. Monolithic parquet (legacy):
     <data_dir>/all_prices_yahoo.parquet
     Downloaded from Google Drive folder: 1rMMeiT-O-z7zfW5htfL_8H188swUtUCj

Env vars:
  ML_DATA_DIR       — Local directory with parquets (default: ml/data)
  GDRIVE_FOLDER_ID  — Google Drive folder ID to download from
"""

import os
import sys
import json
import glob
import re

def log(msg):
    print(f"[DataLoader] {msg}", file=sys.stderr, flush=True)

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DEFAULT_GDRIVE_FOLDER_ID = "1rMMeiT-O-z7zfW5htfL_8H188swUtUCj"
EOD_FOLDER_ID = "1WH3G0BKcaDtmpRaOutdgAsiPlMm5K1C2"

EXPECTED_FILES = [
    "all_prices_yahoo.parquet",
    "all_balance_sheets.parquet",
    "all_income_statements.parquet",
    "all_cash_flow.parquet",
]

# Known Google Drive file IDs — avoids unreliable folder-page scraping.
# Discovered from folder 1rMMeiT-O-z7zfW5htfL_8H188swUtUCj.
GDRIVE_FILE_IDS = {
    "all_balance_sheets.parquet": "1bLPnpBe6s5Df2ehalIrALkSMsMzI5CZc",
    "all_cash_flow.parquet": "1oYRLvH_A8NwCkmBOphHXzvXwBLIF8ScN",
    "all_income_statements.parquet": "18lv5CurVMkgFm0IA5RHCateKgYgcAe3c",
    "all_prices_yahoo.parquet": "1HUOqrumZUZ_NagYZEj4FloAJSdVzR012",
}

# Cached Google Drive file index for per-symbol parquets {SYMBOL: gdrive_file_id}
_gdrive_eod_index = None


def get_data_dir():
    return os.environ.get("ML_DATA_DIR", DEFAULT_DATA_DIR)


def ensure_data(data_dir=None):
    """
    Ensure parquet files exist locally. Downloads from Google Drive if missing.
    Returns the data directory path.
    """
    data_dir = data_dir or get_data_dir()
    os.makedirs(data_dir, exist_ok=True)

    # Check which files are missing
    missing = [f for f in EXPECTED_FILES if not os.path.exists(os.path.join(data_dir, f))]

    if not missing:
        log(f"All parquet files present in {data_dir}")
        return data_dir

    log(f"Missing {len(missing)} parquet file(s): {', '.join(missing)}")
    log(f"Downloading from Google Drive...")

    folder_id = os.environ.get("GDRIVE_FOLDER_ID", DEFAULT_GDRIVE_FOLDER_ID)
    _download_folder(folder_id, data_dir)

    # Verify
    still_missing = [f for f in EXPECTED_FILES if not os.path.exists(os.path.join(data_dir, f))]
    if still_missing:
        # Try to find them in subdirectories (gdown sometimes creates nested dirs)
        for f in still_missing:
            found = glob.glob(os.path.join(data_dir, "**", f), recursive=True)
            if found:
                # Move to data_dir root
                os.rename(found[0], os.path.join(data_dir, f))
                log(f"  Moved {f} from nested dir to {data_dir}")

    still_missing = [f for f in EXPECTED_FILES if not os.path.exists(os.path.join(data_dir, f))]
    if still_missing:
        raise FileNotFoundError(
            f"Could not find parquet files after download: {', '.join(still_missing)}. "
            f"Ensure Google Drive folder {folder_id} is public and contains the expected files."
        )

    log(f"All parquet files ready in {data_dir}")
    return data_dir


def _download_folder(folder_id, output_dir):
    """Download .parquet files from Google Drive by their known file IDs.

    Uses direct file-ID downloads (GDRIVE_FILE_IDS) which is completely
    reliable — no folder-page scraping, no 50-file limit, no JS rendering
    issues. Falls back to gdown's folder parser if a direct download fails.
    """
    try:
        import gdown
    except ImportError:
        raise ImportError("gdown not installed. Run: pip install gdown")

    log(f"Downloading parquet files from Google Drive")

    # Redirect stdout to stderr so gdown progress bars don't contaminate JSON
    old_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        # Primary: download each file directly by its known Google Drive ID
        failed = []
        for file_name, file_id in GDRIVE_FILE_IDS.items():
            dest = os.path.join(output_dir, file_name)
            if os.path.exists(dest):
                log(f"  {file_name} already exists, skipping")
                continue
            file_url = f"https://drive.google.com/uc?id={file_id}"
            log(f"  Downloading {file_name} ({file_id})")
            try:
                result = gdown.download(file_url, dest, quiet=False)
                if result is None:
                    failed.append(file_name)
                    log(f"  WARNING: {file_name} download returned None")
            except Exception as e:
                failed.append(file_name)
                log(f"  WARNING: {file_name} download failed: {e}")

        if failed:
            log(f"Direct downloads failed for: {failed}, trying folder listing...")
            _download_via_folder_listing(gdown, folder_id, output_dir, failed)
    finally:
        sys.stdout = old_stdout


def _download_via_folder_listing(gdown, folder_id, output_dir, needed_files):
    """Fallback: parse the folder page to discover file IDs dynamically."""
    from gdown.download import _get_session
    from gdown.download_folder import _parse_google_drive_file, _GoogleDriveFile

    url = f"https://drive.google.com/drive/folders/{folder_id}?hl=en"
    user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"
    sess = _get_session(proxy=None, use_cookies=False, user_agent=user_agent)
    res = sess.get(url)
    if res.status_code != 200:
        raise RuntimeError(f"Failed to fetch folder page (HTTP {res.status_code})")

    gdrive_file, id_name_type_iter = _parse_google_drive_file(url=url, content=res.text)

    needed_set = set(needed_files)
    for fid, fname, ftype in id_name_type_iter:
        if ftype == _GoogleDriveFile.TYPE_FOLDER:
            continue
        if fname not in needed_set:
            continue
        dest = os.path.join(output_dir, fname)
        if os.path.exists(dest):
            continue
        log(f"  Downloading {fname} ({fid}) via folder listing")
        gdown.download(f"https://drive.google.com/uc?id={fid}", dest, quiet=False)


def load_prices(data_dir=None, ticker=None):
    """
    Load EOD pricing data. Returns a DataFrame.
    If ticker is specified, filters to that ticker only.
    """
    import pandas as pd

    data_dir = data_dir or get_data_dir()
    fpath = os.path.join(data_dir, "all_prices_yahoo.parquet")

    if not os.path.exists(fpath):
        raise FileNotFoundError(f"Price data not found: {fpath}. Run ensure_data() first.")

    log(f"Loading prices from {fpath}")
    df = pd.read_parquet(fpath)
    log(f"  Loaded {len(df):,} rows, columns: {list(df.columns)}")

    # Normalize column names to lowercase
    df.columns = [c.lower().strip() for c in df.columns]

    # Auto-detect ticker column
    ticker_col = _find_column(df, ["symbol", "ticker", "sym", "stock"])
    if ticker_col and ticker:
        df = df[df[ticker_col].str.upper() == ticker.upper()].copy()
        log(f"  Filtered to {ticker}: {len(df):,} rows")

    # Auto-detect and normalize date column
    date_col = _find_column(df, ["date", "datetime", "timestamp", "time"])
    if date_col and date_col != "date":
        df = df.rename(columns={date_col: "date"})
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
        df = df.sort_values("date")

    return df


def load_prices_bulk(data_dir=None, tickers=None):
    """
    Load EOD pricing for multiple tickers in a SINGLE parquet read.
    Returns dict {ticker: DataFrame} — much faster than calling
    load_prices() in a loop (reads ~700MB file once instead of N times).
    """
    import pandas as pd

    data_dir = data_dir or get_data_dir()
    fpath = os.path.join(data_dir, "all_prices_yahoo.parquet")

    if not os.path.exists(fpath):
        raise FileNotFoundError(f"Price data not found: {fpath}. Run ensure_data() first.")

    log(f"Bulk loading prices from {fpath}")
    df = pd.read_parquet(fpath)
    log(f"  Loaded {len(df):,} rows, columns: {list(df.columns)}")

    df.columns = [c.lower().strip() for c in df.columns]

    ticker_col = _find_column(df, ["symbol", "ticker", "sym", "stock"])
    if not ticker_col:
        raise ValueError(f"No ticker column found in {fpath}. Columns: {list(df.columns)}")

    date_col = _find_column(df, ["date", "datetime", "timestamp", "time"])
    if date_col and date_col != "date":
        df = df.rename(columns={date_col: "date"})
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])

    # Uppercase the ticker column for matching
    df[ticker_col] = df[ticker_col].str.upper()

    if tickers:
        wanted = set(t.upper() for t in tickers)
        df = df[df[ticker_col].isin(wanted)]
        log(f"  Filtered to {len(wanted)} requested tickers: {len(df):,} rows")

    # Split into per-ticker DataFrames
    result = {}
    for tkr, group in df.groupby(ticker_col):
        result[tkr] = group.sort_values("date").reset_index(drop=True)

    found = set(result.keys())
    if tickers:
        missing = wanted - found
        if missing:
            log(f"  Tickers not found in data: {sorted(missing)}")

    log(f"  Returned {len(result)} tickers")
    return result


def load_fundamentals(data_dir=None, ticker=None):
    """
    Load and merge all fundamental data (balance sheets, income statements, cash flow).
    Returns a single DataFrame keyed on (date, ticker).
    """
    import pandas as pd

    data_dir = data_dir or get_data_dir()
    dfs = {}

    for name, fname in [
        ("bs", "all_balance_sheets.parquet"),
        ("is", "all_income_statements.parquet"),
        ("cf", "all_cash_flow.parquet"),
    ]:
        fpath = os.path.join(data_dir, fname)
        if os.path.exists(fpath):
            df = pd.read_parquet(fpath)
            df.columns = [c.lower().strip() for c in df.columns]
            log(f"  Loaded {name}: {len(df):,} rows, {len(df.columns)} cols")
            dfs[name] = df
        else:
            log(f"  {fname} not found, skipping")

    if not dfs:
        return None

    # Merge fundamentals on (date, ticker)
    merged = None
    for name, df in dfs.items():
        ticker_col = _find_column(df, ["symbol", "ticker", "sym", "stock"])
        date_col = _find_column(df, ["date", "datetime", "fiscaldateending", "fillingdate",
                                      "filing_date", "fiscal_date_ending", "report_date",
                                      "calendardate", "period"])

        if not ticker_col or not date_col:
            log(f"  {name}: can't find ticker/date columns, skipping")
            continue

        if ticker and ticker_col:
            df = df[df[ticker_col].str.upper() == ticker.upper()].copy()

        # Standardize key columns
        df = df.rename(columns={ticker_col: "_ticker", date_col: "_date"})
        df["_date"] = pd.to_datetime(df["_date"], errors="coerce")
        df = df.dropna(subset=["_date"])

        # Prefix columns to avoid collisions
        rename = {}
        for c in df.columns:
            if c.startswith("_"):
                continue
            rename[c] = f"{name}_{c}" if c in (merged.columns if merged is not None else []) else c
        df = df.rename(columns=rename)

        if merged is None:
            merged = df
        else:
            merged = pd.merge(merged, df, on=["_ticker", "_date"], how="outer", suffixes=("", f"_{name}"))

    if merged is not None:
        merged = merged.rename(columns={"_ticker": "symbol", "_date": "date"})
        merged = merged.sort_values("date")

    return merged


def inspect_schema(data_dir=None):
    """Print column schemas for all parquet files. Useful for debugging."""
    import pandas as pd

    data_dir = data_dir or get_data_dir()
    result = {}

    for fname in EXPECTED_FILES:
        fpath = os.path.join(data_dir, fname)
        if os.path.exists(fpath):
            df = pd.read_parquet(fpath, nrows=0) if hasattr(pd, 'read_parquet') else pd.DataFrame()
            # Read just a few rows for schema
            sample = pd.read_parquet(fpath).head(3)
            result[fname] = {
                "columns": list(sample.columns),
                "dtypes": {c: str(sample[c].dtype) for c in sample.columns},
                "sample": sample.to_dict(orient="records"),
            }
        else:
            result[fname] = {"status": "missing"}

    return result


def _find_column(df, candidates):
    """Find the first matching column name from a list of candidates."""
    cols_lower = {c.lower(): c for c in df.columns}
    for candidate in candidates:
        if candidate.lower() in cols_lower:
            return cols_lower[candidate.lower()]
    return None


def _load_gdrive_eod_index(data_dir=None):
    """Load the Google Drive file-ID index for per-symbol parquets.

    Tries local cache first (gdrive_eod_index.json), then scrapes the
    Google Drive embedded folder view to build the index.
    """
    global _gdrive_eod_index
    if _gdrive_eod_index is not None:
        return _gdrive_eod_index

    data_dir = data_dir or get_data_dir()
    index_path = os.path.join(data_dir, "gdrive_eod_index.json")

    if os.path.exists(index_path):
        with open(index_path) as f:
            _gdrive_eod_index = json.load(f)
        log(f"  Loaded GDrive EOD index: {len(_gdrive_eod_index)} tickers")
        return _gdrive_eod_index

    # Scrape the Google Drive embedded folder view
    log(f"  Building GDrive EOD index from folder {EOD_FOLDER_ID}...")
    try:
        import requests
        url = f"https://drive.google.com/embeddedfolderview?id={EOD_FOLDER_ID}"
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        pattern = re.compile(
            r'id="entry-([a-zA-Z0-9_\-]+)".*?flip-entry-title">([^<]+)</div>',
            re.DOTALL,
        )
        _gdrive_eod_index = {}
        for m in pattern.finditer(resp.text):
            fid, fname = m.group(1), m.group(2).strip()
            if fname.endswith(".parquet"):
                _gdrive_eod_index[fname.replace(".parquet", "")] = fid
        # Cache to disk
        os.makedirs(data_dir, exist_ok=True)
        with open(index_path, "w") as f:
            json.dump(_gdrive_eod_index, f, indent=2)
        log(f"  Scraped GDrive EOD index: {len(_gdrive_eod_index)} tickers")
    except Exception as e:
        log(f"  WARNING: Could not build GDrive EOD index: {e}")
        _gdrive_eod_index = {}

    return _gdrive_eod_index


def _download_eod_symbol(symbol, data_dir=None):
    """Download a single per-symbol parquet from Google Drive."""
    data_dir = data_dir or get_data_dir()
    eod_dir = os.path.join(data_dir, "eod_by_symbol")
    os.makedirs(eod_dir, exist_ok=True)

    dest = os.path.join(eod_dir, f"{symbol}.parquet")
    if os.path.exists(dest) and os.path.getsize(dest) > 100:
        return dest

    idx = _load_gdrive_eod_index(data_dir)
    if symbol not in idx:
        return None

    try:
        import gdown
        fid = idx[symbol]
        old_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            gdown.download(f"https://drive.google.com/uc?id={fid}", dest, quiet=True)
        finally:
            sys.stdout = old_stdout
        if os.path.exists(dest) and os.path.getsize(dest) > 100:
            return dest
    except Exception as e:
        log(f"  WARNING: Failed to download {symbol}: {e}")
    return None


def ensure_eod_symbols(tickers, data_dir=None):
    """Ensure per-symbol parquets exist locally for the given tickers.

    Downloads missing files from Google Drive on demand.
    Returns (found_paths, missing_symbols).
    """
    data_dir = data_dir or get_data_dir()
    eod_dir = os.path.join(data_dir, "eod_by_symbol")
    os.makedirs(eod_dir, exist_ok=True)

    found = {}
    missing = []

    for sym in tickers:
        sym_upper = sym.upper()
        fpath = os.path.join(eod_dir, f"{sym_upper}.parquet")
        if os.path.exists(fpath) and os.path.getsize(fpath) > 100:
            found[sym_upper] = fpath
        else:
            result = _download_eod_symbol(sym_upper, data_dir)
            if result:
                found[sym_upper] = result
            else:
                missing.append(sym_upper)

    log(f"  EOD symbols: {len(found)} found, {len(missing)} missing")
    if missing:
        log(f"  Missing: {missing[:20]}{'...' if len(missing) > 20 else ''}")

    return found, missing


def load_eod_by_symbol(data_dir=None, tickers=None):
    """Load per-symbol parquet files into {ticker: DataFrame} dict.

    This is the preferred loading path — reads small per-symbol files
    instead of a 700MB monolithic parquet.
    """
    import pandas as pd

    data_dir = data_dir or get_data_dir()
    eod_dir = os.path.join(data_dir, "eod_by_symbol")

    if tickers is None:
        # Load all locally available symbols
        if not os.path.isdir(eod_dir):
            return {}
        tickers = [f.replace(".parquet", "") for f in os.listdir(eod_dir)
                    if f.endswith(".parquet")]

    found_paths, missing = ensure_eod_symbols(tickers, data_dir)

    result = {}
    for sym, fpath in found_paths.items():
        try:
            df = pd.read_parquet(fpath)
            df.columns = [c.lower().strip() for c in df.columns]
            if "date" in df.columns:
                df["date"] = pd.to_datetime(df["date"])
                df = df.sort_values("date").reset_index(drop=True)
            result[sym] = df
        except Exception as e:
            log(f"  WARNING: Failed to read {sym}: {e}")

    log(f"  Loaded {len(result)} per-symbol DataFrames")
    return result


def list_available_eod_symbols(data_dir=None):
    """List all locally-cached per-symbol parquet tickers."""
    data_dir = data_dir or get_data_dir()
    eod_dir = os.path.join(data_dir, "eod_by_symbol")
    if not os.path.isdir(eod_dir):
        return []
    return sorted(f.replace(".parquet", "") for f in os.listdir(eod_dir)
                   if f.endswith(".parquet"))


def discover_universe(data_dir=None, min_rows=2000, min_volume_pct=0.80,
                      max_price=100000, min_price=0.01, max_absurd_days=0,
                      top_n=30):
    """Auto-discover the best tickers in the dataset.

    Scans the parquet file, filters by data quality, deduplicates tickers
    that share identical price series, and returns the top_n tickers sorted
    by average daily volume.

    Returns:
        list[str]: ticker symbols, sorted by volume descending
        dict: diagnostics {total_tickers, passed_filters, unique_series, ...}
    """
    import pandas as pd
    import numpy as np

    data_dir = data_dir or get_data_dir()
    fpath = os.path.join(data_dir, "all_prices_yahoo.parquet")
    if not os.path.exists(fpath):
        raise FileNotFoundError(f"Price data not found: {fpath}")

    log(f"Discovering universe from {fpath}")
    df = pd.read_parquet(fpath)
    df.columns = [c.lower().strip() for c in df.columns]

    ticker_col = _find_column(df, ["symbol", "ticker", "sym", "stock"])
    if not ticker_col:
        raise ValueError(f"No ticker column found. Columns: {list(df.columns)}")

    total_tickers = df[ticker_col].nunique()
    log(f"  Total tickers in data: {total_tickers}")

    # Pass 1: filter by row count, volume, price range, absurd returns
    fingerprints = {}
    good_tickers = {}

    for sym, grp in df.groupby(ticker_col):
        n = len(grp)
        if n < min_rows:
            continue
        close = grp.sort_values("date")["close"].dropna()
        if len(close) < min_rows:
            continue
        vol = grp["volume"].fillna(0)
        vol_pct = (vol > 0).sum() / n
        if vol_pct < min_volume_pct:
            continue
        cmin, cmax = close.min(), close.max()
        if cmin < min_price or cmax > max_price:
            continue
        rets = close.pct_change().dropna()
        absurd = int((rets.abs() > 0.5).sum())
        if absurd > max_absurd_days:
            continue

        # Fingerprint for dedup: first 10 + last 10 close values
        vals = close.values
        fp = tuple(np.round(vals[:10], 2)) + tuple(np.round(vals[-10:], 2))
        fp_key = hash(fp)
        if fp_key not in fingerprints:
            fingerprints[fp_key] = []
        fingerprints[fp_key].append(sym)
        good_tickers[sym] = {
            "rows": n, "cmin": cmin, "cmax": cmax,
            "mean_vol": vol.mean(), "absurd": absurd, "fp": fp_key,
        }

    # Pass 2: pick best representative from each deduplicated group
    reps = []
    for fp_key, syms in fingerprints.items():
        best = min(syms, key=lambda s: (good_tickers[s]["absurd"],
                                         -good_tickers[s]["mean_vol"]))
        info = good_tickers[best]
        reps.append((best, info))

    reps.sort(key=lambda x: -x[1]["mean_vol"])
    selected = [sym for sym, _ in reps[:top_n]]

    diagnostics = {
        "total_tickers": total_tickers,
        "passed_filters": len(good_tickers),
        "unique_series": len(fingerprints),
        "selected": len(selected),
    }
    log(f"  Passed filters: {len(good_tickers)}, unique series: {len(fingerprints)}, selected top {len(selected)}")
    for sym, info in reps[:top_n]:
        log(f"    {sym:10s}: {info['rows']:5d} rows | "
            f"${info['cmin']:.2f}-${info['cmax']:.2f} | "
            f"vol/day={info['mean_vol']:.0f}")

    return selected, diagnostics
