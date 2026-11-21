# Add a Cruncher step

Start with [`request-approval/`](request-approval/). Each step has one folder.

| Put this in `<step-name>/` | Purpose |
| --- | --- |
| `activity.mjs` | Implement the Temporal activity and validate its arguments. |
| `activity.test.mjs` | Test the handler's behavior, including failures and retry behavior where applicable. |
| `step.json` | Describe the step ID, registered activity name, label, and input schema. Cruncher reads the activity name from this file. Studio does not load it yet. |

1. Register the activity in [`index.mjs`](index.mjs) and check the worker's queue in [`../main.mjs`](../main.mjs). Approval runs on `hoverseer-activities`. Use a dedicated worker and queue for steps that need different permissions or dependencies.
2. Add a Zigflow `call: activity` to a workflow. Set `with.name` to the registered name, `with.taskQueue` to the worker's queue, and `with.arguments` to the argument list the handler expects. The workflow's own queue stays in `document.taskQueue`. See the [article-review workflow](../../workflows/article-review/workflow.yaml) for a complete example.
3. Run `npm ci` and `npm test` from [`cruncher/`](../). Rebuild the worker and run a workflow that calls the step. Keep the activity name, queue, and argument contract compatible with saved workflows.

Keep integration credentials in the worker configuration. Pass business inputs through the workflow and activity arguments.

For Studio forms, palette presets, and DSL changes, see the [contribution map](../../CONTRIBUTING.md).
