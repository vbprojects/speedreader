"""Production PWA smoke/soak test with Chromium and Playwright.

Serve a production build, optionally exposing exact pinned download fixtures at
--local-assets-url. External downloads are real unless that option is supplied.
"""
import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path
from playwright.async_api import async_playwright


async def run(args):
    async with async_playwright() as p:
        launch_args = ['--no-sandbox', f'--remote-debugging-port={args.debug_port}']
        if args.autoplay_unrestricted:
            launch_args.append('--autoplay-policy=no-user-gesture-required')
        if args.browser == "firefox":
            browser = await p.firefox.launch(headless=True)
        else:
            browser = await p.chromium.launch(executable_path=args.chromium, headless=True, args=launch_args,
                ignore_default_args=["--mute-audio"] if args.unmute_audio else [])
        context = await browser.new_context()
        if args.browser == "firefox":
            await context.grant_permissions(['persistent-storage'])
        page = await context.new_page()
        args.partial_checks = []
        args.browser_version = browser.version
        errors = []
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        page.on('pageerror', lambda error: errors.append(str(error)))
        if args.local_assets_url:
            await page.add_init_script('''const fetchOriginal = window.fetch.bind(window);
              window.fetch = (input, init) => {
                const url = typeof input === 'string' ? input : input.url;
                const name = ['model_quantized.onnx', 'af_heart.bin', 'en-us.txt'].find(
                  name => url?.startsWith('https:') && url.endsWith(name));
                return fetchOriginal(name ? ASSET_BASE + name : input, init);
              };'''.replace('ASSET_BASE', json.dumps(args.local_assets_url)))
        await page.goto(args.url)
        await page.wait_for_function('() => Boolean(navigator.serviceWorker.controller)')
        if args.text_file:
            async with page.expect_file_chooser() as chooser:
                await page.get_by_role('button', name='Import file', exact=False).first.click()
            await (await chooser.value).set_files({"name": args.text_file.stem + ".txt", "mimeType": "text/plain", "buffer": args.text_file.read_bytes()})
        else:
            await page.get_by_role('button', name='Read a sample', exact=True).click()
        await page.get_by_role('button', name='Start reading', exact=True).click()
        await page.locator('summary').filter(has_text='Read aloud').click()
        assert not any(url.endswith(('.onnx', '.bin', '.wasm', '/en-us.txt')) for url in requests), requests
        start = time.monotonic()
        await page.get_by_role('button', name='Install voice', exact=True).click()
        installed_message = page.get_by_text('English voice is installed for offline use.', exact=True)
        for _ in range(240):
            if await installed_message.count():
                break
            if not await page.get_by_role('button', name='Cancel installation', exact=True).count():
                raise RuntimeError('Voice installation failed: ' + await page.locator('details').inner_text())
            await page.wait_for_timeout(500)
        else:
            raise TimeoutError('Voice installation timed out: ' + await page.locator('details').inner_text())
        installation_seconds = time.monotonic() - start
        print(f"Installed and verified in {installation_seconds:.2f}s", flush=True)
        await page.get_by_role('checkbox', name='Read aloud', exact=True).check()
        # Use the application's awaited save/exit path before closing the document.
        await page.get_by_role('button', name='← Library', exact=True).click()
        await page.get_by_role('button', name='Continue reading', exact=True).wait_for()
        await context.set_offline(True)
        await page.reload()
        await page.get_by_role('button', name='Continue reading', exact=True).click()
        await page.locator('summary').filter(has_text='Read aloud').click()
        assert await page.get_by_role('checkbox', name='Read aloud', exact=True).is_checked()
        status = page.locator('details p[role="status"]')

        async def wait_playing():
            for _ in range(120):
                text = await status.inner_text()
                if text == 'playing':
                    return
                if await page.get_by_role('button', name='Reset voice for retry').count():
                    raise RuntimeError(text)
                await page.wait_for_timeout(500)
            raise TimeoutError('Audio never entered playing state: ' + await status.inner_text())

        def word_index(body):
            match = re.search(r'word (\d+) /', body)
            assert match, body
            return int(match.group(1))

        first_audio_start = time.monotonic()
        await page.get_by_role('button', name='Play', exact=True).first.click()
        await wait_playing()
        first_audio_seconds = time.monotonic() - first_audio_start
        for _ in range(40):
            if word_index(await page.locator('body').inner_text()) > 1:
                break
            await page.wait_for_timeout(250)
        else:
            raise RuntimeError('Playback did not advance beyond the first word')
        # The audio panel exposes Pause even when presentation controls are hidden.
        await page.get_by_role('button', name='Pause speech', exact=True).click()
        before = word_index(await page.locator('body').inner_text())
        await page.wait_for_timeout(1200)
        assert word_index(await page.locator('body').inner_text()) == before
        checks = args.partial_checks = ['no-model-download-before-install', 'install-hash-and-local-synthesis', 'offline-reopen', 'sample-cursor-progression', 'pause-preserves-position']
        for view in ['Read along', 'Context', 'RSVP']:
            await page.get_by_role('button', name=view, exact=True).click()
            assert word_index(await page.locator('body').inner_text()) == before
        checks.append('all-presentations-preserve-position')
        await page.get_by_role('button', name='Preview voice', exact=True).click()
        await page.get_by_text('Playing voice preview.', exact=True).wait_for(timeout=90000)
        if await page.get_by_role('button', name='Stop preview', exact=True).count():
            await page.get_by_role('button', name='Stop preview', exact=True).click()
        assert word_index(await page.locator('body').inner_text()) == before
        checks.append('offline-preview-preserves-position')
        await page.get_by_role('button', name='Context', exact=True).click()
        await page.get_by_role('button', name='Play', exact=True).first.click()
        await wait_playing()
        await page.wait_for_timeout(700)
        await page.get_by_role('button', name='Pause speech', exact=True).click()
        checks.append('offline-context-playback')
        await page.get_by_role('button', name='RSVP', exact=True).click()
        sliders = page.locator('details input[type="range"]')
        await sliders.nth(0).fill(format(args.pacing, "g"))
        await sliders.nth(1).fill(format(args.compression, "g"))
        await page.get_by_role('button', name='Next sentence', exact=True).click()
        assert await page.get_by_role('button', name='Play', exact=True).first.is_visible()
        await page.get_by_role('button', name='Play', exact=True).first.click()
        await wait_playing()
        checks.extend(['seek-remains-paused', 'offline-two-speed-controls'])
        await page.wait_for_timeout(1000)
        await page.get_by_role('button', name='Pause speech', exact=True).click()
        await page.get_by_role('button', name='Previous sentence', exact=True).click()
        await page.get_by_role('button', name='Read along', exact=True).click()
        await page.get_by_role('button', name='Play', exact=True).first.click()
        await wait_playing()
        checks.append('offline-read-along-resume')
        print("Offline controls and playback checks passed; starting timed run", flush=True)
        soak_start = time.monotonic()
        last_progress = -60
        cycles = 0
        completed_pass_rates = []
        last_word = None
        last_movement = time.monotonic()
        heap_samples = []
        while time.monotonic() - soak_start < args.soak_seconds:
            text = await status.inner_text()
            if text == 'error' or await page.get_by_role('button', name='Reset voice for retry').count():
                raise RuntimeError(text)
            if text == 'ended':
                completed_body = await page.locator('body').inner_text()
                rate = re.search(r'Observed speech: ≈ (\d+) WPM', completed_body)
                if rate:
                    completed_pass_rates.append(int(rate.group(1)))
                cycles += 1
                await page.get_by_role('button', name='Play', exact=True).first.click()
            current_word = word_index(await page.locator('body').inner_text())
            if current_word != last_word:
                last_word = current_word
                last_movement = time.monotonic()
            if time.monotonic() - last_movement > 90:
                raise RuntimeError(f'No word progress for 90 seconds at word {current_word}, state {text}')
            heap = await page.evaluate('() => performance.memory?.usedJSHeapSize ?? null')
            if heap is not None:
                heap_samples.append(heap)
            elapsed = time.monotonic() - soak_start
            if elapsed - last_progress >= 60:
                last_progress = elapsed
                print(f"Timed run: {elapsed:.0f}s, completed passes: {cycles}, state: {text}", flush=True)
                args.report.with_suffix('.progress.json').write_text(json.dumps({
                    'status': 'running', 'elapsedSeconds': elapsed, 'completedPasses': cycles,
                    'state': text, 'word': word_index(await page.locator('body').inner_text()),
                    'mainThreadJSHeapBytes': heap,
                }, indent=2) + '\n')
            await page.wait_for_timeout(1000)
        if args.soak_seconds:
            checks.append('timed-offline-soak')
        assert not errors, errors
        app_script = await page.locator('script[type="module"][src]').first.get_attribute('src')
        final_body = await page.locator('body').inner_text()
        observed = re.search(r'Observed speech: ≈ (\d+) WPM', final_body)
        report = dict(appScript=app_script, virtualAudioServer=bool(os.environ.get("PULSE_SERVER")), audioOutputUnmuted=args.unmute_audio, persistentStoragePermissionGranted=args.browser == "firefox", browserEngine=args.browser, autoplayUnrestricted=args.autoplay_unrestricted, pacing=args.pacing, compression=args.compression, observedWpm=int(observed.group(1)) if observed else None,
                      lastWord=word_index(final_body), status="passed", url=args.url, browser=browser.version, installedDownloadFixtures=bool(args.local_assets_url),
                      installationSeconds=installation_seconds, offlineFirstAudioSeconds=first_audio_seconds,
                      checks=checks, soakSeconds=time.monotonic() - soak_start, completedSoakCycles=cycles, completedPassObservedWpm=completed_pass_rates,
                      peakMainThreadJSHeapBytes=max(heap_samples, default=None),
                      memoryNote='Main-thread JS heap only; excludes worker/WASM/native audio memory.',
                      audioAudibilityValidated=False, device=f'Linux headless {args.browser}; WASM fallback')
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
        await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Production URL including ?kokoro=1')
    parser.add_argument('--browser', choices=['chromium', 'firefox'], default='chromium')
    parser.add_argument('--chromium', help='Optional installed Chromium executable')
    parser.add_argument('--local-assets-url', help='Optional URL prefix for pinned model, voice and dictionary fixture files')
    parser.add_argument('--text-file', type=Path, help='Optional longer text fixture instead of the built-in sample')
    parser.add_argument('--pacing', type=float, default=1.5)
    parser.add_argument('--compression', type=float, default=2)
    parser.add_argument('--unmute-audio', action='store_true', help='Remove Playwright mute flag; requires a working audio device or virtual server')
    parser.add_argument('--autoplay-unrestricted', action='store_true', help='Headless-only workaround; disclosed in report, does not validate autoplay policy')
    parser.add_argument('--debug-port', type=int, default=0)
    parser.add_argument('--soak-seconds', type=int, default=0)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.browser != "chromium" and args.autoplay_unrestricted:
        parser.error("--autoplay-unrestricted applies only to Chromium")
    try:
        asyncio.run(run(args))
    except Exception as error:
        args.report.write_text(json.dumps({'status': 'failed', 'error': str(error),
            'url': args.url, 'pacing': args.pacing, 'compression': args.compression,
            'browserEngine': args.browser, 'browser': getattr(args, 'browser_version', None),
            'autoplayUnrestricted': args.autoplay_unrestricted,
            'completedChecks': getattr(args, 'partial_checks', [])}, indent=2) + '\n')
        raise
    finally:
        args.report.with_suffix('.progress.json').unlink(missing_ok=True)
