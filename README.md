# WebTranslatePlace

WebTranslatePlace combines Discord message translation with selected-text translation in one browser extension. It uses shared sources for Chrome/Chromium (including Edge, Brave and other Chromium browsers), Firefox, Safari, GNOME Web (Epiphany) and Thunderbird. Source language is detected automatically; **Discord target language** defaults to Czech; **TranslatePlace language 1** defaults to English and **TranslatePlace language 2** defaults to Czech; both apply to page text, editor selections and Thunderbird.

- **Discord messages:** click the translation icon beside a message. Translation appears progressively; click again to restore the original. The icon pulses only while translating and shows a static blue check mark after completion, including when viewing the original. Original colors and typography are preserved. Messages being edited and the composer are excluded.
- **Selected drafts:** select text in a text input, textarea or contenteditable editor and press **Ctrl+Alt+S in Firefox** (**Command+Option+S** on macOS), or **Shift+Alt+S** in other browsers (**Shift+Option+S** on macOS). This includes Discord's composer. The extension waits for the complete translation, replaces only the selected text, and never sends the message.
- **Selected page text:** select a word or passage on a web page and use the same shortcuts to replace it with the translation. The selection must stay within one continuous text segment; selections crossing links, formatting boundaries or paragraphs are skipped. Surrounding text and HTML stay intact. Changes are local to the open page and disappear on reload; dynamic websites may also restore the original when they redraw their content. Originals and completed translations are available in history.
- **Translation history:** click the toolbar icon, then **Show history** to copy or delete the most recent selected texts and their completed translations (50 by default, configurable from 1 to 1,000), with originals saved locally before translation starts and translations added when complete. **Copy original** and **Copy translation** copy either text separately. Older entries and failed translations retain the original only. The same window configures the API for both features. History starts hidden every time the popup opens; **Hide history** hides the list again.

Discord translation support is enabled by default. Use **Discord translation** in the popup to turn it off or on. The setting is saved locally and applies to open Discord tabs immediately. Turning it off removes message translation icons and restores original messages; selected-text translation remains available, including in Discord's composer.

Before sending text to the API, the background removes invisible U+FEFF/U+200B editor placeholders from otherwise blank lines. Spaces and line breaks are preserved, as are characters inside nonempty text. Original draft backups keep the exact selection.

If the selected text or its selection changes while translation runs, the extension leaves it alone. Password, disabled and read-only fields are ignored. If saving the original fails, translation does not start.

This is an extension client; it includes no server or language model. It is a new extension with its own storage and identity. Existing DiMeTrans/CzEn Composer settings and backups are not migrated automatically. Disable those extensions when testing WebTranslatePlace on the same pages to avoid duplicate icons and shortcut conflicts.

## Build

```bash
python3 scripts/build.py                 # all five targets
python3 scripts/build.py chrome firefox  # selected targets
```

Python 3 is the only build dependency. Edit `src/` and `manifests/`, then rebuild; `dist/` is generated. `manifests/base.json` contains the shared version, permissions and entry points. Target overlays select browser-specific background implementations. Open `WebTranslatePlace.code-workspace` in VS Code to use the default build task.

| Target | Unpacked extension | Package |
| --- | --- | --- |
| Chrome/Chromium | `dist/chrome/` | `dist/webtranslateplace-chrome-0.1.0.zip` |
| Firefox 142+ | `dist/firefox/` | `dist/webtranslateplace-firefox-0.1.0.zip` |
| Safari | `dist/safari/` | `dist/webtranslateplace-safari-0.1.0.zip` |
| Thunderbird 128+ | `dist/thunderbird/` | `dist/webtranslateplace-thunderbird-0.1.0.xpi` |
| GNOME Web (experimental) | `dist/epiphany/` | `dist/webtranslateplace-epiphany-0.1.0.xpi` |

Packages contain only runtime assets and use fixed ZIP metadata for reproducible builds.

## Install

