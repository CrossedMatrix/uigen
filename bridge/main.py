"""
main.py — FastAPI live-futures server backed by ib_insync
──────────────────────────────────────────────────────────────────────────────
Target: IB Gateway Paper Trading  host=127.0.0.1  port=4002  clientId=1

Data flow:
  IB Gateway (port 4002)
    └─ ib_insync  ticker.updateEvent  (~every tick)
         └─ MARKET_DATA  (module-level in-memory dict)
              └─ GET /api/live-futures  (JSON, polled by Next.js every 2 s)

Run:
  cd bridge
  pip install -r requirements.txt
  python main.py

IB Gateway setup (one-time):
  1. Launch IB Gateway → choose Paper Trading
  2. Configure > API > Settings
       ✓ Enable ActiveX and Socket Clients
       ✓ Socket port: 4002
       ✓ Allow connections from localhost only
  3. Restart IB Gateway after saving
"""

import asyncio
import logging
import math
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ib_insync import IB, Future, Ticker, util

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("main")
logging.getLogger("ib_insync").setLevel(logging.WARNING)

# ─── IB Gateway configuration ─────────────────────────────────────────────────

IB_HOST      = "127.0.0.1"
IB_PORT      = 4002   # IB Gateway Paper Trading (live paper = 4002, live real = 4001)
IB_CLIENT_ID = 1
RECONNECT_S  = 30     # seconds to wait before retrying a failed connection

# Front-month contracts — explicit expiry avoids "Ambiguous contract" errors.
# Update lastTradeDateOrContractMonth each quarter (Mar=03, Jun=06, Sep=09, Dec=12).
# June 2026 front-month: ESM6, NQM6, ZNM6
_CONTRACTS = [
    Future(symbol="ES", exchange="CME",  currency="USD", lastTradeDateOrContractMonth="202606"),
    Future(symbol="NQ", exchange="CME",  currency="USD", lastTradeDateOrContractMonth="202606"),
    Future(symbol="ZN", exchange="CBOT", currency="USD", lastTradeDateOrContractMonth="202606"),
]

# Decimal precision per symbol (ZN: 32nds pricing → 4 dp; equity futures → 2 dp)
_TICK_DP: Dict[str, int] = {"ES": 2, "NQ": 2, "ZN": 4}

# ─── In-memory tick cache ─────────────────────────────────────────────────────
#
# Populated exclusively by ticker.updateEvent callbacks.
# Read by GET /api/live-futures on every poll.
#
# asyncio is single-threaded: the IB callback and the FastAPI request handler
# run in the same thread, so no explicit lock is needed.
#
# Fields intentionally minimal:
#   last        — most recent trade price (or None until first tick)
#   bid / ask   — inside market (or None until first tick)
#   change      — last − prior_close (requires ticker.close to be populated)
#   change_pct  — (change / prior_close) × 100

MARKET_DATA: Dict[str, Dict[str, Optional[float]]] = {
    "ES": {"last": None, "bid": None, "ask": None, "change": None, "change_pct": None},
    "NQ": {"last": None, "bid": None, "ask": None, "change": None, "change_pct": None},
    "ZN": {"last": None, "bid": None, "ask": None, "change": None, "change_pct": None},
}

# Global connection flag — written by the streaming task, read by the HTTP route
_ib_connected: bool = False


# ─── Tick helper ──────────────────────────────────────────────────────────────

def _coerce(value: Any, dp: int) -> Optional[float]:
    """
    Convert an ib_insync field to a rounded float, or None if the field is
    missing / NaN (IB returns NaN for fields not yet populated by the stream).
    """
    if value is None:
        return None
    try:
        f = float(value)
        return None if math.isnan(f) or math.isinf(f) else round(f, dp)
    except (TypeError, ValueError):
        return None


# ─── ticker.updateEvent handler factory ───────────────────────────────────────

