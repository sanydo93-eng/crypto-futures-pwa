"""Strategy interface and registry.

A strategy looks at a list of *closed* candles (oldest first) and either
returns a Signal for the most recent candle or returns None. It must be
stateless: dedup, cooldowns and delivery are handled by the runner.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable

from ..models import Candle, Signal

_REGISTRY: dict[str, type["Strategy"]] = {}


class Strategy(ABC):
    #: how many candles the strategy needs before it can produce anything
    warmup: int = 100

    def __init__(self, params: dict[str, str] | None = None) -> None:
        self.params = params or {}

    @property
    def name(self) -> str:
        return type(self).strategy_name  # type: ignore[attr-defined]

    @abstractmethod
    def evaluate(self, symbol: str, candles: list[Candle]) -> Signal | None:
        """Return a Signal for candles[-1], or None."""

    # -- small helpers for reading params out of the environment ------------

    def param_float(self, key: str, default: float) -> float:
        raw = self.params.get(key)
        return float(raw) if raw not in (None, "") else default

    def param_int(self, key: str, default: int) -> int:
        raw = self.params.get(key)
        return int(raw) if raw not in (None, "") else default

    def param_bool(self, key: str, default: bool) -> bool:
        raw = self.params.get(key)
        if raw in (None, ""):
            return default
        return str(raw).strip().lower() in ("1", "true", "yes", "on")


def register(name: str) -> Callable[[type[Strategy]], type[Strategy]]:
    def wrap(cls: type[Strategy]) -> type[Strategy]:
        cls.strategy_name = name  # type: ignore[attr-defined]
        _REGISTRY[name] = cls
        return cls

    return wrap


def build_strategy(name: str, params: dict[str, str] | None = None) -> Strategy:
    if name not in _REGISTRY:
        raise KeyError(f"unknown strategy {name!r}; available: {sorted(_REGISTRY)}")
    return _REGISTRY[name](params)


def available() -> list[str]:
    return sorted(_REGISTRY)
