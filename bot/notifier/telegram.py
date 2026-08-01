"""Telegram delivery.

Secrets (bot token, chat id) come from the environment only — they are never
written to the repo or to the log.
"""

from __future__ import annotations

import asyncio
import html
import logging
from datetime import datetime, timezone

import httpx

from ..models import Side, Signal

log = logging.getLogger(__name__)


class TelegramNotifier:
    def __init__(
        self,
        token: str,
        chat_id: str,
        timeout: float = 15.0,
        max_retries: int = 4,
        dry_run: bool = False,
    ) -> None:
        self._chat_id = chat_id
        self._dry_run = dry_run
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(
            base_url=f"https://api.telegram.org/bot{token}",
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def verify(self) -> str:
        """Confirm the token works; returns the bot username."""
        resp = await self._client.get("/getMe")
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get("ok"):
            raise RuntimeError(f"Telegram getMe failed: {payload}")
        return payload["result"].get("username", "unknown")

    async def send(self, text: str) -> bool:
        if self._dry_run:
            log.info("DRY_RUN, not sending:\n%s", text)
            return True

        delay = 1.0
        for attempt in range(1, self._max_retries + 1):
            try:
                resp = await self._client.post(
                    "/sendMessage",
                    json={
                        "chat_id": self._chat_id,
                        "text": text,
                        "parse_mode": "HTML",
                        "disable_web_page_preview": True,
                    },
                )
                if resp.status_code == 429:
                    retry_after = int(resp.json().get("parameters", {}).get("retry_after", delay))
                    log.warning("Telegram rate limited, sleeping %ss", retry_after)
                    await asyncio.sleep(retry_after)
                    continue
                resp.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                log.warning(
                    "Telegram send failed (attempt %d/%d): %s", attempt, self._max_retries, exc
                )
                if attempt == self._max_retries:
                    log.error("giving up on Telegram message after %d attempts", self._max_retries)
                    return False
                await asyncio.sleep(delay)
                delay *= 2
        return False


def format_signal(signal: Signal, granularity: int) -> str:
    arrow = "🟢" if signal.side is Side.LONG else "🔴"
    ts = datetime.fromtimestamp(signal.candle_ts / 1000, tz=timezone.utc)

    lines = [
        f"{arrow} <b>{html.escape(signal.side.value)}</b> — <b>{html.escape(signal.symbol)}</b>",
        f"Вход: <code>{_fmt(signal.price)}</code>",
    ]
    if signal.stop_loss is not None:
        risk_pct = abs(signal.price - signal.stop_loss) / signal.price * 100
        lines.append(f"Стоп: <code>{_fmt(signal.stop_loss)}</code>  ({risk_pct:.2f}%)")
    for i, tp in enumerate(signal.take_profits, start=1):
        gain_pct = abs(tp - signal.price) / signal.price * 100
        lines.append(f"Цель {i}: <code>{_fmt(tp)}</code>  (+{gain_pct:.2f}%)")

    if signal.reasons:
        lines.append("")
        lines.extend(f"• {html.escape(r)}" for r in signal.reasons)
    for key, value in signal.extra.items():
        lines.append(f"• {html.escape(key)}: {html.escape(str(value))}")

    lines.append("")
    lines.append(
        f"<i>{html.escape(signal.strategy)} · {_tf_label(granularity)} · "
        f"свеча {ts:%Y-%m-%d %H:%M} UTC</i>"
    )
    lines.append("<i>Не является инвестиционной рекомендацией.</i>")
    return "\n".join(lines)


def _fmt(value: float) -> str:
    if value >= 1000:
        return f"{value:,.2f}".replace(",", " ")
    if value >= 1:
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return f"{value:.8f}".rstrip("0").rstrip(".")


def _tf_label(granularity: int) -> str:
    if granularity % 1440 == 0:
        return f"{granularity // 1440}d"
    if granularity % 60 == 0:
        return f"{granularity // 60}h"
    return f"{granularity}m"
