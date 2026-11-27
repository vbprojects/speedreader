"""SIGKILL a dedicated Chromium process group at four persistence boundaries.
Build the harness first. Uses a temporary persistent profile, never a user profile.
Requires Python Playwright and an actual Chromium binary. No close/pagehide runs.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from threading import Thread
import time
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--chromium", required=True, type=Path)
parser.add_argument("--dist", type=Path, default=Path(__file__).with_name("dist"))
parser.add_argument("--iterations", type=int, default=3)
parser.add_argument("--output", type=Path, default=Path("process-kill-results.json"))
args = parser.parse_args()
if not args.chromium.is_file() or args.iterations < 1:
    parser.error("Supply an actual Chromium binary and at least one iteration")

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(args.dist.resolve())))
Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/"
results = []
report = {"timestamp": datetime.now(timezone.utc).isoformat(), "platform": os.uname().sysname,
          "binary": str(args.chromium.resolve()), "method": "SIGKILL dedicated process group; persistent profile; no close/pagehide", "results": results}

with tempfile.TemporaryDirectory(prefix="speedreader-crash-") as directory, sync_playwright() as playwright:
    profile = Path(directory) / "profile"
    profile.mkdir()
    log = open(Path(directory) / "chromium.log", "ab")
    process = None
    def launch():
        global process
        port_file = profile / "DevToolsActivePort"
        port_file.unlink(missing_ok=True)
        process = subprocess.Popen([str(args.chromium.resolve()), "--headless=new", "--no-sandbox", "--no-zygote",
            "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update",
            "--remote-debugging-port=0", "--user-data-dir=" + str(profile), "about:blank"],
            stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 20
        while not port_file.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                log.flush()
                raise RuntimeError((Path(directory) / "chromium.log").read_text(errors="replace")[-6000:])
            time.sleep(.05)
        port = port_file.read_text().splitlines()[0]
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:" + port)
        report["browserVersion"] = browser.version
        page = browser.contexts[0].pages[0]
        page.goto(url)
        page.wait_for_function("window.crashHarness?.ready")
        return browser, page
    def kill():
        global process
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=15)
        process = None
    try:
        browser, page = launch()
        for iteration in range(args.iterations):
            for mode in ["before-submit", "during-transaction", "committed-before-ack", "after-ack"]:
                page.evaluate("crashHarness.prepare()")
                page.evaluate("mode => crashHarness.run(mode)", mode)
                page.wait_for_function("mode => crashHarness.phase === mode", arg=mode)
                attempt = page.evaluate("crashHarness.attempt")
                assert attempt, "The production controller must have an operation identity"
                kill()
                browser, page = launch()
                recovered = page.evaluate("crashHarness.read()")
                expected = "before" if mode in ["before-submit", "during-transaction"] else "after"
                wanted = {"local": [["slot", expected]], "session": [["history", expected]]}
                assert recovered["snapshot"] == wanted, (mode, recovered)
                if expected == "after":
                    page.evaluate("batch => crashHarness.replay(batch)", attempt)
                    assert page.evaluate("crashHarness.read()") == recovered
                results.append({"iteration": iteration + 1, "boundary": mode, "expected": expected, "recovered": expected,
                                "bothAreasAtomic": True, "idempotentReplay": expected == "after", "passed": True})
                print(f"PASS {iteration + 1}: {mode} -> {expected}", flush=True)
        page.evaluate("navigator.serviceWorker.ready")
        page.reload()
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        page.context.set_offline(True)
        page.reload()
        page.wait_for_function("window.crashHarness?.ready")
        report["offlineReload"] = True
        report["passed"] = True
    finally:
        kill()
        log.close()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        server.shutdown()