def make_update_handler(symbol: str):
    """
    Returns a closure bound to *symbol* that updates MARKET_DATA whenever
    ticker.updateEvent fires.

    ticker.updateEvent is per-ticker and fires on every field change
    (last, bid, ask, volume, …).  We write only the fields the dashboard
    needs; the rest are ignored.
    """
    dp = _TICK_DP.get(symbol, 2)

    def _on_update(ticker: Ticker) -> None:
        last  = _coerce(ticker.last,  dp)
        bid   = _coerce(ticker.bid,   dp)
        ask   = _coerce(ticker.ask,   dp)
        close = _coerce(ticker.close, dp)   # prior-session settlement

        # Only overwrite fields with live non-None values.
        # When markets are closed ticker.last is NaN → None, so we leave the
        # historical seed (written by _seed_from_history) intact rather than
        # stomping it back to None on every heartbeat tick.
        if last is not None:
            MARKET_DATA[symbol]["last"] = last
        if bid is not None:
            MARKET_DATA[symbol]["bid"]  = bid
        if ask is not None:
            MARKET_DATA[symbol]["ask"]  = ask

        # Derive intraday change from the ticker's prior-session close.
        # Only recalculate when a live trade price is present; when the market is
        # closed the seeded change values from _seed_from_history are preserved.
        if last is not None and close is not None and close > 0:
            chg = round(last - close, dp)
            MARKET_DATA[symbol]["change"]     = chg
            MARKET_DATA[symbol]["change_pct"] = round((chg / close) * 100, 4)

    return _on_update


# ─── Historical close seeding (weekend / pre-market fallback) ────────────────

async def _seed_from_history(ib: IB, contracts: list) -> None:
    """
    Fetch the two most recent daily TRADE bars for each contract and inject the
    latest session's close into MARKET_DATA as a floor price.

    Called once after reqMktData subscriptions are bound.  On weekends and
    pre-market the live stream returns NaN for ticker.last, so MARKET_DATA stays
    all-None and the dashboard shows '--'.  This function fills that gap with the
    Friday (or most recent) settlement so the UI always has a meaningful price.

    Seeding is skipped for any symbol where a live tick already arrived first.
    Once the session opens, live ticks naturally override the seeded value because
    _on_update only writes non-None coerced prices.

    Change / change_pct are derived from the two bars:
      change     = bar[-1].close − bar[-2].close
      change_pct = (change / bar[-2].close) × 100
    """
    log.info("[IB] Seeding historical closes (weekend/pre-market fallback)…")

    for contract in contracts:
        sym = contract.symbol
        dp  = _TICK_DP.get(sym, 2)

        try:
            bars = await ib.reqHistoricalDataAsync(
                contract,
                endDateTime="",          # empty = up to now
                durationStr="2 D",       # two trading days covers Fri + Thu
                barSizeSetting="1 day",
                whatToShow="TRADES",
                useRTH=True,             # regular trading hours only
                formatDate=1,
                keepUpToDate=False,
            )
        except asyncio.CancelledError:
            raise                        # propagate so the stream loop can exit cleanly
        except Exception as exc:
            log.warning(f"[IB]   ✗  {sym}  historical fetch failed: {exc!r}")
            continue

        if not bars:
            log.warning(f"[IB]   ✗  {sym}  no historical bars returned")
            continue

        last_bar  = bars[-1]
        prior_bar = bars[-2] if len(bars) >= 2 else None

        close = round(float(last_bar.close), dp)
        prior = round(float(prior_bar.close), dp) if prior_bar else None

        # Don't clobber a live tick that beat us to the field
        if MARKET_DATA[sym]["last"] is None:
            MARKET_DATA[sym]["last"] = close
            if prior is not None and prior > 0:
                chg = round(close - prior, dp)
                MARKET_DATA[sym]["change"]     = chg
                MARKET_DATA[sym]["change_pct"] = round((chg / prior) * 100, 4)
            log.info(
                f"[IB]   ↩  {sym}  seeded  last={close}  "
                f"change={MARKET_DATA[sym]['change']}  "
                f"(bar={last_bar.date})"
            )
        else:
            log.info(
                f"[IB]   ↩  {sym}  live tick already present "
                f"({MARKET_DATA[sym]['last']}), skipping seed"
            )


