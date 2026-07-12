# Terminal Fidelity

Hydraterm renders terminal SGR colors, styles, and hyperlinks. It does not yet provide
complete terminal visual fidelity.

## Supported

- Ghostty VT parsing.
- Terminal resize.
- Primary and alternate screen handling.
- Scrollback retention.
- Plain-text screen snapshots.
- SGR foreground/background colors and text styles.
- OSC 8 hyperlinks. Clicking a displayed HTTP(S) hyperlink opens it in the default browser.
- Terminal query responses written back to the child PTY.

## Not Rendered In This Milestone

- Terminal title and working-directory display.
- Clipboard effects.
- Mouse protocols.
- Graphics and sixel.
- Kitty keyboard extensions.
- Richer formatter output.

The dashboard uses Ghostty's HTML formatter for its supported styles and links, but it
does not yet render a visually complete terminal emulator.
