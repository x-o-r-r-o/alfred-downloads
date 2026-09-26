#!/usr/bin/env python3
"""Build tool (developer machine only; nothing here ships in the workflow).

  python3 tools/build.py            # write src/info.plist from workflow.json + README.md
  python3 tools/build.py --package  # also zip src/ into dist/<name>-<version>.alfredworkflow
  python3 tools/build.py --check    # validate only

workflow.json describes objects with short type names and connections by id;
this script expands them into Alfred 5 info.plist structures with stable UIDs.
"""
import json, os, plistlib, re, sys, uuid, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

MODS = {"": 0, "cmd": 1048576, "alt": 524288, "ctrl": 262144, "shift": 131072, "fn": 8388608,
        "cmd+alt": 1572864, "cmd+shift": 1179648, "alt+shift": 655360, "ctrl+alt": 786432}

SCRIPT_TYPES = {"bash": 0, "osascript": 6, "jxa": 7, "external": 8}


def scriptfilter(o):
    return ("alfred.workflow.input.scriptfilter", 3, {
        "alfredfiltersresults": o.get("alfredfilters", False),
        "alfredfiltersresultsmatchmode": 0,
        "argumenttreatemptyqueryasnil": True,
        "argumenttrimmode": o.get("trimmode", 0),
        "argumenttype": {"required": 0, "optional": 1, "none": 2}[o.get("argument", "optional")],
        "escaping": 102,
        "keyword": o["keyword"],
        "queuedelaycustom": 3,
        "queuedelayimmediatelyinitially": True,
        "queuedelaymode": o.get("queuedelaymode", 0),
        "queuemode": o.get("queuemode", 1),
        "runningsubtext": o.get("running", "…"),
        "script": o["script"],
        "scriptargtype": 1,
        "scriptfile": "",
        "subtext": o.get("subtext", ""),
        "title": o["title"],
        "type": SCRIPT_TYPES[o.get("lang", "bash")],
        "withspace": o.get("withspace", True),
        "skipuniversalaction": o.get("skipuniversalaction", True),
    })


def script(o):
    return ("alfred.workflow.action.script", 2, {
        "concurrently": o.get("concurrently", False),
        "escaping": 102,
        "script": o["script"],
        "scriptargtype": 1,
        "scriptfile": "",
        "type": SCRIPT_TYPES[o.get("lang", "bash")],
    })


def clipboard(o):
    return ("alfred.workflow.output.clipboard", 3, {
        "autopaste": o.get("autopaste", False),
        "clipboardtext": o.get("text", "{query}"),
        "ignoredynamicplaceholders": True,
        "transient": o.get("transient", False),
    })


def notification(o):
    return ("alfred.workflow.output.notification", 1, {
        "lastpathcomponent": False,
        "onlyshowifquerypopulated": o.get("onlyifquery", True),
        "removeextension": False,
        "text": o.get("text", "{query}"),
        "title": o.get("title", "{var:alfred_workflow_name}"),
    })


def universalaction(o):
    # acceptsmulti: 0 = single item, 1 = single and multiple, 2 = multiple only
    # (alfredapp/simple-diff-workflow uses 2 for its two-file "Path Diff")
    return ("alfred.workflow.trigger.universalaction", 1, {
        "acceptsfiles": o.get("files", False),
        "acceptsmulti": o.get("multi", 0),
        "acceptstext": o.get("text", False),
        "acceptsurls": o.get("urls", False),
        "name": o["name"],
    })


def fileaction(o):
    # keys as in alfredapp/heic-to-jpeg-workflow and tinypng-workflow (no accepts* flags)
    return ("alfred.workflow.trigger.action", 1, {
        "acceptsmulti": o.get("multi", 0),
        "filetypes": o.get("filetypes", []),
        "name": o["name"],
    })


def hotkey(o):
    return ("alfred.workflow.trigger.hotkey", 2, {
        "action": 0, "argument": o.get("argument", 0), "focusedappvariable": False,
        "focusedappvariablename": "", "hotkey": 0, "hotmod": 0, "hotstring": "", "leftcursor": False,
        "modsmode": 0, "relatedAppsMode": 0,
    })


def external(o):
    return ("alfred.workflow.trigger.external", 1, {"availableviaurlhandler": o.get("url", False), "triggerid": o["trigger"]})


def argument(o):
    return ("alfred.workflow.utility.argument", 1, {
        "argument": o.get("argument", "{query}"), "passthroughargument": o.get("passthrough", False),
        "variables": o.get("variables", {}),
    })


def openurl(o):
    return ("alfred.workflow.action.openurl", 1, {"browser": "", "skipqueryencode": True, "skipvarencode": False, "spaces": "", "url": o.get("url", "{query}")})


def largetype(o):
    return ("alfred.workflow.output.largetype", 3, {"alignment": 0, "backgroundcolor": "", "fadespeed": 0, "fillmode": 0, "font": "", "ignoredynamicplaceholders": True, "largetypetext": o.get("text", "{query}"), "textcolor": "", "wrapat": 50})


