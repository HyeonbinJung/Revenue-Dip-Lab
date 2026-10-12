"""Real-market dataset: yfinance prices + SEC EDGAR revenue history, cached in SQLite.

Build once (a few minutes), then every backtest reads the local database:

    python -m backend.realdata            # build data/market.sqlite (2021-01-01 .. 2025-12-31)
    python -m backend.realdata --check    # print what the database holds

Why two sources: yfinance only returns the latest four fiscal years of income statements and no
publication dates, so a 2022 signal could not see FY2018-FY2021 and look-ahead could not be
prevented. SEC companyfacts carries every 10-K revenue value with its original filing date.
"""
import csv, datetime as dt, gzip, io, json, math, os, sqlite3, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv('REAL_DB_PATH', ROOT / 'data' / 'market.sqlite'))
PRICE_START, PRICE_END = '2021-01-01', '2025-12-31'
SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
SEC_TICKERS = 'https://www.sec.gov/files/company_tickers.json'
SEC_FACTS = 'https://data.sec.gov/api/xbrl/companyfacts/CIK{:010d}.json'
# SEC asks automated clients to identify themselves; override with SEC_USER_AGENT="Name contact@domain".
SEC_UA = os.getenv('SEC_USER_AGENT', 'RevenueDipLab/1.3 (local research tool)')
REVENUE_CONCEPTS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
                    'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense',
                    'SalesRevenueGoodsNet', 'SalesRevenueServicesNet']
