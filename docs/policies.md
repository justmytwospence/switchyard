# Agent orchestration and policies

This describes the phase 3 implementation under development, not a reviewed or shipped release. Policies are guardrails for managed Pi actions, not an OS sandbox: trusted extensions and code running as the host user can bypass interception. Use host OS permissions and isolation appropriate to the agent's access.

## Agent tools and inbox

The managed bridge registers these Pi tools:

- `switchyard_create_task` creates a Ready task in the caller's project, with an objective, optional acceptance criteria and dependencies, parent, host/profile hints and finish notification. By default its parent is the calling session's task. Ready does not mean immediate execution: automation, dependencies, capacity and workspace gates still apply.
- `switchyard_send` sends to a session in `steer` or `queue` mode. Use `replyTo` when replying to a message. Pairwise rate and causal-depth limits constrain loops.
- `switchyard_inbox` reads the recipient's durable messages, with cursor pagination. Ordinary deliveries inject an identifying header, not the message body; read the inbox for the body.

The board nests subtasks, and parent cycles are rejected. Finish subscriptions survive restarts. A child reaching Review, Done or Failed generates a bounded notice with its title, outcome, last reply and open permission IDs; it is also in the inbox. Messages wait while the terminal has a draft or dialog; after ten minutes they are queued.

Tool-call identity deduplicates task and message creation, and completion notices are captured durably. Confirmed delivery IDs are deduplicated, but if Pi enqueue is ambiguous, delivery is marked uncertain and is not automatically retried. This is not exactly-once Pi execution; inspect the inbox and session before acting on uncertainty.

## Rules and approvals

Settings > Policies manages and tests CEL rules at session, profile and server scope. Rules can return ALLOW, ASK or DENY and maintain bounded counters. Session rules are considered before profile and server rules; a session ALLOW can override a profile ASK, not a DENY or server ASK. Evaluation errors fail closed. The enforced phases are `tool_call` before a Pi tool and `request` for agent actions. Built-in guardrails cover destructive shell actions and continuation budgets; shell classification is conservative, not a complete security boundary.

ASK creates an interaction answered through the existing Switchyard interaction flow. Pi shows the approval URL and waits. A grant is scoped to the root task (or session without a task), rule revision and normalized action fingerprint: it may apply to the matching action in a child, but is not blanket permission. Changes to a rule or action do not inherit that grant.

## Budgets and rollout

Provider/model pairs can be classified cheap or expensive; unclassified models count as expensive. Budget checks happen at settlement before automated continuations, using available token and cost accounting. The built-in soft rule asks at 80%; the built-in hard rule denies an automated continuation at the configured limit for expensive or unclassified models. Continuation count and time limits still apply. **Pre-provider `model_request` enforcement is deferred:** a running turn can exceed a budget, and this integration cannot cap spending inside that turn.

Feature negotiation is optional for compatibility. Old hosts remain browsable, but protected launches refuse unsupported hosts. Policy-capable launches require Pi `>=1.5.0 <1.6.0` and an active, configured bridge; host capability alone is not proof. Legacy live Pi processes remain visibly unprotected until explicitly reloaded or restarted. Initialization, evaluation errors and a 30-second loss of coordinator communication fail closed. A healthy human approval wait itself is not limited to 30 seconds. See [compatibility.md](compatibility.md) and [operations.md](operations.md#upgrading).
