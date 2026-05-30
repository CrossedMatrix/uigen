"""
ib_bridge.py — Read-only IBKR TWS/Gateway market-data bridge
──────────────────────────────────────────────────────────────────────────────
Connects to a locally running TWS or IB Gateway instance and streams live
ticks for the active front-month equity and treasury futures contracts.

Tracked contracts (front-month continuous, auto-qualified):
  ES  — S&P 500 E-mini       CME
  NQ  — Nasdaq-100 E-mini    CME
  ZN  — 10-Year T-Note       CBOT

Requirements:
  pip install ib_insync==0.9.86

Usage:
  python ib_bridge.py

TWS / IB Gateway prerequisites (one-time setup):
  1. Open TWS → Edit → Global Configuration → API → Settings
       ✓ Enable "Enable ActiveX and Socket Clients"
       ✓ Socket port: 7497  (paper trading)  or  7496  (live)
       ✓ Master Client ID: leave blank (bridge uses clientId=1)
       ✗ "Read-Only API" — leave unchecked; bridge requests readonly=True in code
  2. Trusted IP list: leave blank for localhost-only access, or add 127.0.0.1
  3. Restart TWS/Gateway after changing API settings
"""

import asyncio
import logging
from datetime import datetime

from ib_insync import IB, Future, Ticker, util

# ─── Configuration ────────────────────────────────────────────────────────────

HOST      = '127.0.0.1'
PORT      = 7497          # 7497 = TWS paper / IB Gateway paper
                          # 7496 = TWS live  / IB Gateway live
CLIENT_ID = 1             # Must be unique per concurrent API client

# Contracts to subscribe — empty lastTradeDateOrContractMonth lets IB resolve
# the active front-month expiry automatically during qualify.
CONTRACTS = [
    Future(symbol='ES', exchange='CME',  currency='USD'),
    Future(symbol='NQ', exchange='CME',  currency='USD'),
    Future(symbol='ZN', exchange='CBOT', currency='USD'),
]

# Generic tick-type list — empty string = IB default set
# (BidSize, Bid, Ask, AskSize, Last, LastSize, Volume, Open, High, Low, Close)
GENERIC_TICK_LIST = ''

# ─── Logging setup ────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('ib_bridge')

# Keep ib_insync's own INFO lines quiet so tick output stays readable
logging.getLogger('ib_insync').setLevel(logging.WARNING)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _fmt(value: float, decimals: int) -> str:
    """Format a float field; returns '—' if the value is NaN (field not yet populated)."""
    try:
        if value != value:          # IEEE NaN check
            return '—'
        return f'{value:.{decimals}f}'
    except (TypeError, ValueError):
        return '—'


def _fmt_vol(volume) -> str:
    """Format volume as a comma-separated integer."""
    try:
        if volume != volume:
            return '—'
        return f'{int(volume):,}'
    except (TypeError, ValueError):
        return '—'


# ─── Tick event handler ───────────────────────────────────────────────────────

def on_pending_tickers(tickers: set[Ticker]) -> None:
    """
    Called by ib.pendingTickersEvent approximately every 250 ms whenever one or
    more tickers have received a new field update since the last event cycle.

    Only tickers with a meaningful last-price update are printed to avoid
    flooding the terminal with bid/ask-only partial updates at open.
    """
    for ticker in tickers:
        sym = ticker.contract.symbol

        # ZN is quoted in 32nds-of-a-percent convention — show 4 dp for clarity.
        # ES/NQ are quoted in index points — 2 dp is standard.
        dp = 4 if sym == 'ZN' else 2

        last_s = _fmt(ticker.last,   dp)
        bid_s  = _fmt(ticker.bid,    dp)
        ask_s  = _fmt(ticker.ask,    dp)
        vol_s  = _fmt_vol(ticker.volume)

        # Derive intraday change from close if both fields are populated
        chg_s = '—'
        try:
            if ticker.last == ticker.last and ticker.close == ticker.close:
                chg = ticker.last - ticker.close
                sign = '+' if chg >= 0 else ''
                chg_s = f'{sign}{chg:.{dp}f}'
        except (TypeError, AttributeError):
            pass

        log.info(
            f'[TICK]  {sym:<4}  '
            f'last={last_s:<10}  '
            f'chg={chg_s:<10}  '
            f'bid={bid_s:<10}  '
            f'ask={ask_s:<10}  '
            f'vol={vol_s}'
        )


