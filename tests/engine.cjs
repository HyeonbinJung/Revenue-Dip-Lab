const assert=require('node:assert/strict');const {run}=require('../dist/engine.js');
const f=[2017,2018,2019,2020].map((y,i)=>({symbol:'TEST',fiscalYear:y,published:`${y+1}-03-01`,revenue:1000*1.1**i}));
function dataset(prices){return {source:'unit fixture',universeMode:'historical',financials:f,prices:prices.map(([date,open,close])=>({symbol:'TEST',date,open,close})),universe:prices.filter(p=>p[0]>='2022-01-01').map(p=>({symbol:'TEST',date:p[0],marketCap:1e9}))}}
let d=dataset([['2021-12-03',100,100],['2022-01-03',90,88],['2022-01-04',80,80],['2022-01-05',85,89],['2022-01-06',90,88],['2022-01-07',60,60]]);let c={start:'2022-01-01',end:'2022-05-01',capital:100000,costBps:0};let r=run(d,c);assert.equal(r.trades.length,1);assert.equal(r.trades[0].investment,12000);assert.equal(r.trades[0].entryDate,'2022-01-04');assert.equal(r.trades[0].exitDate,'2022-01-06');assert.equal(r.trades[0].pnl,1500);assert.equal(r.metrics.equity,101500);assert.equal(r.metrics.entered,1);
let mature=dataset([['2021-12-03',100,100],['2022-01-03',90,88],['2022-01-04',80,80],['2022-04-01',70,70],['2022-04-04',65,65]]);r=run(mature,c);assert.equal(r.trades[0].exitDate,'2022-04-04');assert.equal(r.trades[0].reason,'3-month expiry');assert.equal(r.trades[0].pnl,-2250);
let future=structuredClone(d);future.financials.at(-1).published='2022-01-03';r=run(future,c);assert.equal(r.trades.length,0);
r=run(d,{...c,capital:1000});assert.equal(r.metrics.entered,0);assert(r.metrics.skipped>0);
let noCap=structuredClone(d);noCap.universe=[{symbol:'TEST',date:'2021-12-01',marketCap:1e9}];r=run(noCap,c);assert.equal(r.metrics.entered,0);assert(r.metrics.staleDays>0);
let short=dataset([['2021-12-03',100,100],['2022-01-03',90,88],['2022-01-04',80,80]]);r=run(short,c);assert.equal(r.open.length,1);assert.equal(r.trades.length,0);assert.equal(r.metrics.equity,100000);
const dup=structuredClone(d);dup.prices.push(dup.prices[0]);assert.throws(()=>run(dup,c),/Duplicate/);
console.log('PASS: next-open fills, sizing, take-profit, calendar maturity, no re-entry, publication delay, cash limit, stale universe, open MTM, duplicate rejection');
