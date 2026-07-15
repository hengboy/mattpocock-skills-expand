# Spec Execution

This context describes the records and work items used to execute a MattPocock Spec through delegated Tickets and final review.

## Language

**Checkpoint**:
A persistent record of the lifecycle and recovery point for one MattPocock Spec execution. Its Spec source is `spec.ref`; it names Ticket prerequisites with `blocked_by` only. An `in_progress` Ticket has its start commit and time, a `done` Ticket has its landed commit and completion time, while a `blocked` Ticket has an error instead.
_Avoid_: state file, `blocking_edges`