# ─── Connection helpers ───────────────────────────────────────────────────────

def _connection_error_hint(port: int) -> str:
    return (
        f'\n  Checklist:\n'
        f'    1. TWS or IB Gateway is running\n'
        f'    2. API enabled: Edit → Global Configuration → API → Settings\n'
        f'    3. Socket port matches: {port}  '
        f'(paper=7497, live=7496)\n'
        f'    4. 127.0.0.1 is in the trusted-client list (or list is empty)\n'
        f'    5. No other process is already connected with clientId={CLIENT_ID}'
    )


# ─── Main async loop ──────────────────────────────────────────────────────────

async def main() -> None:
    ib = IB()

    # ── Connect ───────────────────────────────────────────────────────────────
    log.info(
        f'Connecting to IBKR TWS/Gateway  '
        f'host={HOST}  port={PORT}  clientId={CLIENT_ID}  readonly=True'
    )
    try:
        await ib.connectAsync(
            HOST,
            PORT,
            clientId=CLIENT_ID,
            readonly=True,      # never accidentally submit an order
            timeout=10,
        )
    except ConnectionRefusedError:
        log.error('Connection refused.' + _connection_error_hint(PORT))
        return
    except asyncio.TimeoutError:
        log.error('Connection timed out after 10 s.' + _connection_error_hint(PORT))
        return
    except Exception as exc:
        log.error(f'Connection failed: {exc}' + _connection_error_hint(PORT))
        return

    log.info(f'Connected  ·  server version {ib.client.serverVersion()}')

    # ── Qualify contracts (resolves front-month expiry) ───────────────────────
    log.info('Qualifying front-month contracts ...')
    try:
        qualified = await ib.qualifyContractsAsync(*CONTRACTS)
    except Exception as exc:
        log.error(f'Contract qualification failed: {exc}')
        ib.disconnect()
        return

    if not qualified:
        log.error(
            'No contracts were qualified.  '
            'Check that symbol/exchange/currency values are correct and that '
            'the market-data subscription includes futures.'
        )
        ib.disconnect()
        return

    for c in qualified:
        log.info(
            f'  ✓  {c.symbol:<4}  '
            f'expiry={c.lastTradeDateOrContractMonth}  '
            f'exchange={c.exchange}  '
            f'conId={c.conId}'
        )

    # ── Subscribe to streaming market data ────────────────────────────────────
    active_tickers = []
    for c in qualified:
        ticker = ib.reqMktData(
            c,
            genericTickList=GENERIC_TICK_LIST,
            snapshot=False,             # False = streaming (not one-shot)
            regulatorySnapshot=False,
        )
        active_tickers.append(ticker)
        log.info(f'  ⟳  Subscribed: {c.symbol}')

    # ── Wire the aggregated event ─────────────────────────────────────────────
    ib.pendingTickersEvent += on_pending_tickers

    log.info('─' * 72)
    log.info('Bridge LIVE — streaming ticks for ES · NQ · ZN   (Ctrl-C to stop)')
    log.info('─' * 72)

    # ── Run until interrupted ─────────────────────────────────────────────────
    try:
        await asyncio.sleep(float('inf'))
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        log.info('Shutting down ...')
        for ticker in active_tickers:
            try:
                ib.cancelMktData(ticker.contract)
            except Exception:
                pass
        ib.disconnect()
        log.info('Disconnected cleanly.')


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    # Patch the event loop for ib_insync compatibility (must be called before run)
    util.patchAsyncio()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info('Interrupted by user.')
