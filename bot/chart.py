"""Chart rendering for Telegram.

Draws the candles around the signal with the FVG zone shaded and the entry,
stop and targets marked, so the pattern is visible at a glance instead of
described in words. Rendering is best-effort: if it fails the signal still
goes out as text.

The app draws its own interactive charts client-side from the same data.
"""

from __future__ import annotations

import io
import logging

from .models import Candle, Side, Signal

log = logging.getLogger(__name__)

_BG = "#0b0b0f"
_GRID = "#1e1e26"
_UP = "#26a17b"
_DOWN = "#e2504a"
_TEXT = "#e7e7ea"
_MUTED = "#8b8b96"


def render(
    signal: Signal,
    candles: list[Candle],
    granularity: int,
    window: int = 90,
) -> bytes | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Rectangle
    except ImportError:
        log.info("matplotlib not installed, sending signals without a chart")
        return None

    try:
        view = candles[-window:]
        if len(view) < 10:
            return None

        fig, ax = plt.subplots(figsize=(9, 5.2), dpi=140)
        fig.patch.set_facecolor(_BG)
        ax.set_facecolor(_BG)

        width = 0.62
        for i, candle in enumerate(view):
            colour = _UP if candle.close >= candle.open else _DOWN
            ax.vlines(i, candle.low, candle.high, color=colour, linewidth=0.9, zorder=2)
            height = abs(candle.close - candle.open) or (candle.high - candle.low) * 0.002
            ax.add_patch(
                Rectangle(
                    (i - width / 2, min(candle.open, candle.close)),
                    width,
                    height,
                    facecolor=colour,
                    edgecolor=colour,
                    linewidth=0.6,
                    zorder=3,
                )
            )

        zone = signal.zone
        if zone:
            start = _index_of_ts(view, int(zone["created_ts"]))
            ax.add_patch(
                Rectangle(
                    (start, zone["bottom"]),
                    len(view) - start - 0.5,
                    zone["top"] - zone["bottom"],
                    facecolor="#3b82f6" if signal.side is Side.LONG else "#f59e0b",
                    alpha=0.18,
                    edgecolor="#3b82f6" if signal.side is Side.LONG else "#f59e0b",
                    linewidth=1.0,
                    linestyle="--",
                    zorder=1,
                )
            )
            ax.text(
                start + 0.4,
                zone["top"],
                "FVG",
                color=_MUTED,
                fontsize=8,
                va="bottom",
                zorder=4,
            )

        _level(ax, len(view), signal.price, _TEXT, f"вход {_fmt(signal.price)}")
        if signal.stop_loss is not None:
            _level(ax, len(view), signal.stop_loss, _DOWN, f"стоп {_fmt(signal.stop_loss)}")
        for i, target in enumerate(signal.take_profits, start=1):
            _level(ax, len(view), target, _UP, f"цель {i} {_fmt(target)}")

        entry_x = len(view) - 1
        ax.scatter(
            [entry_x],
            [signal.price],
            marker="^" if signal.side is Side.LONG else "v",
            s=110,
            color=_UP if signal.side is Side.LONG else _DOWN,
            zorder=6,
            edgecolors=_BG,
            linewidths=0.8,
        )

        title = (
            f"{signal.symbol}  ·  {signal.side.value}  ·  сила {signal.strength:.0f}/100"
            f" ({signal.grade})  ·  {_tf(granularity)}"
        )
        ax.set_title(title, color=_TEXT, fontsize=11, pad=12, loc="left")

        ax.grid(color=_GRID, linewidth=0.6, alpha=0.7)
        ax.set_axisbelow(True)
        for spine in ax.spines.values():
            spine.set_color(_GRID)
        ax.tick_params(colors=_MUTED, labelsize=8)
        ax.set_xticks([])
        ax.margins(x=0.02)

        buffer = io.BytesIO()
        fig.tight_layout()
        fig.savefig(buffer, format="png", facecolor=_BG)
        plt.close(fig)
        return buffer.getvalue()
    except Exception:
        log.exception("chart rendering failed; sending the signal without it")
        return None


def _level(ax, span: int, price: float, colour: str, label: str) -> None:
    ax.axhline(price, color=colour, linewidth=0.9, linestyle=":", alpha=0.75, zorder=4)
    ax.text(
        span - 0.5,
        price,
        f" {label}",
        color=colour,
        fontsize=7.5,
        va="center",
        ha="left",
        zorder=5,
    )


def _index_of_ts(view: list[Candle], ts: int) -> int:
    for i, candle in enumerate(view):
        if candle.ts >= ts:
            return i
    return max(0, len(view) - 10)


def _fmt(value: float) -> str:
    if value >= 1000:
        return f"{value:,.1f}".replace(",", " ")
    if value >= 1:
        return f"{value:.3f}".rstrip("0").rstrip(".")
    return f"{value:.6f}".rstrip("0").rstrip(".")


def _tf(granularity: int) -> str:
    if granularity % 1440 == 0:
        return f"{granularity // 1440}d"
    if granularity % 60 == 0:
        return f"{granularity // 60}h"
    return f"{granularity}m"
