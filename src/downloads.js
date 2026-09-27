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

// ---------- configuration ----------

function expandPath(raw) {
  let p = String(raw || "");
  // Alfred passes the filepicker value as is; only trim when the untrimmed path doesn't exist,
  // so a folder whose name really ends with a space still works
  if (p.trim() !== p && !FM.fileExistsAtPath($(p).stringByExpandingTildeInPath.js)) p = p.trim();
  if (!p.trim()) p = "~/Downloads";
  if (p.startsWith("~")) p = $(p).stringByExpandingTildeInPath.js;
  if (!p.startsWith("/")) p = HOME + "/" + p;
  p = $(p).stringByStandardizingPath.js;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

// "/Users/me/Downloads" -> "~/Downloads" (only as a prefix)
function tilde(p) {
  return p === HOME || p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

// Checkboxes arrive as "1"/"0"; an empty or unknown value means the default
function flag(name, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  return fallback;
}

// A popup value, or the default when it's missing or not one of the choices
function choice(name, allowed, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

const SORTS = ["added", "modified", "created"];
const PRIMARY = ["open", "reveal", "copy", "paste"];

function config() {
  return {
    folder: expandPath(env("downloads_folder", "")),
    hidden: flag("show_hidden", false),
    subfolders: flag("include_subfolders", false),
    sortBy: choice("sort_by", SORTS, "added"),
    primary: choice("primary_action", PRIMARY, "open"),
    // a required keyword left empty would reopen Alfred with just the query
    keyword: String(env("keyword_dls", "")).trim() || "dls",
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
// Null-prototype maps: a file named "x.constructor" or a query like "__proto__" must not hit Object.prototype
const EXT_KIND = Object.create(null);
for (const [kind, list] of Object.entries(KINDS)) {
  for (const ext of list.split(" ")) (EXT_KIND[ext] = EXT_KIND[ext] || []).push(kind);
}

// Words typed after the keyword that filter instead of search
const FILTERS = Object.assign(Object.create(null), {
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
  big: "@big", large: "@big", largest: "@big",
});

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
// The folder itself is always read in full; subfolders are read breadth-first, shallowest first,
// until MAX_ENTRIES entries have been collected, so a huge subfolder never hides newer top-level files.
function scan(cfg) {
  const entries = [];
  let truncated = false;
  const queue = [];
  const walk = (dir, rel, depth) => {
    const raw = readDir(dir);
    if (!Array.isArray(raw)) return raw.error;
    const names = new Set(raw.map((r) => r.name));
    for (const r of raw) {
      if (depth > 0 && entries.length >= MAX_ENTRIES) {
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
        queue.push([path, rel ? `${rel}/${r.name}` : r.name, depth + 1]);
      }
    }
    return null;
  };
  const error = walk(cfg.folder, "", 0);
  for (let i = 0; !error && i < queue.length; i++) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    walk(...queue[i]);
  }
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
  const filters = [], sites = [];
  for (;;) {
    const w = words.length ? words[0].toLowerCase() : "";
    if (FILTERS[w]) filters.push(FILTERS[words.shift().toLowerCase()]);
    else if (w === "from" && words.length > 1) sites.push(fold(words.splice(0, 2)[1]));
    else break;
  }
  return { filters, words: words.map(fold), sites };
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
  const today = startOfDay(0), yesterday = startOfDay(1), week = startOfDay(6), month = startOfDay(30);
  const tomorrow = startOfDay(-1); // files dated in the future don't count as recent
  const since = (t) => (e) => e.sortTime >= t && e.sortTime < tomorrow;
  for (const f of filters) {
    if (f === "@today") out = out.filter(since(today));
    else if (f === "@yesterday") out = out.filter((e) => e.sortTime >= yesterday && e.sortTime < today);
    else if (f === "@week") out = out.filter(since(week));
    else if (f === "@month") out = out.filter(since(month));
    else if (f === "@big") out = out.filter((e) => !e.dir && !e.link && !e.icloud);
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
  if (s < -120) return absoluteDate(t); // dated in the future
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (t >= startOfDay(0)) return `${Math.floor(s / 3600)} h ago`;
  if (t >= startOfDay(1)) return "yesterday";
  if (t >= startOfDay(6)) return `${calendarDaysAgo(t)} days ago`;
  return absoluteDate(t);
}

function absoluteDate(t) {
  const d = new Date(t * 1000);
  const thisYear = new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === thisYear ? "" : " " + d.getFullYear()}`;
}

function oneLine(s) {
  // control characters and line breaks become spaces; bidi overrides are dropped so a name
  // like "\u202Egnp.exe" can't pose as a different file type
  return String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
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
  for (const raw of urls) {
    const u = raw.replace(/^blob:/i, "");
    const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]\/?#]*\]|[^\/?#:]+)/i);
    if (m) return m[1].replace(/^www\./, "");
  }
  return "";
}

// The address worth copying: a web address rather than a page-local blob: or an inline data: URL
function downloadAddress(urls) {
  return urls.find((u) => /^(https?|ftp):\/\//i.test(u)) || urls.find((u) => !/^data:/i.test(u)) || "";
}

// Shorten for display without splitting an emoji or other surrogate pair
function shorten(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

// ---------- Script Filter ----------

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}

function modsFor(e, path, query, primary) {
  const m = (action, subtitle, valid = true) => ({ arg: path, valid, subtitle, variables: { dl_action: action, dl_query: query } });
  // when ↩ is set to reveal, copy or paste, the modifier that did that opens the file instead
  const mod = (action, subtitle) => (action === primary ? m("open", "Open the file") : m(action, subtitle));
  return {
    cmd: mod("reveal", "Reveal in Finder"),
    alt: m("trash", "Move to Trash"),
    ctrl: mod("copy", "Copy the file to the clipboard"),
    fn: mod("paste", "Paste the file into the frontmost app"),
    shift: m("move", "Move to the folder open in Finder"),
    "cmd+alt": m("copyurl", "Copy the address it was downloaded from"),
  };
}

function linkLabel(path) {
  const target = FM.destinationOfSymbolicLinkAtPathError(path, null);
  if (target.isNil()) return "Symbolic link";
  const broken = !FM.fileExistsAtPath(path);
  return `${broken ? "Broken link" : "Link"} → ${tilde(target.js)}`;
}

function fileItem(e, cfg, now) {
  const time = e.sortTime;
  const bits = [];
  // iCloud placeholders always download on ↩; unfinished downloads are revealed
  let action = e.icloud ? "open" : cfg.primary;
  let brokenLink = false;
  if (e.partial) {
    bits.push(e.dir ? "Downloading…" : `Downloading… ${formatSize(e.size)} so far`);
    bits.push(`started ${relativeTime(time, now)}`);
    action = "reveal";
  } else if (e.icloud) {
    bits.push("In iCloud, not downloaded", relativeTime(time, now));
  } else {
    if (e.link) {
      const label = linkLabel(e.path);
      brokenLink = label.startsWith("Broken");
      bits.push(label);
    }
    else if (e.dir) bits.push(e.pkg ? (extOf(e.name) === "app" ? "Application" : "Package") : "Folder");
    else bits.push(formatSize(e.size));
    bits.push(relativeTime(time, now));
    if (e.dataless) bits.push("in iCloud");
  }
  if (e.rel) bits.push(`in ${e.rel}`);
  if (!e.dir && !e.link && !e.icloud) {
    const host = sourceHost(e.urls === undefined ? whereFroms(e.path) : e.urls);
    if (host) bits.push(`from ${host}`);
  }
  const mods = modsFor(e, e.path, cfg.query, e.icloud ? "open" : cfg.primary);
  return {
    // Alfred hides "file" rows whose path doesn't resolve; a broken link is still worth listing (and trashing)
    type: brokenLink ? "file:skipcheck" : "file",
    title: oneLine(e.display),
    subtitle: oneLine(bits.join(" · ")),
    arg: e.path,
    icon: { type: "fileicon", path: e.path },
    quicklookurl: e.icloud ? undefined : e.path,
    // an iCloud placeholder's real file will appear next to it under its own name
    text: { copy: e.icloud ? `${$(e.path).stringByDeletingLastPathComponent.js}/${e.display}` : e.path, largetype: e.display },
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
    subtitle: tilde(cfg.folder),
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
      shift: m("none", "The folder itself can’t be moved", false),
      "cmd+alt": m("none", "No download address for a folder", false),
    },
  };
}

function folderProblem(cfg) {
  const isDir = Ref();
  const shown = tilde(cfg.folder);
  const configure = { valid: true, arg: "configure", variables: { dl_action: "configure" } };
  if (!FM.fileExistsAtPathIsDirectory(cfg.folder, isDir)) {
    return info("Downloads folder not found", `${shown} doesn’t exist. ↩ Choose another folder in the Workflow’s Configuration`, "error", configure);
  }
  if (!isDir[0]) {
    return info("Not a folder", `${shown} is a file. ↩ Choose a folder in the Workflow’s Configuration`, "error", configure);
  }
  return null;
}

function permissionItem(cfg, error) {
  const detail = error && !error.isNil() && error.localizedDescription ? error.localizedDescription.js : "";
  if (!FM.isReadableFileAtPath(cfg.folder) || !FM.isExecutableFileAtPath(cfg.folder)) {
    // Plain Unix permissions: System Settings can't help
    return info("You don’t have permission to read this folder", detail || tilde(cfg.folder), "lock");
  }
  // Readable by permissions but blocked: macOS privacy protection (TCC)
  return info(
    "Alfred can’t read the Downloads folder",
    `↩ Allow Alfred in Privacy & Security › Files and Folders${detail ? " · " + detail : ""}`,
    "lock",
    { valid: true, arg: "privacy", variables: { dl_action: "privacy" } }
  );
}

function setSortTimes(entries, cfg) {
  for (const e of entries) {
    e.sortTime = cfg.sortBy === "modified" ? e.modified : cfg.sortBy === "created" ? e.created || e.added : e.added;
  }
}

function newestFinished(list) {
  let best = null;
  for (const e of list) if (!e.partial && !e.icloud && (!best || e.sortTime > best.sortTime)) best = e;
  return best;
}

// "from github" matches files downloaded from github.com (or any address that contains the word)
function fromSite(e, word) {
  if (e.dir || e.link || e.icloud) return false;
  if (e.urls === undefined) e.urls = whereFroms(e.path);
  return e.urls.some((u) => fold(sourceHost([u])).includes(word));
}

// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns (rerun):
// without one the selection jumps back to the first row on every rerun (found in real Alfred).
// The uid is the position plus the title with its numbers masked, so countdowns, prices and clocks
// keep it, while typing something new changes it and the selection resets to the top as usual.
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

function listItems(query) {
  const cfg = config();
  cfg.query = query;
  const problem = folderProblem(cfg);
  if (problem) return { items: [problem] };
  const { entries, error, truncated } = scan(cfg);
  if (error) return { items: [permissionItem(cfg, error), folderItem(cfg)] };

  setSortTimes(entries, cfg);
  const { filters, words, sites } = parseQuery(query);
  let list = applyFilters(entries, filters);
  if (sites.length) list = list.filter((e) => sites.every((w) => fromSite(e, w)));
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
  const bySize = filters.includes("@big");
  list.sort((a, b) => (b.score || 0) - (a.score || 0) || (bySize ? b.size - a.size : 0) || b.sortTime - a.sortTime ||
    (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
  if (filters.includes("@latest")) {
    // the most recent finished download among the matches, whatever the search score
    const best = newestFinished(list);
    list = best ? [best] : [];
  }

  const now = Date.now() / 1000;
  const items = list.slice(0, MAX_ITEMS).map((e) => fileItem(e, cfg, now));
  if (!items.length) {
    if (!entries.length) items.push(info("The folder is empty", tilde(cfg.folder), "empty"));
    else if (filters.includes("@latest")) items.push(info("No finished downloads", "Nothing matches in the folder", "empty"));
    else if (sites.length && !words.length) items.push(info("No downloads from that website", `Nothing was downloaded from “${oneLine(sites.join(" "))}”`, "empty"));
    else items.push(info("No matching downloads", `Nothing matches “${oneLine(query.trim())}”`, "empty"));
  }
  if (list.length > MAX_ITEMS) {
    items.push(info(`Showing ${words.length ? "the best" : bySize ? "the largest" : "the newest"} ${MAX_ITEMS} of ${list.length.toLocaleString("en-US")}`, "Type to search, or add a filter like img, pdf or zip", "info"));
  }
  if (truncated) items.push(info(`Some subfolders weren’t searched`, `Subfolders stop at ${MAX_ENTRIES.toLocaleString("en-US")} files; every file directly in the folder is listed`, "info"));
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
  // a dry run never touches the real clipboard, even when the test forgot to name a pasteboard
  const name = env("DL_TEST_PASTEBOARD", "") || (env("DL_TEST_DRYRUN", "") === "1" ? "io.github.x-o-r-r-o.downloads.dryrun" : "");
  return name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
}

function copyFile(path) {
  const pb = pasteboard();
  pb.clearContents;
  return pb.writeObjects($([$.NSURL.fileURLWithPath(path)]));
}

function pasteFile(path, dry) {
  if (!copyFile(path)) return `Couldn’t copy ${quoteName(path)}`;
  if (dry) return `paste ${path}`;
  delay(0.25); // let Alfred's window close and the previous app take focus
  try {
    Application("System Events").keystroke("v", { using: "command down" });
  } catch (e) {
    return `Copied ${quoteName(path)}: press ⌘V to paste it, or allow Alfred to control System Events in Privacy & Security › Automation`;
  }
  return "";
}

function trash(path, cfg, dry) {
  if (!inside(path, cfg.folder)) return `Not moved: ${quoteName(path)} isn’t inside the Downloads folder`;
  const testDir = env("DL_TEST_TRASH_DIR", "");
  if (dry && !testDir) return `trash ${path}`; // a dry run never uses the real Trash
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

// The folder shown in the frontmost Finder window, or "" when there isn't one
function finderFolder() {
  const test = env("DL_TEST_FINDER_DIR", null);
  if (test !== null) return test;
  const finder = Application("Finder");
  if (!finder.running()) return "";
  const windows = finder.finderWindows;
  if (!windows.length) return "";
  let raw;
  try {
    raw = windows[0].target().url(); // fails for windows like Recents or AirDrop that aren't folders
  } catch (e) {
    return "";
  }
  const url = $.NSURL.URLWithString(raw);
  return url.isNil() || !url.isFileURL ? "" : url.path.js;
}

function moveToFolder(path, dest, cfg) {
  if (!inside(path, cfg.folder)) return `Not moved: ${quoteName(path)} isn’t inside the Downloads folder`;
  const isDir = Ref();
  if (!dest || !FM.fileExistsAtPathIsDirectory(dest, isDir) || !isDir[0]) return "Open the destination folder in Finder first";
  const real = (p) => $(p).stringByResolvingSymlinksInPath.js;
  const name = $(path).lastPathComponent.js;
  const from = `${real($(path).stringByDeletingLastPathComponent.js)}/${name}`;
  const to = real(dest);
  const shown = `“${oneLine($(to).lastPathComponent.js || to)}”`;
  if (real($(path).stringByDeletingLastPathComponent.js) === to) return `${quoteName(path)} is already in ${shown}`;
  if (to === from || to.startsWith(from + "/")) return `Can’t move ${quoteName(path)} into itself`;
  const target = `${to}/${name}`;
  if (exists(target)) return `Not moved: ${shown} already has an item named ${quoteName(path)}`;
  const err = $();
  if (FM.moveItemAtPathToPathError(path, target, err)) return `Moved ${quoteName(path)} to ${shown}`;
  const why = !err.isNil() && err.localizedDescription ? ": " + err.localizedDescription.js : "";
  return `Couldn’t move ${quoteName(path)}${why}`;
}

function reopenAlfred(cfg) {
  const query = env("dl_query", "");
  try {
    Application("com.runningwithcrayons.Alfred").search(`${cfg.keyword} ${query}`);
  } catch (e) {} // the file is already in the Trash; the notification still says so
}

function doAction(path, forced) {
  const cfg = config();
  const action = forced || env("dl_action", "open");
  const dry = env("DL_TEST_DRYRUN", "") === "1";
  const ws = $.NSWorkspace.sharedWorkspace;

  if (action === "configure") {
    if (dry) return "configure";
    try {
      Application("com.runningwithcrayons.Alfred").revealWorkflow(env("alfred_workflow_bundleid", "io.github.x-o-r-r-o.downloads"));
    } catch (e) {
      return "Open Alfred Preferences › Workflows › Downloads › Configure Workflow to choose the folder";
    }
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
      const msg = trash(path, cfg, dry);
      if (!dry && cfg.reopen && msg.startsWith("Moved")) reopenAlfred(cfg);
      return msg;
    }
    case "copy":
    case "paste":
      if (placeholder) return `${quoteName(path)} is in iCloud: press ↩ to download it first`;
      if (PARTIAL_RE.test(name)) return `${quoteName(path)} is still downloading`;
      if (action === "paste") return pasteFile(path, dry);
      return copyFile(path) ? `Copied ${quoteName(path)} to the clipboard` : `Couldn’t copy ${quoteName(path)}`;
    case "move": {
      if (placeholder) return `${quoteName(path)} is in iCloud: press ↩ to download it first`;
      if (PARTIAL_RE.test(name)) return `${quoteName(path)} is still downloading`;
      if (dry && env("DL_TEST_FINDER_DIR", null) === null) return `move ${path}`;
      let dest;
      try {
        dest = finderFolder();
      } catch (e) {
        return "Couldn’t ask Finder for its folder: allow Alfred to control Finder in Privacy & Security › Automation";
      }
      return moveToFolder(path, dest, cfg);
    }
    case "copyurl": {
      const address = downloadAddress(whereFroms(path));
      if (!address) return `No download address recorded for ${quoteName(path)}`;
      const pb = pasteboard();
      pb.clearContents;
      pb.setStringForType($(address), $.NSPasteboardTypeString);
      return `Copied ${shorten(oneLine(address), 200)}`;
    }
    default:
      return `Unknown action: ${action}`;
  }
}

// Act on the most recent finished download straight from a Hotkey, without showing Alfred
const LATEST_ACTIONS = ["open", "reveal", "copy", "paste", "move", "copyurl"];
function doLatest(action) {
  action = String(action || "").trim().toLowerCase();
  if (!LATEST_ACTIONS.includes(action)) return `Unknown action for the latest download: ${oneLine(action)}`;
  const cfg = config();
  const problem = folderProblem(cfg);
  if (problem) return `${problem.title}: ${tilde(cfg.folder)}`;
  const { entries, error } = scan(cfg);
  if (error) return "Alfred can’t read the Downloads folder: allow it in Privacy & Security › Files and Folders";
  setSortTimes(entries, cfg);
  const best = newestFinished(entries);
  if (!best) return "No finished downloads";
  return doAction(best.path, action);
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "list": {
        const res = listItems(query);
        stableUids(res.items || []);
        return JSON.stringify(Object.assign({ skipknowledge: true }, res));
      }
      // an empty result must print nothing at all (osascript prints "" as a blank line), so the
      // Notification, set to show only when populated, stays quiet after a silent success
      case "action": return doAction(query) || undefined;
      case "latest": return doLatest(query) || undefined;
      default: return JSON.stringify({ items: [info(`Unknown command: ${cmd}`, "", "error")] });
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (cmd === "action" || cmd === "latest") return `Downloads error: ${msg}`;
    return JSON.stringify({ items: [info("Downloads error", msg, "error")] });
  }
}
