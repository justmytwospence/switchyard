# Keyboard shortcuts

Switchyard's Vim-style shortcuts move focus through the app; they do **not** change how text fields edit text. Terminals own their keyboard input. Enter activates only the focused link or button—navigation never sends a message, approves a request, runs an automation, moves a task, or dismisses attention by itself.

Press **?** outside a text field or terminal to open the **Keyboard shortcuts** guide. The guide is also available from the command palette, the desktop rail and the mobile More screen. Turn **Vim-style navigation** off there to disable the plain-letter navigation keys while retaining standard modifiers, arrows, Tab and Escape.

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous visible item; in the transcript, scroll down / up |
| `h` / `l` | Previous / next Code pane or desktop Board column; on focused tabs, previous / next tab |
| `g g` / `G` | First / last item, or transcript top / bottom |
| `Ctrl+d` / `Ctrl+u` | Scroll the focused transcript down / up half a page |
| `/` | Focus this view's search, or open the command palette if no search is visible |
| `i` | Focus the visible Code composer |
| `g c` / `g b` / `g a` / `g t` | Go to Sessions / Board / Attention / Tasks |
| `g q` / `g o` / `g s` | Go to Queue / Automations / Settings |
| `?` | Show the keyboard guide |
| `Esc` | Dismiss the topmost popup/dialog, or leave a text field without clearing it |

The `g` prefix expires after 800 ms and is canceled by changing focus or route. Navigation never wraps at the end of a list. It uses the visible rows after filters and collapse state: in Attention, the focused row is nonactivating, so Tab into its controls to act. Desktop Board movement skips empty columns. File trees support `j/k/h/l`; menus support `j/k/G`; shared tablists support `h/l`. These aliases do not change their existing arrows, Home/End or Tab behavior.

The command palette opens with **Cmd+K** on Mac or **Ctrl+K** elsewhere (also Alt+K). Its search always accepts plain text, including `j`, `k`, `g`, `/` and `?`. Use arrows or **Ctrl+j/n** and **Ctrl+k/p** to select a result, Enter to activate it and Escape to close it. In the composer, Ctrl+j/k/n/p navigate an open completion list, while the first Escape dismisses that list and the next Escape leaves the field without discarding your draft.

Existing Alt navigation and terminal shortcuts remain available independently of the Vim-style toggle. Native text editing, IME composition, form controls and the Pi terminal are not intercepted by the new plain-letter shortcuts.
