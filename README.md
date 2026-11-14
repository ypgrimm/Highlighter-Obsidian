# Highlighter for Obsidian

**Highlight, draw, type and take notes directly on your PDFs, without ever leaving Obsidian.**

Highlighter adds a full annotation toolbar to Obsidian's built-in PDF viewer. It looks and feels like part of Obsidian, works with mouse, touch and stylus, and keeps your annotations safe across devices with any cloud sync, including Google Drive, iCloud, Dropbox, Syncthing and OGD Sync.

Annotations are drawn on a layer above the PDF instead of being injected into the page, so scrolling stays smooth and pages never refresh. Your original PDF is never modified.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://github.com/user-attachments/assets/727229a9-2bb2-4eb5-974a-e2fb5cf39be7" width="100%" alt="Highlighting text in pastel colours" /><br />
      <sub><b>Highlight</b> in soft pastel colours</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://github.com/user-attachments/assets/70a282a8-a3cb-4099-844f-34e3591d1098" width="100%" alt="Adding a note to a highlight" /><br />
      <sub><b>Annotate</b> highlights with quick notes</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="https://github.com/user-attachments/assets/27be1622-e0a5-46bc-b008-e6b21be75837" width="100%" alt="Freehand drawing on a PDF" /><br />
      <sub><b>Draw</b> freehand, any way you need</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://github.com/user-attachments/assets/f7cbe421-45e0-492c-bdb5-08c872a63d66" width="100%" alt="Typing text anywhere on a worksheet" /><br />
      <sub><b>Write</b> anywhere: take notes or answer questions</sub>
    </td>
  </tr>
</table>

---

## Features

- **Text highlighting.** Select text and it is highlighted the moment you release the mouse, with a live preview while you drag.
- **Freehand highlighter.** Sweep across anything, including diagrams and scanned pages that have no selectable text.
- **Pen.** Smooth ink with pressure sensitivity on a stylus.
- **Text boxes.** Click anywhere on a page and type. Supports bold, italic, underline, font size, alignment, and bullet and numbered lists. Ideal for worksheets and past papers.
- **Notes on highlights.** Attach a note to any highlight, text or freehand. Hover to read it, click to edit it.
- **Eraser.** Wipe out strokes, highlights or text boxes. A stylus barrel button or eraser end erases too.
- **Undo and redo** for every change, per PDF.
- **Customisable palette and hotkeys**, so the tools fit the way you work.
- **Sync-safe by design.** Each device writes only its own file, so cloud sync can't create conflicts or overwrite another device's work.
- **Crash-safe saving.** Every change is written to disk immediately, so closing the app straight after drawing is fine.
- **Move-proof.** Rename or move a PDF, even outside Obsidian, and its annotations follow it.

---

## Quick start

1. Open any PDF in Obsidian. The Highlighter toolbar appears at the top right, next to Obsidian's own PDF controls.
2. Pick a colour (or press `1` to `9`).
3. Press **`V`**, select some text, and let go. That's a highlight.
4. Press **`H`** to highlight freehand, **`P`** to draw, **`T`** to type, **`E`** to erase.
5. Press the same tool key again to go back to the normal cursor.

Hotkeys work while your mouse is over a PDF, including in split panes, and they are never triggered while you're typing in a note or a search box.

---

## Tools

| Tool | Key | What it does |
|---|---|---|
| **Text** | `T` | Click anywhere to place a text box. Drag a box by its edge to move it. |
| **Select** | `V` | Select text to highlight it instantly. Hover or click highlights to work with notes. |
| **Highlighter** | `H` | Freehand highlighter strokes. Tapping an existing highlight opens its note instead of starting a stroke. |
| **Pen** | `P` | Freehand ink. |
| **Eraser** | `E` | Drag over anything to remove it. Erases whole items, not part of a stroke. |

With no tool active, the PDF behaves exactly like normal reading mode. Highlights that have notes still show a read-only preview when you hover over them.

---

## Notes on highlights

Both text highlights and freehand highlighter strokes can carry a note.

