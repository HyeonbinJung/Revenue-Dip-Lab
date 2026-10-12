(function(root){
// Date strings repeat millions of times across a run; parse each one once.
const day=86400000, dtCache=new Map(), dt=s=>{let v=dtCache.get(s);if(v===undefined){v=Date.parse(s+'T00:00:00Z');dtCache.set(s,v)}return v}, iso=n=>new Date(n).toISOString().slice(0,10);
function months(s,m){let d=new Date(dt(s)),n=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+m);let last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(n,last));return iso(+d)}
function validate(d){if(!d||!Array.isArray(d.prices)||!Array.isArray(d.financials)||!Array.isArray(d.universe))throw Error('Dataset must contain prices, financials and universe arrays.');if(d.prices.length>1000000)throw Error('Maximum 1,000,000 price rows supported.');const seen=new Set();for(const p of d.prices){if(!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!Number.isFinite(dt(p.date))||!p.symbol||![p.open,p.close].every(x=>typeof x==='number'&&x>0&&Number.isFinite(x)))throw Error('Check price dates, symbols and positive numeric open/close values.');let k=p.symbol+p.date;if(seen.has(k))throw Error('Duplicate price: '+k);seen.add(k)}for(const f of d.financials)if(!f.symbol||!Number.isInteger(f.fiscalYear)||!(f.revenue>0)||!Number.isFinite(f.revenue)||!Number.isFinite(dt(f.published)))throw Error('Check fiscalYear, revenue and publication dates.');for(const u of d.universe)if(!u.symbol||!(u.marketCap>0)||!Number.isFinite(u.marketCap)||!Number.isFinite(dt(u.date)))throw Error('Invalid market-cap snapshot.');if(!['historical','current'].includes(d.universeMode))throw Error('Set universeMode to historical or current.');return d}
const DEFAULTS={start:'2023-01-01',end:'2025-12-31',capital:1000000,spread:5,minGrowth:0,drop:10,base:10000,extra:1000,target:10,hold:3,costBps:10,top:200};
function settings(c){
c={...DEFAULTS,...c};
for(const k of ['capital','spread','minGrowth','drop','base','extra','target','hold','costBps','top'])if(!Number.isFinite(c[k]))throw Error('Invalid numeric parameter: '+k);
if(c.capital<=0||c.base<=0||c.extra<0||c.drop<=0||c.drop>=100||c.target<=0||c.spread<0||c.hold<1||!Number.isInteger(c.hold)||c.costBps<0||c.costBps>=1000||c.top<1||c.top>200||dt(c.start)>=dt(c.end))throw Error('Check parameter ranges and start/end dates.');
return c}
/* Screening work that does not depend on sizing, holding or exits: universe ranks, revenue
 * filter and 30-day declines per date. Depends only on start, end, top, spread and minGrowth.
 * Candidates are kept down to `floor` (default c.drop) so one preparation serves any entry decline >= floor. */
