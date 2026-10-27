# mmap user guide

mmap is a private knowledge base for Windows. You write down ideas, concepts and sources as
**nodes**, give each one a rich note, tag them, attach files, connect them with typed
**relationships**, link to other nodes from inside a note, arrange nodes on **mind maps**, explore
everything in the **knowledge graph**, look back on your activity in the **timeline**, and
search everything you wrote. Everything stays in a folder on your computer. mmap works without an internet connection, has no
account, and sends nothing anywhere.

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
- **Cloud-sync folders** (OneDrive, Dropbox, Google Drive, iCloud Drive, Box) are allowed, but a
  warning is shown at the top of the window and in Settings. A sync program that copies the
  database while mmap is writing to it can damage it. Use **Move workspace…** to move it to a
  folder that is not synced.

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
from there until you empty the bin. Copies of the folder you made elsewhere are not affected.
If the folder cannot be moved to the Recycle Bin, nothing is deleted and the workspace opens
again.

### Nothing is deleted automatically

mmap never deletes a workspace on its own, and uninstalling mmap leaves all workspace folders in
place. **Remove from list** in the recent workspaces only forgets the entry; the folder stays.

## Nodes

A **node** is one idea, concept or source. It has a title, an optional summary, tags, a rich note
and attached files. Several nodes can have the same title.

### Creating and finding nodes

- Click **New node** at the top of the window. A node called "Untitled node" is created and opens
  on the right. Type its real title.
- The **Library** lists every node in the workspace with its last update time and tags. Choose
  **Sort by**: Recently updated, Recently created, or Title (A–Z). Click **Load more** to see more
  nodes. Click a node to open it.
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
- **Open a node** by double-clicking it on the canvas, or by selecting it in the outline and
  pressing Enter or **Open**. It opens in the node panel, the same one as in the Library.

### Adding nodes to a map

Click **Add** in the outline (or press **Insert** while the outline has focus). In the window that
opens, type part of a node's title and pick it, or choose **Create a new node “…”** to create a
node with that title and place it. A node is only created when you choose that option. Nodes that
are already on the map are not offered.

In a freeform map, new items appear to the right of the existing ones. In a hierarchy, **Add
child** adds the new item under the selected one, and **Add top-level** adds it at the top level.

### Freeform maps

- **Move** an item by dragging it, or select it and use the arrow keys. Positions are saved
  automatically.
- **Draw a connector** by dragging from the small handle on the right edge of one item to another
  item. Connectors are dashed arrows from the item where you started. They may form loops.
- Connectors are pictures on this map only. They never create relationships between the nodes.
  You cannot add a label to a connector yet.
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

**Timeline** in the sidebar lists what you did in this workspace, newest first, grouped by day:

- **Created**: a node was created (including by duplicating one).
- **Edited the note of**: you edited a node's note. Edits are grouped into one entry per editing
  session, which ends after 30 minutes without changes, so you see "09:05–09:40" instead of one
  entry per autosave. Changing only a title or summary is not recorded.
- **Added a relationship from**: you added a relationship; the entry names the node the
  relationship starts from.
- **Reviewed**: you marked the node as reviewed, with your reflection if you wrote one.

Click a node's title to open it. Entries of deleted nodes stay in the timeline with the title the
node had, marked "(deleted)". **Load more** at the bottom shows older entries.

The timeline is a record of what happened. It does not score, rate or estimate how well you know
something, and it never adds entries on its own beyond the activity listed above.

### Marking a node as reviewed

1. Open the node.
2. Click **Mark as reviewed…** at the bottom of the side panel.
3. Optionally write a short **reflection**: what became clear, what to revisit. It can have
   several lines and up to 2,000 characters.
4. Click **Mark as reviewed**. "Review recorded in the timeline." confirms it.

You can mark the same node as reviewed as often as you like; each time adds an entry.

### Changing or deleting a review

Review entries have two buttons: the **pencil** edits the reflection (clear the text to remove the
reflection but keep the review), and the **bin** deletes the review after you confirm. The node is
not changed.

Only your reviews can be changed. Created, edited and relationship entries are a record of what
happened and cannot be edited or deleted.

### Filters

- **From** and **To**: only entries on these days, in your timezone (see below). Either can be left
  empty.
- **Event types**: click **Created**, **Note edits**, **Relationships** or **Reviews** to show only
  those kinds of entries.
- **Tags**: only entries of nodes that carry all selected tags now.
- **Only this node**: pick a node to see its history; the **×** removes the filter.

**Clear all filters** shows everything again. An editing session counts on the day and at the time
it started: a session that began before the **From** day is not shown, even if it continued into
it.

Entries marked **Imported** come from imported history. Importing is not available yet, so you
will not see them today.

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

### Filtering by tags

Click tags in the **Filter** row above the results to keep only nodes that carry all selected
tags. **Clear filters** removes them.

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

**Backups and exports are not available yet. To back up a workspace, quit mmap and copy the
closed workspace folder** (for example to an external drive). To use the copy, open it with
**Open existing workspace folder…**.

The only automatic copy mmap makes today is a safety copy of the database before a newer version
of mmap upgrades a workspace's storage format. It is placed in the workspace's `recovery` folder.
This is not a general backup.

The first time this version opens a workspace created by an earlier version, it makes such a
copy and upgrades the workspace (so that notes can contain links to nodes and the knowledge graph
can remember where nodes are). After that, earlier versions of mmap can no longer open the
workspace; they report that the workspace was created by a newer version and change nothing.

## Not available yet

These features are planned for later versions:

- **Editing a relationship's explanation** after it was added, and **creating relationships from
  the graph**.
- In the graph: **map regions** (an outline around each map's nodes) and **collapsing a map**
  into one summary node, which are being built now; **dragging from one node to another to
  connect them**; **keyboard use of the drawing itself** (use the List tab); undoing
  **Rearrange**; and clearing expanded neighbors without leaving the graph. Labels of two lines
  between the same nodes can overlap; the node panel and the List name each one.
- **Filtering search results by relationship type** (the graph has this filter).
- **Changing the text of an existing node link.** Delete the link and insert it again with new
  **Link text**.
- On mind maps: **labels on connectors**, **linking a connector to a relationship**, **dragging
  an item onto another to change its parent**, a **search or sort** for the list of maps, and
  more colors.
- **Export, import and backups** inside the app. Until then, quit mmap and copy the workspace
  folder to back it up.
- **More than one window.**
