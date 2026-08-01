"""Zonal trading: entry on the retest of a Fair Value Gap.

The idea, in order:

1. Price leaves an imbalance behind (FVG) — a zone it moved through too fast.
2. Price comes back to that zone and *reacts* — dips in, closes back out.
3. We enter on that reaction, with the stop just beyond the zone, because if
   price closes through the zone the whole premise is dead.

Everything that makes one retest better than another (trend behind it, whether
the zone is untouched, how violent the move that created it was, how clean the
rejection is) becomes a scored factor, so the signal ships with its reasoning
attached rather than a bare verdict.
"""

from __future__ import annotations

from .. import indicators as ind
from ..models import Candle, Side, Signal
from ..scoring import Score, scale
from ..zones import find_zones, rejection_ratio, retested_zone
from .base import Strategy, register


@register("fvg_retest")
class FvgRetestStrategy(Strategy):
    def __init__(self, params: dict[str, str] | None = None) -> None:
        super().__init__(params)
        self.atr_period = self.param_int("ATR_PERIOD", 14)
        self.trend_fast = self.param_int("TREND_FAST", 50)
        self.trend_slow = self.param_int("TREND_SLOW", 200)
        self.rsi_period = self.param_int("RSI_PERIOD", 14)

        self.zone_max_age = self.param_int("ZONE_MAX_AGE", 60)
        self.zone_max_touches = self.param_int("ZONE_MAX_TOUCHES", 2)
        self.zone_min_atr = self.param_float("ZONE_MIN_ATR", 0.10)
        self.zone_max_atr = self.param_float("ZONE_MAX_ATR", 4.0)

        self.stop_buffer_atr = self.param_float("STOP_BUFFER_ATR", 0.25)
        self.rr_targets = [
            self.param_float("RR_TP1", 1.5),
            self.param_float("RR_TP2", 3.0),
        ]
        self.min_strength = self.param_float("MIN_STRENGTH", 55.0)
        self.require_trend = self.param_bool("REQUIRE_TREND", True)

        self.warmup = max(self.trend_slow, self.zone_max_age) + 30

    def evaluate(self, symbol: str, candles: list[Candle]) -> Signal | None:
        if len(candles) < self.warmup:
            return None

        closes = ind.closes(candles)
        atr = ind.atr(candles, self.atr_period)
        ema_fast = ind.ema(closes, self.trend_fast)
        ema_slow = ind.ema(closes, self.trend_slow)
        rsi = ind.rsi(closes, self.rsi_period)

        last_index = len(candles) - 1
        last = candles[-1]
        atr_now = atr[-1]
        if not atr_now or ema_fast[-1] is None or ema_slow[-1] is None or rsi[-1] is None:
            return None

        bias = self._trend_bias(last.close, float(ema_fast[-1]), float(ema_slow[-1]))
        if self.require_trend and bias is None:
            return None

        zones = find_zones(candles, atr, self.zone_min_atr, self.zone_max_atr)
        sides = [bias] if bias is not None else [Side.LONG, Side.SHORT]

        for side in sides:
            fresh = [
                z
                for z in zones
                if not z.invalidated
                and z.touches <= self.zone_max_touches
                and 1 <= z.age_candles(last_index) <= self.zone_max_age
            ]
            zone = retested_zone(fresh, last, side)
            if zone is None:
                continue

            signal = self._build(
                symbol=symbol,
                side=side,
                zone=zone,
                candles=candles,
                atr_now=float(atr_now),
                ema_fast=float(ema_fast[-1]),
                ema_slow=float(ema_slow[-1]),
                rsi_now=float(rsi[-1]),
                bias=bias,
                last_index=last_index,
            )
            if signal is not None:
                return signal

        return None

    def _trend_bias(self, close: float, fast: float, slow: float) -> Side | None:
        if close > slow and fast > slow:
            return Side.LONG
        if close < slow and fast < slow:
            return Side.SHORT
        return None

    def _build(
        self,
        symbol: str,
        side: Side,
        zone,
        candles: list[Candle],
        atr_now: float,
        ema_fast: float,
        ema_slow: float,
        rsi_now: float,
        bias: Side | None,
        last_index: int,
    ) -> Signal | None:
        last = candles[-1]
        entry = last.close
        buffer_ = self.stop_buffer_atr * atr_now

        if side is Side.LONG:
            stop = zone.bottom - buffer_
            if stop >= entry:
                return None
        else:
            stop = zone.top + buffer_
            if stop <= entry:
                return None

        risk = abs(entry - stop)
        if risk <= 0:
            return None

        targets = [
            entry + rr * risk if side is Side.LONG else entry - rr * risk
            for rr in self.rr_targets
        ]

        score = self._score(
            side=side,
            zone=zone,
            candles=candles,
            atr_now=atr_now,
            ema_fast=ema_fast,
            ema_slow=ema_slow,
            rsi_now=rsi_now,
            bias=bias,
            risk=risk,
            entry=entry,
            last_index=last_index,
        )
        if score.total < self.min_strength:
            return None

        direction = "лонг" if side is Side.LONG else "шорт"
        headline = (
            f"Ретест {'бычьей' if side is Side.LONG else 'медвежьей'} FVG-зоны "
            f"{_fmt(zone.bottom)}–{_fmt(zone.top)}: цена вошла в зону и закрылась "
            f"обратно за неё — реакция в {direction}."
        )

        return Signal(
            symbol=symbol,
            side=side,
            strategy=self.name,
            candle_ts=last.ts,
            price=entry,
            stop_loss=stop,
            take_profits=targets,
            strength=score.total,
            grade=score.grade,
            factors=score.to_dict(),
            zone=zone.to_dict(before_ts=last.ts),
            reasons=[headline] + score.notes(),
            extra={
                "Стоп за зоной": f"{self.stop_buffer_atr}×ATR",
                "Риск": f"{risk / entry * 100:.2f}%",
            },
        )

    def _score(
        self,
        side: Side,
        zone,
        candles: list[Candle],
        atr_now: float,
        ema_fast: float,
        ema_slow: float,
        rsi_now: float,
        bias: Side | None,
        risk: float,
        entry: float,
        last_index: int,
    ) -> Score:
        score = Score()
        last = candles[-1]

        # 1. Trend agreement — the single biggest edge in zonal trading.
        if bias is side:
            score.add(
                "trend",
                "Тренд",
                25,
                25,
                f"EMA{self.trend_fast}/EMA{self.trend_slow} и цена согласованы по направлению",
            )
        elif bias is None:
            score.add("trend", "Тренд", 8, 25, "тренд не выражен, сделка против рынка не подтверждена")
        else:
            score.add("trend", "Тренд", 0, 25, "вход против тренда старших EMA")

        # 2. Freshness — an untouched gap has the whole unfilled order flow behind it.
        # Counted before the current candle, which is itself a touch.
        prior = zone.touches_before(last.ts)
        if prior == 0:
            score.add("freshness", "Свежесть зоны", 20, 20, "зона нетронутая, это первый ретест")
        elif prior == 1:
            score.add("freshness", "Свежесть зоны", 11, 20, "зону уже касались один раз")
        else:
            score.add("freshness", "Свежесть зоны", 4, 20, f"зону касались {prior} раза")

        # 3. Displacement — how decisive the move that left the gap was.
        disp = zone.displacement_atr
        score.add(
            "displacement",
            "Импульс",
            scale(disp, 0.3, 1.6, 20),
            20,
            f"свеча, создавшая зону, = {disp:.2f}×ATR",
        )

        # 4. Zone geometry — a gap that is too thin is noise, too fat is a bad stop.
        size_atr = zone.height / atr_now
        if size_atr < 0.2:
            geometry_note = f"зона узкая ({size_atr:.2f}×ATR), риск шумного стопа"
            geometry = 5.0
        elif size_atr > 2.0:
            geometry_note = f"зона широкая ({size_atr:.2f}×ATR), стоп получается дальним"
            geometry = 6.0
        else:
            geometry_note = f"размер зоны комфортный ({size_atr:.2f}×ATR)"
            geometry = 15.0
        score.add("geometry", "Геометрия зоны", geometry, 15, geometry_note)

        # 5. Reaction quality — the rejection wick on the retest candle.
        wick = rejection_ratio(last, side)
        score.add(
            "reaction",
            "Реакция",
            scale(wick, 0.15, 0.6, 10),
            10,
            f"хвост отбоя = {wick * 100:.0f}% диапазона свечи",
        )

        # 6. Retest volume — a quiet pullback into the zone is the healthy kind.
        vols = ind.volumes(candles)
        avg_vol = sum(vols[-21:-1]) / 20 if len(vols) > 21 else 0.0
        if avg_vol > 0:
            ratio = last.volume / avg_vol
            volume_score = 10.0 if ratio <= 1.0 else scale(2.0 - ratio, 0.0, 1.0, 10)
            note = f"объём ретеста {ratio:.2f}× от среднего"
        else:
            volume_score, note = 5.0, "недостаточно данных по объёму"
        score.add("volume", "Объём", volume_score, 10, note)

        # 7. RSI — penalise entering into an already exhausted move.
        if side is Side.LONG:
            rsi_score = 0.0 if rsi_now > 78 else scale(75 - rsi_now, 0, 25, 10)
        else:
            rsi_score = 0.0 if rsi_now < 22 else scale(rsi_now - 25, 0, 25, 10)
        score.add("rsi", "RSI", rsi_score, 10, f"RSI({self.rsi_period}) = {rsi_now:.0f}")

        return score


def _fmt(value: float) -> str:
    if value >= 1000:
        return f"{value:,.1f}".replace(",", " ")
    if value >= 1:
        return f"{value:.3f}".rstrip("0").rstrip(".")
    return f"{value:.6f}".rstrip("0").rstrip(".")
