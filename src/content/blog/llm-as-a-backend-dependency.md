---
title: "The LLM Is a Backend Dependency: Engineering It Like One"
date: 2026-10-10
tags: [ai, architecture, backend]
description: "Treat a model call like any other unreliable, expensive, versioned dependency. Contracts, timeouts, fallbacks, evals, and cost budgets matter more than the prompt."
---

Most teams ship their first LLM feature the way they'd build a demo: write a prompt, call the API, parse the JSON, and hope. It works in the sprint review. Then real traffic arrives, and the incidents start to look familiar.

They look familiar because they are. An LLM is a remote service that is **slow**, **sometimes wrong**, **charged per use**, and **updated by someone else**. We already know how to build around services like that: payment gateways, search clusters, third-party APIs. The mistake is treating the model as magic instead of as infrastructure.

## The short version

If you only read one section, read this one:

| Problem | What to do |
|---|---|
| Output is unpredictable | Define a strict output shape and validate every response |
| Calls are slow | Give each route a time budget; stream, queue, or batch |
| Calls fail | Retry the safe errors, and keep side effects out of the model call |
| The model can be down or refuse | Have a planned backup path |
| Costs drift | Track cost per finished task, and cache stable prompt content |
| Prompt changes break things | Test prompts with evals, like unit tests |
| Model versions change | Pin versions and roll out upgrades like deploys |
| Inputs can be malicious | Treat the model as untrusted and limit what it can do |

## Where the model sits

Think of the model as one box in your architecture, not the center of it. Your service owns the rules. The model just helps with one step.

<pre class="mermaid">
graph LR
    U[User or job] --> S[Your service]
    S --> G[LLM gateway\ntimeouts, retries, budgets, logging]
    G --> M1[Primary model]
    G -.->|backup| M2[Fallback model]
    G --> V[Schema validator]
    V --> S
    S --> DB[(Database)]
    S --> X[Side effects\nemail, payments, updates]
</pre>

The important box is the **gateway**: one thin layer that every model call goes through. It's where timeouts, retries, cost limits, and logging live, so individual features don't each reinvent them.

## 1. Start with the contract, not the prompt

The prompt is an implementation detail. The **contract** is what the rest of your system depends on: the exact shape of what comes back.

A weak contract: "the model returns a category."

A strong contract: "the model returns one of six categories or `unknown`, and `unknown` goes to a human queue."

That second version tells every caller exactly what to expect, including what happens when the model isn't sure. In practice:

- **Ask for structured output.** Use the provider's JSON or schema mode, and validate anyway. Parsing free text with regex is a bug you've scheduled for later.
- **Give the model a way to say "I don't know."** If your schema can't express uncertainty, the model will express it by being confidently wrong.
- **Treat the output as untrusted input.** Check it before it touches a database, the same way you'd check a form submission.

<pre class="mermaid">
graph LR
    A[Model output] --> B{Matches schema?}
    B -->|No| R[Reject and retry\nor fall back]
    B -->|Yes| C{Value is unknown?}
    C -->|Yes| H[Human queue]
    C -->|No| D[Use the result]
</pre>

Once the contract is fixed, you can change the prompt freely behind it. That's the point.

## 2. Design for the latency you actually have

A model call is not a database read. It can take under a second or several minutes, depending on how much text goes in, how much comes out, and how much reasoning is involved. Design for the slow cases, not the average.

Pick a pattern based on who is waiting:

<pre class="mermaid">
graph TD
    A[New LLM route] --> B{Is a person\nwaiting on screen?}
    B -->|Yes| C[Stream the response\nshow progress early]
    B -->|No| D{Needed within\nminutes?}
    D -->|Yes| E[Background queue\nreturn a job ID]
    D -->|No| F[Batch API\ncheaper, runs later]
</pre>

Two habits help:

- **Set timeouts on purpose.** SDK defaults are often generous (ten minutes is common). A user-facing request should never inherit that.
- **Batch what isn't urgent.** Overnight enrichment and bulk classification don't need real-time pricing. Most providers offer a batch API at a discount.

If you can't say what a route's time budget is, it isn't ready for a model.

## 3. Retries, idempotency, and side effects

Model calls fail like any network call: rate limits, overloaded servers, timeouts, dropped streams. The usual rules apply, and they matter more because every attempt costs money.

- **Retry only what can succeed next time.** A rate limit (429) or server error (5xx) is worth retrying with backoff. A bad request (400) will fail the same way again.
- **Cap total attempts.** A retry storm against a paid API turns an outage into an invoice.
- **Never let the model call and the side effect happen in one step.** Save the model's decision first, then perform the action in a way that is safe to repeat.

Here's what that looks like:

<pre class="mermaid">
sequenceDiagram
    participant S as Your service
    participant M as Model
    participant DB as Database
    participant E as Email service
    S->>M: Classify this request
    M-->>S: category = refund
    S->>DB: Save decision with request ID
    S->>E: Send email with idempotency key
    Note over S,E: If the email fails, retry only that step
</pre>

If the email step fails, only that step is retried. The saved decision means the model isn't called twice, and the idempotency key means the customer never gets two emails.

I've written before about [idempotence](/blog/idempotence-in-software-design) and [atomicity](/blog/atomicity-in-software-design). Both matter more with LLMs, not less.

## 4. Plan the backup path before you need it

Every LLM feature needs an answer to one question: **what happens when the model is down, slow, or refuses?** There are only a few good answers:

1. **A fallback model.** Another model that meets the same contract. It must pass the same tests, or it isn't a fallback, it's a gamble.
2. **A simple rule.** A rule, a cached result, or the last known good answer. Less clever, always available.
3. **Hide the feature.** The AI part disappears and the main workflow keeps working. Often right for "assistant" features.
4. **Send it to a person.** For decisions that matter, a human queue is a valid backup, not a failure.

