# Downloads — Plan

**Priority tier:** 1 · **Bundle ID:** `com.xorro.downloads`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Downloads Manager | 83,442 |
| **Total** | **83,442** |

**Alfred today:** Only 2013 'Empty Downloads Folder' style workflows; 'RecentlyAdded' (2014).

## Features (v1.0)
- [ ] `dl` list newest downloads with Quick Look preview (⇧) and file-type icons
- [ ] Actions: open, reveal, copy file, copy path, move to…, delete (to Trash)
- [ ] `dl latest` hotkey: act on most recent download
- [ ] `dl clean` move files older than N days to Trash (configurable)
- [ ] Filter by type (images, pdf, archives, dmg)

## Tech
- **Stack:** zsh (`mdls`/`stat`) + Alfred Script Filter JSON.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
