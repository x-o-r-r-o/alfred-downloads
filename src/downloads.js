#!/usr/bin/osascript -l JavaScript
// Downloads for Alfred: list the Downloads folder newest first and act on files.
// Usage: osascript -l JavaScript downloads.js list [query]
//        osascript -l JavaScript downloads.js action <path>   (the action comes from $dl_action)
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
const HOME = $.NSHomeDirectory().js;

const MAX_ITEMS = 100; // rows sent to Alfred
const MAX_ENTRIES = 20000; // stop scanning subfolders after this many entries
const MAX_DEPTH = 4; // subfolder levels below the Downloads folder
const SOURCE_LOOKUPS = 25; // rows that show the website a file came from

// ---------- configuration ----------

function expandPath(raw) {
  let p = String(raw || "").trim();
  if (!p) p = "~/Downloads";
  if (p.startsWith("~")) p = $(p).stringByExpandingTildeInPath.js;
  if (!p.startsWith("/")) p = HOME + "/" + p;
  p = $(p).stringByStandardizingPath.js;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function flag(name, fallback) {
  const v = String(env(name, fallback ? "1" : "0")).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function config() {
  return {
    folder: expandPath(env("downloads_folder", "")),
    hidden: flag("show_hidden", false),
    subfolders: flag("include_subfolders", false),
    sortBy: { added: "added", modified: "modified", created: "created" }[env("sort_by", "added")] || "added",
    keyword: env("keyword_dls", "dls"),
    reopen: flag("reopen_after_trash", true),
  };
}

// ---------- file kinds ----------

const KINDS = {
  image: "png jpg jpeg jpe gif webp heic heif avif bmp tif tiff svg ico icns psd ai eps raw cr2 cr3 nef arw dng orf rw2 jxl",
  pdf: "pdf",
  archive: "zip rar 7z tar gz tgz bz2 tbz tbz2 xz txz zst lz lzma lz4 z cab sit sitx arj cpio",
  installer: "dmg pkg mpkg app iso xip img sparseimage sparsebundle toast",
  video: "mp4 m4v mov mkv avi webm wmv flv mpg mpeg m2ts mts 3gp ogv vob",
  audio: "mp3 m4a m4b aac wav flac aif aiff aifc ogg oga opus wma alac mid midi caf amr",
  doc: "pdf doc docx dot dotx pages rtf rtfd txt md markdown odt xls xlsx xlsm numbers csv tsv ppt pptx key odp ods epub mobi azw3 tex log json xml html htm",
};
const EXT_KIND = {};
for (const [kind, list] of Object.entries(KINDS)) {
  for (const ext of list.split(" ")) (EXT_KIND[ext] = EXT_KIND[ext] || []).push(kind);
}

// Words typed after the keyword that filter instead of search
const FILTERS = {
  img: "image", image: "image", images: "image", pic: "image", pics: "image", photo: "image", photos: "image",
  pdf: "pdf", pdfs: "pdf",
  zip: "archive", zips: "archive", archive: "archive", archives: "archive",
  dmg: "installer", dmgs: "installer", pkg: "installer", app: "installer", apps: "installer", installer: "installer", installers: "installer",
  video: "video", videos: "video", movie: "video", movies: "video",
  audio: "audio", music: "audio", sound: "audio", sounds: "audio",
  doc: "doc", docs: "doc", document: "doc", documents: "doc",
  folder: "folder", folders: "folder", dir: "folder",
  today: "@today", yesterday: "@yesterday", week: "@week", month: "@month",
  latest: "@latest", last: "@latest",
};

// Directories that behave like files
const PACKAGE_EXT = new Set(
  ("app bundle framework plugin kext pkg mpkg rtfd pages numbers key download photoslibrary xcodeproj xcworkspace " +
    "playground scptd workflow fcpbundle logicx band component qlgenerator prefpane saver xpc appex dsym docarchive " +
    "imovielibrary musiclibrary sparsebundle mdimporter wdgt").split(" ")
);

// In-progress downloads: Chrome/Edge/Brave, Firefox, Safari, Opera, qBittorrent
const PARTIAL_RE = /\.(crdownload|part|download|partial|opdownload|!qb)$/i;

function extOf(name) {
  const m = name.match(/\.([^.\/]+)$/);
  return m && m.index > 0 ? m[1].toLowerCase() : "";
}

function kindsOf(e) {
  if (e.dir && !e.pkg) return ["folder"];
  return EXT_KIND[extOf(e.display)] || [];
}

// ---------- scanning ----------
// getattrlistbulk(2) reads names, types, dates, flags and sizes for a whole directory in a few
// system calls (about 40 ms for 10,000 files). The NSFileManager fallback is much slower in JXA.

let BULK = null;
function bulkAvailable() {
  if (BULK === null) {
    try {
      ObjC.bindFunction("open", ["int", ["char *", "int"]]);
      ObjC.bindFunction("close", ["int", ["int"]]);
      ObjC.bindFunction("getattrlistbulk", ["int", ["int", "void *", "void *", "unsigned long", "unsigned long long"]]);
      BULK = env("DL_TEST_NO_BULK", "") !== "1";
    } catch (e) {
      BULK = false;
    }
  }
  return BULK;
}

const A_RETURNED = 0x80000000, A_ERROR = 0x20000000, A_NAME = 0x1, A_TYPE = 0x8, A_CRTIME = 0x200,
  A_MODTIME = 0x400, A_CHGTIME = 0x800, A_FLAGS = 0x40000, A_ADDED = 0x10000000, F_DATALENGTH = 0x200;
const UF_HIDDEN = 0x8000, SF_DATALESS = 0x40000000;
const VDIR = 2, VLNK = 5;

function latin1Data(bytes) {
  return $(String.fromCharCode(...bytes)).dataUsingEncoding($.NSISOLatin1StringEncoding);
}
function u32bytes(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}
let ATTRLIST = null;
function attrList() {
  if (!ATTRLIST) {
    const common = A_RETURNED | A_ERROR | A_NAME | A_TYPE | A_CRTIME | A_MODTIME | A_CHGTIME | A_FLAGS | A_ADDED;
    ATTRLIST = latin1Data([5, 0, 0, 0, ...u32bytes(common), ...u32bytes(0), ...u32bytes(0), ...u32bytes(F_DATALENGTH), ...u32bytes(0)]).mutableCopy;
  }
  return ATTRLIST;
}

function decodeName(raw) {
  try {
    return decodeURIComponent(escape(raw));
  } catch (e) {
    return null; // not valid UTF-8
  }
}

// Returns an array of raw entries, or null when getattrlistbulk can't read the directory.
function bulkRead(dir) {
  const fd = $.open(dir, 0x100000 /* O_RDONLY | O_DIRECTORY */);
  if (fd < 0) return null;
  const size = 256 * 1024;
  const buf = $.NSMutableData.dataWithLength(size);
  const al = attrList();
  const out = [];
  try {
    for (;;) {
      const n = $.getattrlistbulk(fd, al.mutableBytes, buf.mutableBytes, size, 8 /* FSOPT_PACK_INVAL_ATTRS */);
      if (n < 0) return out.length ? out : null;
      if (n === 0) break;
      const s = $.NSString.alloc.initWithDataEncoding(buf, $.NSISOLatin1StringEncoding).js;
      const u32 = (o) => (s.charCodeAt(o) | (s.charCodeAt(o + 1) << 8) | (s.charCodeAt(o + 2) << 16)) + s.charCodeAt(o + 3) * 16777216;
      const i32 = (o) => u32(o) | 0;
      const time = (o) => u32(o) + i32(o + 4) * 4294967296 + u32(o + 8) / 1e9;
      let p = 0;
      for (let i = 0; i < n; i++) {
        const len = u32(p);
        if (!len) break;
        let o = p + 4;
        const retCommon = u32(o), retFile = u32(o + 12);
        o += 20;
        const err = u32(o);
        o += 4;
        const nameStart = o + i32(o), nameLen = u32(o + 4);
        o += 8;
        const name = decodeName(s.substr(nameStart, Math.max(0, nameLen - 1)));
        if (err || name === null || name === "." || name === "..") {
          p += len;
          continue;
        }
        const type = u32(o); o += 4;
        const created = time(o); o += 16;
        const modified = time(o); o += 16;
        const changed = time(o); o += 16;
        const flags = u32(o); o += 4;
        const added = retCommon & A_ADDED ? time(o) : 0;
        o += 16;
        const size = retFile & F_DATALENGTH ? u32(o) + u32(o + 4) * 4294967296 : 0;
        out.push({ name, type, created, modified, changed, flags, added: added > 0 ? added : changed, size });
        p += len;
      }
    }
  } finally {
    $.close(fd);
  }
  return out;
}

function nsTime(d) {
  return d && !d.isNil() ? d.timeIntervalSince1970 : 0;
}

// Slow but dependable: used when getattrlistbulk isn't available or fails for a directory.
function fmRead(dir) {
  const err = $(); // NSError out-parameter (Ref() crashes here)
  const keys = $([$.NSURLAddedToDirectoryDateKey, $.NSURLCreationDateKey, $.NSURLContentModificationDateKey,
    $.NSURLAttributeModificationDateKey, $.NSURLIsDirectoryKey, $.NSURLIsSymbolicLinkKey, $.NSURLFileSizeKey, $.NSURLIsHiddenKey]);
  const urls = FM.contentsOfDirectoryAtURLIncludingPropertiesForKeysOptionsError($.NSURL.fileURLWithPath(dir), keys, 0, err);
  if (urls.isNil()) return { error: err };
  const out = [];
  const n = urls.count;
  for (let i = 0; i < n; i++) {
    const u = urls.objectAtIndex(i);
    const v = u.resourceValuesForKeysError(keys, $());
    if (v.isNil()) continue;
    const get = (k) => v.objectForKey(k);
    const link = get($.NSURLIsSymbolicLinkKey);
    const isDir = get($.NSURLIsDirectoryKey);
    const hidden = get($.NSURLIsHiddenKey);
    const size = get($.NSURLFileSizeKey);
    const changed = nsTime(get($.NSURLAttributeModificationDateKey));
    const added = nsTime(get($.NSURLAddedToDirectoryDateKey));
    out.push({
      name: u.lastPathComponent.js,
      type: !link.isNil() && link.boolValue ? VLNK : !isDir.isNil() && isDir.boolValue ? VDIR : 1,
      created: nsTime(get($.NSURLCreationDateKey)),
      modified: nsTime(get($.NSURLContentModificationDateKey)),
      changed,
      flags: !hidden.isNil() && hidden.boolValue ? UF_HIDDEN : 0,
      added: added > 0 ? added : changed,
      size: size.isNil() ? 0 : Number(size.js),
    });
  }
  return out;
}

function readDir(dir) {
  if (bulkAvailable()) {
    const r = bulkRead(dir);
    if (r) return r;
  }
  return fmRead(dir);
}

const ALWAYS_SKIP = new Set([".DS_Store", ".localized", ".com.apple.timemachine.supported", ".Spotlight-V100", ".Trashes", ".fseventsd", "Icon\r"]);

function isPackage(path, name) {
  const ext = extOf(name);
  if (!ext) return false;
  if (PACKAGE_EXT.has(ext)) return true;
  if (/^\d+$/.test(ext)) return false; // "Photos 2.1" style folder names
  return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath(path);
}

// Walk the folder (and optionally its subfolders) and return display-ready entries.
function scan(cfg) {
  const entries = [];
  let truncated = false;
  const walk = (dir, rel, depth) => {
    const raw = readDir(dir);
    if (!Array.isArray(raw)) return raw.error;
    const names = new Set(raw.map((r) => r.name));
    for (const r of raw) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return null;
      }
      if (ALWAYS_SKIP.has(r.name)) continue;
      const path = `${dir}/${r.name}`;
      const e = {
        name: r.name, display: r.name, path, rel, added: r.added, created: r.created, modified: r.modified,
        size: r.size, dir: r.type === VDIR, link: r.type === VLNK, pkg: false,
        hidden: r.name.startsWith(".") || (r.flags & UF_HIDDEN) !== 0, dataless: (r.flags & SF_DATALESS) !== 0,
        icloud: false, partial: false,
      };
      // iCloud placeholder of an evicted file: ".Name.pdf.icloud"
      const ph = r.name.match(/^\.(.+)\.icloud$/);
      if (ph && !e.dir) {
        if (names.has(ph[1])) continue;
        e.display = ph[1];
        e.icloud = true;
        e.hidden = ph[1].startsWith(".");
      }
      if (PARTIAL_RE.test(r.name)) {
        e.partial = true;
        e.display = r.name.replace(PARTIAL_RE, "") || r.name;
      } else if (!e.dir && r.size === 0 && (names.has(r.name + ".part") || names.has(r.name + ".crdownload"))) {
        continue; // Firefox's empty placeholder next to the .part file
      }
      if (e.dir) e.pkg = isPackage(path, r.name) || e.partial;
      if (e.hidden && !cfg.hidden) continue;
      entries.push(e);
      if (cfg.subfolders && e.dir && !e.pkg && depth < MAX_DEPTH) {
        walk(path, rel ? `${rel}/${r.name}` : r.name, depth + 1);
      }
    }
    return null;
  };
  const error = walk(cfg.folder, "", 0);
  return { entries, error, truncated };
}

