"""Signal bot entry point.

Runs two things side by side: the signal loop (poll KuCoin, evaluate the
strategy, publish and track trades) and the web app the PWA talks to.
"""

from __future__ import annotations

import asyncio
import logging
import signal as signal_module
import time

from . import api as api_module
from . import chart
from .config import Config
from .exchange import KuCoinError, KuCoinFutures
from .models import Candle, Signal
from .notifier import TelegramNotifier, format_signal, format_trade_closed
from .storage import Storage
from .strategies import build_strategy
from .tracker import TradeTracker

log = logging.getLogger("bot")


async def run(config: Config) -> None:
    strategy = build_strategy(config.strategy, config.strategy_params)
    storage = Storage(config.db_path)
    tracker = TradeTracker(storage, move_stop_to_breakeven=config.move_stop_to_breakeven)
    exchange = KuCoinFutures()
    notifier = TelegramNotifier(
        config.telegram_token, config.telegram_chat_id, dry_run=config.dry_run
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal_module.SIGINT, signal_module.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    runner = None
    try:
        await _preflight(config, strategy, exchange, notifier)

        if config.web_enabled:
            app = api_module.build_app(storage, config)
            runner = await api_module.start(app, config.web_host, config.web_port)

        while not stop.is_set():
            started = time.time()

            candles_by_symbol: dict[str, list[Candle]] = {}
            for symbol in config.symbols:
                if stop.is_set():
                    break
                candles = await _fetch(exchange, symbol, config)
                if candles:
                    candles_by_symbol[symbol] = candles
                    await _check_for_signal(
                        symbol, candles, config, strategy, notifier, storage
                    )

            await _review_open_trades(config, exchange, notifier, storage, tracker, candles_by_symbol)

            wait = _seconds_until_next_run(config, elapsed=time.time() - started)
            log.debug("sleeping %.1fs until next check", wait)
            try:
                await asyncio.wait_for(stop.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
    finally:
        log.info("shutting down")
        if runner is not None:
            await runner.cleanup()
        await exchange.aclose()
        await notifier.aclose()
        storage.close()


async def _preflight(config: Config, strategy, exchange: KuCoinFutures, notifier: TelegramNotifier) -> None:
    """Fail fast on bad config: wrong token, unknown symbols, broken kline format."""
    username = await notifier.verify()
    log.info("telegram bot: @%s", username)

    active = set(await exchange.active_symbols())
    unknown = [s for s in config.symbols if s not in active]
    if unknown:
        raise SystemExit(
            f"эти символы не торгуются на KuCoin Futures: {', '.join(unknown)}. "
            f"KuCoin использует имена вида XBTUSDTM (BTC), ETHUSDTM (ETH)."
        )

    probe = await exchange.closed_klines(config.symbols[0], config.granularity, limit=5)
    log.info(
        "kline probe ok: %s last close=%s at %s",
        config.symbols[0],
        probe[-1].close,
        probe[-1].opened_at,
    )

    if config.send_startup_message:
        link = f"\n📊 {config.app_url}" if config.app_url else ""
        await notifier.send(
            "🤖 Бот сигналов запущен\n"
            f"Пары: {', '.join(config.symbols)}\n"
            f"Таймфрейм: {config.granularity}m · стратегия: {strategy.name}\n"
            f"Сделка живёт максимум {config.max_hold_hours:g} ч{link}"
        )


async def _fetch(exchange: KuCoinFutures, symbol: str, config: Config) -> list[Candle]:
    try:
        return await exchange.closed_klines(symbol, config.granularity, config.history_candles)
    except KuCoinError as exc:
        log.error("could not fetch candles for %s: %s", symbol, exc)
        return []


async def _check_for_signal(
    symbol: str,
    candles: list[Candle],
    config: Config,
    strategy,
    notifier: TelegramNotifier,
    storage: Storage,
) -> None:
    if len(candles) < strategy.warmup:
        log.warning(
            "%s: only %d closed candles, strategy needs %d — skipping",
            symbol,
            len(candles),
            strategy.warmup,
        )
        return

    try:
        result: Signal | None = strategy.evaluate(symbol, candles)
    except Exception:
        log.exception("strategy %s raised on %s", strategy.name, symbol)
        return

    if result is None:
        return

    if storage.already_sent(result.strategy, symbol, result.candle_ts):
        return

    previous = storage.last_signal(result.strategy, symbol)
    if previous is not None and _too_soon(previous, result, config):
        log.info("%s: %s suppressed by cooldown", symbol, result.side.value)
        return

    signal_id = storage.save_signal(result, config.granularity, candles, config.max_hold_seconds)
    result.id = signal_id

    image = chart.render(result, candles, config.granularity) if config.send_chart else None
    if image:
        sent = await notifier.send_photo(
            image, format_signal(result, config.granularity, config.app_url, compact=True)
        )
    else:
        sent = await notifier.send(format_signal(result, config.granularity, config.app_url))

    if sent:
        log.info(
            "%s: sent %s @ %s (strength %.0f)",
            symbol,
            result.side.value,
            result.price,
            result.strength,
        )
    else:
        log.error("%s: signal %d saved but could not be delivered to Telegram", symbol, signal_id)


def _too_soon(previous, result: Signal, config: Config) -> bool:
    if previous["side"] != result.side.value:
        return False  # reversals always go out
    elapsed = (result.candle_ts - int(previous["candle_ts"])) / (config.granularity * 60 * 1000)
    return elapsed < config.cooldown_candles


async def _review_open_trades(
    config: Config,
    exchange: KuCoinFutures,
    notifier: TelegramNotifier,
    storage: Storage,
    tracker: TradeTracker,
    cached: dict[str, list[Candle]],
) -> None:
    for trade in storage.open_trades():
        symbol = trade["symbol"]
        candles = cached.get(symbol)
        if candles is None:
            candles = await _fetch(exchange, symbol, config)
            if not candles:
                continue
            cached[symbol] = candles

        try:
            update = tracker.review(trade, candles)
        except Exception:
            log.exception("could not review trade %s on %s", trade["id"], symbol)
            continue

        if update is not None:
            await notifier.send(format_trade_closed(update, config.app_url))


def _seconds_until_next_run(config: Config, elapsed: float) -> float:
    if config.poll_interval_seconds > 0:
        return max(1.0, config.poll_interval_seconds - elapsed)

    period = config.granularity * 60
    now = time.time()
    next_close = (int(now) // period + 1) * period
    return max(1.0, next_close + config.candle_lag_seconds - now)


def main() -> None:
    try:
        config = Config.from_env()
    except ValueError as exc:
        raise SystemExit(f"Ошибка конфигурации: {exc}")

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    log.info(
        "starting: symbols=%s granularity=%sm strategy=%s max_hold=%sh dry_run=%s",
        ",".join(config.symbols),
        config.granularity,
        config.strategy,
        config.max_hold_hours,
        config.dry_run,
    )
    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
