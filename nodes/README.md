# Add a worker node

Start with [`request-approval/`](request-approval/) or [`shell/`](shell/). Each Hoverseer node has one folder.

| File in `<node>/` | Purpose |
| --- | --- |
| `node.json` | Define the palette label, activity name, worker queue, argument schema, defaults, multiline fields, and default Temporal activity options. |
| `activity.mjs` | Implement the Temporal activity and validate the resolved arguments. |
| `activity.test.mjs` | Test the activity's behavior. |
| `example.yaml` | Copy this Zigflow task into a workflow's `do` list. |

1. Register the handler in [`index.mjs`](index.mjs) and set `taskQueue` in the manifest to `hoverseer-activities`, the queue polled by [Cruncher](../cruncher/main.mjs). Keep the deployed names, queues, and argument contracts compatible with saved workflows.
2. Rebuild Studio and Cruncher. Studio reads the manifests at build time and offers the presets inside a workflow body. It saves `call: activity` with one object argument. Zigflow reads the saved YAML and schedules the activity. Cruncher runs it on the queue named by the manifest.
3. Run `npm ci` and `npm test` in [`cruncher/`](../cruncher/). Open Studio, add the node, save the workflow, and run it. Compare the saved task with `example.yaml`.

Put integration credentials in the worker configuration. Keep workflow inputs in the argument object. See the [contribution map](../CONTRIBUTING.md) for workflow authoring and upstream Studio or Zigflow changes.

For Docker, `./hoverseer docker up` rebuilds both images. For an existing kind cluster, rebuild and load the Studio and Cruncher images, then restart the `workflow` and `cruncher` Deployments to pick up the refreshed local tags.
