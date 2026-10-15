#!/usr/bin/env python3
"""Rank tests by intrinsic timing variability, controlling for machine load.
usage: variance2.py <metrics.jsonl> <out.json>
Identity=(project,file,name); records deduped per (runId,identity). Only outcome=pass durations.
Machine load never dropped below 1.4 load/cpu in the data (no idle baseline), so loadAvgStart
cannot be bucketed; instead each run gets a COMMON-MODE factor f_run = median over its tests
(test median >= 20ms, n>=5) of dur/test_median. load-adjusted duration = dur / f_run.
load_adj_cv = CV of adjusted durations. spearman(load) = rank corr of dur with loadAvgStart/cpus.
Flaky = >1 distinct outcome among {pass,fail} within one (gitSha, dirty) cell, or retryCount>0; clean-tree flips (flips) are strong evidence, dirty-tree flips (flips_dirty) are candidates only.
HIGHLY VARIABLE (timing) = n>=5, median>=5ms, p95>=100ms (absolute floor: sub-100ms spread is scheduler noise), raw CV>0.5,
p95/median>3, load_adj_cv>0.7 and rho_load<0.6 (the spread is NOT explained by machine load => intrinsic).
LOAD-SENSITIVE = same but rho_load>=0.6 or 0.5<load_adj_cv<=0.7: duration tracks load (CPU-bound work), reported, not a nondeterminism defect.
"""
import sys,json,statistics as st,collections
recs={}
for line in open(sys.argv[1]):
    if '"kind":"test"' not in line: continue
    r=json.loads(line); recs[(r['runId'],r['project'],r['file'],r['name'])]=r
by=collections.defaultdict(list)
for r in recs.values(): by[(r['project'],r['file'],r['name'])].append(r)
def pct(v,p):
    v=sorted(v);k=(len(v)-1)*p;f=int(k);c=min(f+1,len(v)-1);return v[f]+(v[c]-v[f])*(k-f)
def cv(v):
    m=st.mean(v);return st.pstdev(v)/m if len(v)>1 and m>0 else 0
def rank(v):
    s=sorted(range(len(v)),key=lambda i:v[i]);r=[0]*len(v)
    for i,j in enumerate(s): r[j]=i
    return r
def spearman(a,b):
    if len(a)<4: return None
    ra,rb=rank(a),rank(b);ma,mb=st.mean(ra),st.mean(rb)
    num=sum((x-ma)*(y-mb) for x,y in zip(ra,rb));den=(sum((x-ma)**2 for x in ra)*sum((y-mb)**2 for y in rb))**.5
    return num/den if den else None
med={}
for k,rs in by.items():
    d=[r['durationMs'] for r in rs if r['outcome']=='pass']
    if len(d)>=5: med[k]=st.median(d)
ratios=collections.defaultdict(list)
for k,rs in by.items():
    if k in med and med[k]>=20:
        for r in rs:
            if r['outcome']=='pass': ratios[r['runId']].append(r['durationMs']/med[k])
f={rid:st.median(v) for rid,v in ratios.items() if len(v)>=3}
out=[]
for k,rs in by.items():
    pas=[r for r in rs if r['outcome']=='pass']
    d=[r['durationMs'] for r in pas]
    sha=collections.defaultdict(set)
    for r in rs:
        if r['outcome'] in('pass','fail'): sha[(r['gitSha'],bool(r.get('dirty')))].add(r['outcome'])
    # a flip only counts inside one (gitSha, dirty) cell: a clean-tree fail next to dirty-tree passes is a red commit with an
    # uncommitted fix, not a flake. Dirty-vs-dirty cells have unknowable content, so they are reported (flips_dirty) not counted.
    flips=sum(1 for (g,d),s in sha.items() if len(s)>1 and not d)
    flips_dirty=sum(1 for (g,d),s in sha.items() if len(s)>1 and d)
    retries=sum(1 for r in rs if r.get('retryCount',0)>0)
    fails=sum(1 for r in rs if r['outcome']=='fail')
    n=len(d)
    if n<5 and not flips and not flips_dirty and not retries and not fails: continue
    m=st.median(d) if d else 0
    adj=[r['durationMs']/f[r['runId']] for r in pas if r['runId'] in f and f[r['runId']]>0]
    p95=pct(d,.95) if d else 0
    row=dict(project=k[0],file=k[1],name=k[2],tier=rs[0].get('tier'),runner=rs[0]['runner'],n=n,median=round(m,1),p95=round(p95,1),
      cv=round(cv(d),2),p95_med=round(p95/m,1) if m else 0,load_adj_cv=round(cv(adj),2) if len(adj)>=5 else None,
      rho_load=None,flips=flips,flips_dirty=flips_dirty,retries=retries,fails=fails)
    rho=spearman(d,[r['loadAvgStart']/r['cpus'] for r in pas])
    row['rho_load']=None if rho is None else round(rho,2)
    base=bool(n>=5 and m>=5 and p95>=100 and row['cv']>.5 and row['p95_med']>3 and (row['load_adj_cv'] or 0)>.5)
    row['timing_variable']=bool(base and row['load_adj_cv']>.7 and (rho is None or rho<.6))
    row['load_sensitive']=bool(base and not row['timing_variable'])
    row['flaky']=bool(flips or flips_dirty or retries)
    out.append(row)
json.dump(out,open(sys.argv[2],'w'),indent=1)
tv=[x for x in out if x['timing_variable']]
print('tests',len(by),'rows',len(out),'timing_variable',len(tv),'flaky',sum(x['flaky'] for x in out),'fails-any',sum(1 for x in out if x['fails']))
