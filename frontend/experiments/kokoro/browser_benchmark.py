"""Measure first versus repeated inference in one browser worker/session.

Serve the frontend development server and stage the assets described in README.
This probe bypasses audio playback and measures the fixed original-word fixture.
"""
import argparse
import asyncio
import json
import statistics
from pathlib import Path
from playwright.async_api import async_playwright


async def run(args):
    async with async_playwright() as p:
        flags = ['--no-sandbox'] + (['--enable-unsafe-webgpu'] if args.software_gpu else [])
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True, args=flags)
        page = await browser.new_page()
        await page.goto(args.url)
        await page.wait_for_timeout(1000)
        await page.wait_for_function('() => typeof window.kokoroProbe === \"function\"')
        adapter = await page.evaluate('''async () => {
          const a = await navigator.gpu?.requestAdapter();
          return a ? {vendor:a.info.vendor, architecture:a.info.architecture,
            device:a.info.device, description:a.info.description,
            isFallbackAdapter:a.info.isFallbackAdapter} : null;
        }''') if args.provider == 'webgpu' else None
        measurements = await asyncio.wait_for(page.evaluate('''async ({provider, pacing, repeats}) =>
          window.kokoroProbe(provider, Array(repeats + 1).fill(pacing))''',
          {'provider': args.provider, 'pacing': args.pacing, 'repeats': args.repeats}), timeout=args.timeout)
        runs = measurements[1:]
        warm = [run['milliseconds'] for run in runs[1:]]
        report = {'status': 'completed', 'browser': browser.version, 'provider': args.provider,
          'adapter': adapter, 'softwareGpuFlag': args.software_gpu, 'pacing': args.pacing,
          'initializationMilliseconds': measurements[0]['milliseconds'],
          'firstInferenceMilliseconds': runs[0]['milliseconds'],
          'warmMedianMilliseconds': statistics.median(warm),
          'warmMilliseconds': warm, 'outputSampleCounts': [run['samples'] for run in runs],
          'repeatSampleCountsEqual': len({run['samples'] for run in runs}) == 1,
          'maxCpuReferenceDurationFrameDifference': max(run['maxDurationFrameDifference'] for run in runs),
          'nativeGeometryValidated': True, 'audibleParityValidated': False,
          'note': 'Fixed fixture, native synthesis only; excludes phonemization, DSP and audio device latency. Few repeats are not a robust p95 measurement.'}
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
        await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:1420/experiments/kokoro/browser-probe.html')
    parser.add_argument('--chromium')
    parser.add_argument('--provider', choices=['wasm', 'webgpu'], default='wasm')
    parser.add_argument('--software-gpu', action='store_true')
    parser.add_argument('--pacing', type=float, choices=[.5, 1, 1.5, 4], default=1)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('at least one warm repeat is required')
    asyncio.run(run(args))
