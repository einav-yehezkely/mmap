# mmap user guide

mmap is a private knowledge base for Windows. You write down ideas, concepts and sources as
**nodes**, give each one a rich note, tag them, and attach files. Everything stays in a folder on
your computer. mmap works without an internet connection, has no account, and sends nothing
anywhere.

This guide covers what the current version can do. Features that are planned but not available
yet are listed at the end.

## Workspaces

A **workspace** is a folder on your computer that holds your nodes, notes, tags and attached
files. Each workspace is separate: nothing in one workspace can be seen or linked from another.

### Your first workspace

The first time you start mmap, it creates a workspace called **My Knowledge** in:

```
%APPDATA%\mmap\workspaces\My Knowledge
```

(usually `C:\Users\<you>\AppData\Roaming\mmap\workspaces\My Knowledge`). You can start writing
straight away. To see where the open workspace lives, go to **Settings**, section **Workspace**,
**Location**, and use **Open folder** to show it in File Explorer.

### Creating and switching workspaces

In **Settings**, section **Workspace**, open **Switch or create workspace**.

- **Create a new workspace:** enter a name (up to 80 characters) and choose a location:
  - **Default mmap folder** puts it next to My Knowledge.
  - **Choose a folder on this computer…** asks you for a folder; mmap creates the workspace as a
    new folder inside it, named after the workspace.

  mmap never reuses an existing folder. If a folder with that name exists, it adds `(2)`, `(3)` and
  so on. The new workspace opens immediately.

- **Open existing workspace folder…** lets you pick a workspace folder, for example one you
  copied from another computer. Pick the workspace folder itself (the one that contains
  `mmap-workspace.json`).
- **Recent workspaces** lists the last ten. **Open** switches to one. The **×** button removes it
  from the list only; its files are kept.

When you switch, mmap opens the new workspace first and only then closes the current one. If the
new one cannot be opened, you stay where you were and see a message explaining why.

To rename the open workspace, change **Name** in Settings. This changes the name shown in mmap; the
folder on disk keeps its name.

### Where workspaces can live

- Use a folder on a local drive.
- **Network shares are not supported.** mmap refuses to create or open a workspace on a network
  path (`\\server\share\...`) because the database can be damaged there.
- **Cloud-sync folders** (OneDrive, Dropbox, Google Drive, iCloud Drive, Box) are allowed, but
  Settings shows a warning. A sync program that copies the database while mmap is writing to it
  can damage it. Move the workspace to a folder that is not synced.

### If a workspace cannot be opened

If mmap cannot open the workspace you used last time, it shows a **Choose a workspace** screen
with the reason and the folder path. Common reasons:

- The folder was moved or deleted, or it is on a removable drive that is not connected. Reconnect
  the drive and open the workspace again from the list, or use **Open existing workspace folder…**
  if you moved it.
- The workspace is already open in another mmap window or process. Close the other one. If mmap
  crashed earlier, it detects the leftover lock and opens normally.
- The workspace is open on another computer (for example on a USB drive). Close it there first.
- The workspace was created by a newer version of mmap. Update mmap.
- The database file is missing or damaged.

In every case, **nothing is deleted or replaced**. mmap never creates an empty workspace in place
of one it cannot find.

### Nothing is deleted automatically