function prepare(data,c,floor=c.drop){
const histories={},fins={},snaps={};
for(const p of data.prices)(histories[p.symbol]??=[]).push(p);
for(const f of data.financials)(fins[f.symbol]??=[]).push(f);
for(const u of data.universe)(snaps[u.date]??=[]).push(u);
for(const h of Object.values(histories))h.sort((a,b)=>a.date.localeCompare(b.date));
for(const f of Object.values(fins))f.sort((a,b)=>a.fiscalYear-b.fiscalYear||a.published.localeCompare(b.published));
const snapDates=Object.keys(snaps).sort(),ranks={};
for(const s of snapDates){const uniq=new Map();for(const u of snaps[s]){if(uniq.has(u.symbol))throw Error('Duplicate symbol in the same universe snapshot.');uniq.set(u.symbol,u)}ranks[s]=[...uniq.values()].sort((a,b)=>b.marketCap-a.marketCap).slice(0,c.top)}
const dates=[...new Set(data.prices.map(p=>p.date))].filter(d=>d>=c.start&&d<=c.end).sort();
if(!dates.length)throw Error('No prices in the selected date range.');
const prices=new Map(data.prices.map(p=>[p.symbol+'|'+p.date,p])),index={};
for(const [s,h] of Object.entries(histories))index[s]=new Map(h.map((p,i)=>[p.date,i]));
const stale=[],signals=[],universeSeen=new Set();let rows=[],staleDays=0,k=-1;
dates.forEach((date,di)=>{
while(k+1<snapDates.length&&snapDates[k+1]<=date)k++;
const snapshot=data.universeMode==='current'?snapDates.at(-1):snapDates[k];
const isStale=!snapshot||(data.universeMode==='historical'&&dt(date)-dt(snapshot)>7*day);
stale.push(isStale);if(isStale)staleDays++;
const list=[],last=di===dates.length-1;if(last)rows=[];
for(const u of isStale?[]:ranks[snapshot]){
universeSeen.add(u.symbol);
let s=u.symbol,p=prices.get(s+'|'+date);if(!p)continue;
let available=(fins[s]||[]).filter(f=>f.published<date),byYear=new Map();
for(const f of available)byYear.set(f.fiscalYear,f);
let fs=[...byYear.values()].sort((a,b)=>a.fiscalYear-b.fiscalYear).slice(-4);
if(fs.length<4||fs.some((f,i)=>i&&f.fiscalYear!==fs[i-1].fiscalYear+1))continue;
let g=fs.slice(1).map((f,i)=>(f.revenue/fs[i].revenue-1)*100),spread=Math.max(...g)-Math.min(...g),pass=spread<=c.spread+1e-9&&Math.min(...g)>=c.minGrowth-1e-9;
let h=histories[s],i=index[s].get(date),j=i-1,cut=dt(date)-30*day;
while(j>=0&&dt(h[j].date)>cut)j--;
let ref=j>=0&&cut-dt(h[j].date)<=7*day?h[j].close:null,drop=ref?(1-p.close/ref)*100:null;
if(last)rows.push({symbol:s,name:u.name||s,marketCap:u.marketCap,growth:g,spread,pass,dropPct:drop});
if(pass&&drop!==null&&drop>=floor-1e-9)list.push({symbol:s,dropPct:drop,growth:g})}
signals.push(list)});
return {data,dates,prices,stale,signals,rows,staleDays,universeSymbols:[...universeSeen],floor}}
/* Orders, fills, exits and daily marks for one sizing/holding/exit configuration. */
function simulate(prep,c){
const {data,dates,prices,stale,signals}=prep,lastIndex=dates.length-1;
if(c.drop<prep.floor-1e-9)throw Error('Entry decline is below the prepared screening floor.');
let cash=c.capital,positions={},pending={},used=new Set(),trades=[],curve=[],screen=[],skipped=0;
const fee=c.costBps/10000;
function sell(s,p,reason){let pos=positions[s],gross=pos.shares*p.open,net=gross*(1-fee);cash+=net;trades.push({...pos,symbol:s,exitDate:p.date,exitPrice:p.open,proceeds:net,pnl:net-pos.investment,returnPct:(net/pos.investment-1)*100,reason});delete positions[s];delete pending[s]}
dates.forEach((date,di)=>{
for(const s of Object.keys(pending).sort()){let p=prices.get(s+'|'+date),order=pending[s];if(!p)continue;if(order.side==='sell'){sell(s,p,order.reason);continue}if(order.amount>cash){skipped++;delete pending[s];continue}let shares=order.amount/(p.open*(1+fee));cash-=order.amount;positions[s]={entryDate:date,entryPrice:p.open,investment:order.amount,shares,deadline:months(date,c.hold),dropPct:order.dropPct,growth:order.growth,signalDate:order.signalDate};used.add(s);delete pending[s]}
for(const s of Object.keys(positions)){let p=prices.get(s+'|'+date),pos=positions[s];if(p&&date>=pos.deadline&&!pending[s]){sell(s,p,`${c.hold}-month expiry`);continue}if(p&&p.close>=pos.entryPrice*(1+c.target/100)&&!pending[s])pending[s]={side:'sell',reason:'Take-profit signal'};if(p)pos.mark=p.close}
// A row's status reflects its own state before this date's signals, matching the per-row order.
if(di===lastIndex)screen=prep.rows.map(r=>({...r,status:used.has(r.symbol)?(positions[r.symbol]?'Holding':'Entry completed'):pending[r.symbol]?'Pending':r.pass?'Pass':'Fail'}));
if(!stale[di])for(const x of signals[di])if(x.dropPct>=c.drop-1e-9&&!used.has(x.symbol)&&!pending[x.symbol])pending[x.symbol]={side:'buy',amount:c.base+Math.floor(Math.max(0,x.dropPct-c.drop)+1e-8)*c.extra,dropPct:x.dropPct,growth:x.growth,signalDate:date};
let value=Object.values(positions).reduce((a,p)=>a+p.shares*(p.mark||p.entryPrice),0);
curve.push({date,equity:cash+value,cash,invested:value,positions:Object.keys(positions).length})});
let peak=c.capital,mdd=0;for(const p of curve){peak=Math.max(peak,p.equity);p.drawdown=(p.equity/peak-1)*100;mdd=Math.min(mdd,p.drawdown)}let last=curve.at(-1),years=(dt(last.date)-dt(curve[0].date))/day/365.25,closedPnl=trades.reduce((a,t)=>a+t.pnl,0),wins=trades.filter(t=>t.pnl>0),loss=trades.filter(t=>t.pnl<0),grossWin=wins.reduce((a,t)=>a+t.pnl,0),grossLoss=-loss.reduce((a,t)=>a+t.pnl,0);let open=Object.entries(positions).map(([symbol,p])=>({...p,symbol,value:p.shares*(p.mark||p.entryPrice),pnl:p.shares*(p.mark||p.entryPrice)-p.investment}));const staleDays=prep.staleDays;return {config:c,source:data.source||'Imported dataset',universeMode:data.universeMode,metrics:{equity:last.equity,returnPct:(last.equity/c.capital-1)*100,cagr:years>0?(Math.pow(last.equity/c.capital,1/years)-1)*100:null,mdd,winRate:trades.length?wins.length/trades.length*100:null,trades:trades.length,entered:used.size,open:open.length,closedPnl,profitFactor:grossLoss?grossWin/grossLoss:null,skipped,staleDays},curve,trades,open,screen,universeSymbols:prep.universeSymbols.slice(),pending:Object.entries(pending).map(([symbol,o])=>({symbol,...o})),warnings:[...(data.warnings||[]),...(data.universeMode==='current'?['The current universe is applied to historical dates. Results contain survivorship and look-ahead bias.']:[]),'Dividends, taxes, FX and delisting settlements are excluded. Missing-price holdings retain the last available mark and are not forcibly closed.','Take-profit signals use the close and execute at the next available open. Gaps can change the realized return.',...(staleDays?[`New entries were suspended on ${staleDays} dates because the historical universe was missing or more than 7 days old.`]:[])]}}
function run(data,c={}){validate(data);c=settings(c);return simulate(prepare(data,c),c)}
/* Grid search over any two of the sweepable parameters, e.g. axes=[{key:'hold',values:[1,2,3]},{key:'extra',values:[1000,2000]}].
 * Screening is computed once (down to the lowest entry decline on an axis); onPoint receives each finished cell. */