// ---------- matching and sorting ----------

function fold(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// 3: starts a word, 2: substring, 1: letters in order, 0: no match
function matchScore(hay, needle) {
  const i = hay.indexOf(needle);
  if (i === 0 || (i > 0 && /[^\p{L}\p{N}]/u.test(hay[i - 1]))) return 3;
  if (i > 0) return 2;
  let j = 0;
  for (let k = 0; k < hay.length && j < needle.length; k++) if (hay[k] === needle[j]) j++;
  return j === needle.length ? 1 : 0;
}

function parseQuery(query) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const filters = [];
  while (words.length && FILTERS[words[0].toLowerCase()]) filters.push(FILTERS[words.shift().toLowerCase()]);
  return { filters, words: words.map(fold) };
}

function startOfDay(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime() / 1000;
}

// Whole calendar days between t and today (safe across daylight saving changes)
function calendarDaysAgo(t) {
  const d = new Date(t * 1000);
  d.setHours(12, 0, 0, 0);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((today - d) / 86400000);
}

function applyFilters(entries, filters) {
  let out = entries;
  for (const f of filters) {
    if (f === "@today") out = out.filter((e) => e.sortTime >= startOfDay(0));
    else if (f === "@yesterday") out = out.filter((e) => e.sortTime >= startOfDay(1) && e.sortTime < startOfDay(0));
    else if (f === "@week") out = out.filter((e) => e.sortTime >= startOfDay(6));
    else if (f === "@month") out = out.filter((e) => e.sortTime >= startOfDay(30));
    else if (f !== "@latest") out = out.filter((e) => kindsOf(e).includes(f));
  }
  return out;
}

