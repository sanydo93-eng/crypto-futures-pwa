"""HTTP API + static hosting for the PWA."""

from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web

from . import balance as balance_module
from . import stats as stats_module

log = logging.getLogger(__name__)

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"

STORAGE = web.AppKey("storage", object)
CONFIG = web.AppKey("config", object)


def build_app(storage, config) -> web.Application:
    app = web.Application()
    app[STORAGE] = storage
    app[CONFIG] = config

    app.router.add_get("/api/health", _health)
    app.router.add_get("/api/config", _config)
    app.router.add_get("/api/feed", _feed)
    app.router.add_get("/api/signals/{signal_id}", _signal_detail)
    app.router.add_get("/api/stats", _stats)
    app.router.add_get("/api/market", _market_summary)
    app.router.add_get("/api/market/{symbol}", _market_detail)

    if WEB_ROOT.is_dir():
        app.router.add_get("/", _index)
        app.router.add_get("/index.html", _index)
        app.router.add_static("/", WEB_ROOT, show_index=False)
    else:
        log.warning("web root %s is missing, serving API only", WEB_ROOT)

    app.middlewares.append(_cors)
    return app


@web.middleware
async def _cors(request: web.Request, handler):
    if request.method == "OPTIONS":
        response = web.Response(status=204)
    else:
        response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response


async def _index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_ROOT / "index.html")


async def _health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def _config(request: web.Request) -> web.Response:
    config = request.app[CONFIG]
    return web.json_response(
        {
            "symbols": config.symbols,
            "granularity": config.granularity,
            "strategy": config.strategy,
            "max_hold_hours": config.max_hold_hours,
            "balance_currency": config.balance_currency,
            "risk_per_trade_pct": config.risk_per_trade_pct,
        }
    )


async def _feed(request: web.Request) -> web.Response:
    storage = request.app[STORAGE]
    limit = _clamp(request.query.get("limit"), default=30, low=1, high=100)
    offset = _clamp(request.query.get("offset"), default=0, low=0, high=100_000)
    symbol = request.query.get("symbol") or None
    return web.json_response(
        {
            "items": storage.feed(limit=limit, offset=offset, symbol=symbol),
            "symbols": storage.symbols_seen(),
        }
    )


async def _signal_detail(request: web.Request) -> web.Response:
    storage = request.app[STORAGE]
    try:
        signal_id = int(request.match_info["signal_id"])
    except ValueError:
        raise web.HTTPBadRequest(reason="signal id must be a number")

    detail = storage.signal_detail(signal_id)
    if detail is None:
        raise web.HTTPNotFound(reason="signal not found")
    return web.json_response(detail)


async def _stats(request: web.Request) -> web.Response:
    storage = request.app[STORAGE]
    config = request.app[CONFIG]
    body = stats_module.build(storage)
    body["balance"] = balance_module.build(
        storage, config.starting_balance, config.risk_per_trade_pct, config.balance_currency
    )
    return web.json_response(body)


async def _market_summary(request: web.Request) -> web.Response:
    storage = request.app[STORAGE]
    return web.json_response({"items": storage.market_summary(), "granularity": request.app[CONFIG].granularity})


async def _market_detail(request: web.Request) -> web.Response:
    storage = request.app[STORAGE]
    symbol = request.match_info["symbol"].upper()
    limit = _clamp(request.query.get("limit"), default=200, low=10, high=500)
    candles = storage.market_candles(symbol, limit)
    if not candles:
        raise web.HTTPNotFound(reason="no market data for this symbol yet")
    return web.json_response(
        {"symbol": symbol, "granularity": request.app[CONFIG].granularity, "candles": candles}
    )


def _clamp(raw: str | None, default: int, low: int, high: int) -> int:
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        return default
    return max(low, min(high, value))


async def start(app: web.Application, host: str, port: int) -> web.AppRunner:
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    log.info("web app listening on http://%s:%d", host, port)
    return runner
