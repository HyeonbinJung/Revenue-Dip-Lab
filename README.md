# Revenue-Dip-Lab

A five-panel backtesting workspace for stable revenue growth and price declines. FastAPI serves the application and its data APIs. A shared JavaScript engine executes identically in the browser and through the API.

## Start locally

Requirements: **Python 3.10+**, **Node.js 22+**.

- Windows: run `start.bat`.
- macOS/Linux: run `sh start.sh`.
- Open **http://localhost:8000**.

The startup scripts create `.venv` and install the Python requirements. First launch requires an internet connection. Manual startup:

```bash
pip install -r requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

API documentation: http://localhost:8000/docs

## Five-panel workflow

1. **Strategy:** choose the universe, date range, starting capital, revenue stability tolerance, minimum annual growth, entry decline, base order, extra order amount per percentage point, take-profit target, maximum holding months and one-way costs.
2. **Results:** inspect net return, CAGR, maximum drawdown, win rate, equity curve, trades, screening candidates, open positions and execution protocol. Export trades as CSV or the dataset as JSON.
3. **Price signals:** inspect a grid of small three-year symbol charts; click a chart to enlarge it. Cyan lines show closing prices; green B and red S markers show actual entry and exit execution prices. Each card lists execution dates, prices, investment size and exit reason.
4. **CAGR surface:** **ALL BACKTEST** sweeps any two of entry decline, take profit, base order, add per 1%, max holding and one-way costs. Pick a parameter for X and Y, then type **from / to / step** for each (e.g. add per 1%: 100 → 5,000 step 100); choosing the other axis's parameter swaps them, invalid ranges disable the run with a reason, and grids are capped at 20,000 backtests. Every other parameter is taken from Strategy. Results stream into a rotatable 3D CAGR surface with back walls and floor grid, painted in eight contour bands of a single-hue blue ramp (brighter = higher CAGR) and flat-shaded; the best cell is marked. Drag to rotate, wheel to zoom, double-click to reset. Hover for return, drawdown and win rate; click a grid point or a top-10 row to copy both values into Strategy. Export the grid as CSV. The sweep runs in a Web Worker; screening is computed once (down to the lowest entry decline on an axis) and reused for every cell. Treat the best cell as in-sample: picking it from the same data overfits.
5. **Factor search:** all six parameters at once. Give each factor a from / to / step (from = to fixes it), then choose **RANDOM N** distinct grid points (default 5,000, reproducible seed) or the **FULL GRID** (up to 100,000). Work is split across up to four Web Workers, each screening the universe once. With **OUT-OF-SAMPLE** on (default test start 2024-01-01), every combination runs on the in-sample period (Strategy start to the day before the split) and again on the out-of-sample period (split to Strategy end). Views: sensitivity bars (η², the share of in-sample CAGR variance each factor explains on its own), parallel coordinates (one line per combination; the top 10% by in-sample CAGR in color; extra axes for in- and out-of-sample CAGR), an in-sample vs out-of-sample scatter with Spearman ρ and where the in-sample winner lands out of sample, a pair heat map (max or median CAGR over the other four factors), and a top-20 table; click a row to copy all six values into Strategy. CSV export includes both periods. ρ near zero or negative means the in-sample optimum does not survive: on the real 2022–2025 data, 5,000 combinations gave ρ = −0.56.

All five panels sit side by side on one screen. Drag a panel heading (or its ⠿ grip) to reorder panels; drag the divider between two panels to resize them, or double-click it to equalize them. The ⤢ button (or double-clicking a heading) maximizes one panel. When the grip has focus, arrow keys reorder; when a divider has focus, Left/Right resize. **RESET LAYOUT** restores the default. The layout is remembered in the browser. Below 900 px wide, the panels stack vertically.

Each run replays the backtest: the equity curve and every price chart draw from the first date to the last on one shared clock, B/S markers appear as their execution dates pass, and the metrics update live (CAGR appears at the end). Use **REPLAY** to watch again or **SKIP** to show the full result immediately. Reduced-motion settings skip the animation. Price charts are painted when near the viewport.

The default synthetic dataset is loaded on startup and clearly labeled. It is not actual market data and does not establish strategy performance. A manual **RUN BACKTEST** highlights the Results panel. Editing parameters does not silently change the previous results; run again to apply them.

## Strategy and fills

- Rank the supplied universe by market cap, select the top N (maximum 200), then apply the revenue filter. Missing revenue does not cause substitution with a lower-ranked security.
- Four consecutive annual revenue values produce three YoY growth rates. The default tolerance is `max(growth) - min(growth) <= 5 percentage points`, with every rate at least 0%. Both are adjustable.
- Financial reports must be published before the signal date. Use the latest eligible report for each fiscal year. Same-day reports are conservatively excluded.
- Compare the closing price to the most recent available close at or before **30 calendar days** earlier, allowing at most a seven-day gap.
- Default entry: at least 10% below that reference. Investment is `$10,000 + floor(decline percentage - 10) * $1,000`. Thus 10% means $10,000, 11% means $11,000, and 15% means $15,000. Both amounts and the entry threshold are adjustable.
- Example customization: base $20,000 and incremental $2,500 produces a $25,000 order for a 12% decline with a 10% threshold.
- Fix order size at the signal close and execute at the next available session open. Total investment includes entry costs. Fractional shares are allowed.
- Each symbol enters once across the full backtest; no averaging down or re-entry. Cash-constrained orders are canceled, but a later signal can be reconsidered if the symbol never entered. Same-day orders are handled in alphabetical ticker order. No leverage or shorting.
- Default profit exit: a close at least 10% above the entry price triggers a sale at the next open. This threshold is before transaction costs. Gaps can change the actual realized return.
- Otherwise sell at the first available open on or after the selected holding deadline, default **3 calendar months** after purchase. Calendar month ends are clamped to the last valid day. A previously queued sell executes first.
- One-way costs represent combined commission/slippage, default 10 bps, and are charged on each side.
- Open positions at the backtest end are marked at the latest available close and excluded from closed-trade win rate. Missing-price holdings retain their last mark; there is no invented delisting payout or terminal liquidation.
- Portfolio return, CAGR and drawdown include uninvested cash and unrealized gains/losses.
- Cash dividends, taxes, FX, trading halts, delisting settlements, liquidity and market impact are not modeled. Supply split-adjusted, cash-dividend-unadjusted open/close prices in a consistent currency.

## Three-year chart windows

Default test period: **2023-01-01 through 2025-12-31**.

Charts normally show the final 36 calendar months ending on the test end date. If an entry predates that interval, its card shifts the window to retain the entry, ending two years after entry or at test end, whichever is earlier. A holding longer than the three-year window can have its exit outside the plot; exact execution details remain in the card header. Partial data is explicitly labeled; missing history is never fabricated.

Entered symbols appear in entry-date order. Non-entered symbols follow in ticker order. The full view includes every symbol that belonged to a valid top-N snapshot during the test, so historical membership changes can produce more than N cards. Use **Entered symbols only** to narrow the display.

## Real market data (2022–2025): Yahoo Finance + SEC, cached in SQLite

Select **Real data 2022–25** (local server only). The first time, the server builds `data/market.sqlite` (about 5 minutes); afterwards every load reads the database and backtests run in the page. Build ahead of time from the command line:

```bash
python -m backend.realdata          # build data/market.sqlite
python -m backend.realdata --check  # what the database holds
```

- **Prices:** Yahoo Finance via `yfinance`, 2021-01-01 to 2025-12-31 (2021 supplies the 30-day warm-up and chart history). Open/close are split-adjusted, not dividend-adjusted, as the engine expects.
- **Revenue:** SEC EDGAR companyfacts, every annual 10-K value with its **original filing date**; restatements are stored with their own filing date, so a signal only sees what had been published. `yfinance` statements are not used for revenue: they cover only the latest four fiscal years and carry no publication dates, so 2022 signals could not see FY2018–FY2021 and look-ahead could not be prevented.
- **Universe:** current S&P 500 constituents, re-ranked every week by market cap = split-adjusted close × SEC shares outstanding (restated to today's split basis; share classes summed per filing). Top-N selection therefore changes over time, but companies that left the index before today are missing (**survivorship bias**).
- Companies without a usable annual revenue concept (mostly banks and insurers) never pass the revenue filter; the dataset warnings list them.
- Tables: `prices`, `splits`, `financials`, `shares`, `universe` (weekly top 200), `companies`, `meta`. The server serves a gzip-compressed columnar export (`GET /api/data/real`), cached next to the database and rebuilt only when it changes.
- Set `SEC_USER_AGENT="Your Name you@example.com"` to identify your client to SEC, as SEC requests for automated access.

## Market data through FMP

Set your API key in the server environment before launch:

```bash
# macOS / Linux
export FMP_API_KEY='your-key'
python -m uvicorn backend.app:app --port 8000
```

```powershell
# Windows PowerShell
$env:FMP_API_KEY='your-key'
python -m uvicorn backend.app:app --port 8000
```

Then select **Connect FMP**. The key is never sent to browser code. `.env.example` is a reference template and is not loaded automatically.

FMP requests can require a paid plan and take several minutes (over 400 API calls). The collector retrieves all screener pages before sorting; incomplete coverage, repeated pages or fewer than 200 eligible stocks stop collection. Partial per-symbol collection failures are reported in dataset warnings. Data remains in server memory until exported.

FMP's default universe is current US-domiciled stocks on NASDAQ/NYSE/AMEX, excluding ETFs/funds/ADRs. Multiple share classes count as separate securities. This is not a consolidated issuer ranking. Applying the current universe to historical dates introduces survivorship and look-ahead bias. Financial history can include restatements and is not guaranteed to be point-in-time. Symbol changes and delistings are not fully reconciled.

The collector requests prices starting three years before the selected backtest start, to support chart windows even for a short test. Actual coverage depends on the provider plan and listing date.

Endpoints: `company-screener`, `historical-price-eod/full`, `income-statement`.
Official documentation: https://site.financialmodelingprep.com/developer/docs

Live collection has not been tested with a user API key. Validate provider permissions, adjustments and completeness before interpreting real-data results.

## Import JSON

```json
{
  "source": "Your data provider",
  "universeMode": "historical",
  "prices": [
    {"symbol": "ABC", "date": "2022-01-03", "open": 100, "close": 99}
  ],
  "financials": [
    {"symbol": "ABC", "fiscalYear": 2020, "published": "2021-03-01", "revenue": 1000000000}
  ],
  "universe": [
    {"symbol": "ABC", "name": "ABC Corp", "date": "2022-01-03", "marketCap": 50000000000}
  ]
}
```

This is a schema example, not a sufficient dataset. Include at least 30 days of warm-up prices, four consecutive fiscal years of revenue and sufficient price coverage for the desired charts. Use ISO dates, numeric money values, consistent currencies and adjusted prices. Price date/symbol duplicates are rejected.

For restatements, preserve original publication dates and historically known values. Do not assign future revised values to an earlier publication date.

- `historical`: supply the entire market, or a verified top-200 list, in each snapshot. Use the most recent snapshot at or before each signal date. Snapshots more than seven days old disable new entries. Include removed/delisted securities in their historical membership.
- `current`: use the latest snapshot throughout the test, explicitly acknowledging universe bias.

The program cannot verify rankings outside your supplied universe or the truth of publication dates.

## Project structure

- `backend/app.py`: FastAPI routes, FMP collection, static server and project ZIP download.
- `backend/realdata.py`: yfinance + SEC EDGAR collector, SQLite schema and compact export.
- `backend/runner.cjs`: Node subprocess entry point for FastAPI. The numerical engine is shared JavaScript, not pure Python.
- `dist/engine.js`: signal, order, accounting and metric calculations; deterministic 200-symbol synthetic dataset.
- `dist/app.js`: dataset controls, strategy configuration, result rendering and exports.
- `dist/navigation.js`: five-panel layout: reorder, resize, maximize and saved layout.
- `dist/playback.js`: shared playback clock that reveals charts from start to end.
- `dist/sweep.js`, `dist/sweep-worker.js`: ALL BACKTEST two-parameter grid search and the 3D CAGR surface.
- `dist/factors.js`, `dist/factor-worker.js`: six-factor random/grid search, parallel workers, out-of-sample split and its views.
- `dist/engine.js` also exposes `prepare`/`simulate` (screening split from execution; `run` = both) and `sweep`.
- `dist/stock-charts.js`: per-symbol chart windows, execution markers, lazy rendering and hover inspection.
- `dist/index.html`, `dist/style.css`: English terminal layout and responsive styling.
- `tests/`: deterministic regression tests for fills, settings, charts and navigation.
- `start.bat`, `start.sh`: local startup helpers.
- `Dockerfile`, `.dockerignore`, `.env.example`, `requirements.txt`: runtime setup.

The hosted site runs browser calculations and accepts JSON uploads. It does not run FastAPI. FMP collection is available through the included local FastAPI server. The local API has no authentication: add authentication and request-size limits before exposing it publicly.

## Docker

```bash
docker build -t revenue-dip-lab .
docker run --rm -p 127.0.0.1:8000:8000 -e FMP_API_KEY revenue-dip-lab
```

## Verification

```bash
node tests/engine.cjs
node tests/config-and-charts.cjs
node tests/navigation.cjs
node tests/sweep.cjs
node tests/factors.cjs
python tests/realdata_test.py
```

`POST /api/backtest`: `{"data": <dataset>, "config": {"start":"2023-01-01","end":"2025-12-31"}}`.
Other routes: `GET /api/data/real`, `GET /api/data/real/status`, `POST /api/data/real/build`, `GET /api/health`, `POST /api/data/fmp`, `GET /api/data/jobs/{job}`, `GET /revenue-dip-lab.zip`.
