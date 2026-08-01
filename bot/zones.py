"""Fair Value Gap detection and zone lifecycle.

A Fair Value Gap (FVG, imbalance) is a three-candle pattern where price moved
so fast that candle 1 and candle 3 do not overlap, leaving an unfilled range:

    bullish                       bearish
    candle3.low > candle1.high    candle3.high < candle1.low
    zone = [candle1.high, candle3.low]   zone = [candle3.high, candle1.low]

The zone is where price is expected to return ("retest") before continuing.
We track each zone's life: fresh -> touched -> invalidated, because a fresh
zone is worth far more than one price has already chewed through.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Candle, Side


@dataclass
class Zone:
    side: Side  # LONG = bullish gap (support), SHORT = bearish gap (resistance)
    top: float
    bottom: float
    created_ts: int  # timestamp of the middle (displacement) candle
    created_index: int
    displacement_atr: float  # size of the impulse candle in ATR units
    touches: int = 0
    invalidated: bool = False
    invalidated_ts: int | None = None
    touch_ts: list[int] = field(default_factory=list)

    @property
    def height(self) -> float:
        return self.top - self.bottom

    @property
    def mid(self) -> float:
        return (self.top + self.bottom) / 2

    @property
    def is_fresh(self) -> bool:
        return self.touches == 0 and not self.invalidated

    def contains(self, price: float) -> bool:
        return self.bottom <= price <= self.top

    def age_candles(self, current_index: int) -> int:
        return current_index - self.created_index

    def to_dict(self) -> dict:
        return {
            "side": self.side.value,
            "top": self.top,
            "bottom": self.bottom,
            "created_ts": self.created_ts,
            "touches": self.touches,
            "invalidated": self.invalidated,
            "displacement_atr": round(self.displacement_atr, 3),
        }


def find_zones(
    candles: list[Candle],
    atr: list[float | None],
    min_size_atr: float = 0.10,
    max_size_atr: float = 4.0,
) -> list[Zone]:
    """Detect every FVG in the series and replay price through each one.

    Returns zones oldest-first, including invalidated ones (callers filter).
    """
    zones: list[Zone] = []

    for i in range(2, len(candles)):
        first, middle, third = candles[i - 2], candles[i - 1], candles[i]
        atr_now = atr[i] if i < len(atr) and atr[i] else None
        if not atr_now:
            continue

        if third.low > first.high:
            zone = Zone(
                side=Side.LONG,
                top=third.low,
                bottom=first.high,
                created_ts=middle.ts,
                created_index=i,
                displacement_atr=abs(middle.close - middle.open) / atr_now,
            )
        elif third.high < first.low:
            zone = Zone(
                side=Side.SHORT,
                top=first.low,
                bottom=third.high,
                created_ts=middle.ts,
                created_index=i,
                displacement_atr=abs(middle.close - middle.open) / atr_now,
            )
        else:
            continue

        size_in_atr = zone.height / atr_now
        if not (min_size_atr <= size_in_atr <= max_size_atr):
            continue

        _replay(zone, candles)
        zones.append(zone)

    return zones


def _replay(zone: Zone, candles: list[Candle]) -> None:
    """Walk price forward from zone creation, recording touches and death."""
    for j in range(zone.created_index + 1, len(candles)):
        candle = candles[j]

        if zone.side is Side.LONG:
            entered = candle.low <= zone.top
            broken = candle.close < zone.bottom
        else:
            entered = candle.high >= zone.bottom
            broken = candle.close > zone.top

        if entered:
            zone.touches += 1
            zone.touch_ts.append(candle.ts)

        if broken:
            zone.invalidated = True
            zone.invalidated_ts = candle.ts
            return


def active_zones(
    zones: list[Zone],
    side: Side,
    current_index: int,
    max_age_candles: int,
    max_touches: int = 2,
) -> list[Zone]:
    """Zones still worth trading, nearest-to-creation last."""
    return [
        z
        for z in zones
        if z.side is side
        and not z.invalidated
        and z.touches <= max_touches
        and z.age_candles(current_index) <= max_age_candles
        and z.age_candles(current_index) >= 1
    ]


def retested_zone(
    zones: list[Zone],
    candle: Candle,
    side: Side,
) -> Zone | None:
    """The zone the current candle is retesting with a rejection, if any.

    A valid retest means price dipped into the zone and closed back out of it —
    an actual reaction, not a candle sitting inside the gap or slicing through.
    """
    candidates = []
    for zone in zones:
        if zone.side is not side:
            continue
        if side is Side.LONG:
            dipped_in = candle.low <= zone.top
            closed_out = candle.close > zone.top
            held = candle.low >= zone.bottom
        else:
            dipped_in = candle.high >= zone.bottom
            closed_out = candle.close < zone.bottom
            held = candle.high <= zone.top

        if dipped_in and closed_out and held:
            candidates.append(zone)

    if not candidates:
        return None
    # Prefer the freshest zone, then the most recently created one.
    return sorted(candidates, key=lambda z: (z.touches, -z.created_index))[0]


def rejection_ratio(candle: Candle, side: Side) -> float:
    """How much of the candle is the rejection wick, 0..1."""
    span = candle.high - candle.low
    if span <= 0:
        return 0.0
    if side is Side.LONG:
        wick = min(candle.open, candle.close) - candle.low
    else:
        wick = candle.high - max(candle.open, candle.close)
    return max(0.0, min(1.0, wick / span))