What's not acceptable is the AI feature failing and taking the surrounding workflow down with it.

The full request flow I default to:

<pre class="mermaid">
graph TD
    A[Request] --> B{Cached answer?}
    B -->|Yes| Z[Return cached result]
    B -->|No| C[Call primary model\nwith timeout and budget]
    C --> D{Valid against schema?}
    D -->|Yes| E[Save decision]
    D -->|No or refused| F{Backup available?}
    C -->|Timeout or error| F
    F -->|Yes| G[Fallback model\nsame contract]
    G --> D
    F -->|No| H[Simple rule\nor human queue]
    E --> I[Run side effects\nsafely, once]
</pre>

## 5. Cost is a capacity metric

With most services, someone reviews cost once a quarter. With LLMs, cost changes every time someone edits a prompt, so watch it the way you watch latency.

- **Measure cost per finished task, not per call.** A cheap call that needs three retries isn't cheap.
- **Make prompts cache-friendly.** Providers cache prompts by matching the beginning of the text exactly. Put the parts that never change first and the parts that change every time last.
- **Use only as much reasoning as the task needs.** Simple classification doesn't need the same depth as a multi-step agent. Many models let you tune this per request.
- **Set budgets per customer and per feature.** Hard limits stop one runaway loop from eating the month.

How prompt ordering affects caching:

<pre class="mermaid">
graph LR
    subgraph Good[Cache-friendly order]
        A1[Instructions\nnever change] --> A2[Tool definitions\nrarely change] --> A3[Reference docs\nchange daily] --> A4[User question\nchanges every call]
    end
    subgraph Bad[Cache-breaking order]
        B1[Current timestamp\nchanges every call] --> B2[Instructions] --> B3[Tool definitions] --> B4[User question]
    end
</pre>

In the second version, the timestamp at the top changes every call, so nothing after it can be reused. One line in the wrong place can quietly multiply your bill.

The cheapest token is the one you don't send. Cutting context the model doesn't need usually saves more than switching to a cheaper model.

## 6. Evals are your test suite

You wouldn't ship a parser without tests. A prompt is a parser for natural language, so it needs tests too. In the LLM world these are called **evals**.

An eval set is a fixed list of real inputs with known good answers (or clear grading rules). It runs automatically every time the prompt, the model, or the schema changes.

- **Use real inputs, including messy ones.** Pull examples from production (with proper data handling), not from what you imagine users send.
- **Grade against the contract.** Is the output valid? Is the category right? Did it say `unknown` when it should have?
- **Track one score over time.** A regression should show up as a drop on a chart, not as a support ticket.

Without evals, every prompt edit is a guess, and "it worked on the three examples I tried" is how regressions ship.

## 7. Prompts and models are deploys

A prompt change can change behavior as much as a code change. Treat it the same way: version control, review, automated tests, and a rollout plan.

The model itself changes too. Providers release new versions and retire old ones. **Pin an exact model version** in config, never a name that silently points to something new, and treat upgrades like migrations:

<pre class="mermaid">
graph LR
    A[Prompt or model\nchange] --> B[Code review]
    B --> C[Run evals in CI]
    C --> D{Score held or\nimproved?}
    D -->|No| A
    D -->|Yes| E[Compare cost\nand latency]
    E --> F[Canary on a small\nslice of traffic]
    F --> G{Metrics healthy?}
    G -->|No| H[Roll back]
    G -->|Yes| I[Full rollout]
</pre>

Log the prompt version and model version on every call. When someone asks why an answer changed last Tuesday, that's the only way to find out.

## 8. Observability you'll actually use

Normal monitoring tells you a call was slow. For model calls, also track:

- **Tokens and cost:** input, output, and cached tokens per call
- **Versions:** which model and which prompt version answered
- **Stop reason:** did the model finish normally, hit the length limit, refuse, or call a tool?
- **Validation failures and fallback usage:** as real metrics, with alerts
- **Sampled traces:** a small, access-controlled sample of inputs and outputs for debugging

Stop reasons are the underrated one. If more responses start getting cut off or refused, something upstream changed, and you want to know before users do.

## 9. The trust boundary

Anything the model reads can try to steer it: user messages, retrieved documents, tool results, web pages. This is called **prompt injection**, and you can't fix it with better wording. It's a security boundary problem.

<pre class="mermaid">
graph LR
    subgraph Untrusted[Untrusted zone]
        I1[User input]
        I2[Retrieved documents]
        I3[Tool and web results]
        M[Model]
        I1 --> M
        I2 --> M
        I3 --> M
    end
    subgraph Trusted[Trusted zone: your code]
        V[Validation and\npermission checks]
        A[Actions\nwrites, payments, emails]
    end
    M --> V
    V -->|Allowed| A
    V -->|Risky| H[Human approval]
    H --> A
</pre>

The rule: **the model can suggest, but your code decides.**

- Give the model only the permissions the task needs. A summarizer doesn't need write access.
- Put important actions behind code checks or human approval, outside the model's control.
- Never put secrets in a prompt. Anything in the prompt can end up in the output.
- Don't send sensitive data the task doesn't need, and know your provider's data retention terms.

## The question that matters

The question isn't "which model is best?" Models keep getting better and cheaper, and that answer changes every quarter.

The lasting question is: **if we swapped this model out tomorrow, what would break?**

If the answer is "we'd have to rewrite the feature," the model has leaked into your architecture. If the answer is "we'd run the evals, check the cost dashboard, and canary it," the system was built right.

Engineer the boundary, and the model becomes just another dependency. That's the goal.
