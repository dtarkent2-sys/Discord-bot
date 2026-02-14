"""
Data loader for ML predictor — reads parquet files from local cache,
auto-downloads from Google Drive on first use.

Layout expected (matches user's Google Drive):
  <data_dir>/
    all_prices_yahoo.parquet    — EOD pricing for all tickers
    all_balance_sheets.parquet  — Balance sheet fundamentals
    all_income_statements.parquet — Income statements
    all_cash_flow.parquet       — Cash flow statements

Env vars:
  ML_DATA_DIR       — Local directory with parquets (default: ml/data)
  GDRIVE_FOLDER_ID  — Google Drive folder ID to download from
"""

import os
import sys
import json
import glob

def log(msg):
    print(f"[DataLoader] {msg}", file=sys.stderr, flush=True)

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DEFAULT_GDRIVE_FOLDER_ID = "1rMMeiT-O-z7zfW5htfL_8H188swUtUCj"

EXPECTED_FILES = [
    "all_prices_yahoo.parquet",
    "all_balance_sheets.parquet",
    "all_income_statements.parquet",
    "all_cash_flow.parquet",
]


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
    """Download only .parquet files from a Google Drive folder.

    Uses the Drive web page to list files, then downloads each parquet
    individually with gdown.download(). This avoids the 50-file limit
    that gdown.download_folder hits when subfolders contain many CSVs.
    """
    try:
        import gdown
    except ImportError:
        raise ImportError("gdown not installed. Run: pip install gdown")

    import re
    import requests

    log(f"Listing files in Google Drive folder {folder_id}")

    # Fetch the folder page and extract file entries
    # gdown uses this same technique internally
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    session = requests.Session()
    res = session.get(url)
    res.raise_for_status()

    # Extract file IDs and names from the folder page HTML.
    # Google Drive embeds file metadata in the page source.
    # Pattern matches: ["file_id","file_name", ...]
    file_entries = re.findall(
        r'\["(1[A-Za-z0-9_-]{10,})","([^"]+\.parquet)"',
        res.text,
    )

    if not file_entries:
        # Fallback: try the JSON-ish format Google sometimes uses
        file_entries = re.findall(
            r'"(1[A-Za-z0-9_-]{10,})"[^"]*"([^"]+\.parquet)"',
            res.text,
        )

    if not file_entries:
        raise RuntimeError(
            f"Could not find any .parquet files in Google Drive folder {folder_id}. "
            f"Ensure the folder is public and contains parquet files."
        )

    # Deduplicate (same file can appear multiple times in the page)
    seen = set()
    unique = []
    for file_id, file_name in file_entries:
        if file_id not in seen:
            seen.add(file_id)
            unique.append((file_id, file_name))

    log(f"Found {len(unique)} parquet file(s): {[n for _, n in unique]}")

    # Download each parquet file individually — no 50-file limit
    # Redirect stdout to stderr so gdown progress doesn't contaminate JSON output
    old_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        for file_id, file_name in unique:
            dest = os.path.join(output_dir, file_name)
            if os.path.exists(dest):
                log(f"  {file_name} already exists, skipping")
                continue
            file_url = f"https://drive.google.com/uc?id={file_id}"
            log(f"  Downloading {file_name} ({file_id})")
            gdown.download(file_url, dest, quiet=False)
    finally:
        sys.stdout = old_stdout


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
