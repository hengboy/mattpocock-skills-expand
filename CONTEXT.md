# Spec Execution

This context describes the records and work items used to execute a MattPocock Spec through delegated Tickets and final review.

## Language

**Checkpoint**:
A mutable record of the lifecycle and recovery point for one MattPocock Spec execution. It identifies one immutable Execution Plan revision and records Ticket progress, review, integration, and the Git facts that prove them.
_Avoid_: state file, `blocking_edges`

**Execution Plan**:
An immutable, materialized snapshot of one MattPocock Spec and Issue source references, their Ticket facts, and prerequisites. It is the input to an execution and is distinct from its Checkpoint; source content and work items remain in the committed Spec and Issue files.
_Avoid_: spec copy, issue cache

**Execution Coordinator**:
The owner of one Spec execution that composes the Execution Plan, Checkpoint, worktree lifecycle, and Completion Adapter into one recoverable lifecycle.
_Avoid_: orchestration script, workflow glue

**Frontier**:
The set of Tickets whose prerequisites are complete and can therefore be executed together. A Frontier completes only when every one of its Tickets has a Completion Result, even when one result is blocked.
_Avoid_: batch, queue

**Completion Result**:
The terminal outcome of delegated Ticket execution. It identifies the Ticket and reports whether execution is done or blocked, together with its commits, tests, and non-empty summary; tests may be absent. A done result has at least one landed commit and no error, while a blocked result has no commits and a non-empty error, including when a raw terminal outcome is invalid.
_Avoid_: task response, agent message

**Completion Adapter**:
The module that executes a Frontier and returns its Completion Results. Its supported forms are the concrete Codex/Claude and OpenCode adapters; without one, every Ticket in the Frontier receives a blocked result.
_Avoid_: generic harness support
