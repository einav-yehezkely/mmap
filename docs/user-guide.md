# mmap user guide

mmap is a private knowledge base for Windows. You write down ideas, concepts and sources as
**nodes**, give each one a rich note, tag them, attach files, connect them with typed
**relationships**, link to other nodes from inside a note, arrange nodes on **mind maps**, explore
everything in the **knowledge graph**, look back on your activity in the **timeline**, and
search everything you wrote. Everything stays in a folder on your computer, mmap backs it up
every day, and you can export it to a single file to move or keep it. mmap works without an
internet connection, has no account, and sends nothing anywhere.

This guide covers what the current version can do. Features that are planned but not available
yet are listed at the end.

## Home

mmap opens on **Home**, the first item in the sidebar. It shows where you left off and what you
can do next:

- A greeting with today's date and the name of the open workspace. The time of day and the date
  follow the workspace's [timezone](#timezone).
- **Quick actions**: **New node** (start a new note), **Search** (jump to the search box; also
  **Ctrl+K**), **Mind maps** and **Knowledge graph**.
- **Continue where you left off**: the six notes you edited most recently, with how long ago.
  Click one to open it; **All notes** opens the Library.
- **Mind maps**: your most recently changed maps. Click one to open it; **All maps** opens Mind
  Maps.
- **Recent activity**: the latest entries from the [timeline](#timeline); **Timeline** opens it.
- A line at the bottom with the number of notes and maps, when you were last active, and the
  backup status: "Backed up 2 hours ago", "No backup yet", or "The last backup failed — check
  Settings". Click it to go to Settings.

In a new, empty workspace, Home shows three steps under **Get started** instead: write your first
note, link ideas together, and see the big picture on mind maps and the graph.

## More than one window

Click **New window** at the bottom of the sidebar (or press **Ctrl+Shift+N**) to open another
window on the same workspace, for example a map in one window and a note in the other. In an open
note, **New window** opens that note in its own window, to compare two notes side by side.

All windows work on the same notes. When you switch to a window, it shows what you changed in the
others. If two windows change the same note at the same time, the second save shows the usual
conflict message with your text kept, so nothing is lost. Closing the last window quits mmap.

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
- **Cloud-sync folders** (OneDrive, Dropbox, Google Drive, iCloud Drive, Box) are allowed, but a
  warning is shown at the top of the window and in Settings. A sync program that copies the
  database while mmap is writing to it can damage it. Use **Move workspace…** to move it to a
  folder that is not synced.

#### If you want your notes in OneDrive (or Dropbox, Google Drive…)

Keep the workspace itself in a normal folder on your computer, and let mmap put **backups** in the
cloud instead:

1. In **Settings › Backups**, click **Change folder…** and choose a folder inside OneDrive, for
   example `OneDrive\mmap backups`.
2. In OneDrive, right-click that folder and choose **Always keep on this device**, so you can see
   and restore your backups even when you are offline.

mmap then backs up there every day. Backups suit sync folders: each backup is complete before it
gets its final name and never changes afterwards, and every file is checked against its checksum
when you restore. To move to another computer, install mmap there, wait until OneDrive has synced
the folder, and use **Settings › Backups › Restore from a backup folder…**, or move a ZIP export
(**Settings › Export and import**). Do not open the same workspace on two computers at once
through a synced folder.

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

### Moving a workspace

**Settings › Workspace › Move workspace…** asks for a local folder and moves the workspace into
it. mmap closes the workspace, copies every file, checks that each copy is identical to the
original, opens the copy, and only then moves the old folder to the **Recycle Bin**. If anything
goes wrong, the copy is discarded and the workspace stays where it was. If the old folder cannot
be moved to the Recycle Bin (for example because another program has a file open), mmap tells you
where it is so you can delete it yourself.

### Deleting a workspace

**Settings › Workspace › Delete workspace…** shows the folder that will be removed and asks you
to type the workspace name. The folder is moved to the **Recycle Bin**, so you can restore it
from there until you empty the bin. Copies of the folder you made elsewhere, backups and exports
are not affected (see [Deleting data and backups](#deleting-data-and-backups)).
If the folder cannot be moved to the Recycle Bin, nothing is deleted and the workspace opens
again.

### Nothing is deleted automatically

mmap never deletes a workspace on its own, and uninstalling mmap leaves all workspace folders in
place. **Remove from list** in the recent workspaces only forgets the entry; the folder stays.

## Nodes

A **node** is one idea, concept or source. It has a title, an optional summary, tags, a rich note
and attached files. Several nodes can have the same title.

### Creating and finding nodes

- Click **New node** at the top of the window (or on Home, or in the Library). Type a title (it
  can be changed later; an empty title becomes "Untitled node") and click **Create node**. The new
  node opens: across the whole window when you are on Home or in the Library, otherwise on the
  right.
- **Add to Mind Maps** in the same window is optional: tick one or more maps to place the node on
  them right away, or tick none to keep it only in the Library. If you open the window while a
  map is open, that map is already ticked. In a hierarchy map, choose where it goes with **Place
  under** (an existing item, or **Top level** for a new root). One node is created and shown on
  every map you ticked; it is placed at a free spot near the map's other items, never on top of
  one. Relationships it has with nodes already on those maps appear there straight away.
- The **Library** lists every node in the workspace with its last update time and tags. Choose
  **Sort by**: Recently updated, Recently created, or Title (A–Z). Click **Load more** to see more
  nodes. Click a node to open it.
- **Notes opened from Home or the Library fill the window**, so there is room to write. Tags,
  relationships, maps, attachments and links sit beside the note, or under it in a collapsed
  **Details** section when the window is narrow. **Back to Home** (or **Back to Library**)
  returns you to the same place on the page. Changes are saved as you type; if the last save
  failed, mmap asks before you leave.
- **Add to mind maps…** in an open node lists the maps it is on and adds it to more maps.
- To find a node by what it says, use the **search box** at the top of the window (see
  [Search](#search)).

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
and opens it. Attached files stay with the original node. Relationships are not copied. Links in
the note are copied with the note, so the nodes it links to also list the copy under
**Linked from**.

### Deleting a node

**Delete…** first shows what will be affected: how many relationships and attached files will be
deleted with the node, and how many other notes link to it. Those links are not removed from the
other notes; they stay readable and are marked as unresolved so you can repair them (see
[Linking to other nodes](#linking-to-other-nodes)). Deleting cannot be undone. The files you
originally attached, wherever they are on your computer, are not affected.

## Rich notes

The **Note** area under the tags and relationships is a rich text editor. Use the toolbar above it:

| Toolbar button                                   | What it does                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Bold, Italic, Underline (Ctrl+B, Ctrl+I, Ctrl+U) | Text formatting                                                                          |
| Strikethrough, Inline code                       | More text formatting                                                                     |
| Link                                             | Add, change or remove a link on the selected text                                        |
| Heading 1, Heading 2, Heading 3                  | Section headings                                                                         |
| Bulleted list, Numbered list, Checklist          | Lists; checklist items have a box you can tick                                           |
| Quote, Code block                                | Quoted text and blocks of code                                                           |
| Right to left                                    | Writes the selected paragraphs right to left; press again for the automatic direction    |
| Insert table                                     | Adds a table; inside a table you can add or remove rows and columns, or delete the table |
| Inline formula, Display formula                  | Mathematics (see below)                                                                  |
| Link to a node ([[)                              | Links to another node (see [Linking to other nodes](#linking-to-other-nodes))            |
| Attach files                                     | Adds files to the node (see [Attachments](#attachments))                                 |
| Undo, Redo (Ctrl+Z, Ctrl+Y)                      | Undo or redo your last changes                                                           |

### Mathematics

Formulas are written in LaTeX and displayed with KaTeX. **Inline formula** puts a formula inside a
line of text, for example `E = mc^2`. **Display formula** puts it on its own line. A preview shows
the result while you type. Click a formula later to edit it. For safety, LaTeX commands that create
links or raw HTML (such as `\href`) are not available.

### Web links

Web links can point to web pages (`https://…` or `http://…`) and email addresses (`mailto:…`).
Other kinds of links, such as links to files on your computer or to programs, are refused. Web
addresses you type or paste become links automatically.

- A normal click on a web link only places the cursor, so you can edit the link text.
- **Ctrl+click** a web link to open it in your web browser or email program.

Links to other nodes work differently; see [Linking to other nodes](#linking-to-other-nodes).

### Right-to-left and mixed text

Each paragraph takes its direction from its own text. You can write Hebrew or Arabic paragraphs
and English paragraphs in the same note, and each is aligned correctly. Titles, summaries and tags
work the same way.

When a paragraph starts with a word in the other direction (for example a Hebrew sentence that
begins with an English term), set its direction yourself: put the cursor in it, or select several
paragraphs, and press **Right to left** in the toolbar. Press it again to go back to the automatic
direction. The choice is saved with the note.

### Size

A note can be very long (up to about 2 MB, including its formatting). If a note becomes too large, mmap shows a
message under the editor and does not save until you shorten it. Attached files do not count
towards this limit.

## Linking to other nodes

You can link from a note to another node, wiki style. A link is a reference inside your text; it
is **not** a relationship (see [Links and relationships are different](#links-and-relationships-are-different)).

### Adding a link

1. In the note, type `[[` (or click **Link to a node ([[)** in the toolbar). The brackets
   disappear and a **Link to a node** window opens.
2. Start typing the node's title. Titles that start with what you typed are listed first, then
   titles that contain it. Use the arrow keys and Enter, or click.
3. If the node does not exist yet, choose **Create a new node “…”** at the end of the list. mmap
   creates the node with that title and links to it. A node is only ever created when you choose
   this option.

The link appears in the note as `[[title]]`, using the node's title at the moment you linked it.
To show different text, fill in **Link text (optional)** in the same window before choosing the
node; for example, link to "Photosynthesis" with the text "how plants make sugar".
Links are always to one specific node you picked, so two nodes with the same title are never
confused.

### Following a link

Click a link to open the linked node. (Web links need Ctrl+click; node links open with a normal
click.)

### Renaming keeps links working

A link remembers which node it points to, not its title. If you rename the linked node, the link
still opens it. The link text in your note stays as you wrote it; hovering over the link shows the
node's current title.

### Unresolved links and repair

If the linked node is deleted, the link stays in your note so you can still read it, but it is
shown struck through with a red dashed outline, and its tooltip says "Unresolved link". Click it
to **Repair link**: choose another node (or create a new one), and the link points there from now
on. The link text does not change.

### Links and relationships are different

Writing a link never creates a relationship between the two nodes. Links show up under
**Linked from** on the node you link to; relationships are added only on purpose, in the
**Relationships** section (see [Relationships](#relationships)).

## Linked from (backlinks)

The node panel has a **Linked from** section listing every other note that links to this node,
with the title of that note and a short piece of text around the link. If a note links here
several times, it is listed once with the number of links. Click a title to open that note.

The list follows saved notes: when you remove a link from a note, the entry disappears once that
note has been saved (about a second after you stop typing). A note that links to itself is not
listed.

## Relationships

A **relationship** is a statement you make about two nodes, such as "Entropy _depends on_
Probability". Relationships have a **type**, and every type is either:

- **directed** (shown with an arrow, `→`): it reads from a source to a target. "A depends on B" is
  not the same as "B depends on A", and both can exist; or
- **undirected** (shown with a dash, `—`, and no arrow): it reads the same both ways. "A related
  to B" and "B related to A" are the same relationship.

Every workspace starts with five types: **related to** (undirected), **depends on**, **part of**,
**example of** (directed) and **contradicts** (undirected).

Relationships are only created when you add them yourself. Links in notes never create them.

### Adding a relationship

1. Open a node and find the **Relationships** section under the tags.
2. Click **Add**.
3. Choose the type. The form reads as a sentence: "This node", the type, then the other node. For
   a directed type, this node is the source; click **Swap** if it should be the target instead.
4. Type part of the other node's title in the field below and pick it from the list. (Creating a
   new node from here is not possible; create it first with **New node**.)
5. Optionally explain **Why are they related?** (up to 1,000 characters).
6. Click **Add relationship**.

mmap refuses:

- a relationship from a node to itself;
- a relationship that already exists with the same type and direction. For undirected types this
  includes the reversed pair: if "A related to B" exists, "B related to A" is refused.

Two nodes can still have several relationships of different types.

### Reading relationships

Each relationship is shown as a sentence. The node you are looking at is shown as **this node**;
the other node is a link you can click to open it. Directed relationships show `— type →`,
undirected ones `— type —`.

### Changing and deleting

- **Reverse** (directed relationships only) swaps source and target. It is refused if the reversed
  relationship already exists.
- The **type** menu on each relationship changes its type. If you change an undirected
  relationship to a directed type, check the arrow afterwards and use **Reverse** if needed.
- The **bin** button deletes the relationship after confirmation. Both nodes stay.

The explanation you typed when adding a relationship is shown under it. It cannot be edited
afterwards yet; delete and re-add the relationship to change it.

### Relationship types

Click **Types** in the Relationships section to manage types:

- **Create** a type: enter a name (up to 60 characters) and choose **→ directed** or
  **— undirected**. Names are unique regardless of capital letters.
- **Rename** a type (the pencil). Every relationship keeps it.
- **Archive** a type (the box). Existing relationships keep it and still show it, but it is no
  longer offered for new relationships. **Restore** brings it back. Types are never deleted.
- **Direction** can be changed only while no relationship uses the type. Once a type is in use, the
  direction control is locked; create a new type with the other direction instead. mmap does this
  so that existing relationships never change meaning.

Each type shows how many relationships use it.

## Mind maps

A **mind map** arranges nodes from your library on a canvas. A map never copies a node: it shows
the node itself. The same node can appear on as many maps as you like, but only once on each map.
If you rename a node or edit its note, every map shows the change. Where a node sits on a map, its
color and its place in a hierarchy belong to that map only, so moving it on one map does not move
it on another.

### Creating and managing maps

Open **Mind Maps** in the sidebar.

- **New map** asks for a title (up to 200 characters) and a **Layout**:
  - **Freeform**: place items anywhere and draw connectors between them.
  - **Hierarchy**: arrange items as an outline with automatic layout.

  You can switch between the two later. The new map opens straight away.

- The list shows each map's layout, number of items and last change, most recently changed first.
  Click a map to open it; **All maps** takes you back.
- **Rename** (the pencil) changes the title.
- **Duplicate** (the two squares) creates "Title (copy)" with the same nodes, positions,
  hierarchy, colors and connectors. The nodes are not copied; both maps show the same nodes.
- **Delete** (the bin) asks for confirmation. The map with its layout and connectors is deleted;
  the nodes on it stay in your library with their notes, tags and relationships.

### The map editor

The editor shows the map's title, a **Freeform** / **Hierarchy** switch and a **Color** menu at
the top, the canvas on the left, and the **outline** (a list of the map's items) on the right,
with a short legend below it.

- **Pan** by dragging the empty background; **zoom** with the mouse wheel or the + and − buttons in
  the corner of the canvas. The third button there (fit view) shows the whole map.
- mmap remembers where you panned and zoomed for each map. A map you open for the first time is
  fitted into view.
- **Preview a node** by double-clicking it on the canvas, or by selecting it in the outline and
  pressing Enter or **Open**. Its summary, tags and note open read-only beside the map, with its formatting,
  formulas and attachments. Click a node link in the preview to preview that node. To change the
  note, select the **pencil** in the preview's top corner: the node panel opens, the same one as
  in the Library. Escape or **×** closes the preview.
- When a panel beside the map leaves little room, the outline moves below the map.

### Adding nodes to a map

Click **Add** in the outline (or press **Insert** while the outline has focus). In the window that
opens, type part of a node's title and pick it, or choose **Create a new node “…”** to create a
node with that title and place it. A node is only created when you choose that option. Nodes that
are already on the map are not offered.

In a freeform map, new items appear to the right of the existing ones. In a hierarchy, **Add
child** adds the new item under the selected one, and **Add top-level** adds it at the top level.

To put an item that is **already on the map** under another one, select the new parent, click **Add
child**, and type the item's title: it is listed as "already on this map; moves here". Choosing it
moves the item, with everything under it, below the selected one. (A node appears only once on a
map, so it is moved rather than added twice.)

### Relationships on maps

A map shows the relationships between the nodes on it as **colored curved lines** labeled with
the relationship type, with an arrow when the relationship has a direction (for example "Energy
depends on Heat" points from Energy to Heat; "related to" has no arrow). This happens wherever
the relationship was made, in the node panel, the Library or the graph, and every map that has
both nodes shows it. Changes appear as soon as they are saved: changing the type or deleting the
relationship updates every map.

These lines belong to the nodes, not to the map. They never move items or change a hierarchy,
and they cannot be removed from a map; change or delete the relationship on the node instead. If
only one of the two nodes is on a map, nothing is drawn and the other node is not added. A
relationship that a map connector already shows (a connector linked to it) is drawn only once.

### Freeform maps

- **Move** an item by dragging it, or select it and use the arrow keys. Positions are saved
  automatically.
- **Draw a connector** by dragging from any of the four dots around an item (left, right, top or
  bottom) to another item. Connectors are dashed arrows from the item where you started. They may
  form loops. Each line attaches to the sides that face each other: side to side when the items
  are next to each other, top to bottom when one is below the other, and it follows when you move
  an item.
- Connectors are pictures on this map only. They never create relationships between the nodes.
- **Write a note on a connector**: click the connector, then the speech-bubble button on it. Type
  the note (up to 200 characters, in any language) and press Enter, or click elsewhere. Escape
  cancels. Double-click a note to change it; erase its text to remove it. Ctrl+Z (or **Undo**)
  reverses the last note change, like other connector changes.
- **Show a relationship on a connector**: when the two notes have a relationship (added in a
  note's Relationships section), click the connector, then the link button on it, and choose the
  relationship. The connector then shows its type, and the separate relationship line is no longer
  drawn. **Remove the link** turns it back into a plain connector; the relationship stays. Ctrl+Z
  undoes this too.
- **Select several items** with Ctrl+click, or by holding Shift and dragging a box around them.
- **Remove** the selected items or connectors with **Delete** (or Backspace) while the map canvas
  has focus. This removes them from the map only; the nodes stay in your library.

### Hierarchy maps

In a hierarchy, mmap lays out the items as a tree that grows from left to right: top-level items
on the left, their children to the right, connected by solid lines. A map can have several
top-level items, and every other item has exactly one parent. The layout is automatic, so items
cannot be dragged.

- **Reorder and nest** items in the outline: select an item and press **Alt+Up** or **Alt+Down**
  to move it among its siblings, **Alt+Right** to indent it under the item above it, or
  **Alt+Left** to outdent it to just after its parent. The arrow buttons above the outline do the
  same.
- An item cannot be moved inside its own branch; mmap refuses with "This would put an item inside
  its own branch."
- **Collapse** a branch with the small arrow on an item (a collapsed item shows how many items it
  hides), or with Left and Right in the outline. Collapsing is remembered.
- The hierarchy only arranges this map. Putting B under A does **not** create a "part of"
  relationship between them.
- Connectors drawn in freeform mode are still shown as dashed arrows. New connectors can only be
  drawn in freeform mode.

### Colors

Select an item and choose a **Color**: Gray, Blue, Green, Amber, Red, Violet, or Default. The
color belongs to this map only. Colors are for your own orientation; mmap never uses them to mean
anything.

### Switching a freeform map to a hierarchy

Click **Hierarchy**. Because every item in a hierarchy needs exactly one parent, mmap first shows
a **Switch to hierarchy** window. For a map that has never been a hierarchy, the suggestions are
based on your connectors:

- A connector from A to B suggests that A is the parent of B.
- Items that no connector points at start at the top level.
- If connectors from several items point at an item, or if following its connector would create a
  loop, mmap does not guess. The item is listed under **Choose a parent**, and you pick one of the
  candidates or **Top level (no parent)**. **Switch to hierarchy** stays disabled until every such
  item has a decision.
- Under **Review the … suggested parents** you can change any suggestion to **Top level**.
- If your choices would put items in a loop, mmap names those items and asks you to choose
  **Top level** for one of them before you can switch.

To give an item a parent that is not suggested, switch first and then move it in the outline.

### Switching back to freeform

Click **Freeform**. Every item returns to the position it had on the freeform canvas, because
mmap keeps those positions while the map is a hierarchy. Items you added while in hierarchy mode
appear to the right of the others.

mmap also keeps the hierarchy. When you switch to hierarchy again, the **Switch to hierarchy**
window suggests the hierarchy you had before (items added in the meantime start at the top
level), not suggestions from connectors.

### Keyboard use

The outline lets you do everything without a mouse. Click an item in it (or Tab to it), then:

| Key                 | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| Up, Down, Home, End | Move to the previous, next, first or last item                 |
| Right, Left         | Expand or collapse an item, or go to its first child or parent |
| Enter               | Open the node                                                  |
| Insert              | Add an item (in a hierarchy, as a child of the selected item)  |
| Delete              | Remove the item from this map                                  |
| Alt+Up, Alt+Down    | Move the item up or down among its siblings (hierarchy)        |
| Alt+Right           | Indent the item under the item above it (hierarchy)            |
| Alt+Left            | Outdent the item to just after its parent (hierarchy)          |

In a freeform map the outline lists items by title; on the canvas, the arrow keys move the
selected item.

### Removing items keeps your nodes

- **Removing an item from a map** (Delete, or **Remove** in the outline) takes it off this map
  only. The node stays in your library and on other maps. In a hierarchy, its children move up to
  take its place, so no branch disappears.
- **Deleting a map** never deletes nodes.
- **Deleting a node** (from the node panel) removes it from every map. The delete preview says on
  how many maps it is placed. Its children on those maps move up to take its place.

### If a change is not applied

If a map was changed somewhere else after you opened it, for example because a node on it was
deleted, mmap does not apply your change on top. It shows the latest version of the map with the
message "This map was changed elsewhere, so your last change was not applied." Make the change
again.

## Knowledge graph

**Knowledge Graph** in the sidebar shows your nodes and the relationships between them across the
whole workspace. It shows the same nodes as the Library and your maps, not copies, and looking at
the graph never changes your knowledge or your maps; it only remembers where you placed nodes in
the graph.

### The toolbar

Above the graph:

- **Find in graph**: type part of a title to get up to eight matching nodes that are on the graph
  now; choose one (or press Enter for the first) to select it and move the view to it.
- **−** and **+** zoom out and in; **Fit** shows the whole graph again.
- **Rearrange** lays out the visible graph again. It replaces the positions you gave those nodes
  by dragging.
- **Show Maps** marks which mind maps each node is on (see [Mind maps in the graph](#mind-maps-in-the-graph)).
- **All labels** writes the relationship type on every line (otherwise labels appear when you
  point at a line or select a node).
- **Note links** adds the links you wrote in notes (`[[…]]`).
- **Filters** opens and closes the filter panel; the button shows how many filters are active.
- **Graph** and **List** switch between the drawing and the [List](#the-list-tab).

### Reading the graph

- Each dot is a node; better-connected nodes are drawn larger. Its title is written below it,
  shortened if it is long. Point at a node to see its full title and its maps.
- A line with an **arrow** is a directed relationship, read from the source to the target ("A
  depends on B" points from A to B). A line **without an arrow** is an undirected relationship.
- With **Note links** on, note links are **dashed** lines without an arrow. They are not
  relationships, so they are drawn differently and are off by default. Several links from one note
  to the same node are one line. The List says which way each link goes.
- Being on the same mind map never draws a line between two nodes.

The line under the graph repeats what the lines mean.

### Adding a relationship from the graph

Select a node, then press **Add relationship** in the panel on the right. Choose the type, then the
other node: click it on the graph, find it with **Find in graph**, or type its title in the form.
Clicking nodes on the graph does not change the selection while the form is open. Add an
explanation if you like, and press **Add relationship**. The new line appears at once. **Cancel**
or Escape closes the form.

### Where nodes are placed

The graph remembers where nodes are. The first time you open it, mmap arranges the graph for you
(for up to 300 nodes; in a larger graph, nodes are placed next to their neighbors without
overlapping, and **Rearrange** arranges them). After that:

- New nodes, and nodes that appear because of a filter or an expansion, are placed next to the
  nodes they are connected to. Nothing that is already on screen moves.
- **Drag** a node to move it; mmap remembers the new place.
- Positions in the graph are separate from your mind maps: moving a node here never moves it on a
  map, and the reverse.
- **Rearrange** arranges the visible nodes again when the picture has become untidy.

The graph always opens showing everything, and fits again when you change a filter or enter or
leave Focus mode. It never zooms in so far that a few nodes fill the screen. Drag the background
to pan and use the mouse wheel to zoom; once you have done so, the view stays where you put it.

### Filters

Click **Filters** to open the panel:

- **Text**: shows only nodes whose title, summary or note contains the words, with the same rules
  as [search](#how-matching-works). The graph updates a moment after you stop typing.
- **Tags**: click tags to keep only nodes that carry all selected tags.
- **Types**: click relationship types to show only relationships of those types, and only nodes
  that take part in at least one of them. Directed types are marked with `→`. Archived types are
  not listed.
- **Mind maps**: search the list of maps and tick one or more to show only nodes that are on any
  of them. Each map shows how many nodes it has, an **eye** button that highlights its nodes
  without filtering, and a button that opens the mind map.

Filters work together: a node must match all of them. **Clear all filters** removes them.

### When the view is partial

A workspace with many nodes is not drawn all at once. The graph first shows at most **1,000**
nodes, the most connected ones first, and at most 3,000 relationships between them. The line
above the graph always tells you what you are looking at:

- "Showing all 240 matching nodes." means nothing that matches your filters is missing.
- "Partial view: showing 1,000 of 10,000 matching nodes, the most connected first." means other
  nodes match but are not drawn. Narrow the filters, or expand a node to see its neighbors. The
  line turns amber while the view is partial.
- Further sentences say when some relationships or note links between the shown nodes were left
  out, or when an expanded node has more neighbors than were added.

If the line does not say "Showing all", do not assume that a missing node or connection does not
exist.

### Selecting a node

**Click** a node to select it. The node, its direct neighbors and the lines between them stay
bright and everything else fades. A panel on the right shows:

- the title, summary and tags;
- the **mind maps** the node is on, each with an **eye** button (highlight that map's nodes on the
  graph) and a button that opens the mind map;
- its relationships in words, with direction;
- **Open note**, which opens the node in the side panel as everywhere else in mmap
  (**double-clicking** a node does the same);
- **Focus** and **Expand neighbors** (below).

Click the empty background, or the panel's close button, to clear the selection.

### Focus mode and expanding

- **Focus** shows only the selected node and the nodes directly connected to it. The line above
  the graph says which node is in focus; **Exit focus** brings the rest back.
- **Expand neighbors** adds the nodes directly connected to a node (up to 200 at a time) and the
  relationships between them. Expanded nodes get an outline. In Focus mode, expanding a node adds
  its neighbors to what is shown.

mmap keeps your expansions when the graph reloads, for example after you change a filter or edit
a note. They are removed when you leave the Knowledge Graph.

### Mind maps in the graph

The graph shows each node once, however many maps it is on.

- Turn on **Show Maps** to color nodes by map: a node on maps is drawn as a small pie with one
  slice per map. A node on more than six maps gets six colored slices and one gray slice. The line
  under the graph lists the map colors. Colors repeat after eight maps, so the map names (when you
  point at a node, in the panel and in the List) are what count.
- The **eye** button next to a map (in the filter panel or the node panel) highlights that map's
  nodes and fades the rest. The line above the graph says which map is highlighted; click **×** to
  stop.
- The open-map button opens the map in **Mind Maps**, with the map's own layout.
- Turn on **Regions** to outline each map's nodes with a soft colored area labeled with the map's
  name. Areas can overlap: a node on two maps lies inside both areas and is still shown once. If you
  have many maps, regions are drawn for twelve of them; choose maps in **Filters** to pick which.
- The **collapse** button next to a map (in **Filters**) folds the map into one box showing its
  name and how many nodes it has. Nodes that are only on collapsed maps are tucked into the box;
  a node that is also on another, expanded map stays visible. Lines from the box (for example
  "3 connections") stand for relationships to the hidden nodes. Click the box, or **Expand all**
  above the graph, to show the nodes again. Collapsing only changes this view: nothing in the map
  or your knowledge changes.

### The List tab

Switch from **Graph** to **List** to see the same nodes as a list, sorted by title, which works
fully with the keyboard and screen readers. Each node lists its mind maps and its connections in
words, with direction:

- "depends on → Probability": this node depends on Probability;
- "← depends on Entropy": Entropy depends on this node;
- "related to — Heat": an undirected relationship;
- "note links to Heat" and "linked from the note of Heat": note links, when **Note links** is on.

Each row has **Open**, **Focus** and **Expand** buttons. The list shows exactly what the graph
shows (in Focus mode, only the nodes in focus), so the line above it applies to the list too.

## Timeline

**Timeline** in the sidebar shows what you did and learned in this workspace:

- **Created**: a node was created (including by duplicating one).
- **Note edits** ("Edited the note of"): you edited a node's note. Edits are grouped into one
  entry per editing session, which ends after 30 minutes without changes, so you see
  "09:05–09:40" instead of one entry per autosave. Changing only a title or summary is not
  recorded.
- **Relationships** ("Added a relationship from"): you added a relationship; the entry names the
  node the relationship starts from.
- **Reviews**: you marked the node as reviewed, with your reflection if you wrote one.
- **Milestones**: a learning milestone you added, such as finishing a course or understanding a
  hard idea.

The timeline is a record of what happened. It does not score, rate or estimate how well you know
something, and it never adds entries on its own beyond the activity listed above.

The screen has two tabs: **Timeline**, a time axis you can move along, and **List**, the same
entries as a list.

### Recorded time and learning date

Every entry has the time it was **recorded**, which never changes. You can also give any entry a
**learning date**: when the learning actually happened, for example if you review today something
you learned last week. An entry with a learning date is shown at that date, both on the axis and
in the list; without one it is shown at the recorded time. A learning date cannot be in the
future or before 1900.

### The time axis

The **Timeline** tab shows a horizontal line of time: older entries on the left, newer ones on the
right. Dates along the line are shown in the workspace's timezone, and a **Now** line marks the
present. It opens on your recent activity, with now near the right edge; if nothing happened
recently, it opens on your latest entry instead.

- **Move through time**: click **‹** (earlier) or **›** (later), drag the background, or use the
  mouse wheel or touchpad.
- **Zoom**: click **Day**, **Week**, **Month** or **Year**, or hold **Ctrl** and use the mouse
  wheel. Zooming keeps the selected entry (or now, when it is visible) in the same place.
- **Today** brings back the present.

Each kind of entry has its own shape and icon, as well as its own color:

| Entry         | Marker                                                              |
| ------------- | ------------------------------------------------------------------- |
| Created       | Circle with a plus                                                  |
| Note edits    | Bar; an editing session stretches from its start to its last change |
| Relationships | Diamond with a link                                                 |
| Reviews       | Square with a book and check mark                                   |
| Milestones    | Pennant with a flag                                                 |

A small dot on a marker means the entry is shown at a learning date you set. The legend under the
axis explains the shapes in words.

Markers that would overlap are stacked in rows. When you zoom out, entries close together become
one round marker with a number; click it to zoom in and see them one by one.

The line under the axis says how many entries are in the period shown. If there are none, it
says "No events in this period." and offers **Go to the latest event**. If a long period holds
very many entries (more than 2,000), it says "Showing N of M events in this period, spread across
it; zoom in to see them all": entries are then taken evenly across the whole period, so a busy day
never hides a quieter week. Zoom in to see every entry.

**Keyboard**: every marker and numbered marker can be reached with **Tab** and activated with
**Enter** or **Space**; screen readers announce what each marker stands for and when it happened.
The **List** tab presents the same entries as an ordinary list.

### The List tab

**List** shows the entries newest first, grouped by day, with the time, what happened, the node or
milestone title and any reflection. Entries placed at a learning date are marked **learning
date**. **Load more** at the bottom shows older entries.

### Entry details

Click an entry, on the axis or in the list, to open its details at the side:

- What happened, the title and the **Recorded** date (for an editing session, from start to
  end), and the **Learned** date if you set one.
- **Open …** opens the node. Entries of deleted nodes stay in the timeline with the title the node
  had, marked "(deleted)".
- **When did the learning happen?**: pick a date and time and click **Save learning date** to move
  the entry to that date. **Use recorded time** removes the learning date again. This works for
  every entry.
- For your reviews and milestones: edit the **Title** (milestones), the **Details** (milestones)
  or the **Reflection** (reviews) and click **Save**, or click **Delete** and confirm. Deleting
  removes the entry from the timeline; nodes are not changed.

Only your reviews and milestones can be edited or deleted. Created, edited and relationship
entries are a record of what happened: you can give them a learning date, but you cannot change or
delete them.

### Marking a node as reviewed

1. Open the node.
2. Click **Mark as reviewed…** at the bottom of the side panel.
3. Optionally write a short **reflection**: what became clear, what to revisit. It can have
   several lines and up to 2,000 characters.
4. Optionally fill in **When did you learn this?**. Leave it empty to use the current time.
5. Click **Mark as reviewed**. "Review recorded in the timeline." confirms it.

You can mark the same node as reviewed as often as you like; each time adds an entry.

### Adding a milestone

1. On the Timeline screen, click **Add milestone**.
2. Enter a **Title** (up to 200 characters).
3. **When did it happen?** is set to now; change it if the milestone was earlier. Left unchanged,
   the milestone is placed at the moment you add it; a changed date becomes its learning date.
4. Optionally add **Details** (up to 2,000 characters) and a **Related node**.
5. Click **Add milestone**.

### Filters

Click **Filters** to open or close the filter panel. The button shows how many filters are on.

- **From** and **To**: only entries on these days, in your timezone (see below). Either can be left
  empty. Choosing dates also moves the axis to that period.
- **Event types**: click **Created**, **Note edits**, **Relationships**, **Reviews** or
  **Milestones** to show only those kinds of entries.
- **Tags**: only entries of nodes that carry all selected tags now.
- **Only this node**: pick a node to see its history; the **×** removes the filter.

**Clear all filters** shows everything again. Dates are matched by the time an entry is shown at:
its learning date if it has one, otherwise the recorded time. An editing session counts on the day
and at the time it started: a session that began before the **From** day is not shown, even if it
continued into it.

Entries marked **Imported** come from a workspace you [imported](#importing-a-zip-export). They
show what happened in the other workspace, at the times it happened there, and are kept apart
from your own activity in this workspace.

### Timezone

Dates and times in the timeline, and elsewhere in mmap, are shown in the workspace's timezone.
It is set to your computer's timezone when the workspace is created. To change it, go to
**Settings**, **Timezone for dates**, and pick a timezone, or click **Use this computer's
timezone**.

The timezone decides which calendar day an entry belongs to and what **From** and **To** mean: for
example, with `Asia/Jerusalem`, "27 March" covers 27 March from midnight to midnight in Jerusalem,
including on the day the clocks change. mmap stores every time in UTC, so changing the timezone
never changes your history; entries only move to the day they belong to in the new timezone. The
timezone is saved with the workspace, so it stays the same when you open the workspace on another
computer.

## Search

Use the **search box** at the top of the window, or press **Ctrl+K** to jump to it from anywhere.
Results appear as you type, and Enter searches immediately.

### What is searched

Node titles, summaries and note text, including the text of links in notes. Attached files are
not searched, except for their names where they appear in a note.

### How matching works

- **Every word must match.** `light interference` finds nodes that contain both words.
- **The last word can be the start of a word.** `entro` finds "Entropy" while you are still
  typing. Earlier words must be whole words.
- **Capital letters do not matter.**
- **Accents on Latin letters are ignored.** `cafe` finds "Café".
- **Title matches come first.** Matches in the title count most, then matches in the summary,
  then matches in the note text.
- Punctuation and symbols are ignored, and words such as `OR`, `NOT` or `title:` are searched as
  ordinary words.

Each result shows the node's title and a short piece of the matching text with the matching words
highlighted. Click a result to open the node. **Load more** shows the next 20 results; the count
above the list says how many nodes match.

### Filtering by tags and relationships

Click tags in the **Filter** row above the results to keep only nodes that carry all selected
tags. **Clear filters** removes them.

The **Has a relationship** row lists the relationship types you use, with how many relationships
have each. Click one or more to keep only nodes with a relationship of any of those types, in
either direction: **depends on** keeps both the nodes that depend on something and the nodes
something depends on. **Clear** removes the relationship filter. Tag and relationship filters work
together.

### Known limitations

- **Hebrew vowel points must match.** A word written with vowel points (niqqud) is found only
  when you type it with the same points, and an unpointed search does not find the pointed
  spelling. Unpointed Hebrew and Arabic text is found normally.
- If you change nodes while browsing results, **Load more** can occasionally show a result twice
  or skip one. Search again to refresh the list.
- When you pick a node for a link or a relationship, the list matches titles more strictly than
  search: accents must match, and capital letters are ignored only for the letters A–Z.

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

mmap backs up the open workspace **once a day**, automatically: the first time you open it on a
day, and again a day later if you leave mmap running. A backup is a complete copy of the
workspace (notes, nodes, tags, relationships, maps, timeline and attached files) taken while you
keep working. Everything about backups is in **Settings**, section **Backups**.

### Checking your backups

At the top of the section you see **Last backup:** with its time, or **No backup yet.** If the
last backup failed, a red message says when and why (for example that the disk is full or the
backup folder's drive is not connected). The Home page shows the same status.

**Backups of this workspace** lists every backup with its time, its size and its number of
attached files. "(N missing at backup time)" means N attached files were missing from the
workspace folder, or had been changed outside mmap, when that backup was taken; they are not in
it.

**Back up now** takes a backup immediately, for example before a big change. A bar shows how
far it is; **Cancel** stops it and leaves no partial backup behind.

### Where backups are kept

**Backup folder** shows where backups go. By default this is `%APPDATA%\mmap\backups` on your
computer, which is on the **same drive** as your workspaces. mmap then shows a warning: if that
drive fails, the workspace and its backups are lost together. To protect against that, click
**Change folder…** and choose a folder on another drive, such as an external disk, then click
**Back up now**. **Use the default folder** switches back. Backups that are already in the old
folder stay there.

A network folder works as a backup folder too, and so does a folder synced by OneDrive,
Dropbox or a similar program: that is the easiest way to keep a copy off your computer (see
[If you want your notes in OneDrive](#if-you-want-your-notes-in-onedrive-or-dropbox-google-drive)).
mmap recognises such a folder and says so instead of the "same drive" warning.

### How many backups are kept

By default mmap keeps one backup for each of the last **7 days** and one for each of the last
**4 weeks** (the newest of each), and always the newest backup. Older ones are deleted
automatically. To change this, enter new numbers under **How many backups to keep** (**Daily**
0–60, **Weekly** 0–104) and click **Save**.

### Going back to an earlier state

1. In **Backups of this workspace**, click **Restore…** next to the backup you want.
2. Read the message and click **Restore**.

The workspace is replaced by the backup. Changes made after that backup are no longer in the
workspace, but they are not lost: mmap first makes a backup of the current state, which appears
in the list, so you can restore it to return. The current workspace folder is moved to the
**Recycle Bin**. The window then reloads and shows the restored workspace.

Before anything is replaced, mmap checks that the backup is complete and undamaged. If it is not,
or if something goes wrong while swapping (for example because another program has a file in
the workspace folder open), you see a message and the workspace stays as it was.

### Restoring on a new computer or after losing a drive

If the workspace folder is gone but you still have the backup folder (for example on an external
disk):

1. Install and start mmap.
2. In **Settings**, **Backups**, click **Restore from a backup folder…**.
3. In the backup folder, open the folder named after the workspace's ID, then `snapshots`, and
   choose one of the folders inside it. They are named by date and time (in UTC), for example
   `2026-10-27T09-15-00-123Z`; the newest is usually the one you want.

mmap checks the backup, restores it as a new workspace called **`<name> (restored)`** in the
default mmap folder, and opens it. This does not work for a backup of the workspace that is open
right now; use **Restore…** in the list for that.

Step-by-step instructions for these cases, and what mmap checks, are in the
[backup and restore runbook](runbooks/backup-and-restore.md).

### Safety copies before upgrades

Separately from daily backups, when a newer version of mmap upgrades a workspace's storage format,
it first saves a copy of the database in the workspace's `recovery` folder. After an upgrade,
earlier versions of mmap can no longer open the workspace; they report that the workspace was
created by a newer version and change nothing.

### Deleting data and backups

Deleting a node, or deleting a workspace, does not delete its backups, exports you saved, or
copies made by Windows (File History, System Restore) or by you. Deleted content remains in
backups until they are deleted by the rules above. Uninstalling mmap also leaves the backup folder
in place. To remove a workspace's backups, delete its folder (named after the workspace ID)
inside the backup folder yourself.

## Export and import

**Settings**, section **Export and import**, has three buttons. Each asks you where to save or
which file to open.

### Progress and Cancel

Exporting, checking an archive, importing, backing up and restoring show a bar with the current
step. **Cancel** stops an export, an import or a backup and leaves nothing behind: no partial file,
no added notes. While an import is saving its notes, or a backup is finishing, Cancel is not
available for those few seconds. A restore cannot be cancelled once it has started.

### Exporting a workspace (ZIP)

**Export workspace (ZIP)…** saves the complete workspace in one file, for example
`My Knowledge 2026-10-27.mmap.zip`: all nodes and notes, tags, relationships and their types,
mind maps with their layout, the timeline, where nodes sit in the knowledge graph, and every
attached file. Use it to move a workspace to another computer, to keep a copy somewhere else, or
to combine workspaces. It contains only your workspace data, not your settings.

You can keep working while it is written. When it is done, mmap says how many nodes, maps and
attachments it exported. If an attached file is missing from the workspace folder or was changed
outside mmap, it is left out and a warning says so.

### Exporting as Markdown

**Export as Markdown…** saves a ZIP file of plain-text Markdown files that other programs can
read, for example `My Knowledge 2026-10-27 Markdown.zip`:

- one file per node in `nodes`, named after its title, starting with the node's ID, title,
  summary, tags and dates;
- the note with its formatting, lists, checklists, quotes, code, tables and math (as LaTeX
  between `$…$` and `$$…$$`);
- links to other nodes written as `[[file name|link text]]`, and the node's relationships in a
  list at the end;
- attached files in `attachments`, linked from the notes.

Mind maps, the timeline and some formatting (for example merged table cells) are not part of the
Markdown export, and **mmap cannot import Markdown**. To move or restore a workspace, use the ZIP
export.

### Importing a ZIP export

**Import from an export…** adds the contents of a ZIP export to the **open** workspace.

1. Choose the `.mmap.zip` file. mmap checks the whole file first and changes nothing yet.
2. A preview shows the workspace it came from, when it was exported, and what will be added:
   nodes, relationships, mind maps and map items, timeline entries, attachments, and how many
   tags and relationship types are new or already exist here. Warnings, if any, are listed below.
3. Click **Import**, or close the dialog to cancel.

What to expect:

- **Everything is added as new items.** Nothing already in the workspace is changed or replaced.
  Importing an export of this same workspace adds a second copy of everything; the preview warns
  you.
- **Tags and relationship types with the same name are shared.** A tag that already exists here
  is reused. A relationship type is reused if it has the same name and direction; if the
  direction differs, the imported one is named "… (imported)" and the preview says so.
- **Timeline entries** from the export are marked **Imported** in the timeline.
- **Links to nodes that were not in the export** stay in the notes as unresolved links, which you
  can [repair](#unresolved-links-and-repair).
- **Attached files are checked again.** Programs and scripts, and files larger than this
  computer's [size limit](#size-limit), are not imported; the preview says how many and why, and
  the notes show them as missing.
- **Importing the same file twice.** If you imported this file into this workspace before, the
  preview says when, and you must tick **Import it again anyway** before **Import** works. A new
  export of the same workspace counts as a different file.
- **All or nothing.** If the file is damaged, was changed, is not an mmap export, or something
  fails while importing, you see a message and nothing is added. A file exported by a newer
  version of mmap cannot be imported until you update mmap.

A preview stays available for 10 minutes. If you wait longer, or switch workspaces in between,
choose the file again.

A large import (thousands of nodes) can take several seconds. mmap keeps responding meanwhile;
changes you make to notes are saved once the import has finished.

## Not available yet

These features are planned for later versions:

- In the graph: **dragging from one node to another to connect them** (use **Add relationship**
  in the side panel); **keyboard use of the drawing itself** (use the List tab); undoing
  **Rearrange**; and clearing expanded neighbors without leaving the graph. Labels of two lines
  between the same nodes can overlap; the node panel and the List name each one.
- In the timeline: **separate lanes per tag or topic**. Today all entries share one time axis.
- **Changing the text of an existing node link.** Delete the link and insert it again with new
  **Link text**.
- On mind maps: **dragging
  an item onto another to change its parent**, a **search or sort** for the list of maps, and
  more colors.
- **Automatic updates.** To update mmap, run the installer of the newer version; your workspaces,
  settings and backups are kept.
- **Merging an import** into existing nodes: importing always adds copies.
- **Importing Markdown** files.
- **A progress bar and a cancel button** for long exports, imports and backups.
