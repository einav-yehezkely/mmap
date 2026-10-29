# Architecture Decision Records

This folder holds the Architecture Decision Records (ADRs) for mmap desktop. An ADR is a short
document that records one consequential technical decision: the problem it answers, what was
chosen, what it costs, and what else was considered. PRD §10 (Maintainability) requires these
records, and PRD §14 lists the decisions that must be recorded before implementation starts:
Electron and SQLite-driver versions, installer/signing/update approach, workspace location,
supported filesystems, and backup policy.

ADRs are written for future maintainers and reviewers. They explain _why_ the code looks the
way it does, so that a later change can be made deliberately rather than by accident.

## Conventions

- One decision per file, named `NNNN-short-kebab-title.md`, numbered in order of creation.
- Numbers are never reused. A decision that changes gets a new ADR; the old one is marked
  `Superseded by ADR-NNNN` and is otherwise left unchanged.
- Cite the PRD by section (for example "PRD §8") and the implementation plan where relevant.
- Statements that are assumptions rather than verified facts are labelled `Assumption:`.
- Keep each record short: a reviewer should be able to read it in a few minutes.

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- Date: YYYY-MM-DD

## Context

The problem, the constraints (with PRD references), and the forces that make this a decision.

## Decision

What we will do, stated precisely enough to check in code review.

## Consequences

What becomes easier, what becomes harder, follow-up work, and which phase owns it.

## Alternatives considered

Each serious alternative and the reason it was not chosen.
```

## Index

| ADR                                                          | Title                                        | Status   | Date       |
| ------------------------------------------------------------ | -------------------------------------------- | -------- | ---------- |
| [0001](0001-monorepo-and-module-boundaries.md)               | Monorepo and module boundaries               | Accepted | 2026-10-26 |
| [0002](0002-sqlite-driver-node-sqlite.md)                    | SQLite driver: built-in node:sqlite          | Accepted | 2026-10-26 |
| [0003](0003-electron-version-and-security-baseline.md)       | Electron version and security baseline       | Accepted | 2026-10-26 |
| [0004](0004-installer-signing-and-updates.md)                | Installer, code signing, and updates         | Accepted | 2026-10-26 |
| [0005](0005-workspace-location-and-supported-filesystems.md) | Workspace location and supported filesystems | Accepted | 2026-10-26 |
| [0006](0006-backup-policy.md)                                | Backup policy                                | Accepted | 2026-10-26 |
| [0007](0007-database-migrations-strategy.md)                 | Database migrations strategy                 | Accepted | 2026-10-26 |
| [0008](0008-wikilinks-and-note-schema-v2.md)                 | Wikilinks and note schema version 2          | Accepted | 2026-10-27 |
| [0009](0009-mind-map-editing.md)                             | Mind map editing                             | Accepted | 2026-10-27 |
| [0010](0010-graph-and-timeline.md)                           | Knowledge graph and learning timeline        | Accepted | 2026-10-27 |
| [0011](0011-export-import.md)                                | Workspace export and import                  | Accepted | 2026-10-27 |
| [0012](0012-automatic-map-layout.md)                         | Automatic layout of freeform maps            | Accepted | 2026-10-28 |
| [0013](0013-map-regions.md)                                  | Regions on freeform maps                     | Accepted | 2026-10-29 |

ADR-0004 and ADR-0006 have Phase 5 amendments (signing configuration, manual updates; backup
implementation).
