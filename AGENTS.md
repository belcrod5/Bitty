Codex Instructions

You are working in this repository as a code-changing agent.

Your primary goal is not only to make the requested change work.
Your primary goal is to make the requested change work while keeping the codebase simpler, smaller, and easier to change.

This applies to every task, not only pull requests.

Core rule

Do not move complexity around. Delete it.

A change is not good enough just because it works.
A change is only acceptable if it does not make the system harder to understand, harder to modify, or harder to test.

Prefer:

* deleting code over adding code
* inlining over unnecessary abstraction
* merging thin layers over creating wrappers
* narrowing scope over adding configuration
* explicit simple code over clever generic code
* fixing the underlying shape over patching symptoms

Before changing code

Before implementing, inspect the surrounding code and identify the simplest safe change.

Ask yourself:

* Can this be fixed by deleting or simplifying existing code?
* Am I about to add a new abstraction that is not needed yet?
* Am I moving business logic to the wrong layer?
* Am I spreading one concept across too many files?
* Am I making future changes easier or harder?

If the direct fix would make the code messier, first simplify the design, then implement the fix.

Forbidden patterns

Avoid these unless there is a strong existing reason in the codebase:

* thin wrappers that only rename or forward calls
* generic utilities with fewer than 2 or 3 real call sites
* new configuration options without a current concrete need
* business logic leaking into UI, routing, persistence, or infrastructure layers
* infrastructure concerns leaking into domain logic
* large files becoming larger
* clever abstractions that hide simple behavior
* changes that duplicate logic instead of removing the duplication
* changes that fix one symptom while preserving the broken structure

File size rule

Do not create files over 1,000 lines.

Do not make an existing file over 1,000 lines worse.

If a file is already too large, prefer extracting a real responsibility or deleting unnecessary code.
Do not split files mechanically if the split only moves complexity without improving boundaries.

Abstraction rule

Do not introduce abstractions for imagined future use.

Create an abstraction only when:

* there are multiple real call sites
* the abstraction removes meaningful duplication
* the name clearly represents a domain concept
* the abstraction reduces the amount of code a future reader must understand

If an abstraction only hides one line, forwards arguments, or renames a concept, do not add it.

Layering rule

Keep business logic in the correct layer.

Do not leak domain decisions into:

* controllers
* routes
* UI components
* database adapters
* API clients
* background jobs
* test helpers

When logic is misplaced, move it to the smallest appropriate existing boundary.
Do not create a new layer unless the current structure clearly requires it.

Implementation style

Make the smallest change that solves the real problem cleanly.

Prefer boring code.

Prefer names that make comments unnecessary.

Prefer local reasoning.

A future developer should be able to understand the change without opening many unrelated files.

Self-review before finishing

Before finishing any task, review your own diff.

Check:

* Did I delete or reduce complexity where possible?
* Did I add any thin wrappers?
* Did I create premature abstraction?
* Did I leak logic across layers?
* Did I make any large file larger?
* Did I add indirection that is not needed today?
* Did I preserve or improve testability?
* Would this change be easy to modify later?

If the answer reveals avoidable complexity, revise the code before presenting the result.

Final response

When reporting the result, include:

* what changed
* why this is the simplest safe approach
* what complexity was avoided or removed
* any tests or checks that were run
* any remaining risk or follow-up, if relevant

Do not claim the work is complete if tests were not run.
Say clearly what was and was not verified.

Quality gate

A working change can still be rejected if it makes the codebase messier.

Correct behavior is required.
Simple design is also required.

The best change is the one that solves the problem while leaving the repository easier to work in than before.
