# Code Review Guide

Updated: 2026-06-17 JST

## Purpose

Use this repository guide when asking Codex or a sub-agent to review a pull request.

The goal is to find real bugs, regressions, missing tests, and design risk without mistaking intentional scope decisions for defects.

## Required Review Context

Always provide these items before starting a review:

1. PR target:
   - PR number or branch range
   - base branch
   - head branch

2. Intended behavior:
   - what the change is supposed to do
   - what user workflow it supports
   - what output or UI state is expected

3. Explicit non-goals:
   - platforms not supported
   - data sources not searched
   - performance or UX tradeoffs accepted for now
   - behavior that is intentionally local-only or partial

4. Test expectation:
   - existing tests to run
   - manual checks required
   - missing tests that should be called out

## Review Rules

1. Check the stated spec first.
   - Do not report behavior as a bug if it matches the stated spec.
   - If the spec is incomplete, ask or mark the item as an assumption.

2. Prioritize findings in this order:
   - correctness bugs
   - user-visible regressions
   - data loss or security risk
   - missing tests for the stated behavior
   - maintainability issues only when they affect near-term change safety

3. Each finding must include:
   - severity
   - file and line
   - observed fact from code or logs
   - why it violates the stated spec
   - suggested smallest fix

4. Do not inflate scope.
   - Do not require generic abstractions for one PR.
   - Do not request platform work that is explicitly out of scope.
   - Do not turn accepted limitations into blockers.

5. If behavior is intentional but untested, report it as a test gap, not a bug.

## Sub-Agent Prompt Template

```text
Review PR <number or branch range>.

Spec:
- <intended behavior>

Non-goals:
- <explicitly unsupported platform or behavior>
- <accepted limitation>

Test expectation:
- <tests to run>
- <manual checks>

Review stance:
- Prioritize bugs, regressions, and missing tests.
- Do not report behavior that matches the spec as a bug.
- If the spec is unclear, list it as an assumption or question.
- Return findings ordered by severity with file/line, code fact, cause, and smallest fix.
```

## Lesson From PR 1

The drawer search review lacked two important spec statements:

- iOS is the only supported platform for this change.
- Search is intentionally local-only over already loaded drawer history.

Because those were not stated up front, the review treated accepted behavior as defects.
The useful remaining review point is that this intended local-only search behavior has no focused test coverage.
