# mmap - Your Personal Knowledge Graph

Product Requirements Document (PRD)  
Version: 1.0  
Date: 2026-10-26  
Status: Implementation baseline

## 1. Product vision

mmap is a private, user-curated workspace for collecting knowledge, explaining relationships, organizing ideas in reusable mind maps, and revisiting learning over time. Notes, mind maps, and the global graph are different views of the same underlying knowledge.

The user decides what to record and how concepts relate. There must be no LLM integration, AI generation, embeddings, AI recommendations, automatic summarization, or inferred semantic relationships. Search and layouts use deterministic, conventional algorithms.

## 2. Audience and outcomes

Primary users are independent learners, students, researchers, and professionals building a durable personal knowledge base.

The product must let a user:

- Capture a concept once and reuse it across multiple maps.
- Write rich notes and navigate explicit references and backlinks.
- Create meaningful, typed connections manually.
- Switch between a structured mind map and the global knowledge graph.
- Find previous learning through search, tags, and a learning timeline.
- Export their data and restore it without losing relationships.

Success measures after launch include activation (first three nodes, one relationship, and one map), weekly returning users, successful searches, export/import success rate, and absence of cross-account data exposure. Numeric growth targets will be set after baseline usage is available.

## 3. Scope and exclusions

Version 1 includes individual accounts, knowledge nodes, typed edges, rich notes, wikilinks, backlinks, tags, multiple mind maps, a global graph, search, a learning timeline, attachments, and export/import.

Real-time collaboration, public publishing, shared workspaces, native mobile apps, spaced-repetition scheduling, browser extensions, third-party content ingestion, and offline editing are outside version 1. Responsive browsing and basic editing on smaller screens are required; advanced graph editing may prioritize desktop.

## 4. Core concepts and invariants

### 4.1 Knowledge node

A node is a canonical knowledge item with a stable ID, title, optional summary, rich note, tags, timestamps, and attachment references. Titles may repeat; identity is always the stable ID. Renaming a node must preserve its connections, map placements, and resolved wikilinks.

### 4.2 Semantic relationship

A relationship connects two distinct nodes and has a user-selected type, directionality, and optional description. Initial types include `related to` (undirected), `depends on` (directed), `part of` (directed), `example of` (directed), and `contradicts` (undirected). Users can create, rename, and archive custom relationship types.

For a directed relationship, source-to-target meaning must be visible in both the editor and graph. Undirected relationships must have no arrow and use canonical endpoint ordering to prevent reversed duplicates. Reject self-links and duplicate relationships with the same endpoints, type, and direction. Different types between the same endpoints are allowed. Type directionality cannot change while used; provide an explicit migration flow or require a new type.

### 4.3 Note reference

A wikilink is a reference inside a note, separate from a typed semantic relationship. Writing a wikilink must not silently create a semantic edge. Backlinks are derived from saved note references. The graph may display note-reference connections as a separately styled, optional layer.

### 4.4 Mind map

A mind map contains placements of canonical nodes and map-specific visual connections. A node can appear in many maps and at most once within each map in version 1. Its content remains shared; position, collapse state, parent, and styling belong to the map placement.

Map hierarchy is organizational and must not automatically create semantic `part of` edges. A map connection may optionally reference an existing semantic relationship; creating one requires an explicit user action.

## 5. Functional requirements

### 5.1 Accounts and authentication

- Support registration and login with verified email/password and Google OAuth.
- Support email verification, password reset, logout, and session revocation.
- Keep each account's nodes, relationships, maps, files, tags, and search results private.
- Do not automatically merge accounts solely because a Google email matches an existing account. Linking identities requires authenticated ownership verification.
- Provide account deletion with explicit confirmation, session revocation, and a documented data-removal process.

### 5.2 Node library

- Create, view, edit, duplicate, and delete nodes.
- List nodes with title, tags, last updated time, sorting, and pagination.
- Open a node from the library, search, graph, timeline, map, or backlink.
- Autosave edits with clear saving, saved, and failure states. Failed saves must retain the current editor content and offer retry.
- Use revision checks to prevent a stale browser tab from silently overwriting newer content.
- Deleting a map or placement must leave canonical nodes intact.
- Deleting a canonical node requires a preview of affected relationships, references, and placements. Remove dependent relationships and placements transactionally; preserve readable unresolved reference labels in other notes.

### 5.3 Rich notes

Use Tiptap for paragraphs, headings, bold, italic, lists, checklists, links, blockquotes, code blocks, tables, and image/file attachments. Support inline and display mathematics rendered with KaTeX.

