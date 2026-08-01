"""Aggregate statistics over closed trades.

Reported in R multiples (profit as a share of the risk taken) rather than raw
percent, so trades with different stop distances stay comparable.
"""

from __future__ import annotations

from collections import defaultdict


def build(storage) -> dict:
    closed = storage.closed_trades()
    open_count = len(storage.open_trades())

    overall = _bucket(closed)
    overall["open_now"] = open_count

    by_symbol = _grouped(closed, lambda r: r["symbol"])
    by_side = _grouped(closed, lambda r: r["side"])
    by_grade = _grouped(closed, lambda r: r["grade"] or "—")
    by_strength = _grouped(closed, _strength_bucket)
    by_exit = defaultdict(int)
    for row in closed:
        by_exit[row["exit_reason"] or "—"] += 1

    return {
        "overall": overall,
        "by_symbol": by_symbol,
        "by_side": by_side,
        "by_grade": by_grade,
        "by_strength": by_strength,
        "by_exit": dict(by_exit),
        "equity_curve": _equity_curve(closed),
        "recent": [
            {
                "symbol": r["symbol"],
                "side": r["side"],
                "status": r["status"],
                "exit_reason": r["exit_reason"],
                "r_multiple": r["r_multiple"],
                "pnl_pct": r["pnl_pct"],
                "closed_at": r["closed_at"],
                "strength": r["strength"],
            }
            for r in closed[:25]
        ],
    }


def _strength_bucket(row) -> str:
    strength = float(row["strength"] or 0)
    if strength >= 80:
        return "80-100"
    if strength >= 68:
        return "68-79"
    if strength >= 55:
        return "55-67"
    return "<55"


def _grouped(rows, key) -> dict:
    groups: dict[str, list] = defaultdict(list)
    for row in rows:
        groups[key(row)].append(row)
    return {name: _bucket(items) for name, items in sorted(groups.items())}


def _bucket(rows) -> dict:
    total = len(rows)
    if total == 0:
        return {
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "breakeven": 0,
            "winrate": 0.0,
            "total_r": 0.0,
            "avg_r": 0.0,
            "expectancy": 0.0,
            "profit_factor": 0.0,
            "avg_hold_hours": 0.0,
            "best_r": 0.0,
            "worst_r": 0.0,
        }

    wins = [r for r in rows if r["status"] == "win"]
    losses = [r for r in rows if r["status"] == "loss"]
    breakeven = [r for r in rows if r["status"] == "breakeven"]

    r_values = [float(r["r_multiple"] or 0) for r in rows]
    gross_win = sum(v for v in r_values if v > 0)
    gross_loss = abs(sum(v for v in r_values if v < 0))

    holds = [
        (int(r["closed_at"]) - int(r["opened_at"])) / 3_600_000
        for r in rows
        if r["closed_at"] and r["opened_at"]
    ]

    decided = len(wins) + len(losses)
    return {
        "trades": total,
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": len(breakeven),
        "winrate": round(len(wins) / decided * 100, 1) if decided else 0.0,
        "total_r": round(sum(r_values), 2),
        "avg_r": round(sum(r_values) / total, 3),
        "expectancy": round(sum(r_values) / total, 3),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "avg_hold_hours": round(sum(holds) / len(holds), 1) if holds else 0.0,
        "best_r": round(max(r_values), 2),
        "worst_r": round(min(r_values), 2),
    }


def _equity_curve(closed) -> list[dict]:
    """Cumulative R over time, oldest first."""
    ordered = sorted([r for r in closed if r["closed_at"]], key=lambda r: r["closed_at"])
    running = 0.0
    curve = []
    for row in ordered:
        running += float(row["r_multiple"] or 0)
        curve.append({"ts": row["closed_at"], "r": round(running, 3)})
    return curve
