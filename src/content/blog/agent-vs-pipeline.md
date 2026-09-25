---
title: "Agent vs. Pipeline: When Not to Give an LLM Autonomy"
date: 2026-09-10
tags: [ai, architecture]
description: "Autonomy is a cost you pay for flexibility you might not need. A framework for choosing between agents and fixed pipelines."
---

Every few months, "let's make it an agent" becomes the default answer to "how should this work." It's rarely the right first question.

## Autonomy is a cost, not a feature

An agent decides its own next step. A pipeline has its next step decided for it. That difference sounds like flexibility, and it is, but flexibility is a cost you're choosing to pay, not a free upgrade. You're trading predictability for adaptability, and that trade is only worth it when the task actually varies enough to need it.

## The question that actually matters

Before reaching for an agent, I ask: does the next step depend on something I can't know in advance?

- If the steps are the same every time, just with different data, that's a pipeline. Document intake, extraction, validation, routing: fixed shape, variable content. An agent adds cost and non-determinism with no upside.
- If the steps themselves need to change based on what's found along the way, that's where agentic reasoning earns its keep.

Most "AI workflows" I've seen are the first case wearing the second case's clothing.

## Where agents have actually earned their keep

The cases that justified agent autonomy shared one trait: the failure mode of being wrong was cheap and recoverable, and the task genuinely branched in ways that couldn't be enumerated ahead of time. Reasoning about which signals matter, and in what order, from open-ended and messy inputs is a reasonable place for an agent, because the right approach really does vary case to case.

Automating a file's validation and retry logic is not that case, even though it touches AI-adjacent language like "automation." The steps are fixed. The variability is in the data, not the process. A pipeline with clear retry and alerting logic beats an agent here every time. It's auditable, it's fast, and it fails the same way twice, which matters enormously when the thing being automated has real consequences.

As a decision tree:

<pre class="mermaid">
graph TD
    A[New AI workflow] --> B{Does the next step depend on\nsomething unknowable in advance?}
    B -->|No, steps are fixed| C[Use a Pipeline]
    B -->|Yes, steps vary by case| D[Use an Agent]
    C --> E[Auditable, fast, fails\nthe same way twice]
    D --> F[Flexible, but costs\npredictability]
</pre>

## A cheap test

If the process fits on a whiteboard in five boxes and it doesn't change next week, an agent probably isn't needed. If the flowchart can't be drawn because the right next box depends on what the last box found, it might be.

Reach for autonomy because the problem demands it, not because the tooling makes it easy to add.