const SWEEP_KEYS=['drop','target','base','extra','hold','costBps'];
function sweep(data,c={},axes=[],onPoint){
validate(data);c=settings(c);
if(axes.length!==2||axes[0].key===axes[1].key||!axes.every(a=>SWEEP_KEYS.includes(a.key)&&Array.isArray(a.values)&&a.values.length))throw Error('Choose two different sweep parameters, each with at least one value.');
const [X,Y]=axes;
for(const x of X.values)for(const y of Y.values)settings({...c,[X.key]:x,[Y.key]:y});
const drops=axes.filter(a=>a.key==='drop').flatMap(a=>a.values),prep=prepare(data,c,drops.length?Math.min(...drops):c.drop),points=[];
for(const x of X.values)for(const y of Y.values){
const m=simulate(prep,{...c,[X.key]:x,[Y.key]:y}).metrics;
const point={x,y,[X.key]:x,[Y.key]:y,cagr:m.cagr,returnPct:m.returnPct,mdd:m.mdd,winRate:m.winRate,trades:m.trades,skipped:m.skipped};
points.push(point);if(onPoint)onPoint(point,points.length)}
return points}
const range=(from,to,step)=>Array.from({length:Math.floor((to-from)/step+1e-9)+1},(_,i)=>+(from+i*step).toFixed(10));
function demo(){let prices=[],financials=[],universe=[],seed=42;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};let days=[];for(let t=dt('2021-11-01');t<=dt('2025-12-31');t+=day)if(![0,6].includes(new Date(t).getUTCDay()))days.push(iso(t));for(let i=0;i<200;i++){let s='SIM'+String(i+1).padStart(3,'0'),p=40+i;for(let y=2017;y<=2025;y++){let growth=i%4===0?0.04+(random()-.5)*.12:0.06+(i%12)*.01+(random()-.5)*.01;let prev=financials.filter(f=>f.symbol===s).at(-1)?.revenue||1e9;financials.push({symbol:s,fiscalYear:y,revenue:prev*(1+growth),published:`${y+1}-03-01`})}for(let j=0;j<days.length;j++){let open=p*(1+(random()-.5)*.012);p=open*Math.exp((random()-.49)*.045+(j%210===35?-0.105:j%210===60?0.09:0));prices.push({symbol:s,date:days[j],open,close:p});if(j%5===0)universe.push({symbol:s,name:'Simulation '+(i+1),date:days[j],marketCap:(201-i)*1e9*(1+(random()-.5)*.05)})}}return {source:'Synthetic dataset / not actual market performance',universeMode:'historical',prices,financials,universe}}
const api={run,validate,settings,demo,prepare,simulate,sweep,range,SWEEP_KEYS};if(typeof module!=='undefined')module.exports=api;else root.Lab=api;
})(globalThis);
