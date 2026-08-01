"""Core data types shared across the bot."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class Side(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


@dataclass(frozen=True)
class Candle:
    ts: int  # candle open time, milliseconds since epoch
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def opened_at(self) -> datetime:
        return datetime.fromtimestamp(self.ts / 1000, tz=timezone.utc)


@dataclass
class Signal:
    symbol: str
    side: Side
    strategy: str
    candle_ts: int
    price: float
    stop_loss: float | None = None
    take_profits: list[float] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.strategy}:{self.symbol}"
