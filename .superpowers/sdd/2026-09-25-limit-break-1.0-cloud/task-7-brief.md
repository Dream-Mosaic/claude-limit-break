### Task 7: Icon and brand assets

Source: the Windows lane's revised brief (`2026-09-24-limit-break-1.0/task-7-brief.md`, REVISED
2026-09-24: the user supplied final art; no image processing), with the cloud lane's rulings applied.
The plan file's older Task 7 text (image processing from JPG drafts) is superseded; ignore it.

The final assets are in `.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/assets/`. Copy them from there:

| Source file | Size | What it is | Repo path |
|---|---|---|---|
| `Limit Break-ICO.png` | 256×256 RGBA | colour icon, "Limit" over a rainbow gauge in a navy frame | `media/icon.png` |
| `Limit Break-color.png` | 1254×1254 RGBA | the same icon at high resolution | `media/logo.png` |
| `Limit Break Logo.png` | 627×541 RGBA | README banner: the glove cursor, "LIMIT", the gauge, "Tokenize / Vibe" | `media/banner.png` |
| `Limit Break-mono.png` | 1254×1254 RGBA | monochrome version, kept for a future status-bar icon font | `media/logo-mono.png` |
| `logo-mono.svg` | viewBox 1254 | the monochrome logo for the v1.1 activity-bar sidebar: frame, "Limit" and gauge in `currentColor` on transparent | `media/logo-mono.svg` |

- Copy them byte for byte; do not re-encode, resize or edit them. Verify with `cmp` after copying.
- Set `"icon": "media/icon.png"` in package.json.
- Make sure `.vscodeignore` ships `media/icon.png` in the VSIX and does NOT ship the other four. The Marketplace only needs the icon; the README banner is referenced by its GitHub URL, which Task 9 handles. (The SVG ships once a v1.1 sidebar uses it; not now.)
- Run `bash scripts/check-vsix.sh` if it applies, and `npx @vscode/vsce ls` (npm registry access works here) to confirm the VSIX contents. Report what you ran and the listing.
- Add a test only if the repo already has a packaging test to extend; otherwise the VSIX listing is the evidence. If `scripts/check-vsix.sh` asserts VSIX contents, extending it to assert `media/icon.png` ships and the other media files do not is in scope.
- Commit: `feat: Limit Break icon and brand assets`.
