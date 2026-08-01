"""Persisted dedup state.

Guards against two failure modes: re-sending the same signal after a restart,
and spamming the channel when a strategy keeps firing on consecutive candles.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile

from .models import Signal

log = logging.getLogger(__name__)


class SignalState:
    def __init__(self, path: str) -> None:
        self._path = path
        self._data: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as fh:
                self._data = json.load(fh)
            log.info("loaded signal state for %d keys from %s", len(self._data), self._path)
        except FileNotFoundError:
            self._data = {}
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("could not read state at %s (%s); starting fresh", self._path, exc)
            self._data = {}

    def _save(self) -> None:
        directory = os.path.dirname(self._path) or "."
        try:
            os.makedirs(directory, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self._data, fh)
            os.replace(tmp, self._path)
        except OSError as exc:
            log.error("could not persist state to %s: %s", self._path, exc)

    def should_send(self, signal: Signal, granularity: int, cooldown_candles: int) -> bool:
        previous = self._data.get(signal.key)
        if previous is None:
            return True

        last_ts = int(previous.get("candle_ts", 0))
        if signal.candle_ts <= last_ts:
            return False

        # Reversals always go out; repeats of the same direction wait out the cooldown.
        if previous.get("side") != signal.side.value:
            return True

        elapsed_candles = (signal.candle_ts - last_ts) / (granularity * 60 * 1000)
        return elapsed_candles >= cooldown_candles

    def record(self, signal: Signal) -> None:
        self._data[signal.key] = {"candle_ts": signal.candle_ts, "side": signal.side.value}
        self._save()
