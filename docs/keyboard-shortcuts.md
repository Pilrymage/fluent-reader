# Keyboard shortcuts

These shortcuts work while a list/card view is focused and are inert inside
inputs, textareas, selects, contenteditable regions, IME composition, settings,
context menus/modals, and `<webview>` elements.

| Key | Action |
| --- | --- |
| `r` | Mark the focused article read and move to the next title. Never toggles and never opens the article. Holding `r` repeats one row at a time. At the last loaded row it loads the next page once, then focuses the first new row; at the true end it clamps without wrapping. |
| `p` / `ArrowUp` | Move focus up without marking read. |
| `n` / `ArrowDown` | Move focus down without marking read. |
| `Shift+R` | Mark every unread article in the current category read, including unloaded rows and child feeds. Fires once per physical press (auto-repeat ignored). |
| `Ctrl+L` | Cycle the focused title position `center → top → bottom → center`. Resets to center after any other navigation or a mouse selection. |

## Page geometry

Movement and cycling set the `#refocus` container's `scrollTop` and focus with
`preventScroll` so the browser never steals focus:

- Moving down past the viewport bottom aligns the new row to the top of the
  visible area, just below the sticky header (`--navHeight`).
- Moving up past the viewport top aligns the new row to the bottom of the
  visible area.
- Scroll offsets always clamp to `[0, scrollHeight - clientHeight]`.

## Existing shortcuts

Article-focused keys `m` (toggle read), `b` (open in browser), `s` (star), and
`h` (hide) are unchanged, as are `F1`–`F9` global actions.

`b` acts on whichever article has focus:

- On a list row it opens that row's article in the default browser.
- In an open article it opens the open article, whether focus is in the page
  itself (its `<webview>`) or on the article toolbar. It does not follow the
  list cursor. The list keys `r`, `p`, `n` and `Ctrl+L` stay inert there.

## Sources menu

With a menu entry focused (for example after `Tab`), `n` moves to the next
visible entry and `p` to the previous one, like `ArrowDown`/`ArrowUp`. Entries
inside collapsed groups are skipped, and focus stops at the first and last
entry. The menu's type-ahead (jump to the next entry starting with a letter)
still works for every other letter.
