"""FastAPI serves the dashboard and executes the shared audited backtest engine."""
import os,json,gzip,subprocess,threading,uuid,datetime,time,urllib.request,urllib.parse,io,zipfile
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
ROOT=Path(__file__).resolve().parents[1]
app=FastAPI(title='Revenue Dip Lab',version='1.3.0')
class Backtest(BaseModel):
    data: dict
    config: dict = {}
@app.post('/api/backtest')
def backtest(body: Backtest):
    if len(body.data.get('prices',[]))>1000000: raise HTTPException(413,'Too many price rows.')
    try:
        p=subprocess.run(['node',str(ROOT/'backend/runner.cjs')],input=json.dumps(body.model_dump()),text=True,capture_output=True,timeout=180)
        if p.returncode: raise HTTPException(422,p.stderr[:1000])
        return json.loads(p.stdout)
    except subprocess.TimeoutExpired: raise HTTPException(408,'Backtest timed out.')
@app.get('/api/health')
def health(): return {'status':'ok','providerConfigured':bool(os.getenv('FMP_API_KEY')),'engine':'shared-node','realData':realdata.DB_PATH.exists()}
JOBS={}; LOCK=threading.Lock()
class Fetch(BaseModel):
    start: str='2023-01-01'
    end: str='2025-12-31'
def fmp(path,**params):
    params['apikey']=os.environ['FMP_API_KEY']
    url='https://financialmodelingprep.com/stable/'+path+'?'+urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=45) as r: data=json.load(r)
            if not isinstance(data,list): raise ValueError('Invalid FMP response. Check plan and API access.')
            return data
        except Exception:
            if attempt==2: raise RuntimeError('FMP request failed. Check API key, plan and rate limits.') from None
            time.sleep(1+attempt)
def collect(job,request):
    try:
        start=datetime.date.fromisoformat(request.start); end=datetime.date.fromisoformat(request.end)
        if start>=end or (end-start).days>3653: raise ValueError('Start must precede end. Maximum backtest interval: 10 years.')
        rows=[]
        # FMP screener is not ordered. Fetch pages, then explicitly rank.
        for page in range(100):
            batch=fmp('company-screener',country='US',isEtf='false',isFund='false',isActivelyTrading='true',limit=1000,page=page)
            if not batch: break
            existing={x['symbol'] for x in rows}; fresh=[x for x in batch if x['symbol'] not in existing]
            if batch and not fresh: raise ValueError('FMP returned repeated pages. Complete market-cap ranking cannot be verified.')
            rows.extend(fresh)
            if len(batch)<1000: break
        else: raise ValueError('Unable to verify full screener coverage.')
        rows=[x for x in rows if x.get('marketCap',0)>0 and x.get('exchangeShortName') in ('NASDAQ','NYSE','AMEX')]
        rows=sorted(rows,key=lambda x:x['marketCap'],reverse=True)[:200]
        if len(rows)<200: raise ValueError('Insufficient screener data to identify the top 200.')
        d={'source':'FMP / current top 200 US stocks','universeMode':'current','prices':[],'financials':[],'universe':[],'warnings':['Current US-domiciled, US-listed universe ranked by security market cap. Multiple share classes are separate symbols. ADRs are excluded.','Financial statements may include revisions and restatements; these are not fully point-in-time records.']}
        today=datetime.date.today().isoformat();warm=(start-datetime.timedelta(days=3*366)).isoformat();missing=[]
        for i,row in enumerate(rows):
            s=row['symbol'];JOBS[job].update(progress=i,total=200,symbol=s)
            d['universe'].append({'symbol':s,'name':row.get('companyName',s),'date':today,'marketCap':row['marketCap']})
            try:
                px=fmp('historical-price-eod/full',symbol=s,**{'from':warm,'to':request.end})
                fs=fmp('income-statement',symbol=s,period='annual',limit=20)
                for p in px:
                    if p.get('open',0)>0 and p.get('close',0)>0:d['prices'].append({'symbol':s,'date':p['date'],'open':p['open'],'close':p['close']})
                for f in fs:
                    pub=f.get('acceptedDate') or f.get('filingDate')
                    if pub and f.get('revenue',0)>0:d['financials'].append({'symbol':s,'fiscalYear':int(f.get('fiscalYear') or f.get('calendarYear') or f['date'][:4]),'revenue':f['revenue'],'published':pub[:10]})
                if not px or not fs:missing.append(s)
            except Exception:missing.append(s)
            time.sleep(.12)
        if not d['prices']:raise ValueError('No prices received. Check FMP data permissions.')
        if missing:d['warnings'].append('Missing price or financial data: '+', '.join(missing))
        JOBS[job].update(status='succeeded',progress=200,data=d)
    except Exception as e:JOBS[job].update(status='failed',error=str(e))
