# Operations

The operator's guide is [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md): environment, deploying, switching to the restricted
database role, cutting over to a clean database, backups, the scheduler, routine tasks and incidents. The scheduler's design
and recovery are in [`SCHEDULER.md`](SCHEDULER.md); what blocks a launch is in [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

Two things that used to be described here no longer exist: there is **no demonstration mode** (production refuses the
`DEMO_MODE` settings, and accounts marked as fixtures are refused at sign-in and hidden from the directory), and there is no
simulated pharmacy or AI assistant.

## Health checks

- `GET /api/health`: 200 without touching the database (for a load balancer). Carries the build's commit id.
- `GET /api/health/scheduler`: 200 only while the reminder scheduler's last run succeeded within 20 minutes (for an uptime monitor).
- `GET /version.json`: the commit that is running.
