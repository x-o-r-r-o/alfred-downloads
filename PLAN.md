# Downloads — Plan

**Priority tier:** 1 · **Bundle ID:** `io.github.x-o-r-r-o.downloads` · **Keywords:** `dls`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Downloads Manager | 83,442 |
| **Total** | **83,442** |

**Alfred today:** Only 2013 'Empty Downloads Folder' style workflows; 'RecentlyAdded' (2014).

## Features (v1.0)
- [x] `dls` list newest downloads (by date added) with Quick Look preview (⇧ / ⌘Y) and file-type icons
- [x] Actions: open, reveal, copy file, paste file, copy path, copy source URL, move to Trash (Move To… via Alfred’s file actions)
- [x] `dls latest` hotkey: act on most recent finished download
- [x] Cleanup of old downloads is left to Burrow (`bularge` / `buinstallers` / proposed `old downloads` filter)
- [x] Filter by type (images, pdf, archives, dmg, video, audio, docs, folders) and by time (today, yesterday, week, month)
- [x] Configurable folder, sort order, subfolders, hidden files; in-progress and iCloud-aware
- [x] 10,000 files listed in ~110 ms (getattrlistbulk, no cache needed)
- [ ] ~~Universal Action “Move to Downloads”~~: dropped, Alfred’s own Move To file action covers it

## Tech
- **Stack:** JXA (`getattrlistbulk` via the ObjC bridge, NSWorkspace, NSPasteboard) + Alfred Script Filter JSON.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (missing folder, no permission, empty folder)
4. [ ] README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] No compiled binary; never strip quarantine
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README (done) and the forum post
- [ ] Version bumped in `workflow.json`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