- **Add:** in Select (`V`) or Highlighter (`H`) mode, hover a highlight and click the **+ Note** pill, or hover and press **`N`**, or right-click and choose *Add note*.
- **Read:** hover a highlight that has a note. A small badge marks highlights with notes.
- **Edit:** click the highlight or the preview. `Ctrl/Cmd + Enter` or `Esc` saves and closes.
- **Right-click menu:** add, edit or remove the note, change the highlight's colour, copy the highlighted text, or delete the highlight.

The note editor also lets you recolour or delete the highlight in one place.

---

## Text boxes

Press `T`, click where you want to write, and type.

| Action | Shortcut |
|---|---|
| Bold / Italic / Underline | `Ctrl/Cmd + B` / `I` / `U` |
| Smaller / larger text | `-` / `=` |
| Cycle alignment (left, centre, right) | `Alt + A` |
| Bullet list | `Alt + 8` |
| Numbered list | `Alt + 7` |
| Finish editing | `Esc` |

Pressing `Enter` on a list line continues the list, and pressing it on an empty list line ends it. Choosing a colour while a box is active recolours it. Empty boxes remove themselves when you click away.

---

## Keyboard shortcuts

All of these can be changed in settings.

| Action | Default |
|---|---|
| Text / Select / Highlighter / Pen / Eraser | `T` / `V` / `H` / `P` / `E` |
| Switch colour | `1` to `9` |
| Add or edit note on hovered highlight | `N` |
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Y` or `Ctrl/Cmd + Shift + Z` |

On macOS, `Alt` is `Option`.

---

## Customisation

Open **Settings → Highlighter**.

- **Palette.** Rename, recolour, add or remove colours. The first nine are bound to `1` to `9`.
- **Hotkeys.** Rebind every tool and every text-formatting shortcut.
- **Text font.** Choose a soft sans, Inter, Nunito Rounded or a serif for text boxes.

---

## How your data is saved

Highlighter never edits your PDFs. Annotations live in small files in your vault, and the design assumes your sync tool simply copies files between devices without merging them.

- **One file per device.** Each device writes only to its own file (`_highlighter_d_<device-id>.hl`). Two devices can never overwrite each other, even if one has been offline for months.
- **Automatic merging.** On start-up, on focus and every 15 seconds, Highlighter reads the other devices' files and merges them in. Edits are matched per item, the newest change wins, and deletions are remembered so erased items don't come back.
- **Saved immediately.** Every stroke, highlight, note, colour change and delete is written as it happens. Typing in a text box is saved a fraction of a second after you pause, and again when you leave the box or close the app.
- **Crash-safe writes.** Each save goes to a temporary file, is checked, and only then replaces the real one, so a half-finished write is never the only copy.
- **Backups.** A daily backup is kept automatically, plus a safety snapshot before any large delete.
- **Small.** Files are compressed, and ink is stored compactly. In one real vault, about 800 annotations across 28 PDFs came to roughly 67 KB.
- **Hidden.** The files use an extension Obsidian doesn't index, so they stay out of your file explorer, search and graph.

If you move or rename a PDF, inside or outside Obsidian, Highlighter recognises it (by name, size and a fingerprint of its contents) and reattaches the annotations.

---

## Good to know

- Annotations are stored separately from the PDF, so other PDF viewers won't show them, and there is no export-to-PDF yet.
- The eraser removes whole items. It can't trim part of a stroke.
- Undo history lasts for the current session and is cleared when you restart Obsidian.
- Notes can be attached to highlights, not to pen strokes or text boxes.
- Reinstalling Obsidian or clearing its local storage gives that device a new ID. Nothing is lost, but one extra small file appears.
- Keep a backup of your vault outside your sync service as well. Sync mirrors mistakes as faithfully as it mirrors good changes.

---

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/highlighter/`.
3. In Obsidian, open **Settings → Community plugins**, reload, and enable **Highlighter**.

### With BRAT

Add this repository in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin and enable Highlighter.

---

## Feedback

Found a bug or have an idea? Open an issue. Please include your Obsidian version, your platform, and the steps that led to the problem. If it involves syncing, say which sync tool you use.