- **Chrome/Chromium:** open `chrome://extensions/`, enable **Developer mode**, choose **Load unpacked** and select `dist/chrome/`. Manage the shortcut at `chrome://extensions/shortcuts`. For local files, enable **Allow access to file URLs** in the extension details.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on** and select `dist/firefox/manifest.json`. Grant access to the pages where you want to translate. Temporary installation ends when Firefox exits; permanent installation needs a [Mozilla-signed package](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). The default shortcut is **Ctrl+Alt+S** (Command+Option+S on macOS). This shortcut can be pressed with the left hand; the popup displays the actual assigned binding. Manage the shortcut through **Manage Extension Shortcuts** in `about:addons`. After updating an existing installation, check this setting if the previous shortcut remains assigned.
- **Safari:** on macOS with Xcode, run `bash scripts/package-safari.sh`, build/run `SafariProject/` in Xcode and enable the extension with access to the desired sites. The ZIP is input to Apple's tool, not a directly installable Safari add-on. See [Apple's packaging documentation](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari).
- **GNOME Web (experimental):** enable experimental WebExtensions support and import the XPI through the extension manager. This target uses Manifest V2 with a persistent background script. Because Epiphany's WebExtensions support is experimental, this extension variant is experimental too. Epiphany 50.6 testing encountered browser crashes, failed extension messaging and crashes during removal; working translation is not confirmed. See [known limitations](docs/epiphany.md).

