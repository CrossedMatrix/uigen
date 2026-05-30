"""
ib_server.py — FastAPI market-data server backed by ib_insync streaming
──────────────────────────────────────────────────────────────────────────────
Combines a FastAPI HTTP server (uvicorn, port 8000) with a persistent
ib_insync streaming loop, both running in the same asyncio event loop.

Architecture:
  IBKR TWS (port 7497)
    ↕  ib_insync pendingTickersEvent (~250 ms cadence)
  TickCache  (module-level dict, updated in-place, thread-safe enough for
              a single asyncio thread — no explicit lock needed)
    ↕  GET /api/live-futures
  Next.js proxy  src/app/api/live-futures/route.ts  (port 3000)
    ↕  useLiveFutures hook (2-second poll)
  Dashboard FuturesCard grid

Requirements (install once after Python is set up):
  pip install -r requirements.txt

Usage:
  python ib_server.py

TWS / IB Gateway prerequisites (same as ib_bridge.py):
  1. Enable "Enable ActiveX and Socket Clients" in TWS API settings
  2. Socket port: 7497 (paper) or 7496 (live)
  3. Restart TWS after changing settings

Notes:
  • clientId=2 — keep ib_bridge.py (clientId=1) running independently if desired
  • readonly=True — this server will NEVER submit orders
  • The tick cache starts empty; the UI shows "--" until the first IB tick arrives
"""

import asyncio
import logging
import math
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ib_insync import IB, Future, Ticker, util

# ─── Configuration ────────────────────────────────────────────────────────────

IB_HOST        = '127.0.0.1'
IB_PORT        = 7497           # 7497 = paper  |  7496 = live
IB_CLIENT_ID   = 2              # Must differ from ib_bridge.py (uses 1)
HTTP_HOST      = '0.0.0.0'     # bind all interfaces so Next.js server can reach it
HTTP_PORT      = 8000
RECONNECT_DELAY = 30            # seconds between IB reconnect attempts

# Instruments to subscribe — qualifyContractsAsync resolves the active front month
CONTRACTS = [
    Future(symbol='ES', exchange='CME',  currency='USD'),
    Future(symbol='NQ', exchange='CME',  currency='USD'),
    Future(symbol='ZN', exchange='CBOT', currency='USD'),
]

# Decimal precision per instrument
TICK_DP: Dict[str, int] = {
    'ES': 2,
    'NQ': 2,
    'ZN': 4,   # ZN quoted in 32nds-of-a-percent; 4 dp carries enough resolution
}

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('ib_server')
logging.getLogger('ib_insync').setLevel(logging.WARNING)

# ─── Tick cache ───────────────────────────────────────────────────────────────

def _nan_to_none(v: float) -> Optional[float]:
    """Convert IEEE NaN to None so JSON serialization is clean."""
    return None if (v is None or math.isnan(v)) else v


class TickCache:
    """
    Thread-safe-enough in-memory store for the latest tick per symbol.

    asyncio is single-threaded; the IB callback fires in the same thread as
    the FastAPI request handler, so no explicit lock is needed here.
    """

    def __init__(self) -> None:
        self._ticks: Dict[str, Dict[str, Any]] = {}
        self.connected: bool = False
        self.last_update_ts: Optional[float] = None

    def update(
        self,
        symbol:  str,
        last:    float,
        bid:     float,
        ask:     float,
        volume:  float,
        close:   float,
    ) -> None:
        """Write the latest tick for a symbol.  NaN fields become None."""
        dp = TICK_DP.get(symbol, 2)

        last_v  = _nan_to_none(last)
        close_v = _nan_to_none(close)

        if last_v is None or last_v <= 0:
            return  # Ignore warm-up / empty ticks

        change     = round(last_v - close_v, dp) if close_v else None
        change_pct = round((change / close_v) * 100, 4) if (change is not None and close_v) else None

        self._ticks[symbol] = {
            'symbol':     symbol,
            'last':       round(last_v, dp),
            'bid':        round(_nan_to_none(bid) or 0, dp) or None,
            'ask':        round(_nan_to_none(ask) or 0, dp) or None,
            'volume':     int(volume) if not math.isnan(volume) else None,
            'change':     change,
            'change_pct': change_pct,
            'timestamp':  datetime.now(timezone.utc).isoformat(),
        }
        self.last_update_ts = datetime.now(timezone.utc).timestamp()

    def snapshot(self) -> Dict[str, Any]:
        return {
            'futures':     list(self._ticks.values()),
            'connected':   self.connected,
            'last_update': self.last_update_ts,
            'timestamp':   datetime.now(timezone.utc).isoformat(),
        }


cache = TickCache()

# ─── IB streaming loop ────────────────────────────────────────────────────────