# ─── IB streaming background task ─────────────────────────────────────────────

async def _ib_stream_loop() -> None:
    """
    Persistent coroutine launched at server startup.  Connects to IB Gateway,
    qualifies the front-month contracts, binds ticker.updateEvent handlers,
    then blocks until IB disconnects.  Automatically retries after RECONNECT_S.

    Cancelled cleanly by the lifespan shutdown hook.
    """
    global _ib_connected

    ib = IB()

    # Track active (ticker, handler) pairs so we can deregister cleanly on
    # each reconnect cycle, preventing duplicate callbacks from accumulating.
    _subs: List[Tuple[Ticker, Any]] = []

    def _teardown() -> None:
        global _ib_connected
        _ib_connected = False
        for ticker, handler in _subs:
            try:
                ticker.updateEvent -= handler
            except Exception:
                pass
        _subs.clear()
        if ib.isConnected():
            try:
                ib.disconnect()
            except Exception:
                pass

    try:
        while True:

            # ── 1. Connect ────────────────────────────────────────────────────
            try:
                log.info(
                    f"[IB] Connecting to IB Gateway  "
                    f"{IB_HOST}:{IB_PORT}  clientId={IB_CLIENT_ID}  readonly=True"
                )
                await ib.connectAsync(
                    IB_HOST,
                    IB_PORT,
                    clientId=IB_CLIENT_ID,
                    readonly=True,
                    timeout=10,
                )
            except asyncio.CancelledError:
                break
            except ConnectionRefusedError:
                log.warning(
                    f"[IB] Connection refused — "
                    f"is IB Gateway running on port {IB_PORT}?  "
                    f"Retry in {RECONNECT_S}s."
                )
                await asyncio.sleep(RECONNECT_S)
                continue
            except asyncio.TimeoutError:
                log.warning(f"[IB] Connect timed out.  Retry in {RECONNECT_S}s.")
                await asyncio.sleep(RECONNECT_S)
                continue
            except Exception as exc:
                log.error(f"[IB] Connect error: {exc!r}  Retry in {RECONNECT_S}s.")
                await asyncio.sleep(RECONNECT_S)
                continue

            _ib_connected = True
            log.info(f"[IB] Connected  ·  server version {ib.client.serverVersion()}")

            # ── 2. Qualify contracts (resolve conId for the explicit front-month) ──
            try:
                qualified = await ib.qualifyContractsAsync(*_CONTRACTS)
            except asyncio.CancelledError:
                _teardown()
                break
            except Exception as exc:
                log.error(f"[IB] qualifyContractsAsync failed: {exc!r}")
                _teardown()
                await asyncio.sleep(RECONNECT_S)
                continue

            if not qualified:
                log.error("[IB] No contracts qualified — check symbol/exchange/expiry.")
                _teardown()
                await asyncio.sleep(RECONNECT_S)
                continue

            # Deduplicate by symbol — if IB still returns multiple rows for the same
            # symbol (rare with an explicit expiry), keep the first (lowest conId / most
            # liquid) and warn so the expiry field can be rechecked if needed.
            seen: Dict[str, bool] = {}
            deduped = []
            for c in qualified:
                if c.symbol not in seen:
                    seen[c.symbol] = True
                    deduped.append(c)
                    log.info(
                        f"[IB]   ✓  {c.symbol:<4}  "
                        f"expiry={c.lastTradeDateOrContractMonth}  "
                        f"localSymbol={c.localSymbol}  conId={c.conId}"
                    )
                else:
                    log.warning(
                        f"[IB]   ⚠  {c.symbol} duplicate skipped  "
                        f"(expiry={c.lastTradeDateOrContractMonth}  conId={c.conId})"
                    )
            qualified = deduped

            # ── 3. Subscribe and bind ticker.updateEvent ──────────────────────
            for contract in qualified:
                sym     = contract.symbol
                ticker  = ib.reqMktData(
                    contract, "", snapshot=False, regulatorySnapshot=False
                )
                handler = make_update_handler(sym)
                ticker.updateEvent += handler
                _subs.append((ticker, handler))
                log.info(f"[IB]   ⟳  {sym}  ticker.updateEvent bound")

            log.info(
                "[IB] Streaming — MARKET_DATA updating on each tick  "
                "(poll http://localhost:8000/api/live-futures to read)"
            )

            # ── 3b. Seed historical closes (runs once; no-op during market hours) ──
            # Give live ticks a 3-second head-start before we check whether seeding
            # is needed.  During market hours the first ticks arrive within ~1 s
            # and _seed_from_history will log "live tick already present" and skip.
            # On weekends / pre-market all fields stay None, so the seed runs fully.
            await asyncio.sleep(3)
            try:
                await asyncio.wait_for(
                    _seed_from_history(ib, qualified),
                    timeout=30.0,
                )
            except asyncio.TimeoutError:
                log.warning("[IB] Historical seed timed out — continuing with live stream only")
            except asyncio.CancelledError:
                _teardown()
                break

            # ── 4. Hold until IB disconnects ──────────────────────────────────
            try:
                while ib.isConnected():
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                _teardown()
                break
            except Exception as exc:
                log.error(f"[IB] Stream error: {exc!r}")

            _teardown()
            log.info(f"[IB] Disconnected — retry in {RECONNECT_S}s.")
            await asyncio.sleep(RECONNECT_S)

    finally:
        _teardown()
        log.info("[IB] Streaming task stopped.")


