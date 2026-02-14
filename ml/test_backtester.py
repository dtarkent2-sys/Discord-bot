#!/usr/bin/env python3
"""Deterministic tests for portfolio_backtester.

Validates:
  1. total_return_pct matches equity_end  (total_return_pct == (equity_end - 1) * 100)
  2. CAGR == equity_end^(252/n_days) - 1
  3. Random baseline selections differ from benchmark holdings
  4. Absurd daily returns are flagged (not silently clipped)
  5. validate_returns catches >±50% and returns flagged tickers
"""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd

# Import functions under test
from portfolio_backtester import (
    compute_metrics, compute_benchmarks, validate_returns,
    ABSURD_DAILY_RETURN, ABSURD_MAX_EVENTS,
)

PASS = 0
FAIL = 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def test_total_return_matches_equity_end():
    """total_return_pct must equal (equity_end - 1) * 100."""
    print("\n=== test_total_return_matches_equity_end ===")

    # Case 1: simple positive returns
    rets = [0.01, 0.02, -0.005, 0.015, 0.008] * 50  # 250 days
    m = compute_metrics(rets, label="test1")
    expected_pct = (m["equity_end"] - 1.0) * 100.0
    check("positive returns",
          abs(m["total_return_pct"] - expected_pct) < 0.01,
          f"total_return_pct={m['total_return_pct']:.4f} vs expected={expected_pct:.4f}")

    # Case 2: negative returns
    rets2 = [-0.005, -0.01, 0.002, -0.003, -0.007] * 50
    m2 = compute_metrics(rets2, label="test2")
    expected_pct2 = (m2["equity_end"] - 1.0) * 100.0
    check("negative returns",
          abs(m2["total_return_pct"] - expected_pct2) < 0.01,
          f"total_return_pct={m2['total_return_pct']:.4f} vs expected={expected_pct2:.4f}")

    # Case 3: zero returns
    rets3 = [0.0] * 100
    m3 = compute_metrics(rets3, label="test3")
    check("zero returns",
          abs(m3["total_return_pct"]) < 0.001 and abs(m3["equity_end"] - 1.0) < 0.001,
          f"total_return_pct={m3['total_return_pct']}, equity_end={m3['equity_end']}")

    # Case 4: equity_start is always 1.0
    check("equity_start is 1.0", m["equity_start"] == 1.0)


def test_cagr_formula():
    """CAGR must equal equity_end^(252/n_days) - 1."""
    print("\n=== test_cagr_formula ===")

    rets = [0.001] * 504  # 2 years of +0.1%/day
    m = compute_metrics(rets, label="cagr_test")

    n_days = m["n_days"]
    equity_end = m["equity_end"]
    expected_cagr = equity_end ** (252.0 / n_days) - 1.0

    check("CAGR formula",
          abs(m["cagr"] - expected_cagr) < 1e-5,
          f"cagr={m['cagr']:.6f} vs expected={expected_cagr:.6f}")


def test_random_differs_from_benchmark():
    """Random baseline must select different tickers from equal-weight benchmark."""
    print("\n=== test_random_differs_from_benchmark ===")

    np.random.seed(42)
    n_dates = 300
    dates = pd.bdate_range("2020-01-01", periods=n_dates)
    tickers = ["A", "B", "C", "D", "E", "F", "G", "H"]

    # Build a return matrix with distinct per-ticker patterns
    data = {}
    for i, t in enumerate(tickers):
        np.random.seed(i + 100)
        data[t] = np.random.normal(0.0005 * (i + 1), 0.02, n_dates)
    return_matrix = pd.DataFrame(data, index=dates)

    benchmarks = compute_benchmarks(
        return_matrix, dates,
        all_tickers=tickers,
        investable_tickers=tickers[:6],  # only 6 investable
        top_k=4,
        rebalance_freq="W-MON",
        cost_bps=10, slippage_bps=0, seed=42,
    )

    check("both benchmarks exist",
          "equal_weight_bh" in benchmarks and "random_baseline" in benchmarks)

    if "equal_weight_bh" in benchmarks and "random_baseline" in benchmarks:
        ew_rets = np.array(benchmarks["equal_weight_bh"]["daily_returns"])
        rand_rets = np.array(benchmarks["random_baseline"]["daily_returns"])
        # They must NOT be identical
        check("random != equal_weight",
              not np.allclose(ew_rets, rand_rets, atol=1e-10),
              "Random baseline is identical to equal-weight — this is a bug!")

        # Random should pick from investable (6) not all (8), and pick 4
        check("random label shows 4-pick",
              "4-pick" in benchmarks["random_baseline"]["name"],
              f"name={benchmarks['random_baseline']['name']}")

    # EW benchmark should label with actual count (8)
    if "equal_weight_bh" in benchmarks:
        check("EW label shows actual count",
              "8-stock" in benchmarks["equal_weight_bh"]["name"],
              f"name={benchmarks['equal_weight_bh']['name']}")

        # EW label should show strategy rebalance freq
        check("EW label shows W-MON",
              "W-MON" in benchmarks["equal_weight_bh"]["name"],
              f"name={benchmarks['equal_weight_bh']['name']}")