// ---------- formatting ----------

function formatSize(n) {
  if (n < 1000) return n === 1 ? "1 byte" : `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n, u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const digits = () => (u === 0 ? 0 : u === 1 ? 1 : 2);
  if (Number(v.toFixed(digits())) >= 1000 && u < units.length - 1) {
    v /= 1000; // 999,999 bytes is "1 MB", not "1000 KB"
    u++;
  }
  return `${v.toFixed(digits()).replace(/\.0+$/, "")} ${units[u]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function relativeTime(t, now) {
  const s = now - t;
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (t >= startOfDay(0)) return `${Math.floor(s / 3600)} h ago`;
  if (t >= startOfDay(1)) return "yesterday";
  if (t >= startOfDay(6)) return `${calendarDaysAgo(t)} days ago`;
  const d = new Date(t * 1000);
  const thisYear = new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === thisYear ? "" : " " + d.getFullYear()}`;
}

function oneLine(s) {
  return String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ");
}

// ---------- extended attributes: where a file was downloaded from ----------

let XATTR = null;
function whereFroms(path) {
  if (XATTR === null) {
    try {
      ObjC.bindFunction("getxattr", ["long", ["char *", "char *", "void *", "unsigned long", "unsigned int", "int"]]);
      XATTR = true;
    } catch (e) {
      XATTR = false;
    }
  }
  if (!XATTR) return [];
  const name = "com.apple.metadata:kMDItemWhereFroms";
  const len = $.getxattr(path, name, null, 0, 0, 1 /* XATTR_NOFOLLOW */);
  if (len <= 0 || len > 65536) return [];
  const data = $.NSMutableData.dataWithLength(len);
  if ($.getxattr(path, name, data.mutableBytes, len, 0, 1) !== len) return [];
  const plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
  if (plist.isNil() || !plist.isKindOfClass($.NSArray)) return [];
  const v = ObjC.deepUnwrap(plist);
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
}

function sourceHost(urls) {
  for (const u of urls) {
    const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]*@)?([^\/?#:]+)/i);
    if (m) return m[1].replace(/^www\./, "");
  }
  return "";
}

// ---------- Script Filter ----------

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}

function modsFor(e, path, query) {
  const m = (action, subtitle, valid = true) => ({ arg: path, valid, subtitle, variables: { dl_action: action, dl_query: query } });
  return {
    cmd: m("reveal", "Reveal in Finder"),
    alt: m("trash", "Move to Trash"),
    ctrl: m("copy", "Copy the file to the clipboard"),
    fn: m("paste", "Paste the file into the frontmost app"),
    "cmd+alt": m("copyurl", "Copy the address it was downloaded from"),
  };
}

function linkLabel(path) {
  const target = FM.destinationOfSymbolicLinkAtPathError(path, null);
  if (target.isNil()) return "Symbolic link";
  const broken = !FM.fileExistsAtPath(path);
  return `${broken ? "Broken link" : "Link"} → ${target.js.replace(HOME, "~")}`;
}

function fileItem(e, cfg, now, withSource) {
  const time = e.sortTime;
  const bits = [];
  let action = "open";
  if (e.partial) {
    bits.push(e.dir ? "Downloading…" : `Downloading… ${formatSize(e.size)} so far`);
    bits.push(`started ${relativeTime(time, now)}`);
    action = "reveal";
  } else if (e.icloud) {
    bits.push("In iCloud, not downloaded", relativeTime(time, now));
  } else {
    if (e.link) bits.push(linkLabel(e.path));
    else if (e.dir) bits.push(e.pkg ? (extOf(e.name) === "app" ? "Application" : "Package") : "Folder");
    else bits.push(formatSize(e.size));
    bits.push(relativeTime(time, now));
    if (e.dataless) bits.push("in iCloud");
  }
  if (e.rel) bits.push(`in ${e.rel}`);
  if (withSource && !e.dir && !e.link) {
    const host = sourceHost(whereFroms(e.path));
    if (host) bits.push(`from ${host}`);
  }
  const mods = modsFor(e, e.path, cfg.query);
  return {
    type: "file",
    title: oneLine(e.display),
    subtitle: oneLine(bits.join(" · ")),
    arg: e.path,
    icon: { type: "fileicon", path: e.path },
    quicklookurl: e.icloud ? undefined : e.path,
    text: { copy: e.path, largetype: e.display },
    variables: { dl_action: action },
    mods,
  };
}

function folderItem(cfg) {
  const name = cfg.folder === HOME + "/Downloads" ? "Downloads" : $(cfg.folder).lastPathComponent.js || cfg.folder;
  const m = (action, subtitle, valid = true) => ({ arg: cfg.folder, valid, subtitle, variables: { dl_action: action } });
  return {
    type: "file",
    title: `Open ${name} Folder`,
    subtitle: cfg.folder.replace(HOME, "~"),
    arg: cfg.folder,
    icon: { path: "icons/folder.png" },
    quicklookurl: cfg.folder,
    text: { copy: cfg.folder, largetype: cfg.folder },
    variables: { dl_action: "open" },
    mods: {
      cmd: m("reveal", "Reveal in Finder"),
      alt: m("none", "The folder itself can’t be moved to the Trash", false),
      ctrl: m("copy", "Copy the folder to the clipboard"),
      fn: m("paste", "Paste the folder into the frontmost app"),
      "cmd+alt": m("none", "No download address for a folder", false),
    },
  };
}

function folderProblem(cfg) {
  const isDir = Ref();
  const shown = cfg.folder.replace(HOME, "~");
  const configure = { valid: true, arg: "configure", variables: { dl_action: "configure" } };
  if (!FM.fileExistsAtPathIsDirectory(cfg.folder, isDir)) {
    return info("Downloads folder not found", `${shown} doesn't exist. ↩ Choose another folder in the Workflow’s Configuration`, "error", configure);
  }
  if (!isDir[0]) {
    return info("Not a folder", `${shown} is a file. ↩ Choose a folder in the Workflow’s Configuration`, "error", configure);
  }
  return null;
}

