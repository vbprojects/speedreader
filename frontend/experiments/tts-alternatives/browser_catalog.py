import argparse
import json
parser = argparse.ArgumentParser(description="Browser catalog smoke test; stage Lessac low/medium/high ONNX + JSON in assets/catalog and run Vite")
parser.add_argument("--url", default="http://localhost:5250")
parser.add_argument("--chromium", required=True)
args = parser.parse_args()
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=args.chromium,args=['--no-sandbox','--enable-unsafe-webgpu'])
 page=b.new_page();page.goto(args.url)
 page.add_init_script('''const original=fetch.bind(window);window.fetch=(input,init)=>{const u=typeof input==='string'?input:input.url;const names=['en_US-lessac-low.onnx.json','en_US-lessac-low.onnx','en_US-lessac-medium.onnx.json','en_US-lessac-medium.onnx','en_US-lessac-high.onnx.json','en_US-lessac-high.onnx'];const n=names.find(n=>u?.startsWith('https:')&&u.endsWith(n));if(n)return original('/experiments/tts-alternatives/assets/catalog/'+n,init);if(u?.startsWith('https:')&&u.endsWith('en-us.txt'))return original('/experiments/kokoro/output-browser/en-us.txt',init);return original(input,init)};''')
 page.reload()
 result=page.evaluate('''async()=>{
 const {KokoroEngine}=await import('/src/audio/kokoro-engine.ts');
 const {packForVoice,downloadPackAsset}=await import('/src/audio/voice-pack.ts');
 const {PackStore,CachedAssets}=await import('/src/audio/pack-store.ts');
 const {IndexedPackMetadata}=await import('/src/audio/pack-metadata.ts');
 const {DEFAULT_AUDIO_SETTINGS}=await import('/src/audio/settings.ts');
 const store=new PackStore(new CachedAssets(),new IndexedPackMetadata(),downloadPackAsset);
 
 const words='This is a short sentence. Read along with Piper.'.split(' ').map((text,index)=>({text,index,metadata:[]}));
 const rows=[];
 for(const selectedVoice of ['piper_lessac','piper_en_US-lessac-medium','piper_en_US-lessac-high']) {
  const provider='wasm';
  await store.install(packForVoice(selectedVoice),async()=>{});
  const engine=new KokoroEngine(selectedVoice);
  try {
   await engine.initialize(a=>store.resolve(a),provider);
   for(const compression of [1,2]) {
    const r=await engine.prepare(words,{...DEFAULT_AUDIO_SETTINGS,readAloudVoice:selectedVoice,speechCompression:compression},{sessionId:'test',contentRevision:0,synthesisRevision:0,dspRevision:0},words.length);
    if(r.words.length!==words.length||r.words.some(w=>w.startSample<0||w.endSample>r.pcm.length))throw Error('Bad word geometry');
    rows.push({selectedVoice,provider:engine.provider,compression,samples:r.pcm.length,sampleRate:r.sampleRate,words:r.words.length,inference:r.synthesisMilliseconds});
   }
  }finally{engine.dispose();}
 }
 return rows;
}''')
 print(json.dumps(result),flush=True)
 page.get_by_role('button',name='Read a sample',exact=True).click();page.get_by_role('button',name='Start reading',exact=True).click();page.get_by_role('button',name='Settings',exact=True).click()
 page.get_by_label('Speech model',exact=True).select_option('piper')
 page.get_by_role('button',name='Repair voice',exact=True).wait_for()
 page.get_by_role('button',name='Repair voice',exact=True).click()
 page.get_by_text('English voice is installed for offline use.',exact=True).wait_for(timeout=120000)
 assert page.get_by_role('checkbox',name='Enable read aloud',exact=True).is_enabled()
 assert not page.get_by_role('checkbox',name='Enable read aloud',exact=True).is_checked()
 page.get_by_label('Speech model',exact=True).select_option('kokoro')
 page.get_by_role('button',name='Install voice',exact=True).wait_for()
 page.get_by_label('Speech model',exact=True).select_option('piper')
 page.get_by_role('button',name='Repair voice',exact=True).wait_for()
 page.get_by_label('Piper quality',exact=True).select_option('medium')
 page.get_by_role('button',name='Repair voice',exact=True).wait_for()
 page.get_by_label('Piper voice',exact=True).select_option('amy')
 page.get_by_role('button',name='Install voice',exact=True).wait_for()
 assert page.get_by_label('Piper quality',exact=True).input_value()=='medium'
 assert page.get_by_label('Piper quality',exact=True).locator('option[value=x_low]').get_attribute('disabled') is not None
 print('PASS: Low/Medium/High native+compressed CPU synthesis; voice/quality dropdowns; real install probe; pack isolation')
 b.close()
