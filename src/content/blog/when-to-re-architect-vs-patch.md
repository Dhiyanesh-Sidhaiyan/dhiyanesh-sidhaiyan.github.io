---
title: "When to Re-Architect vs. Patch"
date: 2026-09-25
tags: [architecture, leadership]
description: "A framework for deciding when a fragmented system needs a rewrite, and when it just needs a fix."
---

Every growing system eventually hits the same wall: the thing you built to move fast now moves slow. Someone asks, "should we rewrite this?" and the honest answer is almost always "it depends," which is unsatisfying but true.

Here's the framework I actually use.

## Ask what's actually broken

Most of the time, the code isn't broken. The *boundaries* are. Look at where the pain shows up:

- Is it slow to change because logic is scattered across five services?
- Is it slow to change because the current design is fine but nobody understands it?
- Is it slow to *run*, meaning real production incidents, or slow to *build on*?

Those are three different diseases with three different cures. Confusing them is how teams end up rewriting a system that was slow to build on, and shipping the same design problems in new code.

## The BFF question

When I re-architected a set of fragmented workflows that had grown out of years of point-to-point integrations, the tempting move was a full rewrite. Instead, we asked a narrower question: where does this specific team need a stable contract, and where does the mess actually live?

The answer was a Backend-for-Frontend layer, one clear seam between what the frontend needs and how the backend actually works underneath. We didn't rewrite the backend. We gave it a front door. That's the pattern I reach for by default now: isolate the mess behind an interface before deciding the mess needs to disappear.

## Signals that mean "patch it"

- The pain is isolated to one workflow, not systemic
- You can name the exact function or service causing friction
- A small, reversible change, like a feature flag or an adapter, would remove most of the pain

## Signals that mean "re-architect"

- Every team touching the system has its own workaround
- The system's original assumptions about traffic shape, data model, or ownership no longer hold
- You spend more time explaining the system than building on it

Here's the decision as a flowchart:

<pre class="mermaid">
graph TD
    A[System is slow to build on] --> B{Where does the pain show up?}
    B -->|One isolated workflow| C[Patch it: feature flag, adapter, small fix]
    B -->|Every team has its own workaround| D[Re-architect: new interface, e.g. a BFF]
    D --> E[Route new traffic through the new layer]
    E --> F[Keep old traffic working on old paths]
    F --> G[Retire old paths as confidence builds]
</pre>

## The part nobody likes

Re-architecting is a bet, and bets should be sized. The BFF pattern worked because it let us re-architect incrementally: new traffic routes through the new layer, old traffic keeps working, and old paths retire as confidence builds. If a rewrite plan requires a big-bang cutover, that's not an architecture decision anymore, it's a risk-management problem, and it deserves to be treated as one.

The best re-architecture I've shipped didn't feel like a rewrite from the outside. It felt like nothing changed, except everything got easier to build on afterward. That's usually the right outcome to aim for.
