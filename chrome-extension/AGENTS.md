# Repository Guidelines

## Project Structure & Module Organization

This is a Chrome Manifest V3 extension with plain JavaScript, HTML, and static assets. `manifest.json` declares permissions, the background service worker, content script, popup, and icons. Core automation lives in `background.js`; popup UI and interactions are in `popup.html` and `popup.js`. Smaller modules handle focused concerns: `config.js` for site storage, `schedule.js` for alarms, `site-url.js` and `site-name.js` for URL/name handling, `balance.js` for balance parsing, and `*-auth.js` files for authentication helpers. `icons/` contains extension icons, and `vendor/Sortable.min.js` is the bundled drag-sort dependency.

## Build, Test, and Development Commands

There is no package manager or bundler required. Load this directory directly from `chrome://extensions/` with Developer Mode enabled.

Use syntax checks before testing in Chrome:

```bash
rtk node --check background.js
rtk node --check popup.js
rtk node --check config.js
rtk node --check site-url.js
rtk node --check backup-config.js
rtk node --check balance.js
```

After changing `manifest.json`, service-worker code, or popup files, reload the unpacked extension in Chrome.

## Versioning

After every file modification in this extension, increment the patch/minor tail of `manifest.json` `version` by 1, for example `1.47` to `1.48`. Also update the fallback footer version text in `popup.html` (`#versionFooter`) to the same value with a leading `v`, for example `v1.48`.

The popup normally replaces the footer with `chrome.runtime.getManifest().version` at runtime, but the HTML fallback must stay in sync so the visible page version is still correct when popup JavaScript has not run. Before manual verification, reload the unpacked extension at `chrome://extensions` and confirm the displayed version matches the new manifest version.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes for JavaScript strings, and descriptive camelCase names. Keep modules small and capability-focused; prefer adding or extending helpers over growing `background.js` or `popup.js` with unrelated logic. Use Chrome extension APIs directly and keep storage keys stable to avoid breaking existing users. Follow `RTK.md`: prefix shell commands with `rtk`.

## Testing Guidelines

No automated test framework is currently configured. At minimum, run `node --check` on changed JavaScript files and manually verify the extension by loading it unpacked. Test the affected flow: adding a site, manual check-in, retry/status rendering, import/export, scheduling, or balance display. For UI changes, verify the popup at normal Chrome extension popup width.

## Commit & Pull Request Guidelines

This directory has no local Git history, so use concise imperative commit messages such as `Fix balance parsing for visit mode` or `Add ZenAPI auth fallback`. Pull requests should describe the user-visible change, list manual verification steps, mention permission or storage changes, and include screenshots for popup UI changes. Link related issues when available.

## Security & Configuration Tips

Do not log tokens, cookies, authorization headers, or decrypted auth cache values. Keep all user data local in Chrome Storage. Be conservative with new permissions in `manifest.json`; document why each added permission is required.