@app.post('/api/data/fmp')
def fetch(request:Fetch):
    if not os.getenv('FMP_API_KEY'):raise HTTPException(400,'Set FMP_API_KEY on the server.')
    with LOCK:
        if any(j['status']=='running' for j in JOBS.values()):raise HTTPException(409,'A data collection job is already running.')
        JOBS.clear();job=uuid.uuid4().hex;JOBS[job]={'status':'running','progress':0,'total':200}
    threading.Thread(target=collect,args=(job,request),daemon=True).start()
    return {'job':job}
@app.get('/api/data/jobs/{job}')
def job_status(job:str):
    if job not in JOBS:raise HTTPException(404,'Data collection job not found.')
    return JOBS[job]
# Real market data: built once into SQLite, served as a gzip-compressed compact dataset.
from fastapi.responses import Response
from backend import realdata
REAL={'key':None,'body':None}
def real_job(job):
    try:
        def report(i,n,message,stage=0): JOBS[job].update(progress=stage,total=4,symbol=message)
        JOBS[job].update(status='succeeded',summary=realdata.build(report),progress=4)
    except Exception as e: JOBS[job].update(status='failed',error=f'{type(e).__name__}: {e}')
@app.get('/api/data/real/status')
def real_status():
    building=next((dict(j,job=k) for k,j in JOBS.items() if j.get('kind')=='real' and j['status']=='running'),None)
    return {**realdata.summary(),'building':building}
@app.post('/api/data/real/build')
def real_build():
    with LOCK:
        if any(j['status']=='running' for j in JOBS.values()):raise HTTPException(409,'A data collection job is already running.')
        job=uuid.uuid4().hex;JOBS[job]={'status':'running','kind':'real','progress':0,'total':4,'symbol':'Starting'}
    threading.Thread(target=real_job,args=(job,),daemon=True).start()
    return {'job':job}
@app.get('/api/data/real')
def real_dataset():
    db=realdata.DB_PATH
    if not db.exists():raise HTTPException(404,'Real-market database not built. Run: python -m backend.realdata')
    key=db.stat().st_mtime_ns; cache=db.with_name('real-dataset.json.gz')
    if REAL['key']!=key:
        # Disk cache survives restarts; rebuilt only when the database changes.
        if cache.exists() and cache.stat().st_mtime_ns>=key: body=cache.read_bytes()
        else:
            body=gzip.compress(json.dumps(realdata.export(db),separators=(',',':')).encode(),compresslevel=6); cache.write_bytes(body)
        REAL.update(key=key,body=body)
    return Response(REAL['body'],media_type='application/json',headers={'Content-Encoding':'gzip','Cache-Control':'no-cache'})
@app.get('/revenue-dip-lab.zip')
def project_download():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ('README.md', 'requirements.txt', 'Dockerfile', 'start.sh', 'start.bat', '.env.example', '.gitignore', '.dockerignore'):
            path = ROOT / name
            if path.is_file(): archive.write(path, 'revenue-dip-lab/' + name)
        for folder in ('backend', 'dist', 'tests'):
            for path in sorted((ROOT / folder).rglob('*')):
                if path.is_file() and path.suffix in ('.py', '.cjs', '.js', '.html', '.css') and '__pycache__' not in path.parts:
                    archive.write(path, 'revenue-dip-lab/' + str(path.relative_to(ROOT)))
    buffer.seek(0)
    return StreamingResponse(buffer, media_type='application/zip', headers={'Content-Disposition': 'attachment; filename="revenue-dip-lab.zip"'})

app.mount('/',StaticFiles(directory=ROOT/'dist',html=True),name='dashboard')