TOP_STORED = 200  # snapshots keep the 200 largest; the app's 50/100/200 universes are subsets

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS companies(symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, cik INTEGER);
CREATE TABLE IF NOT EXISTS prices(symbol TEXT, date TEXT, open REAL, close REAL, PRIMARY KEY(symbol, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS splits(symbol TEXT, date TEXT, ratio REAL, PRIMARY KEY(symbol, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS financials(symbol TEXT, fiscal_year INTEGER, period_end TEXT, published TEXT, revenue REAL, concept TEXT, PRIMARY KEY(symbol, period_end, published)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS shares(symbol TEXT, date TEXT, shares REAL, PRIMARY KEY(symbol, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS universe(date TEXT, symbol TEXT, market_cap REAL, PRIMARY KEY(date, symbol)) WITHOUT ROWID;
"""


def _get(url, headers=None, attempts=4):
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip', **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                return gzip.decompress(body) if r.headers.get('Content-Encoding') == 'gzip' else body
        except Exception:
            if i == attempts - 1: raise
            time.sleep(1.5 * (i + 1))


def _fiscal_year(end):
    # Label by the calendar year that holds most of the period, so Jan-ending and 52/53-week years stay consecutive.
    return (dt.date.fromisoformat(end) - dt.timedelta(days=180)).year


def _revenue_rows(facts):
    """Every annual 10-K revenue value with its filing date (original reports and later restatements)."""
    gaap = facts.get('facts', {}).get('us-gaap', {})
    by_concept = {}
    for concept in REVENUE_CONCEPTS:
        for x in gaap.get(concept, {}).get('units', {}).get('USD', []):
            if not x.get('form', '').startswith('10-K') or 'start' not in x or not x.get('val'): continue
            days = (dt.date.fromisoformat(x['end']) - dt.date.fromisoformat(x['start'])).days
            if 350 <= days <= 380 and x['val'] > 0:
                by_concept.setdefault(concept, {})[(x['end'], x['filed'])] = x['val']
    if not by_concept: return []
    # Prefer the concept that covers the most recent fiscal years; fill other years from the rest.
    coverage = lambda c: len({_fiscal_year(e) for e, _ in by_concept[c] if _fiscal_year(e) >= 2016})
    order = sorted(by_concept, key=lambda c: (-coverage(c), REVENUE_CONCEPTS.index(c)))
    rows = {}
    for concept in reversed(order):  # higher-priority concepts overwrite
        for (end, filed), val in by_concept[concept].items(): rows[(end, filed)] = (val, concept)
    # A period's end can shift by a day between filings; keep one end date per fiscal year and filing.
    out = {}
    for (end, filed), (val, concept) in sorted(rows.items()):
        out[(_fiscal_year(end), filed)] = (end, val, concept)
    return [(fy, end, filed, val, concept) for (fy, filed), (end, val, concept) in sorted(out.items())]


def _share_rows(facts):
    """Shares outstanding by as-of date. Multi-class filers report one row per class, so classes are summed per filing.
    Filers that tag the cover-page count only per share class (GOOGL, META, V, BRK-B...) are absent from companyfacts;
    for them, fall back to the company-wide weighted-average basic share count of each period."""
    f = facts.get('facts', {})
    rows = f.get('dei', {}).get('EntityCommonStockSharesOutstanding', {}).get('units', {}).get('shares', [])
    if not any(x.get('end', '') >= '2020' for x in rows):
        # One company-wide value per period end: a filing repeats the same end for 3-, 6-, 9- and 12-month windows; keep the shortest.
        span = lambda x: (dt.date.fromisoformat(x['end']) - dt.date.fromisoformat(x.get('start', x['end']))).days
        best = {}
        for x in f.get('us-gaap', {}).get('WeightedAverageNumberOfSharesOutstandingBasic', {}).get('units', {}).get('shares', []):
            if x.get('val') and x.get('form', '').startswith(('10-Q', '10-K')):
                key = (x['end'], x.get('filed', ''))
                if key not in best or span(x) < span(best[key]): best[key] = x
        return sorted({end: x['val'] for (end, filed), x in sorted(best.items(), key=lambda k: k[0][1])}.items())
    per_filing = {}
    for x in rows:
        if x.get('val'): per_filing.setdefault((x['end'], x.get('accn'), x.get('filed', '')), []).append(x['val'])
    latest = {}
    for (end, accn, filed), vals in sorted(per_filing.items(), key=lambda k: k[0][2]):
        latest[end] = sum(vals)  # later filings for the same as-of date replace earlier ones
    return sorted(latest.items())


def build(progress=print, db_path=DB_PATH, start=PRICE_START, end=PRICE_END):
    import pandas as pd
    import yfinance as yf
    t0 = time.time()
    db_path = Path(db_path); db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = db_path.with_suffix('.building')
    if tmp.exists(): tmp.unlink()
    con = sqlite3.connect(tmp); con.executescript(SCHEMA)
    warnings = []

    progress(0, 4, 'Loading S&P 500 constituents and SEC ticker map')
    members = list(csv.DictReader(io.StringIO(_get(SP500_CSV).decode('utf-8'))))
    sec = {v['ticker'].upper(): v['cik_str'] for v in json.loads(_get(SEC_TICKERS)).values()}
    companies = []
    for m in members:
        symbol = m['Symbol'].strip().upper().replace('.', '-')  # Yahoo and SEC both use BRK-B
        companies.append((symbol, m.get('Security') or symbol, m.get('GICS Sector', ''), sec.get(symbol)))
    con.executemany('INSERT OR REPLACE INTO companies VALUES (?,?,?,?)', companies)
    symbols = [c[0] for c in companies]

    # Prices and split events from Yahoo, in batches. Open/Close are split-adjusted, not dividend-adjusted.
    last = (dt.date.fromisoformat(end) + dt.timedelta(days=1)).isoformat()
    missing = []
    for i in range(0, len(symbols), 50):
        batch = symbols[i:i + 50]
        progress(i, len(symbols), f'yfinance prices {i + 1}-{i + len(batch)} / {len(symbols)}', stage=1)
        frame = yf.download(batch, start=start, end=last, auto_adjust=False, actions=True, group_by='ticker', progress=False, threads=True)
        for s in batch:
            try: f = frame[s] if isinstance(frame.columns, pd.MultiIndex) else frame
            except KeyError: missing.append(s); continue
            f = f.dropna(subset=['Open', 'Close'])
            f = f[(f['Open'] > 0) & (f['Close'] > 0)]
            if f.empty: missing.append(s); continue
            con.executemany('INSERT OR REPLACE INTO prices VALUES (?,?,?,?)',
                            [(s, d.strftime('%Y-%m-%d'), round(float(o), 6), round(float(c), 6)) for d, o, c in zip(f.index, f['Open'], f['Close'])])
            if 'Stock Splits' in f:
                sp = f[f['Stock Splits'] > 0]['Stock Splits']
                con.executemany('INSERT OR REPLACE INTO splits VALUES (?,?,?)', [(s, d.strftime('%Y-%m-%d'), float(r)) for d, r in sp.items()])
    if missing: warnings.append(f'No Yahoo prices for {len(missing)} symbols: {", ".join(missing[:15])}{"…" if len(missing) > 15 else ""}.')

    # Revenue history and shares outstanding from SEC (<= 10 requests per second).
    no_cik, no_rev = [], []
    for i, (symbol, name, sector, cik) in enumerate(companies):
        if i % 10 == 0: progress(i, len(companies), f'SEC EDGAR revenue {i + 1} / {len(companies)} ({symbol})', stage=2)
        if not cik: no_cik.append(symbol); continue
        try: facts = json.loads(_get(SEC_FACTS.format(cik)))
        except Exception: no_rev.append(symbol); continue
        finally: time.sleep(0.11)
        rev = _revenue_rows(facts)
        if not rev: no_rev.append(symbol)
        con.executemany('INSERT OR REPLACE INTO financials VALUES (?,?,?,?,?,?)', [(symbol, *r) for r in rev])
        con.executemany('INSERT OR REPLACE INTO shares VALUES (?,?,?)', [(symbol, d, v) for d, v in _share_rows(facts)])
    if no_cik: warnings.append(f'No SEC CIK for {len(no_cik)} symbols: {", ".join(no_cik[:15])}.')
    if no_rev: warnings.append(f'No annual 10-K revenue for {len(no_rev)} symbols (e.g. banks using other concepts): {", ".join(no_rev[:15])}{"…" if len(no_rev) > 15 else ""}.')

    progress(3, 4, 'Filling share counts for multi-class filers', stage=3)
    _fill_missing_shares(con, start, warnings)
    progress(3, 4, 'Ranking weekly market-cap snapshots', stage=3)
    _build_universe(con)
    meta = {'source': 'Yahoo Finance prices (yfinance) + SEC EDGAR 10-K revenue', 'built_at': dt.datetime.now().isoformat(timespec='seconds'),
            'price_start': start, 'price_end': end, 'constituents': 'Current S&P 500 (survivorship bias)', 'warnings': json.dumps(warnings),
            'seconds': f'{time.time() - t0:.0f}'}
    con.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)', meta.items())
    con.commit(); con.execute('VACUUM'); con.close()
    os.replace(tmp, db_path)
    progress(4, 4, 'Done')
    return summary(db_path)


def _fill_missing_shares(con, start, warnings, refetch=False):
    """Last resort for symbols with no SEC count inside the window: Yahoo's current count (today's split basis, held constant)."""
    missing = [r[0] for r in con.execute('SELECT symbol FROM companies WHERE symbol NOT IN (SELECT symbol FROM shares WHERE date >= ?)', (start,))]
    if refetch:  # repair an existing database built before the weighted-average fallback existed
        for symbol, cik in con.execute('SELECT symbol, cik FROM companies WHERE symbol IN (%s) AND cik IS NOT NULL' % ','.join('?' * len(missing)), missing).fetchall():
            try: rows = _share_rows(json.loads(_get(SEC_FACTS.format(cik))))
            except Exception: continue
            finally: time.sleep(0.11)
            con.executemany('INSERT OR REPLACE INTO shares VALUES (?,?,?)', [(symbol, d, v) for d, v in rows])
        missing = [r[0] for r in con.execute('SELECT symbol FROM companies WHERE symbol NOT IN (SELECT symbol FROM shares WHERE date >= ?)', (start,))]
    import yfinance as yf
    constant = []
    for symbol in missing:
        try: n = yf.Ticker(symbol).fast_info['shares']
        except Exception: n = None
        if n: con.execute('INSERT OR REPLACE INTO shares VALUES (?,?,?)', (symbol, start, float(n))); constant.append(symbol)
    if constant: warnings.append(f"Share count held at today's Yahoo value for {len(constant)} symbols without SEC history: {', '.join(constant)}.")
    return constant


def _build_universe(con):
    """Weekly top-200 by market cap = split-adjusted close x shares outstanding restated to today's split basis."""
    dates = [r[0] for r in con.execute('SELECT DISTINCT date FROM prices ORDER BY date')]
    weekly, seen = [], set()
    for d in dates:  # first trading day of each ISO week
        week = dt.date.fromisoformat(d).isocalendar()[:2]
        if week not in seen: seen.add(week); weekly.append(d)
    splits, shares = {}, {}
    for s, d, r in con.execute('SELECT symbol, date, ratio FROM splits'): splits.setdefault(s, []).append((d, r))
    # Split history is only known inside the price window, so older counts cannot be restated; use counts from then on.
    for s, d, v in con.execute('SELECT symbol, date, shares FROM shares WHERE date >= ? ORDER BY date', (dates[0],)): shares.setdefault(s, []).append((d, v))

    # Restate every count to today's split basis, then drop filing errors (e.g. a count reported 1000x too large):
    # after split restatement a company's share count moves slowly, so >3x away from its median is not real.
    for symbol, rows in shares.items():
        basis = [(d, v * math.prod(r for sd, r in splits.get(symbol, []) if sd > d)) for d, v in rows]
        mid = sorted(v for _, v in basis)[len(basis) // 2]
        shares[symbol] = [(d, v) for d, v in basis if mid / 3 <= v <= mid * 3]

    def adjusted(symbol, as_of):
        rows = shares.get(symbol)
        if not rows: return None
        # Latest count at or before the date; before the first filing, use the earliest count.
        return max((r for r in rows if r[0] <= as_of), default=rows[0])[1]

    closes = {}
    for s, d, c in con.execute('SELECT symbol, date, close FROM prices WHERE date IN (%s)' % ','.join('?' * len(weekly)), weekly):
        closes.setdefault(d, []).append((s, c))
    rows = []
    for d in weekly:
        caps = [(s, c * n) for s, c in closes.get(d, []) if (n := adjusted(s, d))]
        for s, cap in sorted(caps, key=lambda x: -x[1])[:TOP_STORED]: rows.append((d, s, cap))
    con.execute('DELETE FROM universe')
    con.executemany('INSERT INTO universe VALUES (?,?,?)', rows)


def summary(db_path=DB_PATH):
    if not Path(db_path).exists(): return {'ready': False}
    con = sqlite3.connect(db_path)
    try:
        meta = dict(con.execute('SELECT key, value FROM meta'))
        count = lambda q: con.execute(q).fetchone()[0]
        return {'ready': True, 'path': str(db_path), 'bytes': Path(db_path).stat().st_size, **{k: v for k, v in meta.items() if k != 'warnings'},
                'warnings': json.loads(meta.get('warnings', '[]')), 'symbols': count('SELECT COUNT(DISTINCT symbol) FROM prices'),
                'priceRows': count('SELECT COUNT(*) FROM prices'), 'revenueRows': count('SELECT COUNT(*) FROM financials'),
                'snapshots': count('SELECT COUNT(DISTINCT date) FROM universe')}
    finally: con.close()


def export(db_path=DB_PATH):
    """Compact dataset for the browser: columnar prices for symbols that ever ranked in the top 200."""
    con = sqlite3.connect(db_path)
    try:
        meta = dict(con.execute('SELECT key, value FROM meta'))
        names = dict(con.execute('SELECT symbol, name FROM companies'))
        snap_dates = [r[0] for r in con.execute('SELECT DISTINCT date FROM universe ORDER BY date')]
        symbols = [r[0] for r in con.execute('SELECT DISTINCT symbol FROM universe ORDER BY symbol')]
        index = {s: i for i, s in enumerate(symbols)}
        dates = [r[0] for r in con.execute('SELECT DISTINCT date FROM prices ORDER BY date')]
        di = {d: i for i, d in enumerate(dates)}
        opens = [[None] * len(dates) for _ in symbols]; closes = [[None] * len(dates) for _ in symbols]
        for s, d, o, c in con.execute('SELECT symbol, date, open, close FROM prices'):
            if s in index: opens[index[s]][di[d]] = round(o, 4); closes[index[s]][di[d]] = round(c, 4)
        snaps = {d: [] for d in snap_dates}
        for d, s, cap in con.execute('SELECT date, symbol, market_cap FROM universe ORDER BY date, market_cap DESC'):
            snaps[d].append([index[s], round(cap)])
        financials = [{'symbol': s, 'fiscalYear': fy, 'published': p, 'revenue': r}
                      for s, fy, p, r in con.execute('SELECT symbol, fiscal_year, published, revenue FROM financials ORDER BY symbol, fiscal_year, published') if s in index]
        warnings = json.loads(meta.get('warnings', '[]')) + [
            'Universe: current S&P 500 constituents ranked weekly by market cap (split-adjusted close x SEC shares outstanding). '
            'Companies that left the index or were delisted before today are missing: survivorship bias.',
            'Revenue: SEC 10-K annual values with original filing dates; later restatements become visible only after their own filing date.']
        return {'source': f"Real market data / {meta.get('source')} / built {meta.get('built_at', '?')[:10]}", 'universeMode': 'historical',
                'warnings': warnings, 'compact': {'dates': dates, 'symbols': symbols, 'names': [names.get(s, s) for s in symbols],
                'open': opens, 'close': closes, 'snapshotDates': snap_dates, 'snapshots': [snaps[d] for d in snap_dates]}, 'financials': financials}
    finally: con.close()


def repair_shares(db_path=DB_PATH):
    """Fill missing share counts in an existing database and re-rank, without re-downloading prices."""
    con = sqlite3.connect(db_path)
    meta = dict(con.execute('SELECT key, value FROM meta')); warnings = json.loads(meta.get('warnings', '[]'))
    warnings = [w for w in warnings if not w.startswith('Share count held')]
    _fill_missing_shares(con, meta.get('price_start', PRICE_START), warnings, refetch=True)
    _build_universe(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('warnings', ?)", (json.dumps(warnings),)); con.commit(); con.close()
    return summary(db_path)


if __name__ == '__main__':
    if '--check' in sys.argv: print(json.dumps(summary(), indent=2)); sys.exit()
    if '--repair-shares' in sys.argv: print(json.dumps(repair_shares(), indent=2)); sys.exit()
    def report(i, n, message, stage=0): print(f'[{time.strftime("%H:%M:%S")}] {message}', flush=True)
    print(json.dumps(build(report), indent=2))
