"""Production-browser checks for advisory sessions, CAS conflicts and recovery UI.

Uses only a fresh temporary browser context and synthetic fixture saves. No
production database is opened. Run after building the patched frontend.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import shutil
import tempfile

from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[2] / "dist")
parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("fixture-current.html"))
parser.add_argument("--browser", choices=["chromium", "firefox", "webkit"], default="chromium")
parser.add_argument("--chromium", default=shutil.which("chromium"))
parser.add_argument("--report", type=Path, default=Path(__file__).resolve().parents[3] / "benchmarks" / "concurrent-recovery-browser.json")
args = parser.parse_args()
TITLE = "Speedreader SugarCube Runtime Spike"
MARKER = "__sr_concurrent_marker"
SESSION = "__sr_concurrent_session"
CONFLICT = "This story changed in another session. Reopen it to load the latest save."

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=args.dist.resolve()))
Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}"
results = []
report = {
    "generatedAt": datetime.now(timezone.utc).isoformat(), "browser": args.browser,
    "targetCommit": "0863d924908b6d64525dde6ada0b350ad2e323fd",
    "fixtureSha256": hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
    "dist": str(args.dist.resolve()), "results": results,
    "scope": "Two actual same-origin browser tabs with independent opaque story frames, shared real IndexedDB, real Web Locks and real download/import UI. Desktop browser only; this does not validate iOS process termination.",
}

def result(name, **evidence):
    results.append({"name": name, "status": "passed", **evidence})
    print("PASS " + name, flush=True)


def play_story(page):
    title = page.get_by_text(TITLE, exact=True).first
    title.wait_for()
    resume = page.get_by_role("button", name="Continue reading", exact=True)
    if resume.is_visible():
        resume.click()
    else:
        title.click()
    # Reader mode is remembered after the first tab opens the published story.
    play = page.get_by_role("button", name="Play published story")
    gate = page.get_by_text("This story is open in another tab. Close it there, then reopen here to use the latest save.", exact=True)
    try:
        play.or_(gate).or_(page.locator("iframe").first).first.wait_for()
    except Exception:
        print("Open-story page state: " + page.locator("body").inner_text(), flush=True)
        raise
    if play.is_visible():
        play.click()


def story_frame(page):
    page.frame_locator("iframe").frame_locator("iframe").locator("#passages").wait_for()
    return page.frames[-1]


READ_MARKER = """async ({key, expected}) => {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('speedreader');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('publishedStorage')) { db.close(); resolve(false); return; }
      const tx = db.transaction('publishedStorage', 'readonly');
      const rows = tx.objectStore('publishedStorage').getAll();
      rows.onerror = () => reject(rows.error);
      rows.onsuccess = () => resolve(rows.result.some(row => row.area === 'local' && row.key === key && row.value === expected));
      tx.oncomplete = () => db.close();
    };
  });
}"""


def wait_saved(page, value):
    page.wait_for_function(READ_MARKER, arg={"key": MARKER, "expected": value}, timeout=15000)


def assert_saved(page, value):
    assert page.evaluate(READ_MARKER, {"key": MARKER, "expected": value}), f"expected saved marker {value}"


def export_file(page, label, target):
    with page.expect_download() as pending:
        page.get_by_role("button", name=label, exact=True).click()
    pending.value.save_as(target)
    return json.loads(target.read_text(encoding="utf8"))


def saved_value(document, area, key):
    return dict(document["snapshot"][area]).get(key)

page_a = page_b = None
try:
    with tempfile.TemporaryDirectory() as folder, sync_playwright() as playwright:
        root = Path(folder)
        source = root / "story"
        source.mkdir()
        shutil.copyfile(args.fixture, source / "fixture-current.html")
        browser = getattr(playwright, args.browser).launch(executable_path=args.chromium if args.browser == "chromium" else None)
        report["browserVersion"] = browser.version
        context = browser.new_context(accept_downloads=True)
        context.set_default_timeout(15000)
        page_a = context.new_page()
        # Activate the app shell before import, avoiding its first-install reload.
        page_a.goto(url + "/sugarcube-host.html")
        page_a.evaluate("""async () => {
          await navigator.serviceWorker.register('sw.js');
          await navigator.serviceWorker.ready;
        }""")
        page_a.goto(url)
        page_a.get_by_role("button", name="More import options").click()
        with page_a.expect_file_chooser() as picker:
            page_a.get_by_role("button", name="Import HTML folder", exact=True).click()
        picker.value.set_files(source)
        page_a.get_by_text("Loaded 1 of 1 HTML files.").wait_for()
        play_story(page_a)
        frame_a = story_frame(page_a)
        assert frame_a.evaluate("self.origin") == "null"
        frame_a.evaluate("key => localStorage.setItem(key, 'seed')", MARKER)
        wait_saved(page_a, "seed")

        page_b = context.new_page()
        page_b.goto(url)
        play_story(page_b)
        page_b.get_by_text("This story is open in another tab. Close it there, then reopen here to use the latest save.", exact=True).wait_for()
        assert len(page_b.frames) == 1, "advisory gate must precede starting the second runtime"
        assert_saved(page_a, "seed")
        page_b.get_by_role("button", name="Continue in this tab", exact=True).click()
        frame_b = story_frame(page_b)
        assert frame_b.evaluate("self.origin") == "null"
        assert frame_b.evaluate("key => localStorage.getItem(key)", MARKER) == "seed"
        result("advisory gate and explicit Continue launch a separate session", opaqueOrigins=True)

        frame_a.evaluate("key => localStorage.setItem(key, 'A committed')", MARKER)
        wait_saved(page_a, "A committed")
        # Change both areas in the loser before its batch reaches the parent.
        frame_b.evaluate("({key, session}) => { localStorage.setItem(key, 'B unsaved'); sessionStorage.setItem(session, 'B history'); }", {"key": MARKER, "session": SESSION})
        page_b.get_by_text(CONFLICT, exact=False).wait_for()
        assert page_b.locator("iframe").first.evaluate("frame => frame.inert")
        assert frame_b.evaluate("key => { try { localStorage.setItem(key, 'late'); return false; } catch (e) { return e.name === 'InvalidStateError'; } }", MARKER)
        assert frame_b.evaluate("key => localStorage.getItem(key)", MARKER) == "B unsaved"
        assert_saved(page_a, "A committed")
        result("stale session pauses after CAS conflict; winner remains saved", saved="A committed", live="B unsaved")

        page_b.get_by_text("Save storage and recovery", exact=True).click()
        session_path = root / "session.json"
        candidate = export_file(page_b, "Export this session", session_path)
        persisted = export_file(page_b, "Export saved data", root / "saved.json")
        assert candidate["kind"] == "speedreader-published-save" and candidate["version"] == 1
        assert candidate["sourceHash"] == persisted["sourceHash"]
        assert saved_value(candidate, "local", MARKER) == "B unsaved"
        assert saved_value(candidate, "session", SESSION) == "B history"
        assert saved_value(persisted, "local", MARKER) == "A committed"
        assert_saved(page_a, "A committed")
        result("conflict export downloads current dirty state and saved-data export downloads winner", sourceHash=candidate["sourceHash"])

        # A bad import never changes storage or starts a replacement.
        wrong = dict(candidate); wrong["sourceHash"] = "0" * 64
        wrong_path = root / "wrong-source.json"; wrong_path.write_text(json.dumps(wrong), encoding="utf8")
        page_b.get_by_label("Import save JSON").set_input_files(wrong_path)
        page_b.get_by_text("This save belongs to a different story or source revision.", exact=True).wait_for()
        assert_saved(page_a, "A committed")
        result("different-source recovery import is rejected without writes")

        page_b.get_by_label("Import save JSON").set_input_files(session_path)
        page_b.get_by_role("heading", name="Review imported data", exact=True).wait_for()
        assert_saved(page_a, "A committed")
        confirmations = []
        def dismiss(dialog):
            confirmations.append(dialog.message); dialog.dismiss()
        page_b.once("dialog", dismiss)
        page_b.get_by_role("button", name="Replace published saves", exact=True).click()
        expect(page_b.get_by_role("button", name="Replace published saves", exact=True)).to_be_enabled()
        assert confirmations and "Unselected data and unsaved progress" in confirmations[-1]
        assert_saved(page_a, "A committed")
        result("preview and cancelled replacement preserve the winner")

        page_b.once("dialog", lambda dialog: dialog.accept())
        page_b.get_by_role("button", name="Replace published saves", exact=True).click()
        wait_saved(page_b, "B unsaved")
        page_b.get_by_role("heading", name="Review imported data", exact=True).wait_for(state="detached")
        frame_b = story_frame(page_b)
        assert frame_b.evaluate("key => localStorage.getItem(key)", MARKER) == "B unsaved"
        assert frame_b.evaluate("key => sessionStorage.getItem(key)", SESSION) == "B history"
        assert not page_b.locator("iframe").first.evaluate("frame => frame.inert")
        result("confirmed replacement persists candidate then reopens from it", saved="B unsaved")

        # The old winner is now stale; its later write must not undo the import.
        frame_a.evaluate("key => localStorage.setItem(key, 'A stale after import')", MARKER)
        page_a.get_by_text(CONFLICT, exact=False).wait_for()
        assert_saved(page_b, "B unsaved")
        result("former winner cannot overwrite an explicitly imported replacement")
        browser.close()
        report["status"] = "passed"
except Exception as error:
    report["status"] = "failed"
    report["error"] = repr(error)
    raise
finally:
    server.shutdown(); server.server_close()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(f"Report: {args.report}", flush=True)