Store validated, versioned Tiptap JSON as the source of truth. Maintain a derived plain-text representation for search. Sanitize rendered content and restrict links and embeds to safe schemes. Treat imported notes as untrusted input.

### 5.4 Wikilinks and backlinks

- Typing `[[` opens a searchable node picker; users select a target or explicitly create a new node.
- Store resolved references by target ID with a display label; offer `[[target|label]]` behavior without relying on title matching for identity.
- When raw/imported text has an ambiguous title, require selection instead of choosing an arbitrary node.
- Show backlinks with source title and a short contextual excerpt.
- Reconcile references on each successful note save, removing obsolete backlinks.
- Show missing or deleted targets as unresolved links with a repair action.

### 5.5 Manual relationship editing

Users can create relationships from a node detail panel or graph action, select endpoints and type, inspect direction, and add explanatory text. Editing and deletion must immediately update connected views after the server confirms the change. Archiving a type preserves existing edges but removes the type from new-edge choices.

### 5.6 Multiple mind maps

- Create, rename, duplicate, and delete maps; add existing nodes or explicitly create new ones.
- Freeform mode supports drag positioning, pan, zoom, fit-to-view, selection, and map-specific connectors.
- Hierarchical mode supports roots, parent-child placement, sibling ordering, subtree collapse, and deterministic tree layout. A map may have multiple roots; each non-root placement has exactly one parent.
- Reject hierarchy cycles. Reparenting must preserve canonical node identity and note content.
- Persist viewport, coordinates, styling, and hierarchy across sessions.
- Switching to hierarchical mode requires a reviewed parent assignment when freeform connections are ambiguous. Preserve the previous freeform coordinates for switching back.
- Provide keyboard alternatives for adding, opening, and moving items within a hierarchy.

Use React Flow for map interaction. Freeform connectors can form cycles; hierarchical parent-child structure cannot.

### 5.7 Global knowledge graph

Use Cytoscape to display canonical nodes and semantic relationships across the account. Show directed arrows, relationship labels on demand, and distinct optional note-reference connections.

Support pan, zoom, deterministic layouts, node selection, opening details, filters by tags and relationship types, text filtering, and expansion of a node's neighborhood. Layout coordinates are visual state and must not alter knowledge relationships. Use bounded neighborhood loading and visible result limits for large accounts; never silently imply that a partial view contains all nodes.

### 5.8 Search and tags

Use PostgreSQL full-text search for titles, summaries, and derived note text. Give title matches higher ranking; provide deterministic prefix/title lookup for pickers. Support tag filters, relationship-type filters where applicable, pagination, and highlighted plain-text snippets.

Tags are account-scoped and reusable. Support creation, assignment, removal, rename, and deletion without deleting nodes. Normalize tag uniqueness within an account while preserving a display label. Search and tag queries must always enforce ownership.

### 5.9 Learning timeline

Record explicit node creation, substantive note updates, relationship creation, and user-triggered `reviewed` events. Group autosave updates into one activity per editing session rather than recording every keystroke. Define an editing session as a continuous edit period ending after 30 minutes of inactivity.

Display a reverse-chronological timeline with date range, tag, event-type, and node filters. Store UTC timestamps and display dates in the user's selected timezone. Users can mark a node as learned/reviewed and add a short reflection. The timeline represents recorded activity, not an inferred measure of understanding. Imported history is marked as imported and must not create artificial new learning events.

### 5.10 Attachments

Store binary objects in private S3-compatible storage and metadata in PostgreSQL. Issue short-lived upload/download URLs only after authorization. Validate file type, extension, size, and upload completion; use generated object keys. Reject executable content and enforce account quotas. Version 1 defaults: 20 MB per file and 1 GB per account, configurable by deployment.

Do not render untrusted active formats inline. Quarantine uploads until configured malware scanning completes; fail closed when scanning is unavailable. Remove abandoned uploads and unreferenced objects through a retryable cleanup job.

### 5.11 Export and import

