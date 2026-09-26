#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter and actions the way Alfred does and validate the JSON.

Every test points the workflow at its own temporary folder; the real ~/Downloads is never touched,
and "Move to Trash" is redirected to a temporary folder (DL_TEST_TRASH_DIR).
"""
import json, os, plistlib, shutil, subprocess, sys, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PASTEBOARD = "io.github.x-o-r-r-o.downloads.test"


def run_js(args, **env):
    e = {k: v for k, v in os.environ.items() if k not in ("show_hidden", "include_subfolders", "sort_by", "downloads_folder")}
    e.update(DL_TEST_PASTEBOARD=PASTEBOARD, DL_TEST_DRYRUN="1", alfred_workflow_cache=tempfile.gettempdir())
    e.update({k: str(v) for k, v in env.items()})
    out = subprocess.run(["osascript", "-l", "JavaScript", "./downloads.js", *args], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout.rstrip("\n")


def sf(folder, query="", **env):
    data = json.loads(run_js(["list", query], downloads_folder=folder, **env))
    validate(data)
    return data


def items(folder, query="", **env):
    return sf(folder, query, **env)["items"]


def files(folder, query="", **env):
    return [i for i in items(folder, query, **env) if i.get("type") == "file" and not i["title"].startswith("Open ")]


def titles(folder, query="", **env):
    return [i["title"] for i in files(folder, query, **env)]


def action(path, act, folder, **env):
    return run_js(["action", path], downloads_folder=folder, dl_action=act, **env)


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert "\n" not in it["title"] and "\n" not in it.get("subtitle", ""), it
        icon = it.get("icon")
        if icon and icon.get("type") != "fileicon":
            assert os.path.exists(os.path.join(SRC, icon["path"])), icon
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m


def touch(path, data=b"", mtime=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    time.sleep(0.002)  # distinct "date added" for every file
    return path


def read_pasteboard(kind):
    script = """
ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  if (argv[1] === 'url') { const u = $.NSURL.URLFromPasteboard(pb); return u.isNil() ? '' : u.path.js; }
  const s = pb.stringForType($.NSPasteboardTypeString); return s.isNil() ? '' : s.js;
}"""
    return subprocess.run(["osascript", "-l", "JavaScript", "-e", script, PASTEBOARD, kind],
                          capture_output=True, text=True).stdout.rstrip("\n")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dl-test-")
        self.dir = os.path.join(self.tmp, "Downloads")
        os.makedirs(self.dir)

    def tearDown(self):
        subprocess.run(["chmod", "-R", "u+rwx", self.tmp])
        shutil.rmtree(self.tmp, ignore_errors=True)

    def p(self, *parts):
        return os.path.join(self.dir, *parts)


class OrderTests(Base):
    def test_sorted_by_date_added_not_modified(self):
        touch(self.p("first.txt"))
        touch(self.p("second.txt"))
        touch(self.p("old-server-date.zip"), mtime=978307200)  # downloaded last, but modified in 2001
        self.assertEqual(titles(self.dir), ["old-server-date.zip", "second.txt", "first.txt"])
        self.assertEqual(titles(self.dir, sort_by="modified")[-1], "old-server-date.zip")

    def test_rename_into_folder_counts_as_added(self):
        outside = os.path.join(self.tmp, "moved.pdf")
        touch(outside)
        touch(self.p("a.txt"))
        os.rename(outside, self.p("moved.pdf"))
        self.assertEqual(titles(self.dir)[0], "moved.pdf")

    def test_item_shape(self):
        f = touch(self.p("report.pdf"), b"x" * 2500)
        it = files(self.dir)[0]
        real = it["arg"]
        self.assertTrue(os.path.samefile(real, f))
        self.assertEqual(it["type"], "file")
        self.assertEqual(it["icon"], {"type": "fileicon", "path": real})
        self.assertEqual(it["quicklookurl"], real)
        self.assertEqual(it["text"]["copy"], real)
        self.assertTrue(it["subtitle"].startswith("3 KB · just now"), it["subtitle"])
        self.assertEqual(it["variables"]["dl_action"], "open")
        acts = {k: (m["variables"]["dl_action"], m["arg"]) for k, m in it["mods"].items()}
        self.assertEqual(acts, {"cmd": ("reveal", real), "alt": ("trash", real), "ctrl": ("copy", real),
                                "fn": ("paste", real), "cmd+alt": ("copyurl", real)})
        data = sf(self.dir, "rep")
        self.assertTrue(data["skipknowledge"])
        self.assertEqual(data["variables"]["dl_query"], "rep")
        self.assertNotIn("rerun", data)

    def test_folder_row_last_and_not_trashable(self):
        touch(self.p("a.txt"))
        last = items(self.dir)[-1]
        self.assertEqual(last["title"], "Open Downloads Folder")
        self.assertTrue(os.path.samefile(last["arg"], self.dir))
        self.assertFalse(last["mods"]["alt"]["valid"])

    def test_sizes(self):
        touch(self.p("one.bin"), b"x")
        touch(self.p("mb.bin"), b"x" * 1_250_000)
        subs = {i["title"]: i["subtitle"] for i in files(self.dir)}
        self.assertTrue(subs["one.bin"].startswith("1 byte ·"))
        self.assertTrue(subs["mb.bin"].startswith("1.3 MB ·"))


class NameTests(Base):
    def test_unicode_quotes_newlines_emoji(self):
        weird = 'we"ird \'q\' café 🎉\nline $(echo hi) `x`.txt'
        f = touch(self.p(weird), b"hi")
        it = files(self.dir)[0]
        self.assertEqual(it["title"], 'we"ird \'q\' café 🎉 line $(echo hi) `x`.txt')
        self.assertEqual(os.path.basename(it["arg"]), weird)
        self.assertEqual(titles(self.dir, "cafe"), [it["title"]])  # accents ignored
        self.assertEqual(titles(self.dir, "CAFÉ 🎉"), [it["title"]])
        # the action receives the exact path as argv
        self.assertEqual(action(it["arg"], "open", self.dir), f"open {it['arg']}")
        self.assertTrue(os.path.samefile(it["arg"], f))

    def test_decomposed_unicode_name(self):
        touch(self.p("Café menu.pdf"))
        self.assertEqual(len(titles(self.dir, "café")), 1)
        self.assertEqual(len(titles(self.dir, "cafe menu")), 1)

    def test_fuzzy_and_ranking(self):
        touch(self.p("invoice-march.pdf"))
        touch(self.p("my invoice.pdf"))
        touch(self.p("xinvoicex.pdf"))
        touch(self.p("i-n-v.txt"))
        t = titles(self.dir, "invoice")
        self.assertEqual(t[:2], ["my invoice.pdf", "invoice-march.pdf"])  # word starts, newest first
        self.assertEqual(t[2], "xinvoicex.pdf")
        self.assertIn("i-n-v.txt", titles(self.dir, "inv"))
        self.assertEqual(titles(self.dir, "imp"), ["invoice-march.pdf"])  # letters in order
        self.assertEqual(titles(self.dir, "march invoice"), ["invoice-march.pdf"])

    def test_no_match(self):
        touch(self.p("a.txt"))
        it = items(self.dir, "zzzz")
        self.assertEqual(it[0]["title"], "No matching downloads")
        self.assertEqual(it[-1]["title"], "Open Downloads Folder")


class FilterTests(Base):
    def setUp(self):
        super().setUp()
        for n in ["cat.JPG", "doc.pdf", "notes.docx", "a.zip", "b.tar.gz", "setup.dmg", "movie.mkv", "song.flac"]:
            touch(self.p(n))
        os.makedirs(self.p("Tool.app", "Contents"))
        os.makedirs(self.p("plain folder"))

    def test_type_filters(self):
        self.assertEqual(titles(self.dir, "img"), ["cat.JPG"])
        self.assertEqual(titles(self.dir, "pdf"), ["doc.pdf"])
        self.assertEqual(set(titles(self.dir, "doc")), {"doc.pdf", "notes.docx"})
        self.assertEqual(set(titles(self.dir, "zip")), {"a.zip", "b.tar.gz"})
        self.assertEqual(set(titles(self.dir, "dmg")), {"setup.dmg", "Tool.app"})
        self.assertEqual(titles(self.dir, "video"), ["movie.mkv"])
        self.assertEqual(titles(self.dir, "Audio"), ["song.flac"])
        self.assertEqual(titles(self.dir, "folder"), ["plain folder"])

    def test_filter_plus_search_and_combined(self):
        self.assertEqual(titles(self.dir, "zip b"), ["b.tar.gz"])
        self.assertEqual(titles(self.dir, "img today"), ["cat.JPG"])
        self.assertEqual(titles(self.dir, "img yesterday"), [])
        self.assertEqual(items(self.dir, "pdf nothing")[0]["title"], "No matching downloads")

    def test_time_filters(self):
        old = self.p("old.txt")
        touch(old, mtime=time.time() - 3 * 86400)
        t = titles(self.dir, "week", sort_by="modified")
        self.assertIn("old.txt", t)
        self.assertNotIn("old.txt", titles(self.dir, "today", sort_by="modified"))
        touch(self.p("ancient.txt"), mtime=time.time() - 90 * 86400)
        self.assertNotIn("ancient.txt", titles(self.dir, "month", sort_by="modified"))
        sub = {i["title"]: i["subtitle"] for i in files(self.dir, sort_by="modified")}
        self.assertIn("3 days ago", sub["old.txt"])

    def test_package_is_a_file_and_not_descended(self):
        touch(self.p("Tool.app", "Contents", "Info.plist"))
        t = titles(self.dir, "", include_subfolders="1")
        self.assertIn("Tool.app", t)
        self.assertNotIn("Info.plist", t)
        sub = {i["title"]: i["subtitle"] for i in files(self.dir)}
        self.assertTrue(sub["Tool.app"].startswith("Application ·"))
        self.assertTrue(sub["plain folder"].startswith("Folder ·"))


class LatestTests(Base):
    def test_latest_skips_unfinished(self):
        touch(self.p("done.pdf"))
        touch(self.p("big.iso.crdownload"), b"x" * 10)
        touch(self.p(".cloud.pdf.icloud"))
        it = items(self.dir, "latest")
        self.assertEqual([i["title"] for i in it], ["done.pdf", "Open Downloads Folder"])
        self.assertEqual(titles(self.dir, "latest pdf"), ["done.pdf"])

    def test_latest_empty(self):
        self.assertEqual(items(self.dir, "latest")[0]["title"], "The folder is empty")
        touch(self.p("x.part"))
        self.assertEqual(items(self.dir, "latest")[0]["title"], "No finished downloads")


class PartialTests(Base):
    def test_in_progress_downloads(self):
        touch(self.p("movie.mp4.crdownload"), b"x" * 5000)
        touch(self.p("file.zip"))  # Firefox's empty placeholder
        touch(self.p("file.zip.part"), b"x" * 10)
        os.makedirs(self.p("page.pdf.download"))
        data = sf(self.dir)
        its = {i["title"]: i for i in data["items"] if i.get("type") == "file"}
        self.assertEqual(data.get("rerun"), 1)
        self.assertNotIn("file.zip.part", its)
        self.assertEqual(sum(1 for i in data["items"] if i["title"] == "file.zip"), 1)
        self.assertTrue(its["movie.mp4"]["subtitle"].startswith("Downloading… 5 KB so far"))
        self.assertTrue(its["file.zip"]["subtitle"].startswith("Downloading…"))
        self.assertTrue(its["page.pdf"]["subtitle"].startswith("Downloading…"))
        self.assertEqual(its["movie.mp4"]["variables"]["dl_action"], "reveal")
        self.assertIn("movie.mp4", titles(self.dir, "video"))
        # ↩ reveals instead of opening a half-finished file
        self.assertEqual(action(its["movie.mp4"]["arg"], "open", self.dir), f"reveal {its['movie.mp4']['arg']}")


class HiddenAndICloudTests(Base):
    def test_hidden_files(self):
        touch(self.p(".secret"))
        touch(self.p(".DS_Store"))
        f = touch(self.p("flagged.txt"))
        subprocess.run(["chflags", "hidden", f], check=True)
        touch(self.p("visible.txt"))
        self.assertEqual(titles(self.dir), ["visible.txt"])
        t = titles(self.dir, show_hidden="1")
        self.assertEqual(set(t), {"visible.txt", ".secret", "flagged.txt"})

    def test_icloud_placeholder(self):
        ph = touch(self.p(".Report 2024.pdf.icloud"))
        it = files(self.dir)
        self.assertEqual(it[0]["title"], "Report 2024.pdf")
        self.assertTrue(it[0]["subtitle"].startswith("In iCloud"))
        self.assertNotIn("quicklookurl", it[0])
        self.assertEqual(titles(self.dir, "pdf"), ["Report 2024.pdf"])
        real = os.path.join(os.path.dirname(it[0]["arg"]), "Report 2024.pdf")
        self.assertEqual(action(it[0]["arg"], "open", self.dir), f"icloud {real}")
        # when the real file exists too, only the file is listed
        touch(self.p("Report 2024.pdf"))
        self.assertEqual(titles(self.dir), ["Report 2024.pdf"])


class SubfolderTests(Base):
    def test_subfolders(self):
        touch(self.p("top.txt"))
        touch(self.p("Unzipped", "inner.txt"))
        touch(self.p("Unzipped", ".hidden-dir", "secret.txt"))
        self.assertNotIn("inner.txt", titles(self.dir))
        its = {i["title"]: i for i in files(self.dir, include_subfolders="1")}
        self.assertIn("inner.txt", its)
        self.assertIn("in Unzipped", its["inner.txt"]["subtitle"])
        self.assertNotIn("secret.txt", its)
        self.assertEqual(titles(self.dir, "unzipped inner", include_subfolders="1"), ["inner.txt"])

    def test_symlink_loop_and_depth(self):
        os.makedirs(self.p("a"))
        os.symlink(self.dir, self.p("a", "loop"))
        deep = self.p("1", "2", "3", "4", "5", "6")
        touch(os.path.join(deep, "deep.txt"))
        touch(self.p("1", "2", "shallow.txt"))
        t = titles(self.dir, include_subfolders="1")
        self.assertIn("loop", t)
        self.assertIn("shallow.txt", t)
        self.assertNotIn("deep.txt", t)


class LinkTests(Base):
    def test_symlinks(self):
        target = touch(self.p("real.txt"), b"abc")
        os.symlink(target, self.p("good link"))
        os.symlink(self.p("missing"), self.p("broken link"))
        sub = {i["title"]: i["subtitle"] for i in files(self.dir)}
        self.assertTrue(sub["good link"].startswith("Link → "), sub)
        self.assertTrue(sub["broken link"].startswith("Broken link → "), sub)
        # a broken link can still be trashed (the link, never its target)
        trash = os.path.join(self.tmp, "Trash")
        os.makedirs(trash)
        out = action(self.p("good link"), "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertIn("Moved “good link” to the Trash", out)
        self.assertTrue(os.path.exists(target))
        out = action(self.p("broken link"), "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertIn("Moved", out)


class FolderStateTests(Base):
    def test_empty_folder(self):
        it = items(self.dir)
        self.assertEqual([i["title"] for i in it], ["The folder is empty", "Open Downloads Folder"])

    def test_missing_folder(self):
        it = items(os.path.join(self.tmp, "nope"))
        self.assertEqual(len(it), 1)
        self.assertEqual(it[0]["title"], "Downloads folder not found")
        self.assertEqual(it[0]["variables"]["dl_action"], "configure")
        self.assertEqual(action("configure", "configure", self.dir), "configure")

    def test_folder_is_a_file(self):
        f = touch(os.path.join(self.tmp, "file.txt"))
        self.assertEqual(items(f)[0]["title"], "Not a folder")

    def test_unreadable_folder(self):
        touch(self.p("a.txt"))
        os.chmod(self.dir, 0)
        it = items(self.dir)
        self.assertEqual(it[0]["title"], "You don’t have permission to read this folder")
        self.assertFalse(it[0]["valid"])
        self.assertEqual(it[-1]["title"], "Open Downloads Folder")
        self.assertEqual(action("privacy", "privacy", self.dir), "privacy")

    def test_unreadable_subfolder_is_skipped(self):
        touch(self.p("a.txt"))
        touch(self.p("locked", "b.txt"))
        os.chmod(self.p("locked"), 0)
        t = titles(self.dir, include_subfolders="1")
        self.assertIn("a.txt", t)
        self.assertIn("locked", t)

    def test_tilde_and_trailing_slash(self):
        home = os.path.expanduser("~")
        tmp = tempfile.mkdtemp(prefix="dl-home-", dir=home) if os.access(home, os.W_OK) else None
        if not tmp:
            self.skipTest("home not writable")
        try:
            touch(os.path.join(tmp, "x.txt"))
            rel = "~/" + os.path.basename(tmp) + "/"
            self.assertEqual(titles(rel), ["x.txt"])
            self.assertEqual(titles(os.path.basename(tmp)), ["x.txt"])  # relative to home
        finally:
            shutil.rmtree(tmp)

    def test_folder_row_name(self):
        other = os.path.join(self.tmp, "Inbox")
        os.makedirs(other)
        self.assertEqual(items(other)[-1]["title"], "Open Inbox Folder")


class SourceTests(Base):
    def test_where_from(self):
        f = touch(self.p("tool.zip"))
        data = plistlib.dumps(["https://www.example.com/dl/tool.zip", "https://example.com/"], fmt=plistlib.FMT_BINARY)
        subprocess.run(["xattr", "-wx", "com.apple.metadata:kMDItemWhereFroms", data.hex(), f], check=True)
        self.assertIn("from example.com", files(self.dir)[0]["subtitle"])
        self.assertEqual(action(f, "copyurl", self.dir), "Copied https://www.example.com/dl/tool.zip")
        self.assertEqual(read_pasteboard("string"), "https://www.example.com/dl/tool.zip")
        g = touch(self.p("plain.txt"))
        self.assertEqual(action(g, "copyurl", self.dir), "No download address recorded for “plain.txt”")

    def test_garbage_where_from(self):
        f = touch(self.p("odd.zip"))
        subprocess.run(["xattr", "-w", "com.apple.metadata:kMDItemWhereFroms", "not a plist", f], check=True)
        self.assertNotIn("from", files(self.dir)[0]["subtitle"])


class ActionTests(Base):
    def test_open_reveal(self):
        f = touch(self.p("a b.txt"))
        self.assertEqual(action(f, "open", self.dir), f"open {f}")
        self.assertEqual(action(f, "reveal", self.dir), f"reveal {f}")
        self.assertEqual(action(self.p("gone.txt"), "open", self.dir), "“gone.txt” no longer exists")
        self.assertEqual(action(f, "bogus", self.dir), "Unknown action: bogus")

    def test_copy_file_to_clipboard(self):
        f = touch(self.p("photo 🎉.png"), b"png")
        self.assertEqual(action(f, "copy", self.dir), "Copied “photo 🎉.png” to the clipboard")
        self.assertTrue(os.path.samefile(read_pasteboard("url"), f))
        self.assertEqual(action(f, "paste", self.dir), f"paste {f}")

    def test_trash_only_inside_folder(self):
        trash = os.path.join(self.tmp, "Trash")
        os.makedirs(trash)
        f = touch(self.p("junk.dmg"))
        out = action(f, "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertEqual(out, "Moved “junk.dmg” to the Trash")
        self.assertFalse(os.path.exists(f))
        self.assertTrue(os.path.exists(os.path.join(trash, "junk.dmg")))
        outside = touch(os.path.join(self.tmp, "keep.txt"))
        out = action(outside, "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertTrue(out.startswith("Not moved"), out)
        self.assertTrue(os.path.exists(outside))
        out = action(self.p("..", "keep.txt"), "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertTrue(out.startswith("Not moved"), out)
        out = action(self.dir, "trash", self.dir, DL_TEST_TRASH_DIR=trash)
        self.assertTrue(out.startswith("Not moved"), out)
        self.assertTrue(os.path.isdir(self.dir))
        # a sibling folder whose name starts with the Downloads folder's name
        sib = touch(os.path.join(self.tmp, "Downloads2", "x.txt"))
        self.assertTrue(action(sib, "trash", self.dir, DL_TEST_TRASH_DIR=trash).startswith("Not moved"))

    def test_trash_in_subfolder(self):
        trash = os.path.join(self.tmp, "Trash")
        os.makedirs(trash)
        f = touch(self.p("sub", "x.txt"))
        self.assertTrue(action(f, "trash", self.dir, DL_TEST_TRASH_DIR=trash).startswith("Moved"))

    def test_trash_through_symlinked_folder(self):
        trash = os.path.join(self.tmp, "Trash")
        os.makedirs(trash)
        link = os.path.join(self.tmp, "DL link")
        os.symlink(self.dir, link)
        f = touch(self.p("y.txt"))
        it = files(link)[0]
        self.assertTrue(action(it["arg"], "trash", link, DL_TEST_TRASH_DIR=trash).startswith("Moved"))
        self.assertFalse(os.path.exists(f))


class AuditPass1Tests(Base):
    """Regressions for bugs found in the first audit."""

    def test_trash_refuses_dot_components(self):
        trash = os.path.join(self.tmp, "Trash")
        os.makedirs(trash)
        os.makedirs(self.p("sub"))
        for bad in (self.p("sub", ".."), self.p("."), self.p("sub", "..", "sub")):
            out = action(bad, "trash", self.dir, DL_TEST_TRASH_DIR=trash)
            self.assertTrue(out.startswith("Not moved"), (bad, out))
        self.assertTrue(os.path.isdir(self.p("sub")))

    def test_latest_with_search_is_newest_match(self):
        touch(self.p("invoice-a.pdf"))
        touch(self.p("xinvoice.pdf"))
        self.assertEqual(titles(self.dir, "latest invoice"), ["xinvoice.pdf"])

    def test_size_rounds_up_to_next_unit(self):
        touch(self.p("a.bin"), b"x" * 999_999)
        touch(self.p("b.bin"), b"x" * 1000)
        sub = {i["title"]: i["subtitle"] for i in files(self.dir)}
        self.assertTrue(sub["a.bin"].startswith("1 MB ·"), sub)
        self.assertTrue(sub["b.bin"].startswith("1 KB ·"), sub)

    def test_control_characters_in_names(self):
        touch(self.p("a\tb\x01c\u2028d.txt"))
        self.assertEqual(titles(self.dir), ["a b c d.txt"])

    def test_checkbox_true_false_values(self):
        touch(self.p(".h"))
        self.assertEqual(titles(self.dir, show_hidden="true"), [".h"])
        self.assertEqual(titles(self.dir, show_hidden="false"), [])

    def test_tilde_with_user_name(self):
        import getpass
        home = os.path.expanduser("~")
        if not os.access(home, os.W_OK):
            self.skipTest("home not writable")
        tmp = tempfile.mkdtemp(prefix="dl-home-", dir=home)
        try:
            touch(os.path.join(tmp, "x.txt"))
            self.assertEqual(titles(f"~{getpass.getuser()}/{os.path.basename(tmp)}"), ["x.txt"])
        finally:
            shutil.rmtree(tmp)

    def test_word_start_in_non_latin_names(self):
        touch(self.p("мир.txt"))
        touch(self.p("приветмир.txt"))
        self.assertEqual(titles(self.dir, "мир"), ["мир.txt", "приветмир.txt"])

    def test_days_ago_at_midnight(self):
        import datetime
        midnight = datetime.datetime.combine(datetime.date.today() - datetime.timedelta(days=6), datetime.time())
        touch(self.p("six.txt"), mtime=midnight.timestamp())
        self.assertIn("6 days ago", files(self.dir, sort_by="modified")[0]["subtitle"])

    def test_query_travels_with_trash_modifier(self):
        touch(self.p("a.txt"))
        it = files(self.dir, "latest")[0]
        self.assertEqual(it["mods"]["alt"]["variables"]["dl_query"], "latest")


class AuditPass2Tests(Base):
    """Regressions for bugs found in the second audit."""

    def test_home_is_only_abbreviated_as_a_prefix(self):
        home = os.path.expanduser("~")
        target = f"/nonexistent{home}/file.txt"
        os.symlink(target, self.p("odd link"))
        sub = files(self.dir)[0]["subtitle"]
        self.assertIn(f"Broken link → {target}", sub)

    def test_overflow_row_wording_when_searching(self):
        for i in range(105):
            open(self.p(f"report {i}.txt"), "wb").close()
        self.assertTrue(items(self.dir)[-2]["title"].startswith("Showing the newest 100 of 105"))
        self.assertTrue(items(self.dir, "report")[-2]["title"].startswith("Showing the best 100 of 105"))

    def test_folder_without_search_permission(self):
        touch(self.p("a.txt"))
        os.chmod(self.dir, 0o444)  # readable but not searchable: not a privacy problem
        it = items(self.dir)
        self.assertEqual(it[0]["title"], "You don’t have permission to read this folder")

    def test_blob_download_address(self):
        f = touch(self.p("export.csv"))
        data = plistlib.dumps(["blob:https://app.example.org/1234-abcd"], fmt=plistlib.FMT_BINARY)
        subprocess.run(["xattr", "-wx", "com.apple.metadata:kMDItemWhereFroms", data.hex(), f], check=True)
        self.assertIn("from app.example.org", files(self.dir)[0]["subtitle"])

    def test_subfolder_mode_performance(self):
        for d in range(50):
            sub = self.p(f"Folder {d} (2026) [1080p] [5.1]")
            os.makedirs(sub)
            for i in range(200):
                open(os.path.join(sub, f"f{i}.txt"), "wb").close()
        sf(self.dir, include_subfolders="1")
        t = time.perf_counter()
        data = sf(self.dir, include_subfolders="1")
        elapsed = time.perf_counter() - t
        print(f"\n  50 folders x 200 files with subfolders: {elapsed * 1000:.0f} ms", file=sys.stderr)
        self.assertLess(elapsed, 0.3)
        self.assertTrue(data["items"][-2]["title"].startswith("Showing the newest 100 of 10,050"))


class PerformanceTests(Base):
    def test_ten_thousand_files(self):
        for i in range(10000):
            open(os.path.join(self.dir, f"file {i:05}.txt"), "wb").close()
        sf(self.dir)  # warm up
        best = min(self._time(lambda: sf(self.dir)) for _ in range(3))
        search = min(self._time(lambda: sf(self.dir, "file 99")) for _ in range(3))
        print(f"\n  10,000 files: list {best * 1000:.0f} ms, search {search * 1000:.0f} ms", file=sys.stderr)
        self.assertLess(best, 0.3)
        self.assertLess(search, 0.3)
        data = sf(self.dir)
        its = data["items"]
        self.assertEqual(sum(1 for i in its if i.get("type") == "file"), 101)  # 100 files + folder row
        self.assertEqual(its[0]["title"], "file 09999.txt")
        self.assertTrue(its[-2]["title"].startswith("Showing the newest 100 of 10,000"))
        self.assertLess(len(json.dumps(data)), 250_000)

    def _time(self, fn):
        t = time.perf_counter()
        fn()
        return time.perf_counter() - t

    def test_fallback_scanner_matches(self):
        touch(self.p("a é.txt"), b"12")
        touch(self.p(".hid"))
        os.makedirs(self.p("d"))
        touch(self.p("z.zip"), mtime=978307200)
        fast = [(i["title"], i["subtitle"]) for i in files(self.dir, show_hidden="1")]
        slow = [(i["title"], i["subtitle"]) for i in files(self.dir, show_hidden="1", DL_TEST_NO_BULK="1")]
        self.assertEqual(fast, slow)


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.downloads")
        cfg = {c["variable"]: c for c in p["userconfigurationconfig"]}
        self.assertEqual(cfg["downloads_folder"]["type"], "filepicker")
        self.assertEqual(cfg["downloads_folder"]["config"]["filtermode"], 1)
        for v in ("show_hidden", "include_subfolders", "reopen_after_trash"):
            self.assertEqual(cfg[v]["type"], "checkbox")
        # every modifier used in the Script Filter JSON has a connection
        sf_uid = next(o["uid"] for o in p["objects"] if o["type"] == "alfred.workflow.input.scriptfilter")
        mods = {c["modifiers"] for c in p["connections"][sf_uid]}
        self.assertEqual(mods, {0, 1048576, 524288, 262144, 8388608, 1572864})
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)


if __name__ == "__main__":
    unittest.main(verbosity=1)
