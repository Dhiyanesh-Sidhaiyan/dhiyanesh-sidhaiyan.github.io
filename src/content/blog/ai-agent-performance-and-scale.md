---
title: "Where AI Agents Get Slow and Expensive: Performance and Scale in Practice"
date: 2026-10-20
tags: [ai, architecture, performance, backend]
description: "Agents don't have one performance problem, they have compounding ones. Where latency, cost, and capacity actually go, with worked examples and the fixes that hold up at scale."
---

The first agent demo always feels fast. One question, a few tool calls, a good answer in fifteen seconds. Then it goes to a hundred users, then a thousand, and the same agent takes two minutes, hits rate limits at lunchtime, and costs more per task than the person it was meant to help.

Nothing changed in the code. What changed is that agent performance problems **compound**. Each one is small on its own. Multiplied across steps, users, and retries, they become the whole story.

This post is about where that compounding happens and what actually helps. If you haven't decided yet whether you need an agent at all, start with [Agent vs. Pipeline](/blog/agent-vs-pipeline). Most performance problems are cheapest to solve by not having them.

## Why agents are different from a single LLM call

A single model call has one latency and one cost. An agent is a **loop**: the model thinks, calls a tool, reads the result, and decides again. Every trip around the loop re-sends the growing conversation.

<pre class="mermaid">
graph LR
    A[Task] --> B[Model decides\nnext step]
    B --> C{Done?}
    C -->|No| D[Call a tool]
    D --> E[Append result\nto context]
    E --> B
    C -->|Yes| F[Answer]
</pre>

That loop creates three effects that don't exist in normal backend code:

1. **Latency adds up per step,** and you don't know how many steps there will be.
2. **Context grows every step,** so each step is slower and more expensive than the one before.
3. **One user request becomes many model calls,** so capacity planning in "requests per second" stops making sense.

Most agent performance work is managing those three things.

## 1. Latency: the step count is the real enemy

### The basic math

Say each step takes about 3 seconds of model time and 1.5 seconds of tool time. A 12-step task:

> 12 steps × (3s + 1.5s) = **54 seconds**

There's no single slow component to optimize. Every part is "fine." The total isn't.

The biggest lever is almost never making one step faster. It's **taking steps out**:

- **Give tools more power per call.** A `search_orders(customer, status, date_range)` tool replaces three calls to `get_customer`, `list_orders`, and `filter_orders`. Fine-grained tools feel clean to design and are slow to use.
- **Let the model call tools in parallel.** Most current models can request several tool calls in one turn. If your tool runner executes them one after another, you've thrown that away.
- **Do the predictable parts in code.** If every task starts by loading the user's account, load it before the loop starts and put it in the prompt. Don't make the model spend a step asking for it.

Here's the same work done serially and in parallel:

<pre class="mermaid">
graph TD
    subgraph Serial[Serial: about 18s]
        S1[Model: plan\n3s] --> S2[Tool: orders\n2s] --> S3[Model\n3s] --> S4[Tool: invoices\n2s] --> S5[Model\n3s] --> S6[Tool: tickets\n2s] --> S7[Model: answer\n3s]
    end
    subgraph Parallel[Parallel: about 8s]
        P1[Model: plan\n3s] --> P2[Tool: orders\n2s]
        P1 --> P3[Tool: invoices\n2s]
        P1 --> P4[Tool: tickets\n2s]
        P2 --> P5[Model: answer\n3s]
        P3 --> P5
        P4 --> P5
    end
</pre>

Same tools, same model, less than half the time. And two fewer model calls, each re-sending the whole conversation, means lower cost too.

### Tail latency multiplies

Averages hide the real problem. Suppose any single step has a 1 in 100 chance of being slow (a cold tool, a provider hiccup, a long model response). For one call, that's rare. For a 20-step agent:

> Chance at least one step is slow = 1 − 0.99²⁰ ≈ **18%**

Nearly one in five tasks hits a slow step. Your agent's typical experience is shaped by the *worst* step, not the average one. This is why agents that look fine in a benchmark feel sluggish in production.

What helps:

- **Per-step timeouts,** not just a timeout on the whole task. A tool that normally takes 200ms and is now taking 20 seconds should fail fast and let the model try something else.
- **Hedge slow, safe reads.** For read-only tools with high tail latency, sending a second request after a short delay and taking whichever returns first is cheap insurance.
- **Stream progress to the user.** If a task truly needs 40 seconds, showing "searching invoices…" changes how long it *feels*, even though it doesn't change how long it takes.

## 2. Context growth: the cost curve nobody draws

This is the effect that surprises teams most.