async def stream_ib() -> None:
    """
    Persistent IB streaming task.  Runs forever in the same asyncio event
    loop as FastAPI.  On disconnect or error, waits RECONNECT_DELAY seconds
    then retries.  Cancelled cleanly on server shutdown via the lifespan hook.
    """
    ib = IB()

    def on_pending_tickers(tickers: set) -> None:
        """Called ~250 ms when any subscribed ticker has a new field."""
        for ticker in tickers:
            sym = ticker.contract.symbol
            cache.update(
                symbol=sym,
                last=ticker.last   if ticker.last   is not None else float('nan'),
                bid=ticker.bid     if ticker.bid     is not None else float('nan'),
                ask=ticker.ask     if ticker.ask     is not None else float('nan'),
                volume=ticker.volume if ticker.volume is not None else float('nan'),
                close=ticker.close if ticker.close   is not None else float('nan'),
            )

    try:
        while True:
            # ── Connect ───────────────────────────────────────────────────────
            try:
                log.info(
                    f'[IB] Connecting to {IB_HOST}:{IB_PORT}  '
                    f'clientId={IB_CLIENT_ID}  readonly=True'
                )
                await ib.connectAsync(
                    IB_HOST, IB_PORT,
                    clientId=IB_CLIENT_ID,
                    readonly=True,
                    timeout=10,
                )
            except asyncio.CancelledError:
                break
            except ConnectionRefusedError:
                log.warning(
                    f'[IB] Connection refused — is TWS running on port {IB_PORT}?  '
                    f'Retry in {RECONNECT_DELAY}s'
                )
                await asyncio.sleep(RECONNECT_DELAY)
                continue
            except asyncio.TimeoutError:
                log.warning(f'[IB] Connect timed out.  Retry in {RECONNECT_DELAY}s')
                await asyncio.sleep(RECONNECT_DELAY)
                continue
            except Exception as exc:
                log.error(f'[IB] Connect error: {exc}.  Retry in {RECONNECT_DELAY}s')
                await asyncio.sleep(RECONNECT_DELAY)
                continue

            cache.connected = True
            log.info(f'[IB] Connected  ·  server version {ib.client.serverVersion()}')

            # ── Qualify contracts (resolve front-month expiry) ─────────────────
            try:
                qualified = await ib.qualifyContractsAsync(*CONTRACTS)
                for c in qualified:
                    log.info(
                        f'[IB]   ✓  {c.symbol:<4}  '
                        f'expiry={c.lastTradeDateOrContractMonth}  conId={c.conId}'
                    )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.error(f'[IB] Qualify failed: {exc}')
                cache.connected = False
                ib.disconnect()
                await asyncio.sleep(RECONNECT_DELAY)
                continue

            # ── Subscribe ─────────────────────────────────────────────────────
            ib.pendingTickersEvent += on_pending_tickers
            for c in qualified:
                ib.reqMktData(c, '', snapshot=False, regulatorySnapshot=False)
                log.info(f'[IB]   ⟳  Subscribed: {c.symbol}')

            log.info('[IB] Streaming — tick cache updating every ~250 ms')

            # ── Run until IB disconnects us ───────────────────────────────────
            try:
                while ib.isConnected():
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.error(f'[IB] Stream error: {exc}')
            finally:
                cache.connected = False
                ib.pendingTickersEvent -= on_pending_tickers
                if ib.isConnected():
                    ib.disconnect()
                log.info(f'[IB] Disconnected — retry in {RECONNECT_DELAY}s')

            await asyncio.sleep(RECONNECT_DELAY)

    finally:
        # Guaranteed cleanup on CancelledError (server shutdown)
        if ib.isConnected():
            ib.disconnect()
        log.info('[IB] Streaming task stopped.')


# ─── FastAPI application ──────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the IB streaming task before accepting requests; cancel on shutdown."""
    # util.patchAsyncio() makes ib_insync cooperate with uvicorn's event loop
    util.patchAsyncio()
    ib_task = asyncio.create_task(stream_ib(), name='ib_stream')
    log.info(f'[server] HTTP server ready on http://{HTTP_HOST}:{HTTP_PORT}')
    try:
        yield
    finally:
        ib_task.cancel()
        try:
            await ib_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title='IB Bridge Server', version='1.0', lifespan=lifespan)

# CORS — allow the Next.js dev server (port 3000) and any production origin
# running on localhost.  Explicit list beats wildcard for security.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://localhost:3000',
        'http://127.0.0.1:3000',
    ],
    allow_credentials=False,
    allow_methods=['GET'],
    allow_headers=['*'],
)

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get('/api/live-futures')
def get_live_futures() -> Dict[str, Any]:
    """
    Returns the latest cached tick for every subscribed futures contract.

    Response shape (mirrors LiveFuturesResponse in useLiveFutures.ts):
    {
      "futures": [
        {
          "symbol":     "ES",
          "last":       5284.50,
          "bid":        5284.25,
          "ask":        5284.75,
          "volume":     1234567,
          "change":     12.25,
          "change_pct": 0.2321,
          "timestamp":  "2025-05-23T14:32:01.123456+00:00"
        },
        ...
      ],
      "connected":   true,
      "last_update": 1716474721.123,
      "timestamp":   "2025-05-23T14:32:01.234567+00:00"
    }
    """
    return cache.snapshot()


@app.get('/health')
def health() -> Dict[str, Any]:
    """Lightweight liveness probe — useful for monitoring and frontend status."""
    return {
        'ok':        True,
        'connected': cache.connected,
        'symbols':   list(cache._ticks.keys()),
    }


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    uvicorn.run(
        '__main__:app',
        host=HTTP_HOST,
        port=HTTP_PORT,
        log_level='info',
        # reload=True,  # uncomment during local development for hot-reload
    )
