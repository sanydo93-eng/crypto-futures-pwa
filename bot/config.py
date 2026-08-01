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
    state_path: str = "/data/state.json"
    dry_run: bool = False
    send_startup_message: bool = True
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        env = dict(env if env is not None else os.environ)

        token = _required(env, "TELEGRAM_BOT_TOKEN")
        chat_id = _required(env, "TELEGRAM_CHAT_ID")

        symbols = [s.strip().upper() for s in env.get("SYMBOLS", "XBTUSDTM,ETHUSDTM").split(",") if s.strip()]
        if not symbols:
            raise ValueError("SYMBOLS is empty")

        granularity = int(env.get("GRANULARITY", "15"))
        if granularity not in VALID_GRANULARITIES:
            raise ValueError(
                f"GRANULARITY={granularity} is not supported by KuCoin Futures; "
                f"use one of {', '.join(map(str, VALID_GRANULARITIES))}"
            )

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
            strategy=env.get("STRATEGY", "ema_rsi").strip(),
            strategy_params=params,
            candle_lag_seconds=int(env.get("CANDLE_LAG_SECONDS", "10")),
            poll_interval_seconds=int(env.get("POLL_INTERVAL_SECONDS", "0")),
            cooldown_candles=int(env.get("COOLDOWN_CANDLES", "3")),
            history_candles=int(env.get("HISTORY_CANDLES", "300")),
            state_path=env.get("STATE_PATH", "/data/state.json"),
            dry_run=_flag(env.get("DRY_RUN"), False),
            send_startup_message=_flag(env.get("SEND_STARTUP_MESSAGE"), True),
            log_level=env.get("LOG_LEVEL", "INFO").upper(),
        )


def _required(env: dict[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ValueError(f"{key} is not set — copy .env.example to .env and fill it in")
    return value


def _flag(raw: str | None, default: bool) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")