mmap does not delete workspaces, and uninstalling mmap leaves all workspace folders in place. There
is currently no way to delete or move a workspace from inside mmap; see
[Not available yet](#not-available-yet).

## Nodes

A **node** is one idea, concept or source. It has a title, an optional summary, tags, a rich note
and attached files. Several nodes can have the same title.

### Creating and finding nodes

- Click **New node** at the top of the window. A node called "Untitled node" is created and opens
  on the right. Type its real title.
- The **Library** lists every node in the workspace with its last update time and tags. Choose
  **Sort by**: Recently updated, Recently created, or Title (A–Z). Click **Load more** to see more
  nodes. Click a node to open it.

### Saving is automatic

There is no Save button. About one second after you stop typing, mmap saves your changes. It also
saves when you leave the title field, close the node, or open another node. The status at the top
of the node panel tells you where things stand:

| Status          | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| Saved           | Your changes are stored on disk.                                                              |
| Unsaved changes | You typed something that is not saved yet; it will be saved in a moment.                      |
| Saving…         | mmap is writing your changes.                                                                 |
| Not saved       | Saving failed. Your text is kept in the editor. Read the message below it (see next section). |
| Conflict        | Someone else saved a newer version of this node first (see [Conflicts](#conflicts)).          |

**If saving fails**, your changes stay in the editor and are never thrown away:

- If the message comes with **Retry saving**, something went wrong on the computer (for example
  the disk was busy). Click it to try again.
- If there is no Retry button, the content itself cannot be saved, for example an empty title, a
  title over 300 characters, a summary over 2,000 characters, or a note that is too large. Fix the
  problem and mmap saves again automatically.

### Conflicts

mmap keeps a revision number for every node. If the node was saved by something else since you
opened it, mmap refuses to overwrite it silently and shows a conflict with three choices:

- **Keep my version**: save your text on top of the newer version.
- **Use the saved version**: drop your changes and show the saved version.
- **Save mine as a new node**: keep both. Your version becomes a new node called
  "Original title (my version)", and this node shows the saved version.

### Recovering unsaved changes

While a change is unsaved, mmap also keeps a recovery copy on this computer. If mmap closes before
it could save (a crash, a power cut, or quitting within a second of typing), the next time you open
that node you see:

> Unsaved changes from (date and time) were found on this computer.

Choose **Restore my changes** to put them back into the editor (they are then saved as usual), or
**Discard them**. If the node was saved again after the recovery copy was taken, mmap warns you
that restoring will replace those newer changes.

### Duplicating a node

**Duplicate** creates a copy called "Original title (copy)" with the same summary, note and tags,
and opens it. Attached files stay with the original node.

### Deleting a node

**Delete…** first shows what will be affected, for example how many attached files will be
deleted with the node. Deleting cannot be undone. The files you originally attached, wherever they
are on your computer, are not affected.

## Rich notes

The **Note** area under the tags is a rich text editor. Use the toolbar above it:

| Toolbar button                                   | What it does                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Bold, Italic, Underline (Ctrl+B, Ctrl+I, Ctrl+U) | Text formatting                                                                          |
| Strikethrough, Inline code                       | More text formatting                                                                     |
| Link                                             | Add, change or remove a link on the selected text                                        |
| Heading 1, Heading 2, Heading 3                  | Section headings                                                                         |
| Bulleted list, Numbered list, Checklist          | Lists; checklist items have a box you can tick                                           |
| Quote, Code block                                | Quoted text and blocks of code                                                           |
| Insert table                                     | Adds a table; inside a table you can add or remove rows and columns, or delete the table |
| Inline formula, Display formula                  | Mathematics (see below)                                                                  |
| Attach files                                     | Adds files to the node (see [Attachments](#attachments))                                 |
| Undo, Redo (Ctrl+Z, Ctrl+Y)                      | Undo or redo your last changes                                                           |

### Mathematics

Formulas are written in LaTeX and displayed with KaTeX. **Inline formula** puts a formula inside a
line of text, for example `E = mc^2`. **Display formula** puts it on its own line. A preview shows
the result while you type. Click a formula later to edit it. For safety, LaTeX commands that create
links or raw HTML (such as `\href`) are not available.

### Links

Links can point to web pages (`https://…` or `http://…`) and email addresses (`mailto:…`). Other
kinds of links, such as links to files on your computer or to programs, are refused. Web addresses
you type or paste become links automatically.

- A normal click on a link only places the cursor, so you can edit the link text.
- **Ctrl+click** a link to open it in your web browser or email program.

### Right-to-left and mixed text

Each paragraph takes its direction from its own text. You can write Hebrew or Arabic paragraphs
and English paragraphs in the same note, and each is aligned correctly. Titles, summaries and tags
work the same way.

### Size

A note can be very long (up to about 2 MB, including its formatting). If a note becomes too large, mmap shows a
message under the editor and does not save until you shorten it. Attached files do not count
towards this limit.

## Tags

Tags group nodes across the workspace. Each workspace has its own tags.

- **Add a tag** in the node panel: type in "Add a tag and press Enter". Existing tags are
  suggested as you type. Tag names can be up to 60 characters.
- Tags are the same regardless of capital letters: typing `physics` when `Physics` exists adds
  the existing tag `Physics`.
- **Remove a tag** from a node with the **×** on its chip. The tag itself still exists.
- **Filter the Library** by clicking tags in the **Filter** row; the number next to each tag is how
  many nodes carry it. When several tags are selected, only nodes carrying all of them are shown.
  **Clear filters** shows everything again.
- **Manage tags** in the Library lets you rename a tag (every node keeps it) or delete it. Deleting
  a tag removes it from the nodes that carry it; the nodes themselves are never deleted.

## Attachments

You can attach files, such as PDFs, images, documents, spreadsheets and audio, to a node.

### Attaching files

Click **Attach files** (the paperclip) in the note toolbar and choose one or more files. mmap
**copies** each file into the workspace folder and inserts it into the note where your cursor is:

- PNG, JPEG, GIF and WebP images are shown inline in the note.
- Every other file appears as a labelled chip. Double-click it to open the file.

All files of a node are also listed under **Attachments** in the node panel, with their size.

Your original files are not changed, moved or deleted. Because mmap keeps its own copy, you can
move or delete the original afterwards and the attachment keeps working.

### Size limit

By default a file can be at most 20 MB. To change this, go to **Settings**, section
**Attachments**, **Maximum size per attached file (MB)**, and enter a value from 1 to 1024. The
setting applies to this computer only. Large limits use disk space, because every file is copied
into the workspace.

### What is refused, and why

When you attach several files, each one is checked on its own; a refused file never stops the
others. A message under **Attachments** names each refused file and the reason:

| Message                                                   | Why                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Programs and scripts cannot be attached, for your safety. | Programs, installers, scripts, shortcuts, disk images and macro-enabled Office files (for example `.exe`, `.msi`, `.bat`, `.ps1`, `.js`, `.lnk`, `.iso`, `.docm`, `.xlsm`). mmap also checks the file's content, so a renamed program is still refused. |
| The file is larger than the … MB limit.                   | The file is bigger than your size limit.                                                                                                                                                                                                                |
| The file is empty.                                        | The file has no content.                                                                                                                                                                                                                                |
| The file name cannot be used.                             | The name is one Windows treats specially (such as `CON`) or contains characters that cannot be used.                                                                                                                                                    |
| The selected file could not be read…                      | The file was moved, deleted or is locked by another program.                                                                                                                                                                                            |
| The file changed while it was being copied…               | Another program was still writing the file. Wait until it is finished and try again.                                                                                                                                                                    |
| There is not enough disk space…                           | The drive holding the workspace is full.                                                                                                                                                                                                                |
| mmap does not have permission…                            | Windows did not allow mmap to write to the workspace's attachments folder.                                                                                                                                                                              |

mmap never runs attached files itself. Accepting a file does not mean it is safe; mmap does not
scan for viruses. Use your usual antivirus protection.

### Opening and removing files

- **Open** (the arrow button in the Attachments list, or double-click in the note) opens the file
  in its default application. mmap checks the stored copy again first and will not open it if it
  has turned into a program. If the copy is missing, you see "This file could not be opened."
- **Remove** (the bin button) asks for confirmation, then deletes the workspace copy. Your
  original file elsewhere on this computer is not affected. Where the file appeared in the note, its
  name remains as a label.
- Deleting a node deletes all of its attached copies.

## Backups

**Backups and exports are not available yet. To back up a workspace, quit mmap and copy the
closed workspace folder** (for example to an external drive). To use the copy, open it with
**Open existing workspace folder…**.

The only automatic copy mmap makes today is a safety copy of the database before a newer version
of mmap upgrades a workspace's storage format. It is placed in the workspace's `recovery` folder.
This is not a general backup.

## Not available yet

These features are planned for later versions:

- **Search** (the search box is visible but disabled), relationships between nodes, and
  `[[wikilinks]]` with backlinks.
- **Mind maps** and the **knowledge graph**.
- **Timeline**: mmap already records when you create nodes and edit notes, but there is no view
  for it yet, and you cannot yet mark a node as reviewed.
- **Export, import and backups** inside the app.
- **Moving or deleting a workspace** from inside mmap. To move one, quit mmap, copy the folder, and
  open the copy with **Open existing workspace folder…**. Remove the old folder yourself only once
  you have checked the copy.
- **More than one window.**

The Mind Maps, Knowledge Graph and Timeline areas in the sidebar show a short note saying when
they become available.
