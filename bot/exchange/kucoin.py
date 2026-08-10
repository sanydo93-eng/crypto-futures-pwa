"""KuCoin Futures market-data client.

Only public endpoints are used, so no API keys are required. Base URL:
https://api-futures.kucoin.com

The kline endpoint returns bare arrays without field names, and KuCoin uses a
different column order for spot and futures. Rather than hard-coding one, we
detect the layout from the data itself (highs must dominate, lows must be
dominated) and cache the result. If neither layout validates we fail loudly
instead of silently trading on garbage.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from ..models import Candle

log = logging.getLogger(__name__)

BASE_URL = "https://api-futures.kucoin.com"

# Granularities KuCoin Futures accepts for /api/v1/kline/query, in minutes.
VALID_GRANULARITIES = (1, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 10080)

# (open, high, low, close, volume) index into a raw row whose [0] is the timestamp.
_LAYOUTS: dict[str, tuple[int, int, int, int, int]] = {
    "ohlcv": (1, 2, 3, 4, 5),  # [t, open, high, low, close, volume]
    "ochlv": (1, 3, 4, 2, 5),  # [t, open, close, high, low, volume]
}


class KuCoinError(RuntimeError):
    pass


class KuCoinFutures:
    def __init__(
        self,
        base_url: str = BASE_URL,
        timeout: float = 15.0,
        max_retries: int = 4,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"User-Agent": "crypto-futures-signals/1.0"},
        )
        self._max_retries = max_retries
        self._layout: str | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "KuCoinFutures":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def _get(self, path: str, params: dict | None = None) -> object:
        delay = 1.0
        last_error: Exception | None = None
        for attempt in range(1, self._max_retries + 1):
            try:
                resp = await self._client.get(path, params=params)
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise KuCoinError(f"HTTP {resp.status_code} from {path}")
                resp.raise_for_status()
                payload = resp.json()
                if str(payload.get("code")) != "200000":
                    raise KuCoinError(f"{path} returned code={payload.get('code')} msg={payload.get('msg')}")
                return payload.get("data")
            except (httpx.HTTPError, KuCoinError, ValueError) as exc:
                last_error = exc
                if attempt == self._max_retries:
                    break
                log.warning("KuCoin %s failed (attempt %d/%d): %s", path, attempt, self._max_retries, exc)
                await asyncio.sleep(delay)
                delay *= 2
        raise KuCoinError(f"KuCoin request {path} failed after {self._max_retries} attempts: {last_error}")

    async def active_symbols(self) -> list[str]:
        data = await self._get("/api/v1/contracts/active")
        if not isinstance(data, list):
            raise KuCoinError("unexpected payload for /api/v1/contracts/active")
        return [c["symbol"] for c in data if c.get("status") == "Open"]

    async def klines(self, symbol: str, granularity: int, limit: int = 200) -> list[Candle]:
        """Fetch the most recent `limit` candles, oldest first.

        The final candle is the still-forming one; callers that act on candle
        close should drop it (see `closed_klines`).
        """
        if granularity not in VALID_GRANULARITIES:
            raise ValueError(
                f"granularity {granularity} is not supported by KuCoin Futures; "
                f"pick one of {VALID_GRANULARITIES}"
            )
        now_ms = _now_ms()
        span_ms = granularity * 60 * 1000 * (limit + 2)
        data = await self._get(
            "/api/v1/kline/query",
            params={"symbol": symbol, "granularity": granularity, "from": now_ms - span_ms},
        )
        if not isinstance(data, list) or not data:
            raise KuCoinError(f"no kline data returned for {symbol}")

        candles = self._parse(symbol, data)
        candles.sort(key=lambda c: c.ts)
        return candles[-limit:]

    async def closed_klines(self, symbol: str, granularity: int, limit: int = 200) -> list[Candle]:
        """Klines with the in-progress candle removed."""
        candles = await self.klines(symbol, granularity, limit + 1)
        cutoff = _now_ms() - granularity * 60 * 1000
        closed = [c for c in candles if c.ts <= cutoff]
        return closed[-limit:]

    async def funding_rate(self, symbol: str) -> float | None:
        try:
            data = await self._get(f"/api/v1/funding-rate/{symbol}/current")
        except KuCoinError as exc:
            log.warning("funding rate unavailable for %s: %s", symbol, exc)
            return None
        if isinstance(data, dict) and data.get("value") is not None:
            return float(data["value"])
        return None

    async def mark_price(self, symbol: str) -> float | None:
        try:
            data = await self._get(f"/api/v1/mark-price/{symbol}/current")
        except KuCoinError as exc:
            log.warning("mark price unavailable for %s: %s", symbol, exc)
            return None
        if isinstance(data, dict) and data.get("value") is not None:
            return float(data["value"])
        return None

    def _parse(self, symbol: str, rows: list) -> list[Candle]:
        layout = self._layout or _detect_layout(rows)
        if layout is None:
            raise KuCoinError(
                f"could not determine kline column order for {symbol}; "
                f"first row was {rows[0]!r}. KuCoin may have changed its response format."
            )
        if layout != self._layout:
            log.info("KuCoin kline layout detected: %s", layout)
            self._layout = layout

        o, h, l, c, v = _LAYOUTS[layout]
        return [
            Candle(
                ts=int(row[0]),
                open=float(row[o]),
                high=float(row[h]),
                low=float(row[l]),
                close=float(row[c]),
                volume=float(row[v]),
            )
            for row in rows
        ]


def _detect_layout(rows: list) -> str | None:
    for name, (o, h, l, c, _v) in _LAYOUTS.items():
        if all(_row_is_consistent(row, o, h, l, c) for row in rows):
            return name
    return None


def _row_is_consistent(row: list, o: int, h: int, l: int, c: int) -> bool:
    try:
        op, hi, lo, cl = float(row[o]), float(row[h]), float(row[l]), float(row[c])
    except (IndexError, TypeError, ValueError):
        return False
    return hi >= lo and hi >= max(op, cl) and lo <= min(op, cl)


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