- Provide a complete portable ZIP export containing a versioned JSON manifest, nodes, rich notes, tags, relationship types, edges, map placements, map structure, timeline records, and attachment files with checksums.
- Provide a readable Markdown export with one file per node, stable-ID metadata, wikilinks, math source, and attachment references. Explain that JSON/ZIP is the lossless restore format; arbitrary Markdown import is outside version 1.
- Never export passwords, sessions, OAuth secrets, signed URLs, or internal storage credentials.
- Import the versioned ZIP format with schema validation, archive size/entry limits, path traversal protection, checksums, and a preview of changes and warnings.
- Default import creates new records with an explicit ID mapping and rewrites all internal references. Re-importing the same archive must show a duplicate warning before proceeding.
- Validate the whole package before mutation. Stage attachments, apply database records transactionally, and clean staged objects on failure. Do not report completion until all required files are available.
- Round-trip export/import must preserve note content, directionality, relationships, hierarchy, tags, placements, and file bytes.

## 6. Experience and accessibility

The main navigation contains Library, Mind Maps, Knowledge Graph, Timeline, and Settings. A persistent search entry and node-creation action must be easy to reach. Selecting a node opens the same detail editor from every view.

Use React, TypeScript, and Vite; Tailwind CSS and shadcn/ui supply consistent controls. Include readable empty states, loading indicators, actionable errors, destructive-action confirmation, and unsaved/conflicting edit recovery.

Target WCAG 2.2 AA for primary flows: visible focus, keyboard navigation, accessible labels, sufficient contrast, reduced-motion support, and no color-only meaning. Provide a navigable list alternative to graph information. Rich notes must support Unicode and bidirectional text; the initial interface is English.

## 7. Technical architecture

### 7.1 Stack

| Layer | Required technology and purpose |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| UI | Tailwind CSS, shadcn/ui |
| Map canvas | React Flow |
| Global graph | Cytoscape |
| Note editor | Tiptap |
| Mathematics | KaTeX |
| API | Node.js, TypeScript, Fastify |
| Database | PostgreSQL with Prisma migrations and client |
| Binary storage | Private S3-compatible object storage |

Select supported package versions during implementation and record exact versions in the lockfile. Use a server backend; the browser must never access PostgreSQL directly. Keep secrets in deployment secret storage.

### 7.2 Boundaries

Use a monorepo with frontend, backend, and shared validated API contracts. Backend modules cover authentication, nodes/notes, references, relationships, tags, maps, timeline, files, search, and transfer jobs. Keep request handlers thin; domain services enforce invariants, and repositories handle persistence. Do not expose Prisma records as public API contracts.

Use authenticated REST endpoints with schema validation, consistent errors, bounded pagination, and generated OpenAPI documentation. Large exports/imports and file cleanup run as persisted, retryable jobs with status endpoints. Use idempotency keys for retry-sensitive job creation. Define a configurable worker concurrency limit.

### 7.3 Logical data model

| Entity | Key fields and constraints |
| --- | --- |
| User | ID, email, timezone, timestamps, deletion state |
| AuthIdentity | User ID, provider, provider subject; unique provider/subject |
| PasswordCredential | User ID, password hash; separate from profile |
| Session | User ID, hashed token, expiration, revocation |
| KnowledgeNode | ID, owner ID, title, summary, note JSON, plain text, revision, timestamps |
| RelationshipType | ID, owner ID, label, directionality, archived state |
| Relationship | ID, owner ID, source/target IDs, type ID, description |
| NoteReference | Source node ID, target node ID, label; unresolved references retained in note content |
| Tag / NodeTag | Owner-scoped normalized tag name; unique node/tag pair |
| MindMap | ID, owner ID, title, mode, viewport, revision |
| MapPlacement | Map ID, node ID, coordinates, parent placement ID, sibling order, collapsed state, style |
| MapConnection | Map ID, placement endpoints, optional relationship ID, visual metadata |
| TimelineEvent | Owner ID, optional node ID, event type, UTC time, reflection, import origin |
| Attachment | Owner ID, node ID, object key, MIME type, byte size, checksum, scan state |
| TransferJob | Owner ID, kind, state, progress, result object key, expiration, error code |

Enforce ownership consistency through database constraints where practical and service-layer checks everywhere. Foreign keys alone must not permit cross-owner links. Index ownership with title/date lookup, relationship endpoints, map membership, references, timeline dates, and full-text search vectors. Prevent hierarchy cycles within a transaction using appropriate locking or serializable validation.

## 8. Security and privacy

