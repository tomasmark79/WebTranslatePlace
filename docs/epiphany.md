# GNOME Web / Epiphany (experimental)

This extension variant is experimental because Epiphany's WebExtensions implementation is experimental. It uses Manifest V2, a persistent background script, `browser_action` and host permissions in `permissions`.

Testing with Epiphany 50.6 encountered browser crashes when activating the extension, failed event and message delivery, and crashes when confirming removal. Translation, popup and shortcut behavior are not confirmed to work.

The package follows Epiphany's supported manifest layout. This project does not maintain patches for the browser. Compatibility depends on fixes to Epiphany's WebExtensions implementation.

If the extension manager cannot remove the extension, close Epiphany and move only the installed WebTranslatePlace directory out of `~/.local/share/epiphany/web_extensions/`. Keep it as a backup and preserve the rest of the browser profile. Reopen Epiphany to reload the extension list.