function permissionItem(cfg, error) {
  const detail = error && !error.isNil() && error.localizedDescription ? error.localizedDescription.js : "";
  if (!FM.isReadableFileAtPath(cfg.folder)) {
    // Plain Unix permissions: System Settings can't help
    return info("You don’t have permission to read this folder", detail || cfg.folder.replace(HOME, "~"), "lock");
  }
  // Readable by permissions but blocked: macOS privacy protection (TCC)
  return info(
    "Alfred can’t read the Downloads folder",
    `↩ Allow Alfred in Privacy & Security › Files and Folders${detail ? " · " + detail : ""}`,
    "lock",
    { valid: true, arg: "privacy", variables: { dl_action: "privacy" } }
  );
}

function listItems(query) {
  const cfg = config();
  cfg.query = query;
  const problem = folderProblem(cfg);
  if (problem) return { items: [problem] };
  const { entries, error, truncated } = scan(cfg);
  if (error) return { items: [permissionItem(cfg, error), folderItem(cfg)] };

  for (const e of entries) {
    e.sortTime = cfg.sortBy === "modified" ? e.modified : cfg.sortBy === "created" ? e.created || e.added : e.added;
  }
  const { filters, words } = parseQuery(query);
  let list = applyFilters(entries, filters);
  if (words.length) {
    const scored = [];
    for (const e of list) {
      const hay = fold(e.rel ? `${e.display} ${e.rel}` : e.display);
      const name = fold(e.display);
      let score = 0, ok = true;
      for (const w of words) {
        // the subfolder path counts, but less than the name and never as a loose match
        const inPath = hay === name ? 0 : matchScore(hay, w);
        const s = Math.max(matchScore(name, w), inPath > 1 ? inPath - 1 : 0);
        if (!s) {
          ok = false;
          break;
        }
        score += s;
      }
      if (ok) {
        e.score = score;
        scored.push(e);
      }
    }
    list = scored;
  }
  list.sort((a, b) => (b.score || 0) - (a.score || 0) || b.sortTime - a.sortTime || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
  if (filters.includes("@latest")) {
    // the most recent finished download among the matches, whatever the search score
    let best = null;
    for (const e of list) if (!e.partial && !e.icloud && (!best || e.sortTime > best.sortTime)) best = e;
    list = best ? [best] : [];
  }

  const now = Date.now() / 1000;
  const items = list.slice(0, MAX_ITEMS).map((e, i) => fileItem(e, cfg, now, i < SOURCE_LOOKUPS));
  if (!items.length) {
    if (!entries.length) items.push(info("The folder is empty", cfg.folder.replace(HOME, "~"), "empty"));
    else if (filters.includes("@latest")) items.push(info("No finished downloads", "Nothing matches in the folder", "empty"));
    else items.push(info("No matching downloads", `Nothing matches “${oneLine(query.trim())}”`, "empty"));
  }
  if (list.length > MAX_ITEMS) {
    items.push(info(`Showing the newest ${MAX_ITEMS} of ${list.length.toLocaleString("en-US")}`, "Type to search, or add a filter like img, pdf or zip", "info"));
  }
  if (truncated) items.push(info(`Showing the newest of the first ${MAX_ENTRIES.toLocaleString("en-US")} files`, "Turn off “Include subfolders” to see every file", "info"));
  items.push(folderItem(cfg));
  const out = { items, variables: { dl_query: query } };
  if (list.slice(0, MAX_ITEMS).some((e) => e.partial)) out.rerun = 1;
  return out;
}

// ---------- actions ----------

function inside(path, folder) {
  // Resolve symlinks in the folder and the parent directory, never in the item itself
  const last = $(path).lastPathComponent.js;
  if (!last || last === "." || last === ".." || /(^|\/)\.\.?(\/|$)/.test(path)) return false;
  const real = (p) => $(p).stringByResolvingSymlinksInPath.js;
  const parent = real($(path).stringByDeletingLastPathComponent.js);
  const full = `${parent}/${$(path).lastPathComponent.js}`;
  const base = real(folder);
  return full !== base && full.startsWith(base.endsWith("/") ? base : base + "/");
}

function exists(path) {
  // lstat semantics: a broken symlink still exists
  return !FM.attributesOfItemAtPathError(path, null).isNil();
}

function quoteName(path) {
  const name = $(path).lastPathComponent.js;
  const m = name.match(/^\.(.+)\.icloud$/);
  return `“${oneLine(m ? m[1] : name)}”`;
}

function pasteboard() {
  const name = env("DL_TEST_PASTEBOARD", "");
  return name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
}

function copyFile(path) {
  const pb = pasteboard();
  pb.clearContents;
  return pb.writeObjects($([$.NSURL.fileURLWithPath(path)]));
}

function trash(path, cfg) {
  if (!inside(path, cfg.folder)) return `Not moved: ${quoteName(path)} isn’t inside the Downloads folder`;
  const testDir = env("DL_TEST_TRASH_DIR", "");
  if (testDir) {
    const ok = FM.moveItemAtPathToPathError(path, `${testDir}/${$(path).lastPathComponent.js}`, null);
    return ok ? `Moved ${quoteName(path)} to the Trash` : `Couldn’t move ${quoteName(path)} to the Trash`;
  }
  const err = $();
  if (FM.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, err)) {
    return `Moved ${quoteName(path)} to the Trash`;
  }
  // Finder handles some File Provider locations (e.g. iCloud Drive) that NSFileManager refuses
  try {
    Application("Finder").delete(Path(path));
    if (!exists(path)) return `Moved ${quoteName(path)} to the Trash`;
  } catch (e) {}
  const why = !err.isNil() && err.localizedDescription ? ": " + err.localizedDescription.js : "";
  return `Couldn’t move ${quoteName(path)} to the Trash${why}`;
}

