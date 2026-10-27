# P0/P1 Writing Intelligence

## Goal
Add quality and production layers on top of the existing chapter workflow without replacing author-confirmed stages.

## P0
1. Blueprint scene cards: persisted, editable, injected into drafting, optional AI scene planning.
2. Expanded deterministic continuity preflight: dead characters, absent major characters, never appeared cast, overdue/dormant threads, thin character profiles.
3. Five-role editorial panel: plot, continuity, character, style, pacing; weighted score and blocking findings.
4. Chapter fact ledger: immutable commit built from finalized notes, continuity facts, character states, foreshadowing, and quality score; rebuildable from current projections.

## P1
5. Character voice profiles: extract per character from finalized prose, display in character profile, inject into later drafting.
6. Candidate tournament: score existing draft versions with the editorial panel, rank them, and expose the winner.
7. Cost and quality dashboard: configurable model pricing, estimated USD, per-purpose/chapter totals, and quality score trends.
8. Auto production checkpoint: preserve batch auto-finalize and add an optional editorial score gate that stops at the chapter boundary.

## Safety
- No install or release in this phase.
- New schema is additive migration M08.
- Existing projects migrate forward; no author prose is rewritten.
- Features fail closed when sources are stale or invalid.