# ─── Application lifespan ─────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Start the IB streaming task before uvicorn begins accepting requests.
    Cancel it cleanly when the server shuts down (Ctrl-C / SIGTERM).
    util.patchAsyncio() must be called here — before any IB code runs —
    so ib_insync's internal loop cooperates with uvicorn's event loop.
    """
    util.patchAsyncio()
    task = asyncio.create_task(_ib_stream_loop(), name="ib_stream")
    log.info("[server] FastAPI ready — IB Gateway streaming task started")
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        log.info("[server] Clean shutdown complete.")


# ─── FastAPI application ──────────────────────────────────────────────────────

app = FastAPI(
    title="IB Gateway Live Futures",
    version="1.0",
    lifespan=lifespan,
    docs_url=None,    # disable Swagger UI — keeps the server lightweight
    redoc_url=None,
)

# CORS — allow the Next.js dev server (localhost:3000) to call this server
# directly from the browser when the Next.js proxy route is bypassed.
# The Next.js proxy route (src/app/api/live-futures/route.ts) also calls
# this server server-side, where CORS does not apply.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/live-futures")
def get_live_futures() -> Dict[str, Any]:
    """
    Returns the latest tick snapshot from MARKET_DATA.

    Response shape:
    {
      "connected": true,
      "timestamp": "2025-05-23T14:32:01.234567+00:00",
      "data": {
        "ES": { "last": 5284.50, "bid": 5284.25, "ask": 5284.75,
                "change": 12.25, "change_pct": 0.2321 },
        "NQ": { "last": 19842.00, "bid": 19841.75, "ask": 19842.25,
                "change": -18.50, "change_pct": -0.0932 },
        "ZN": { "last": 109.1563, "bid": 109.1406, "ask": 109.1719,
                "change": -0.2188, "change_pct": -0.2000 }
      }
    }

    Fields are null until the first tick arrives for that symbol.
    'connected' is false until IB Gateway accepts the connection.
    """
    return {
        "connected": _ib_connected,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data":      MARKET_DATA,
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    """Lightweight liveness probe for monitoring and dashboard status checks."""
    live_syms = [s for s, d in MARKET_DATA.items() if d["last"] is not None]
    return {
        "ok":           True,
        "connected":    _ib_connected,
        "live_symbols": live_syms,
        "all_live":     len(live_syms) == len(MARKET_DATA),
    }


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "__main__:app",
        host="0.0.0.0",
        port=8000,
        log_level="info",
    )
