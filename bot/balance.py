"""Virtual balance: what a fixed-risk-per-trade account would show.

Nothing here touches real money — there are no exchange API keys anywhere in
this bot. It replays closed trades against a starting capital the user picks,
sizing each trade at a fixed percentage of risk, and compounds. It exists to
answer "if I actually risked N% per signal starting from X, where would I be
now" — a way to read a stream of R multiples as money instead of an abstract
score.

Each trade's risk_amount is fixed at the moment the signal is saved (using the
balance realized from every trade closed before it), not recomputed
afterwards, so a later trade closing before an earlier one — which can happen
since multiple trades run concurrently — cannot retroactively change what a
past trade was worth. Summing realized pnl is order-independent by
construction; only the *display* curve depends on close order, because that's
when each trade's result actually lands.
"""

from __future__ import annotations


def risk_amount_now(storage, starting_balance: float, risk_pct: float) -> float:
    """The currency amount the next trade should risk, given trades closed so far."""
    return realized_balance(storage, starting_balance, risk_pct) * risk_pct / 100


def realized_balance(storage, starting_balance: float, risk_pct: float) -> float:
    balance = starting_balance
    for trade in _closed_in_order(storage):
        balance += _pnl(trade, starting_balance, risk_pct)
    return balance


def build(storage, starting_balance: float, risk_pct: float, currency: str) -> dict:
    balance = starting_balance
    curve = [{"ts": None, "balance": round(starting_balance, 2)}]
    for trade in _closed_in_order(storage):
        balance += _pnl(trade, starting_balance, risk_pct)
        curve.append({"ts": trade["closed_at"], "balance": round(balance, 2)})

    open_trades = storage.open_trades()
    at_risk = sum(
        trade["risk_amount"] if trade["risk_amount"] is not None else balance * risk_pct / 100
        for trade in open_trades
    )

    return {
        "currency": currency,
        "starting_balance": round(starting_balance, 2),
        "balance": round(balance, 2),
        "change_pct": round((balance / starting_balance - 1) * 100, 2) if starting_balance else 0.0,
        "risk_per_trade_pct": risk_pct,
        "open_trades": len(open_trades),
        "at_risk": round(at_risk, 2),
        "curve": curve,
    }


def _closed_in_order(storage) -> list:
    return sorted(
        (t for t in storage.closed_trades() if t["closed_at"] is not None),
        key=lambda t: (t["closed_at"], t["id"]),
    )


def _pnl(trade, starting_balance: float, risk_pct: float) -> float:
    # Older rows saved before this feature shipped have no stored risk_amount;
    # fall back to the configured percentage so they still contribute.
    risk = trade["risk_amount"] if trade["risk_amount"] is not None else starting_balance * risk_pct / 100
    return risk * (trade["r_multiple"] or 0)