function reopenAlfred(cfg) {
  const query = env("dl_query", "");
  const alfred = Application("com.runningwithcrayons.Alfred");
  alfred.search(`${cfg.keyword} ${query}`);
}

function doAction(path) {
  const cfg = config();
  const action = env("dl_action", "open");
  const dry = env("DL_TEST_DRYRUN", "") === "1";
  const ws = $.NSWorkspace.sharedWorkspace;

  if (action === "configure") {
    if (dry) return "configure";
    Application("com.runningwithcrayons.Alfred").revealWorkflow(env("alfred_workflow_bundleid", "io.github.x-o-r-r-o.downloads"));
    return "";
  }
  if (action === "privacy") {
    if (dry) return "privacy";
    ws.openURL($.NSURL.URLWithString("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"));
    return "";
  }
  if (!path || !path.startsWith("/")) return "Nothing to do";
  if (!exists(path)) return `${quoteName(path)} no longer exists`;
  const url = $.NSURL.fileURLWithPath(path);
  const name = $(path).lastPathComponent.js;
  const placeholder = name.match(/^\.(.+)\.icloud$/);

  switch (action) {
    case "open": {
      if (placeholder) {
        const real = `${$(path).stringByDeletingLastPathComponent.js}/${placeholder[1]}`;
        if (dry) return `icloud ${real}`;
        FM.startDownloadingUbiquitousItemAtURLError($.NSURL.fileURLWithPath(real), null);
        ws.activateFileViewerSelectingURLs($([url]));
        return `Downloading ${quoteName(path)} from iCloud`;
      }
      if (PARTIAL_RE.test(name)) {
        if (dry) return `reveal ${path}`;
        ws.activateFileViewerSelectingURLs($([url]));
        return `${quoteName(path)} is still downloading`;
      }
      if (dry) return `open ${path}`;
      return ws.openURL(url) ? "" : `Couldn’t open ${quoteName(path)}`;
    }
    case "reveal":
      if (dry) return `reveal ${path}`;
      ws.activateFileViewerSelectingURLs($([url]));
      return "";
    case "trash": {
      const msg = trash(path, cfg);
      if (!dry && cfg.reopen && msg.startsWith("Moved")) reopenAlfred(cfg);
      return msg;
    }
    case "copy":
      return copyFile(path) ? `Copied ${quoteName(path)} to the clipboard` : `Couldn’t copy ${quoteName(path)}`;
    case "paste": {
      if (!copyFile(path)) return `Couldn’t copy ${quoteName(path)}`;
      if (dry) return `paste ${path}`;
      delay(0.25);
      Application("System Events").keystroke("v", { using: "command down" });
      return "";
    }
    case "copyurl": {
      const urls = whereFroms(path);
      if (!urls.length) return `No download address recorded for ${quoteName(path)}`;
      const pb = pasteboard();
      pb.clearContents;
      pb.setStringForType($(urls[0]), $.NSPasteboardTypeString);
      return `Copied ${urls[0]}`;
    }
    default:
      return `Unknown action: ${action}`;
  }
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "list": return JSON.stringify(Object.assign({ skipknowledge: true }, listItems(query)));
      case "action": return doAction(query);
      default: return JSON.stringify({ items: [info(`Unknown command: ${cmd}`, "", "error")] });
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (cmd === "action") return `Downloads error: ${msg}`;
    return JSON.stringify({ items: [info("Downloads error", msg, "error")] });
  }
}