- Enforce authentication and object-level authorization on every API, job, and file operation; derive owner ID from the session.
- Hash passwords with a maintained Argon2id implementation. Store only hashed reset/session tokens and expire single-use verification/reset tokens.
- Use secure, HTTP-only, appropriately SameSite cookies, CSRF protection for state-changing cookie-authenticated requests, HTTPS, strict CORS, and OAuth state/nonce/PKCE as applicable to the selected flow.
- Rate-limit login, registration, reset, search, upload, and import operations. Avoid account enumeration in recovery responses.
- Validate all input and sanitize rich content. Configure KaTeX without trusted HTML/URL capabilities. Apply a restrictive Content Security Policy.
- Keep S3 buckets private, restrict service permissions, encrypt transport and stored data, and rotate secrets.
- Log operational events with request IDs without note bodies, passwords, tokens, or private attachment URLs. Restrict audit access and retention.
- Offer export and account deletion. Target active-data removal within 30 days; disclose backup retention and eventual expiry in the privacy policy.
- Run dependency and secret scanning in CI. Remediate critical vulnerabilities before release.

## 9. Reliability, performance, and operations

Initial validation dataset: 10,000 nodes, 30,000 semantic relationships, 100 maps per account, and up to 500 placements per actively edited map. Measure on a documented four-core, 16 GB development-class client and a stated staging server configuration.

Targets under this dataset and a representative 20-concurrent-user staging workload:

- Search API p95 under 500 ms, excluding network transport.
- Standard node reads and writes p95 under 300 ms, excluding file transfers.
- Open a 200-placement map within 2 seconds after its data arrives.
- Load an initial global graph neighborhood capped at 1,000 nodes/3,000 edges within 3 seconds after data arrives.
- Keep interaction responsive through bounded rendering, batched updates, and off-main-thread layout where needed.

Autosave starts after approximately 1 second of inactivity and reports success only after durable server confirmation. Show errors and preserve recoverable local draft content on failure; local drafts do not constitute offline support.

Provide structured logs, error tracking, health/readiness checks, API latency metrics, failed-job monitoring, migration procedures, and environment-specific configuration. Use automated daily backups with a target RPO of 24 hours and RTO of 8 hours; test restoration before launch and periodically afterward. Document actual achieved recovery results.

## 10. Mandatory engineering quality requirements

These requirements are release gates, not optional preferences.

1. **Readable code:** Use clear English names, explicit types at module boundaries, small focused functions, consistent formatting, and straightforward control flow. Avoid clever abstractions, unexplained abbreviations, duplicated business rules, and oversized components or services.
2. **Explanatory English comments:** Write comments in English explaining intent, invariants, non-obvious algorithms, security decisions, edge cases, and tradeoffs. Document public interfaces and complex behavior. Comments must stay accurate when code changes; do not replace explanations with comments that merely restate syntax.
3. **Modularity:** Separate presentation, state, domain rules, persistence, and external integrations. Use cohesive modules with explicit contracts. Centralize validation and ownership rules without hiding authorization assumptions.
4. **Maintainability:** Prefer supported dependencies, strict TypeScript, linting, automated formatting, reproducible lockfiles, migrations, predictable error handling, and minimal global state. Record consequential architectural choices in short decision records.
5. **Documentation:** Supply a root README, local setup instructions, environment-variable reference without real secrets, architecture overview, entity/relationship explanation, API reference, authentication setup, storage setup, migration/backup/restore procedures, test instructions, deployment runbook, and user guidance for linking and import/export.
6. **Testing:** Add meaningful automated coverage for domain rules and user-visible workflows. Every bug fix requires an appropriate regression test. Mock external boundaries where appropriate and test PostgreSQL behavior against PostgreSQL in integration tests.
7. **Review and handoff:** A reviewer must be able to explain the module's purpose and invariants using its code and documentation. Unexplained complex logic, missing critical tests, stale comments, or undocumented operational steps block completion.

## 11. Test strategy

- Unit tests: relationship uniqueness/directionality, hierarchy-cycle detection, reference reconciliation, tag normalization, search query parsing, and import ID remapping.
- Integration tests: database constraints and transactions, every ownership boundary, session/reset flows, OAuth callback failures, optimistic-concurrency conflicts, upload lifecycle, and failed-job cleanup.
- End-to-end tests: register/login, create and link nodes, edit a note with wikilinks/math, inspect backlinks, reuse a node in two maps, browse the global graph, search/filter, record a review, and export/import a complete workspace.
- Security tests: cross-account access using guessed IDs, CSRF, unsafe rich content, hostile archives, oversized files, and expired or unauthorized download URLs.
- Performance tests: the stated dataset, graph limits, search latency, and large map interaction.
- Accessibility checks: automated checks plus manual keyboard and screen-reader smoke tests for primary flows.
- Recovery tests: interrupted save, stale tab, failed import, object-storage outage, and database restore.

