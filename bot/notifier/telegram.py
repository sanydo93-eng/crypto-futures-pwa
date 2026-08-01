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

CAPTION_LIMIT = 1024


class TelegramNotifier:
    def __init__(
        self,
        token: str,
        chat_id: str,
        timeout: float = 20.0,
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
        resp = await self._client.get("/getMe")
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get("ok"):
            raise RuntimeError(f"Telegram getMe failed: {payload}")
        return payload["result"].get("username", "unknown")

    async def send(self, text: str) -> bool:
        return await self._call(
            "/sendMessage",
            json={
                "chat_id": self._chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            preview=text,
        )

    async def send_photo(self, image: bytes, caption: str) -> bool:
        if len(caption) > CAPTION_LIMIT:
            caption = caption[: CAPTION_LIMIT - 1].rstrip() + "…"
        return await self._call(
            "/sendPhoto",
            data={"chat_id": self._chat_id, "caption": caption, "parse_mode": "HTML"},
            files={"photo": ("chart.png", image, "image/png")},
            preview=caption,
        )

    async def _call(self, method: str, preview: str, **kwargs) -> bool:
        if self._dry_run:
            log.info("DRY_RUN, not sending:\n%s", preview)
            return True

        delay = 1.0
        for attempt in range(1, self._max_retries + 1):
            try:
                resp = await self._client.post(method, **kwargs)
                if resp.status_code == 429:
                    retry_after = int(resp.json().get("parameters", {}).get("retry_after", delay))
                    log.warning("Telegram rate limited, sleeping %ss", retry_after)
                    await asyncio.sleep(retry_after)
                    continue
                if resp.status_code >= 400:
                    log.error("Telegram %s rejected: %s %s", method, resp.status_code, resp.text[:300])
                    resp.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                log.warning("Telegram %s failed (attempt %d/%d): %s", method, attempt, self._max_retries, exc)
                if attempt == self._max_retries:
                    log.error("giving up on Telegram %s after %d attempts", method, self._max_retries)
                    return False
                await asyncio.sleep(delay)
                delay *= 2
        return False


def format_signal(signal: Signal, granularity: int, app_url: str = "", compact: bool = False) -> str:
    """Full message for text mode; `compact=True` fits inside a photo caption."""
    arrow = "🟢" if signal.side is Side.LONG else "🔴"
    ts = datetime.fromtimestamp(signal.candle_ts / 1000, tz=timezone.utc)

    lines = [
        f"{arrow} <b>{html.escape(signal.side.value)}</b> · <b>{html.escape(signal.symbol)}</b>"
        f"  —  сила <b>{signal.strength:.0f}/100</b> ({html.escape(signal.grade)})",
        _strength_bar(signal.strength),
        "",
        f"Вход:  <code>{_fmt(signal.price)}</code>",
    ]

    if signal.stop_loss is not None:
        risk_pct = abs(signal.price - signal.stop_loss) / signal.price * 100
        lines.append(f"Стоп:  <code>{_fmt(signal.stop_loss)}</code>  (−{risk_pct:.2f}%)")
    for i, tp in enumerate(signal.take_profits, start=1):
        gain_pct = abs(tp - signal.price) / signal.price * 100
        rr = signal.r_multiple_at(tp)
        lines.append(f"Цель {i}: <code>{_fmt(tp)}</code>  (+{gain_pct:.2f}%, {rr:.1f}R)")

    if signal.zone:
        lines.append(
            f"Зона FVG: <code>{_fmt(signal.zone['bottom'])} – {_fmt(signal.zone['top'])}</code>"
        )

    lines.append("")
    lines.append("<b>Почему:</b>")
    reasons = signal.reasons[: 3 if compact else len(signal.reasons)]
    lines.extend(f"• {html.escape(r)}" for r in reasons)
    if compact and len(signal.reasons) > 3:
        lines.append(f"• …ещё {len(signal.reasons) - 3} — подробности в приложении")

    lines.append("")
    lines.append("⏱ Сделка закрывается максимум через сутки.")
    if app_url:
        link = f"{app_url}/#/signal/{signal.id}" if signal.id else app_url
        lines.append(f'📊 <a href="{html.escape(link)}">Открыть график и статистику</a>')

    lines.append(
        f"<i>{html.escape(signal.strategy)} · {_tf(granularity)} · "
        f"свеча {ts:%d.%m %H:%M} UTC</i>"
    )
    lines.append("<i>Не является инвестиционной рекомендацией.</i>")
    return "\n".join(lines)


def format_trade_closed(update, app_url: str = "") -> str:
    icons = {"win": "✅", "loss": "❌", "breakeven": "➖"}
    titles = {"win": "Профит", "loss": "Убыток", "breakeven": "Безубыток"}
    reasons = {
        "sl": "сработал стоп",
        "be": "стоп в безубытке",
        "tp1": "взята цель 1",
        "tp2": "взята цель 2",
        "tp3": "взята цель 3",
        "timeout": "закрыто по времени (сутки)",
    }

    icon = icons.get(update.status, "•")
    sign = "+" if update.r_multiple >= 0 else ""
    lines = [
        f"{icon} <b>{titles.get(update.status, update.status)}</b> · "
        f"<b>{html.escape(update.symbol)}</b> {update.side.value}",
        f"Выход: <code>{_fmt(update.exit_price)}</code> — {reasons.get(update.exit_reason, update.exit_reason)}",
        f"Результат: <b>{sign}{update.r_multiple:.2f}R</b> ({sign}{update.pnl_pct:.2f}%)",
    ]
    if app_url:
        lines.append(f'📊 <a href="{html.escape(app_url)}/#/stats">Статистика</a>')
    return "\n".join(lines)


def _strength_bar(strength: float) -> str:
    filled = int(round(max(0.0, min(100.0, strength)) / 10))
    return "▰" * filled + "▱" * (10 - filled)


def _fmt(value: float) -> str:
    if value >= 1000:
        return f"{value:,.2f}".replace(",", " ")
    if value >= 1:
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return f"{value:.8f}".rstrip("0").rstrip(".")


def _tf(granularity: int) -> str:
    if granularity % 1440 == 0:
        return f"{granularity // 1440}d"
    if granularity % 60 == 0:
        return f"{granularity // 60}h"
    return f"{granularity}m"