def test_validate_returns_catches_absurd():
    """validate_returns must flag tickers with many absurd daily returns for DROP,
    and keep tickers with few absurd days (<=ABSURD_MAX_EVENTS) with a warning."""
    print("\n=== test_validate_returns_catches_absurd ===")

    np.random.seed(99)
    dates = pd.bdate_range("2020-01-01", periods=100)
    data = {
        "GOOD": np.random.normal(0.001, 0.02, 100),
        "FEW_BAD": np.random.normal(0.001, 0.02, 100),
        "MANY_BAD": np.random.normal(0.001, 0.02, 100),
    }
    # FEW_BAD: 1 absurd day (<=ABSURD_MAX_EVENTS) -> should be KEPT
    data["FEW_BAD"][50] = 0.80
    # MANY_BAD: 5 absurd days (>ABSURD_MAX_EVENTS=3) -> should be DROPPED
    for i in [20, 30, 40, 50, 60]:
        data["MANY_BAD"][i] = 0.75
    return_matrix = pd.DataFrame(data, index=dates)

    flagged, detail_log = validate_returns(return_matrix)

    check("MANY_BAD flagged for drop", "MANY_BAD" in flagged,
          f"flagged={list(flagged.keys())}")
    check("FEW_BAD NOT flagged (kept)", "FEW_BAD" not in flagged,
          f"flagged={list(flagged.keys())}")
    check("GOOD not flagged", "GOOD" not in flagged)
    check("detail log not empty", len(detail_log) > 0)

    # Verify flagged events
    if "MANY_BAD" in flagged:
        check("MANY_BAD has 5 events", len(flagged["MANY_BAD"]) == 5,
              f"got {len(flagged['MANY_BAD'])} events")

    # Test with close_matrix for forensic logging
    close_data = {t: np.cumsum(data[t]) + 100 for t in data}
    close_matrix = pd.DataFrame(close_data, index=dates)
    flagged2, detail_log2 = validate_returns(return_matrix, close_matrix=close_matrix)
    check("close prices in log", any("prev=" in line for line in detail_log2),
          "expected prev_close in detail log")


def test_no_clipping_in_compute_metrics():
    """compute_metrics must NOT clip returns — it should pass them through."""
    print("\n=== test_no_clipping_in_compute_metrics ===")

    # Include a large daily return
    rets = [0.01] * 99 + [0.60]  # last day: +60%
    m = compute_metrics(rets, label="no_clip")

    # With clipping the equity would be capped at 1+0.50 on the last day.
    # Without clipping it should be (1.01^99) * (1.60).
    expected_equity_end = np.prod([1.0 + r for r in rets])
    check("equity_end not clipped",
          abs(m["equity_end"] - expected_equity_end) < 0.001,
          f"equity_end={m['equity_end']:.6f} vs expected={expected_equity_end:.6f}")

    # Verify no 'clipped_days' key (removed)
    check("no clipped_days field", "clipped_days" not in m)


def test_metrics_empty_input():
    """compute_metrics handles empty/short input gracefully."""
    print("\n=== test_metrics_empty_input ===")
    m = compute_metrics([], label="empty")
    check("empty returns", m["n_days"] == 0 and m["equity_end"] == 1.0)

    m1 = compute_metrics([0.0], label="single")
    check("single return (< 2 days -> degenerate)", m1["n_days"] == 0 and m1["equity_end"] == 1.0)


if __name__ == "__main__":
    test_total_return_matches_equity_end()
    test_cagr_formula()
    test_random_differs_from_benchmark()
    test_validate_returns_catches_absurd()
    test_no_clipping_in_compute_metrics()
    test_metrics_empty_input()

    print(f"\n{'='*40}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    if FAIL > 0:
        sys.exit(1)
    else:
        print("All tests passed!")
        sys.exit(0)