CI must pass formatting, linting, strict type checking, unit/integration tests, production builds, and critical end-to-end smoke tests. External Google login requires a documented test-environment verification in addition to automated provider-boundary tests.

## 12. Phased delivery and exit criteria

| Phase | Deliverables | Exit criteria |
| --- | --- | --- |
| 0 — Foundation | Monorepo, contracts, database schema, CI, local environment, architectural decisions | Clean setup works from README; migrations and production builds pass |
| 1 — Private knowledge base | Email/Google auth, node CRUD, Tiptap notes, KaTeX, tags, secure attachments | Ownership tests pass; rich content survives reload; auth and file flows verified |
| 2 — Connections and discovery | Typed semantic relationships, wikilinks, backlinks, search | Direction and uniqueness rules pass; rename/delete references behave correctly; search targets measured |
| 3 — Mind maps | Multiple maps, reusable nodes, freeform/hierarchical modes, persistence | Shared content stays consistent; map deletion preserves nodes; hierarchy cycles rejected |
| 4 — Graph and timeline | Cytoscape graph, filters, bounded expansion, review history | Graph limits are visible; timeline uses correct timezone and event grouping |
| 5 — Portability and release | ZIP/Markdown export, ZIP import, security hardening, accessibility, operations | Round-trip/recovery tests pass; documentation complete; all release gates satisfied |

Deliver each phase as a reviewable working increment. Establish calendar estimates after the initial technical spike and team capacity review; these phases specify dependencies rather than promised dates.

## 13. Acceptance criteria

1. A new user can verify an email account, sign in, reset a password, and sign out. Google sign-in works with the configured application; unsafe automatic account merging is prevented.
2. Account A cannot read, modify, search, export, or download any data owned by account B, including through forged node IDs, map IDs, jobs, or attachment keys.
3. A node with formatted text, a table, a code block, inline/display math, tags, and an attachment retains its content after save and reload.
4. Creating A `depends on` B visibly shows A → B; creating A `related to` B shows no arrow. Reversing an undirected duplicate is rejected, and unrelated edge types remain allowed.
5. A selected `[[wikilink]]` navigates to its stable target after a rename. Its source appears in backlinks; removing the link removes that backlink after save. No semantic relationship is silently added.
6. One node reused in two maps displays the same updated note in both, while moving it in one map leaves its other placement unchanged.
7. Hierarchical reparenting rejects cycles and preserves sibling order and collapse state. Freeform position and viewport survive reopening; mode changes follow the defined conversion flow.
8. Deleting a map leaves all canonical nodes intact. Deleting a node displays affected items and leaves remaining note references readable and repairable.
9. The global graph shows canonical nodes and typed relationships, supports filters and bounded expansion, and identifies when results are partial.
10. Search finds title and note-text matches, applies tags, and meets the measured staging target. Results never cross account boundaries.
11. A user-triggered review appears in the timeline in the selected timezone. Continuous autosaves are grouped, and imported history is clearly marked.
12. A workspace exported and imported into a fresh account preserves every supported entity, stable internal mapping, direction, hierarchy, note content, and attachment checksum. Invalid or interrupted imports leave no partially visible workspace changes.
13. Conflicting edits produce a visible conflict with recovery options, never silent data loss. Failed autosaves keep the edited content available for retry.
14. Primary workflows pass the defined accessibility checks, and graph information is available through an accessible list.
15. CI, security checks, performance validation, backup restore, English explanatory comments, and the mandatory documentation are complete before release.

## 14. Risks and implementation decisions

- **Confusion between visual structure and meaning:** Keep map connectors, hierarchy, semantic relationships, and note references distinct in storage and clearly labeled in the UI.
- **Graph scale:** Default to bounded neighborhoods, debounce filters, and isolate expensive layouts; benchmark before expanding limits.
- **Editor/reference divergence:** Save note JSON and reconcile derived references within one database transaction.
- **Database/object-store consistency:** Stage uploads and transfer files, finalize database visibility only after validation, and use retryable cleanup.
- **Concurrent edits:** Require revision checks for both nodes and map structure; provide a user-visible resolution flow.
- **Data portability:** Version export schemas and document migrations. Reject unknown future versions with an actionable message.

Before implementation, record the selected mail provider, deployment platform, S3 service, malware-scanning service, supported browser versions, and exact backup-retention policy. These selections must preserve the functional and security requirements above. No AI service is permitted in any phase.
