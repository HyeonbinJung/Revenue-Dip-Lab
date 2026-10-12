"""Offline checks for SEC parsing and universe ranking (no network). Run: python tests/realdata_test.py"""
import sqlite3, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.realdata import SCHEMA, _build_universe, _fiscal_year, _revenue_rows, _share_rows


def fact(start, end, filed, val, form='10-K'):
    return {'start': start, 'end': end, 'filed': filed, 'val': val, 'form': form}

# Fiscal-year labels stay consecutive for September, January and 52/53-week year ends.
assert _fiscal_year('2024-09-28') == 2024 and _fiscal_year('2024-01-28') == 2023 and _fiscal_year('2023-01-01') == 2022 and _fiscal_year('2023-12-31') == 2023

# Concept switch (SalesRevenueNet -> RevenueFromContract...), comparatives, a restatement and noise rows.
facts = {'facts': {'us-gaap': {
    'SalesRevenueNet': {'units': {'USD': [fact('2016-01-01', '2016-12-31', '2017-02-01', 100), fact('2017-01-01', '2017-12-31', '2018-02-01', 110)]}},
    'RevenueFromContractWithCustomerExcludingAssessedTax': {'units': {'USD': [
        fact('2017-01-01', '2017-12-31', '2019-02-01', 110),   # comparative in a later 10-K
        fact('2018-01-01', '2018-12-31', '2019-02-01', 121),
        fact('2018-01-01', '2018-12-31', '2020-02-01', 120),   # restated a year later
        fact('2019-01-01', '2019-12-31', '2020-02-01', 133),
        fact('2019-01-01', '2019-03-31', '2019-05-01', 30, '10-Q'),  # quarterly: ignored
        fact('2019-10-01', '2019-12-31', '2020-02-01', 35),            # 3-month value in a 10-K: ignored
    ]}}}}}
rows = _revenue_rows(facts)
assert [(r[0], r[2], r[3]) for r in rows] == [(2016, '2017-02-01', 100), (2017, '2018-02-01', 110), (2017, '2019-02-01', 110),
                                              (2018, '2019-02-01', 121), (2018, '2020-02-01', 120), (2019, '2020-02-01', 133)]
assert {r[4] for r in rows if r[0] >= 2018} == {'RevenueFromContractWithCustomerExcludingAssessedTax'}
assert _revenue_rows({'facts': {}}) == []

# Multi-class issuers: classes in one filing are summed; a later filing for the same date replaces it.
shares = {'facts': {'dei': {'EntityCommonStockSharesOutstanding': {'units': {'shares': [
    {'end': '2023-01-20', 'val': 600, 'accn': 'a', 'filed': '2023-02-01'}, {'end': '2023-01-20', 'val': 400, 'accn': 'a', 'filed': '2023-02-01'},
    {'end': '2023-04-20', 'val': 990, 'accn': 'b', 'filed': '2023-04-25'}]}}}}}
assert _share_rows(shares) == [('2023-01-20', 1000), ('2023-04-20', 990)]
# Class-tagged filers fall back to weighted-average basic shares: 3- and 9-month values for one end are not summed.
weighted = {'facts': {'dei': {}, 'us-gaap': {'WeightedAverageNumberOfSharesOutstandingBasic': {'units': {'shares': [
    {'start': '2023-07-01', 'end': '2023-09-30', 'val': 500, 'form': '10-Q', 'filed': '2023-10-25'},
    {'start': '2023-01-01', 'end': '2023-09-30', 'val': 510, 'form': '10-Q', 'filed': '2023-10-25'},
    {'start': '2023-01-01', 'end': '2023-12-31', 'val': 505, 'form': '10-K', 'filed': '2024-02-01'}]}}}}}
assert _share_rows(weighted) == [('2023-09-30', 500), ('2023-12-31', 505)]

# Market cap uses shares restated to the post-split basis of the adjusted prices.
con = sqlite3.connect(':memory:'); con.executescript(SCHEMA)
con.executemany('INSERT INTO prices VALUES (?,?,?,?)', [('BIG', '2024-01-02', 10, 10), ('BIG', '2024-07-01', 12, 12), ('MID', '2024-01-02', 50, 50), ('MID', '2024-07-01', 50, 50)])
con.executemany('INSERT INTO shares VALUES (?,?,?)', [('BIG', '2023-12-01', 100), ('BIG', '2024-06-20', 1000), ('MID', '2023-12-01', 150), ('MID', '2023-12-20', 150000), ('MID', '2024-03-01', 150), ('MID', '2019-01-01', 3), ('MID', '2019-06-01', 3), ('MID', '2019-09-01', 3), ('MID', '2019-12-01', 3)])  # 1000x filing error; pre-window counts on an unknown split basis
con.execute("INSERT INTO splits VALUES ('BIG', '2024-06-10', 10)")
_build_universe(con)
caps = {(d, s): round(c) for d, s, c in con.execute('SELECT date, symbol, market_cap FROM universe')}
assert caps[('2024-01-02', 'BIG')] == 10 * 100 * 10  # pre-split 100 shares -> 1,000 on today's basis
assert caps[('2024-07-01', 'BIG')] == 12 * 1000
assert caps[('2024-01-02', 'MID')] == 7500  # the 1000x outlier is ignored
print('PASS: fiscal-year labels, concept merge, restatements, 10-K annual filter, multi-class shares, weighted-average fallback, split-adjusted market caps, share-count outliers')
