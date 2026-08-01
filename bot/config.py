"""Configuration, read entirely from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .exchange.kucoin import VALID_GRANULARITIES

# Strategy params are passed through verbatim to the strategy; anything with
# this prefix is stripped of the prefix and handed over.
STRATEGY_PARAM_PREFIX = "STRAT_"


@dataclass
class Config:
    telegram_token: str
    telegram_chat_id: str
    symbols: list[str]
    granularity: int
    strategy: str
    strategy_params: dict[str, str] = field(default_factory=dict)

    candle_lag_seconds: int = 10
    poll_interval_seconds: int = 0  # 0 = align to candle close
    cooldown_candles: int = 3
    history_candles: int = 300

    max_hold_hours: float = 24.0
    move_stop_to_breakeven: bool = True

    db_path: str = "/data/signals.db"
    web_enabled: bool = True
    web_host: str = "0.0.0.0"
    web_port: int = 8080
    app_url: str = ""

    send_chart: bool = True
    dry_run: bool = False
    send_startup_message: bool = True
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        env = dict(env if env is not None else os.environ)

        token = _required(env, "TELEGRAM_BOT_TOKEN")
        chat_id = _required(env, "TELEGRAM_CHAT_ID")

        symbols = [
            s.strip().upper() for s in env.get("SYMBOLS", "XBTUSDTM,ETHUSDTM").split(",") if s.strip()
        ]
        if not symbols:
            raise ValueError("SYMBOLS is empty")

        granularity = _int(env, "GRANULARITY", 15)
        if granularity not in VALID_GRANULARITIES:
            raise ValueError(
                f"GRANULARITY={granularity} is not supported by KuCoin Futures; "
                f"use one of {', '.join(map(str, VALID_GRANULARITIES))}"
            )

        max_hold_hours = _float(env, "MAX_HOLD_HOURS", 24.0)
        if not 0 < max_hold_hours <= 24:
            raise ValueError("MAX_HOLD_HOURS must be greater than 0 and at most 24")

        params = {
            key[len(STRATEGY_PARAM_PREFIX) :]: value
            for key, value in env.items()
            if key.startswith(STRATEGY_PARAM_PREFIX)
        }

        return cls(
            telegram_token=token,
            telegram_chat_id=chat_id,
            symbols=symbols,
            granularity=granularity,
            strategy=env.get("STRATEGY", "fvg_retest").strip(),
            strategy_params=params,
            candle_lag_seconds=_int(env, "CANDLE_LAG_SECONDS", 10),
            poll_interval_seconds=_int(env, "POLL_INTERVAL_SECONDS", 0),
            cooldown_candles=_int(env, "COOLDOWN_CANDLES", 3),
            history_candles=_int(env, "HISTORY_CANDLES", 300),
            max_hold_hours=max_hold_hours,
            move_stop_to_breakeven=_flag(env.get("MOVE_STOP_TO_BREAKEVEN"), True),
            db_path=env.get("DB_PATH", "/data/signals.db"),
            web_enabled=_flag(env.get("WEB_ENABLED"), True),
            web_host=env.get("WEB_HOST", "0.0.0.0"),
            web_port=_int(env, "WEB_PORT", 8080),
            app_url=env.get("APP_URL", "").strip().rstrip("/"),
            send_chart=_flag(env.get("SEND_CHART"), True),
            dry_run=_flag(env.get("DRY_RUN"), False),
            send_startup_message=_flag(env.get("SEND_STARTUP_MESSAGE"), True),
            log_level=env.get("LOG_LEVEL", "INFO").upper(),
        )

    @property
    def max_hold_seconds(self) -> int:
        return int(self.max_hold_hours * 3600)


def _required(env: dict[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ValueError(f"{key} is not set — copy .env.example to .env and fill it in")
    return value


def _int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a whole number, got {raw!r}") from exc


def _float(env: dict[str, str], key: str, default: float) -> float:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number, got {raw!r}") from exc


def _flag(raw: str | None, default: bool) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")