BUILDERS = {f.__name__: f for f in (scriptfilter, script, clipboard, notification, universalaction, fileaction, hotkey, external, argument, openurl, largetype)}


def build(check_only=False):
    spec = json.load(open(os.path.join(ROOT, "workflow.json")))
    bundle = spec["bundleid"]
    uid = lambda i: str(uuid.uuid5(uuid.NAMESPACE_URL, f"{bundle}/{i}")).upper()
    ids = [o["id"] for o in spec["objects"]]
    errors = []
    if len(ids) != len(set(ids)):
        errors.append("duplicate object ids")
    objects, uidata = [], {}
    for o in spec["objects"]:
        typ, ver, cfg = BUILDERS[o["type"]](o)
        obj = {"config": cfg, "type": typ, "uid": uid(o["id"]), "version": ver}
        objects.append(obj)
    # layout: column = longest path from a trigger
    incoming = {}
    for c in spec["connections"]:
        if c["from"] not in ids or c["to"] not in ids:
            errors.append(f"connection to unknown object: {c}")
        incoming.setdefault(c["to"], []).append(c["from"])
    col = {}
    def depth(i, seen=()):
        if i in col:
            return col[i]
        if i in seen:
            return 0
        col[i] = 0 if i not in incoming else 1 + max(depth(p, seen + (i,)) for p in incoming[i])
        return col[i]
    rows = {}
    for o in spec["objects"]:
        d = depth(o["id"])
        r = rows.get(d, 0)
        rows[d] = r + 1
        uidata[uid(o["id"])] = {"xpos": 30 + 220 * d, "ypos": 20 + 130 * r}
        if o.get("note"):
            uidata[uid(o["id"])]["note"] = o["note"]
    connections = {}
    for c in spec["connections"]:
        connections.setdefault(uid(c["from"]), []).append({
            "destinationuid": uid(c["to"]),
            "modifiers": MODS[c.get("mod", "")],
            "modifiersubtext": c.get("modtext", ""),
            "vitoclose": c.get("vitoclose", False),
        })
    # keywords: >= 3 chars and configurable
    cfgvars = {c["variable"]: c for c in spec.get("config", [])}
    for o in spec["objects"]:
        kw = o.get("keyword")
        if kw is None:
            continue
        m = re.fullmatch(r"\{var:(\w+)\}", kw)
        if not m:
            errors.append(f"keyword not configurable: {kw}")
        elif m.group(1) not in cfgvars:
            errors.append(f"keyword variable missing from config: {m.group(1)}")
        elif len(cfgvars[m.group(1)]["config"]["default"]) < 3:
            errors.append(f"keyword shorter than 3 characters: {m.group(1)}")
    for o in spec["objects"]:
        for f in re.findall(r"\./([\w./-]+\.(?:js|sh|py|applescript))", o.get("script", "")):
            if not os.path.exists(os.path.join(SRC, f)):
                errors.append(f"script file missing: {f}")
    icon = os.path.join(SRC, "icon.png")
    if not os.path.exists(icon):
        errors.append("src/icon.png missing")
    readme = open(os.path.join(ROOT, "README.md")).read()
    about = readme.split("## Usage", 1)[1] if "## Usage" in readme else readme
    about = "## Usage" + about.split("\n## Development", 1)[0].split("\n## AI disclosure", 1)[0]
    about = re.sub(r"!\[[^\]]*\]\([^)]*\)\n*", "", about).strip() + "\n"
    info = {
        "bundleid": bundle, "category": spec.get("category", "Productivity"), "connections": connections,
        "createdby": spec["createdby"], "description": spec["description"], "disabled": False,
        "name": spec["name"], "objects": objects, "readme": about, "uidata": uidata,
        "userconfigurationconfig": spec.get("config", []), "variables": spec.get("variables", {}),
        "variablesdontexport": spec.get("variablesdontexport", []), "version": spec["version"],
        "webaddress": spec["webaddress"],
    }
    if errors:
        print("\n".join("ERROR: " + e for e in errors))
        sys.exit(1)
    if not check_only:
        # Write atomically: Alfred (or a parallel build) may read info.plist at any moment
        tmp = os.path.join(SRC, f".info.plist.tmp-{os.getpid()}")
        with open(tmp, "wb") as f:
            plistlib.dump(info, f)
        os.replace(tmp, os.path.join(SRC, "info.plist"))
    return info


def package(info):
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    slug = os.path.basename(ROOT)
    out = os.path.join(ROOT, "dist", f"{slug}-{info['version']}.alfredworkflow")
    tmp = f"{out}.tmp-{os.getpid()}"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for base, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in dirs if not d.startswith((".", "__"))]
            for f in sorted(files):
                if f.startswith(".") or f == "prefs.plist":
                    continue
                p = os.path.join(base, f)
                z.write(p, os.path.relpath(p, SRC))
    os.replace(tmp, out)
    print("Built", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    info = build(check_only="--check" in sys.argv)
    if "--package" in sys.argv:
        package(info)
    elif "--check" not in sys.argv:
        print("Wrote src/info.plist")
