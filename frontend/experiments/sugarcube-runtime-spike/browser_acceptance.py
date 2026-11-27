"""Exercise a production preview with the pinned published SugarCube fixture."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import argparse
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[2] / "dist")
parser.add_argument("--browser", choices=["chromium", "firefox", "webkit"], default="chromium")
parser.add_argument("--chromium", default=shutil.which("chromium"))
args = parser.parse_args()
fixture = Path(__file__).with_name("fixture-current.html")

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=args.dist))
url = f"http://127.0.0.1:{server.server_port}"
Thread(target=server.serve_forever, daemon=True).start()

with server, tempfile.TemporaryDirectory() as folder, sync_playwright() as playwright:
    root = Path(folder)
    story_dir = root / "release"
    story_dir.mkdir()
    # An external script registers a real custom element before story startup.
    html = fixture.read_text(encoding="utf8").replace("</head>", '<script src="./component.js"></script></head>', 1)
    (story_dir / fixture.name).write_text(html, encoding="utf8")
    (story_dir / "component.js").write_text(
        "customElements.define('story-badge', class extends HTMLElement {});", encoding="utf8"
    )
    (story_dir / "test-resource.txt").write_text("packaged resource", encoding="utf8")
    browser = getattr(playwright, args.browser).launch(executable_path=args.chromium if args.browser == "chromium" else None)
    context = browser.new_context()
    page = context.new_page()
    page.goto(url + "/sugarcube-host.html")
    page.evaluate("""async () => {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
    }""")
    page.goto(url)
    with page.expect_file_chooser() as single:
        page.get_by_role("button", name="Import file", exact=True).first.click()
    single.value.set_files({"name": "article.html", "mimeType": "text/html",
                            "buffer": b"<article><p>An ordinary HTML article.</p></article>"})
    page.get_by_role("heading", name="Preview import").wait_for()
    page.get_by_role("button", name="Back to library").click()
    page.get_by_role("button", name="More import options").click()
    with page.expect_file_chooser() as picker:
        page.get_by_role("button", name="Import HTML folder").click()
    picker.value.set_files(folder)
    page.get_by_text("Loaded 1 of 1 HTML files.").wait_for()
    page.get_by_text("Speedreader SugarCube Runtime Spike", exact=True).first.click()
    play = page.get_by_role("button", name="Play published story")
    play.click()
    passage = page.frame_locator("iframe").frame_locator("iframe").locator("#passages")
    passage.get_by_text("Take the forest path", exact=True).click()
    passage.locator(".spike-widget").wait_for()
    frame = page.frames[-1]
    assert frame.evaluate("window.spikeStoryScriptRan === true")
    assert frame.evaluate("Boolean(customElements.get('story-badge'))")
    assert frame.evaluate("self.origin === 'null'")
    assert frame.evaluate("() => { try { return !parent.document } catch { return true } }")
    assert frame.evaluate("fetch('test-resource.txt').then(r => r.text())") == "packaged resource"
    frame.evaluate("SugarCube.Save.browser.slot.save(0, 'Forest checkpoint')")
    passage.get_by_text("Open the controls", exact=True).click()
    passage.locator("input[type=text]").fill("Reader Two")
    passage.locator("input[type=checkbox]").check()
    passage.locator("select").select_option(label="Bold")
    passage.get_by_text("Continue to DOM mutations", exact=True).click()
    passage.get_by_text("Delayed words appeared.", exact=True).wait_for()
    passage.get_by_text("Reveal appended prose", exact=True).click()
    passage.get_by_text("Newly appended words appeared.", exact=False).wait_for()
    passage.get_by_text("Finish the spike", exact=True).click()
    ending = passage.get_by_text("The runtime spike reached its ending.", exact=False)
    ending.wait_for()
    # Failed setItem must be synchronous and leave the previous value intact.
    assert frame.evaluate("""() => {
      localStorage.setItem('__sr_quota_test', 'old');
      try { localStorage.setItem('__sr_quota_test', 'x'.repeat(3 * 1024 * 1024)); return false; }
      catch (e) { return e.name === 'QuotaExceededError' && localStorage.getItem('__sr_quota_test') === 'old'; }
    }""")
    # No wait between mutations and Library: exercise drain and commit ACK.
    frame.evaluate("() => { localStorage.setItem('__sr_quota_test', 'last'); sessionStorage.setItem('__sr_session_test', 'last'); }")
    page.get_by_role("button", name="← Library").click()
    page.get_by_role("button", name="Continue reading").wait_for()
    page.evaluate("navigator.serviceWorker.ready")
    server.shutdown()
    server.server_close()
    page.reload()
    page.get_by_role("button", name="Continue reading").click()
    play.click()
    ending.wait_for()
    frame = page.frames[-1]
    assert frame.evaluate("localStorage.getItem('__sr_quota_test')") == 'last'
    assert frame.evaluate("sessionStorage.getItem('__sr_session_test')") == 'last'
    assert frame.evaluate("SugarCube.Save.browser.slot.get(0).desc") == "Forest checkpoint"
    frame.evaluate("SugarCube.Save.browser.slot.load(0).then(() => SugarCube.Engine.show())")
    passage.locator(".spike-widget").wait_for()
    assert frame.evaluate("SugarCube.State.variables.score") == 2
    portable = frame.evaluate("SugarCube.Save.base64.save()")
    frame.evaluate("SugarCube.Engine.backward()")
    passage.get_by_text("Take the forest path", exact=True).wait_for()
    frame.evaluate("SugarCube.Engine.forward()")
    passage.locator(".spike-widget").wait_for()
    frame.evaluate("SugarCube.Engine.restart()")
    passage.get_by_text("Take the forest path", exact=True).wait_for()
    frame = page.frames[-1]
    frame.evaluate("data => SugarCube.Save.base64.load(data).then(() => SugarCube.Engine.show())", portable)
    passage.locator(".spike-widget").wait_for()
    browser.close()
    print("Published runtime, package assets, isolation, offline session and save slot passed.")