Reload open pages after installing or updating. Browser internal pages and other protected pages cannot run the selection content script; see [Mozilla's content-script documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts). The popup displays the actual assigned shortcut when the browser supports `commands.getAll()`. Browser or OS shortcut conflicts can be resolved in the extension shortcut manager.

Safari and GNOME Web are prepared build targets. Their installation, shortcut dispatch, frame focus, editor replacement, clipboard, API origins and permissions still require live testing on those browsers. Firefox/Chromium live page interaction also needs checking; API smoke tests are not browser UI tests.

## Thunderbird

Build with `python3 scripts/build.py thunderbird`. In Thunderbird, open **Add-ons and Themes**, use the gear menu's **Install Add-on From File**, and choose `dist/webtranslateplace-thunderbird-0.1.0.xpi`. For temporary development loading, use **Debug Add-ons → Load Temporary Add-on** and select `dist/thunderbird/manifest.json`.

- **Writing an email:** select text in the message body and press **Ctrl+Alt+E** (**Command+Option+E** on macOS). The completed translation replaces only that selection after saving its original locally. Changed selections and drafts are left untouched. Both HTML and plain-text compose bodies are handled; subject and recipient fields are outside this integration.
- **Reading an email:** select text in the message body and use the same shortcut. The translation appears in a separate, closable panel. The original message stays intact, and the stored email is never modified. Only the selected text is sent to the API.
- **Settings and history:** use the extension button in the main, compose or message toolbar. API settings and the retained original draft selections and their completed translations are shared inside the Thunderbird installation. Discord controls are hidden; browser extension settings are not imported.

Reopen message and compose windows after installing or updating so their scripts are loaded. Shortcut assignments can be changed through **Manage Extension Shortcuts** in the add-on manager. This target uses Manifest V2 and Thunderbird's [composeScripts](https://webextension-api.thunderbird.net/en/esr-mv2/composeScripts.html) and [messageDisplayScripts](https://webextension-api.thunderbird.net/en/esr-mv2/messageDisplayScripts.html) APIs. The `compose` and `messagesModify` permissions allow scripts in the respective message bodies; HTTP/HTTPS permissions allow connecting to the configured API. No account enumeration, message database access or automatic sending is used.

Automated tests cover script registration, received-message translation, compose replacement and XPI packaging. Live Thunderbird interaction with real mail, focus, shortcut dispatch, undo and clipboard still needs verification.

## Connect an API

The default API is `http://127.0.0.1:5001`. Click the toolbar icon, set **Translation API URL** and save. Use the base URL without `/translate`; HTTP, HTTPS, ports and path prefixes such as `https://example.com/api` are supported. Credentials, query parameters and fragments are rejected. Both features use the same saved address. Running jobs keep their original server; the next translation uses the new setting. **Defaults** fills in the default API address, a history limit of 50 and English for TranslatePlace language 1, Czech for language 2 and Czech for Discord; press **Save** to apply them.

The manifest requests access to all URLs so selection translation can run across websites and the background can reach your configured API. HTTP/HTTPS access is already covered by this required permission, so changing the API address does not request additional permissions. The extension sends only Discord messages, email selections, page text selections and editor selections you explicitly request, using the configured server. There is no analytics or telemetry. Set **History limit** beside the API address in the popup to keep 1–1,000 history entries (default: 50; each original/translation pair counts as one entry). Choose **TranslatePlace language 1**, **TranslatePlace language 2** and **Discord target language** independently in the same settings block. Source language detection is always automatic. Thunderbird uses both TranslatePlace settings and hides the Discord controls. The shared **Save** button saves the API address, history limit and all target languages together. Existing saved target languages are preserved for both features until you choose separate values. Saving a lower limit immediately removes the oldest excess entries. The same limit applies to subsequent saves. Draft backups stay in local extension storage, are not synced or encrypted, and disappear when the extension is uninstalled. Each backup records the original text, target language, timestamp and site hostname, and adds the translated text and completion time when translation succeeds. Results arriving after an entry is deleted or removed by the history limit do not recreate it. Browser-granted site restrictions still apply.

A compatible server must provide:

| Request | Response |
| --- | --- |
| `GET /health` | JSON including `status: "ready"` for diagnostics. |
| `POST /translate` with `{ "q": "Hello", "source": "auto", "target": "cs" }` (replace `cs` with the selected target code) | HTTP 202, `{ "jobId": "<32 lowercase hex characters>", "status": "pending" }`. |
| `GET /translations/<jobId>` | `{ "status": "pending", "partialText": "..." }`, `{ "status": "done", "translatedText": "..." }`, or `{ "status": "failed", "error": "..." }`. |

Polling runs every 500 ms for up to 180 seconds. Partial text is optional and displayed only for Discord messages. The server must accept extension-origin requests; startup, model installation and GPU configuration depend on your backend. Keep a local API on loopback unless you have secured another deployment.

```bash
curl http://127.0.0.1:5001/health
curl -H 'Content-Type: application/json' \
  -d '{"q":"Ahoj","source":"auto","target":"en"}' \
  http://127.0.0.1:5001/translate
```

Use the returned `jobId` with `GET /translations/<jobId>`.

Translations can take several minutes. Discord, editable selections and Thunderbird
wait up to fifteen minutes per translation, including queue time. Each HTTP request
still has a fifteen-second timeout so an unreachable server is reported promptly.

## Development and checks

The Discord script is loaded only on `discord.com`, `canary.discord.com` and `ptb.discord.com`, in the top frame. It also checks the host before starting, and the background accepts its message protocol only from these hosts. Other websites load only the selection script: it registers a message listener and does no DOM scanning, observation, timers or API requests until you invoke translation.

Discord updates are driven by relevant DOM changes, scrolling, resizing and returning to the tab, coalesced over 150 ms. There is no periodic page scan. Hidden tabs disconnect their observer and do not schedule scans or start more automatic translations; already requested jobs can finish. Disabling the translator or invalidating its context disconnects its observer and listeners. The translation cache retains at most 200 entries per tab, and processed message IDs are pruned as Discord removes their DOM nodes. Background startup does not load or rewrite Discord state; it is read when Discord asks for it.

`src/content.js` contains Discord rendering and progressive translation; `src/selection.js` contains page/editor selection and safe replacement. `src/background.js` handles both message protocols, keyboard commands, API requests and serialized draft backups and history limits. The popup contains shared API settings and backup recovery.

Discord defaults to manual translation. To enable automatic translation of visible messages, change `MANUAL_TRANSLATION` in `src/content.js` and rebuild. Discord uses its own target language; editable selections and Thunderbird use the TranslatePlace target. Source language detection is always automatic. Saving a different Discord target restores original Discord messages, clears the old translation cache and discards late progress from jobs using the previous target.

```bash
node --test tests/*.test.cjs
WEBTRANSLATEPLACE_API_NAMESPACE=browser node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
npx --yes web-ext lint --source-dir dist/firefox --warnings-as-errors
```

Tests cover page and editor selection replacement, Slate editor events, changed-draft protection, password exclusion, backup failures and recovery, shortcut dispatch, shared API settings, job server retention, Discord rendering and coexistence of both scripts. Package tests check runtime bytes, entry points, browser manifests, reproducibility and stale-file cleanup.

With a compatible server running:

```bash
node tests/live-translation.cjs chrome
node tests/live-translation.cjs firefox
```

These exercise both translation directions using real HTTP and simulated extension Origin headers. Set `WEBTRANSLATEPLACE_API_URL` for another server. They do not install extensions or verify browser UI behavior.

TranslatePlace has two independent commands: **TranslatePlace: translate into language 1** and **TranslatePlace: translate into language 2**. Language 1 retains the existing shortcut. Language 2 starts without an assigned shortcut; assign it in the browser extension manager (Chrome: `chrome://extensions/shortcuts`, Firefox/Thunderbird: **Manage Extension Shortcuts**). The popup displays the actual shortcuts for both commands. Both commands detect the source automatically and save the chosen target with draft history.

## License

WebTranslatePlace is licensed under the GNU General Public License, version 3 or
any later version (SPDX: `GPL-3.0-or-later`). See [LICENSE](LICENSE).
