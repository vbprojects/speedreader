"""Run the browser benchmark; preserve adapter identity and incremental timings."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url',default='http://localhost:5251')
p.add_argument('--chromium',required=True)
p.add_argument('--high-only',action='store_true',help='Measure only High WebGPU, for a separate recovery run')
p.add_argument('--output',type=Path,default=Path(__file__).parent/'output-backends/results.json')
args=p.parse_args();args.output.parent.mkdir(parents=True,exist_ok=True)
with sync_playwright() as playwright:
 browser=playwright.chromium.launch(executable_path=args.chromium,args=['--no-sandbox','--enable-unsafe-webgpu'])
 page=browser.new_page()
 def save(data):
  args.output.write_text(json.dumps(data,indent=2)+'\n')
  if data['rows']:
   row=data['rows'][-1];print(row['provider'],row['quality'],len(row['runs']),row.get('error',''),flush=True)
 page.expose_function('saveBenchmark',save)
 page.goto(args.url+'/experiments/tts-alternatives/backend-benchmark/index.html')
 page.evaluate('''()=>{const original=fetch.bind(window);window.fetch=(input,init)=>{const u=typeof input==='string'?input:input.url;if(u?.startsWith('https:')&&u.includes('en_US-lessac-'))return original('/experiments/tts-alternatives/assets/catalog/'+u.split('/').pop(),init);if(u?.startsWith('https:')&&u.endsWith('en-us.txt'))return original('/experiments/kokoro/output-browser/en-us.txt',init);return original(input,init)}}''')
 options=dict(providers=['webgpu'],qualities=['high']) if args.high_only else {}
 result=page.evaluate('''async(options)=>{const {benchmark}=await import('/experiments/tts-alternatives/backend-benchmark/benchmark.js');return benchmark(r=>window.saveBenchmark(JSON.parse(JSON.stringify(r))),3,options);}''',options)
 save(result);browser.close()
