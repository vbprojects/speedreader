"""Plot measured inference latency relative to Low within each backend."""
import argparse
import csv
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('results',type=Path)
args=p.parse_args();data=json.loads(args.results.read_text());rows=data['rows'];out=args.results.parent
fig,axes=plt.subplots(1,2,figsize=(11,5))
summary=[]
for ax,provider in zip(axes,['wasm','webgpu']):
 subset=[r for r in rows if r['provider']==provider and 'medianInferenceMs' in r]
 if not subset:
  ax.text(.5,.5,'No completed measurements',ha='center');continue
 low=next(r for r in subset if r['quality']=='low')
 ratios=[r['medianInferenceMs']/low['medianInferenceMs'] for r in subset]
 ax.bar([r['quality'].title() for r in subset],ratios,color=['#397cc0','#e49336','#3f9d56'])
 for i,(row,ratio) in enumerate(zip(subset,ratios)):
  ax.text(i,ratio,f'{ratio:.2f}×\n{row["medianInferenceMs"]/1000:.2f} s',ha='center',va='bottom')
  summary.append(dict(backend=provider,quality=row['quality'],medianInferenceSeconds=row['medianInferenceMs']/1000,
                      relativeToLow=ratio,percentChange=(ratio-1)*100,medianRealTimeFactor=row['medianRealTimeFactor'],
                      initializationSeconds=row['initializationMs']/1000,firstInferenceSeconds=row['firstRun']['inferenceMs']/1000))
 ax.set_ylim(0,max(ratios)*1.3);ax.axhline(1,color='gray',linestyle=':',linewidth=1)
 ax.set(title='CPU / WASM' if provider=='wasm' else ('WebGPU · SwiftShader software' if data['softwareGpu'] else 'WebGPU'),ylabel='Synthesis time / Low synthesis time')
fig.suptitle('Piper Lessac · warm median · native pacing 1× · Low baseline per backend')
fig.tight_layout();fig.savefig(out/'relative-timing.png',dpi=160);fig.savefig(out/'relative-timing.svg')
with (out/'summary.csv').open('w') as f:
 writer=csv.DictWriter(f,fieldnames=list(summary[0]));writer.writeheader();writer.writerows(summary)
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