Every step re-sends the whole conversation so far. If each step adds about 4,000 tokens (a tool result plus the model's reasoning), then:

| Step | Context sent this step |
|---|---|
| 1 | 4k |
| 5 | 20k |
| 10 | 40k |
| 20 | 80k |

A team might estimate "20 steps × 4k = 80k tokens per task." The real number is the **sum** of every step's context:

> 4k + 8k + 12k + … + 80k = **840k input tokens**

That's more than ten times the estimate. Cost and latency grow with the *square* of the step count, not in a straight line. Doubling the steps roughly quadruples the input tokens.

<pre class="mermaid">
graph LR
    A[More steps] --> B[Bigger context\neach step]
    B --> C[Each step slower\nand costlier]
    B --> D[Model attention\nspread thinner]
    D --> E[More mistakes]
    E --> F[More steps to recover]
    F --> A
</pre>

That last loop is the nasty part. Very long contexts can also make the model less focused, which causes mistakes, which causes more steps. Performance and quality problems feed each other.

### What actually controls context growth

- **Keep tool results small.** The single biggest win in most agents. A tool that returns a 30k-token JSON blob when the model needed three fields is a performance bug. Return summaries, the fields that matter, and a way to ask for more (pagination, an ID to fetch details).
- **Cache the stable prefix.** Providers cache prompts by exact prefix. Keep the system prompt and tool definitions identical across calls and put them first. In an agent loop, the conversation history is also a stable prefix that only grows, so it caches well too, as long as you only append and never edit earlier turns. Cached input is typically billed at a small fraction of the normal price and processed faster.
- **Clear what's no longer needed.** Old tool results the agent has already acted on can often be dropped or replaced with a one-line note. Many platforms now support clearing old tool results or summarizing (compacting) older history automatically. Use it, but test it: dropping the wrong thing causes the agent to redo work.
- **Split long tasks into sub-agents.** A sub-agent that reads twenty documents and returns a one-paragraph finding keeps those twenty documents out of the main agent's context. You pay for the sub-agent's tokens once, instead of re-sending them on every later step.

Back to the example: with tool results trimmed from 4k to 1.5k per step and the prefix cached, the same 20-step task drops from 840k full-price input tokens to roughly 315k, most of them served from cache. Same agent, same answers, a fraction of the cost.

## 3. Capacity: tokens are the scarce resource, not CPU

### One request is not one request

In a normal web service, one user request is roughly one unit of work. With agents, one user request becomes 5, 20, or 50 model calls, each with a growing context. Your servers will be mostly idle while you hit the provider's limits.

Model providers rate-limit on **requests per minute** and **tokens per minute**. For agents, the token limit almost always hits first. A worked example:

> Each task uses about 300k input tokens (after trimming).
> Your account allows 2M input tokens per minute.
> **Maximum throughput ≈ 6 or 7 tasks per minute,** no matter how many servers you run.

That's the number to put in the capacity plan. Adding pods doesn't move it. Only fewer tokens per task, caching (cached tokens often count differently against limits), higher limits, or spreading load across providers or regions moves it.

### Protect the system with a queue, not with retries

When an agent fleet hits rate limits, the natural reaction is retrying, and that makes it worse: every retry re-sends a big context and burns more of the same limit. The fix is **admission control**: decide how many agents run at once, and queue the rest.

<pre class="mermaid">
graph TD
    U[User tasks] --> Q[Task queue\nwith priority]
    Q --> AC{Token budget\navailable?}
    AC -->|Yes| W[Agent workers\nfixed concurrency]
    AC -->|No| H[Wait in queue\nshow position to user]
    H --> AC
    W --> L[Shared rate limiter\ntokens per minute]
    L --> M[Model provider]
    W --> T[Tools and\ninternal APIs]
</pre>

What this buys you:

- **Predictable behavior under load.** At peak, tasks wait in a visible queue instead of failing randomly halfway through.
- **Priority.** An interactive user's task can jump ahead of a nightly batch job.
- **Fairness.** Per-tenant limits stop one heavy customer from consuming everyone's capacity.
- **Graceful degradation.** Under heavy load, you can route lower-priority work to a smaller, cheaper model or a lower reasoning-effort setting instead of rejecting it.

### Your own tools become the bottleneck

Agents are very good at load-testing your internal APIs by accident. A hundred concurrent agents, each calling a search tool five times in parallel, is 500 simultaneous requests to a service that was sized for a human-driven UI.

Before scaling agents, check every tool they call:

- Does the downstream service have the capacity for agent traffic, not just human traffic?
- Does the tool have its own timeout, rate limit, and circuit breaker?
- Is it safe to call twice? Agents retry and repeat themselves. Any tool that writes data needs an idempotency key.

## 4. Long-running tasks need durable state

An agent that runs for ten minutes can't live inside an HTTP request. Connections drop, pods restart during deploys, and providers have brief outages. If the agent's state only exists in memory, any of those means starting over, and paying for every step again.

Treat a long agent task like a workflow, not a request:

<pre class="mermaid">
sequenceDiagram
    participant U as User
    participant API as API
    participant DB as Task store
    participant W as Agent worker
    participant M as Model
    U->>API: Start task
    API->>DB: Create task, status running
    API-->>U: Task ID
    loop Each step
        W->>M: Next step with context
        M-->>W: Tool call or answer
        W->>DB: Checkpoint step and result
    end
    W->>DB: Mark complete
    U->>API: Poll or subscribe for updates
</pre>

- **Checkpoint after every step.** If the worker dies at step 14, a new worker resumes at step 15 instead of step 1.
- **Return a task ID, not a held connection.** Users get progress through polling or a stream that can reconnect.
- **Set a step limit and a budget per task.** An agent stuck in a loop should stop at a known ceiling, not run until someone notices the bill. Some platforms let you give the model a token budget it can see, so it plans to finish within it instead of being cut off.

## 5. The development loop is a performance problem too

Teams talk about agent performance in production and forget the one that slows them down every day: **iteration speed**.

Testing an agent is slow and expensive. A real run takes a minute and costs real money. Results vary run to run. A twenty-case eval suite can take half an hour and still not tell you clearly whether your change helped.

What keeps the development loop fast:

<pre class="mermaid">
graph LR
    A[Code or prompt\nchange] --> B[Unit tests:\ntools in isolation\nseconds]
    B --> C[Replay tests:\nrecorded model and\ntool responses\nseconds]
    C --> D[Small live eval:\n20 key cases\nminutes]
    D --> E[Full eval suite\nin CI\nbefore merge]
    E --> F[Canary in\nproduction]
</pre>

- **Test tools without the model.** Most agent bugs are ordinary tool bugs: a bad query, a missing field, a slow endpoint. Plain unit tests catch them in seconds.
- **Record and replay.** Capture a real run's model responses and tool results, then replay them to test your loop logic, checkpointing, and error handling without calling the model at all. Fast, free, and repeatable.
- **Keep a small "smoke" eval.** Twenty carefully chosen tasks that run in a few minutes, for quick feedback during development. Save the full suite for CI.
- **Run evals several times.** Agents vary between runs. One pass/fail tells you little. Three runs and a pass rate tells you a lot more.
- **Track steps and tokens per task in every eval.** A change that keeps accuracy the same but adds four steps per task is a performance regression. Catch it before production does.

## 6. Measure the things that actually move

Generic monitoring won't show you any of the problems above. For agents, the useful numbers are:

| Metric | Why it matters |
|---|---|
| Steps per task, as a distribution | The long tail of 40-step tasks is usually where cost and latency hide |
| Input tokens per step and per task | Shows context growth and tool results that are too large |
| Cache hit rate on input tokens | A sudden drop means someone broke the stable prefix |
| Time per step, split into model and tool | Tells you where to spend optimization effort |
| Token budget used vs provider limit | Your real capacity headroom |
| Queue wait time | Your first warning sign that capacity is running out |
| Cost per completed task | The number that decides whether the agent is worth running at all |

The distribution of steps per task is the one I'd look at first. When an agent is slow or expensive, it's rarely because the average task got worse. It's usually because a small share of tasks are wandering, taking three or four times the normal number of steps. Find those tasks, read their traces, and you'll usually find a missing tool, a confusing tool result, or an unclear instruction.

## Where to start

When an agent is too slow or too expensive, work in this order. The early steps are cheaper and usually give more back.

<pre class="mermaid">
graph TD
    A[Agent too slow\nor too expensive] --> B{Could this be a\npipeline instead?}
    B -->|Yes| P[Replace the loop\nwith fixed steps]
    B -->|No| C[Trim tool results\nand cache the prefix]
    C --> D[Cut steps: stronger tools,\nparallel calls, preload data]
    D --> E[Right-size the model:\nsmaller model or lower\neffort for simple steps]
    E --> F[Move heavy reading\ninto sub-agents]
    F --> G[Queue, budgets, and\nadmission control for scale]
</pre>

Notice what's *not* on the list early: switching to a faster model. It's tempting because it's a one-line change, but it rarely fixes an agent that takes too many steps or carries too much context. It just makes a bad loop run a bit faster.

## The tradeoffs worth being honest about

Every fix above has a cost:

- **Stronger tools mean less flexibility.** A tool that does three things in one call is faster, and the model can no longer combine those pieces in new ways.
- **Parallel calls make failures messier.** When three calls run at once and one fails, the agent and your error handling have to cope with partial results.
- **Clearing context can cause rework.** Drop a tool result the agent needed later, and it calls the tool again. Measure before and after.
- **Sub-agents add hops.** They save main-context tokens but add their own latency and their own failure modes. They pay off for heavy reading, not for small lookups.
- **Queues make peak-time waits visible.** That's honest and better than random failures, but someone has to agree that "your task is 4th in line" is an acceptable experience.

None of these are reasons to skip the fixes. They're reasons to measure each one instead of applying all of them at once.

## The takeaway

Agent performance isn't one problem you solve once. It's a few small effects, more steps, bigger context, more calls per request, multiplying each other. The teams that scale agents well don't have a faster model than everyone else. They have fewer steps, smaller contexts, a queue in front of the provider, and a dashboard that shows steps and tokens per task.

The question to ask before every agent launches: **what does one task cost in steps, tokens, and seconds, and what happens when a thousand of them run at once?** If nobody can answer that yet, it isn't ready to scale. For the dependency side of the same picture, timeouts, fallbacks, and contracts, see [The LLM Is a Backend Dependency](/blog/llm-as-a-backend-dependency).
