"""Exercise a real waiting service-worker update across two tabs.

Serve an older Pages build from --deployment; provide a newer Pages build via
--replacement. This test copies replacement build files into the served directory.
Both builds must use /speedreader/. Pinned installation fixtures are exposed at
/speedreader/__test_assets/. Use a disposable deployment directory.
"""
import argparse
import asyncio
import json
import shutil
from pathlib import Path
from playwright.async_api import async_playwright


async def run(args):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True,
            args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        context = await browser.new_context()
        await context.add_init_script('''const originalFetch = fetch.bind(window);
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            const name = ['model_quantized.onnx', 'af_heart.bin', 'en-us.txt'].find(
              name => url?.startsWith('https:') && url.endsWith(name));
            return originalFetch(name ? '/speedreader/__test_assets/' + name : input, init);
          };''')
        reader = await context.new_page()
        await reader.goto(args.url)
        await reader.wait_for_function('() => Boolean(navigator.serviceWorker.controller)')
        await reader.get_by_role('button', name='Read a sample', exact=True).click()
        await reader.get_by_role('button', name='Start reading', exact=True).click()
        await reader.locator('summary').filter(has_text='Read aloud').click()
        await reader.get_by_role('button', name='Install voice', exact=True).click()
        await reader.get_by_text('English voice is installed for offline use.', exact=True).wait_for(timeout=120000)
        hashes_before = await reader.evaluate("async () => (await (await caches.open('speedreader-kokoro-immutable-v1')).keys()).map(r => r.url).sort()")
        assert len(hashes_before) == 4
        await reader.evaluate('window.readerIdentity = "held-through-update"')
        library = await context.new_page()
        await library.goto(args.url)
        await library.wait_for_function('() => Boolean(navigator.serviceWorker.controller)')
        # Stage all new assets before atomically replacing the worker script.
        shutil.copytree(args.replacement, args.deployment, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('sw.js', '__test_assets'))
        temporary = args.deployment / 'sw.next.js'
        shutil.copyfile(args.replacement / 'sw.js', temporary)
        temporary.replace(args.deployment / 'sw.js')
        await library.evaluate('async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); }')
        await library.wait_for_function('async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)', timeout=60000)
        await library.wait_for_timeout(6000)
        assert await reader.evaluate('window.readerIdentity') == 'held-through-update'
        assert await library.evaluate('async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)')
        print('Waiting update preserved reader in another tab', flush=True)
        await reader.get_by_role('button', name='← Library', exact=True).click()
        await library.wait_for_function('async () => !(await navigator.serviceWorker.getRegistration()).waiting', timeout=30000)
        await library.wait_for_timeout(1500)
        hashes_after = await library.evaluate("async () => (await (await caches.open('speedreader-kokoro-immutable-v1')).keys()).map(r => r.url).sort()")
        assert hashes_after == hashes_before
        await context.set_offline(True)
        await library.reload()
        await library.get_by_role('button', name='Continue reading', exact=True).click()
        await library.locator('summary').filter(has_text='Read aloud').click()
        await library.get_by_role('checkbox', name='Read aloud', exact=True).check()
        await library.get_by_role('button', name='Play', exact=True).first.click()
        await library.wait_for_function("() => /word ([2-9]|[1-9][0-9]+) \\//.test(document.body.innerText)", timeout=90000)
        report = {'status': 'passed', 'browser': browser.version, 'autoplayUnrestricted': True,
                  'installedDownloadFixtures': True, 'checks': ['real-worker-waits-for-reader-in-other-tab',
                  'activation-after-reader-exit', 'pack-assets-survive-app-update', 'offline-synthesis-after-update'],
                  'retainedPackAssets': len(hashes_after)}
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
        await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--chromium')
    parser.add_argument('--deployment', type=Path, required=True)
    parser.add_argument('--replacement', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
