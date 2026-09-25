### Task 7: Icon and brand assets (REVISED 2026-09-24: the user supplied final art; no image processing)

The user delivered the final assets. They are RGBA PNGs, copied to
`.superpowers/sdd/2026-09-24-limit-break-1.0/assets/` (git-ignored; copy them from there):

| Source | Size | What it is | Repo path |
|---|---|---|---|
| `13.png` | 256×256 | colour icon, "Limit" over a rainbow gauge in a navy frame | `media/icon.png` |
| `15.png` | 1254×1254 | the same icon at high resolution | `media/logo.png` |
| `14.png` | 627×541 | README banner: the glove cursor, "LIMIT", the gauge, "Tokenize / Vibe" | `media/banner.png` |
| `16.png` | 1254×1254 | monochrome white-on-black version, kept for a future status-bar icon font | `media/logo-mono.png` |
| `logo-mono.svg` | viewBox 1254 | the user's vector of the monochrome logo: a single `currentColor` evenodd path, the source for a future icon font | `media/logo-mono.svg` |

- Copy them byte for byte; do not re-encode or resize them.
- Set `"icon": "media/icon.png"` in package.json.
- Make sure `.vscodeignore` ships `media/icon.png` in the VSIX and does NOT ship the other three. The Marketplace only needs the icon; the README banner is referenced by its GitHub URL, which Task 9 handles.
- Run `bash scripts/check-vsix.sh` if it exists, and `npx @vscode/vsce ls` if it is available offline, to confirm the VSIX contents. Report what you ran.
- Add a test only if the repo already has a packaging test to extend; otherwise the VSIX listing is the evidence.
- Commit: `feat: Limit Break icon and brand assets`.
