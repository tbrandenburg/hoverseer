# Authoring workflows

Create or import workflows, add human approvals and shell steps, and add worker nodes. Back to the [README](../README.md).

## Add or edit a workflow

Create a project in Studio or import an existing Zigflow YAML file. Import validates the file and creates a new Studio project. Use Studio to update an existing project.

```bash
./hoverseer docker import my-workflow path/to/workflow.yaml
./hoverseer docker reload
```

Use the same commands with `kubernetes` on that backend. Reload registers the saved definitions with Zigflow. Let active runs finish before reloading a changed definition, since a new definition can change how Temporal replays those runs. The seed step preserves existing Studio edits across restarts.

### Add a human approval

Use Zigflow’s `call: activity` task to send a request to Cruncher.

```yaml
- requestReview:
    call: activity
    with:
      name: requestApproval
      taskQueue: hoverseer-activities
      arguments:
        - title: Review article draft
          context: Approve the draft to mark it ready for publication.
          payload:
            headline: '${ $input.headline }'
```

The activity takes a title, optional Markdown context, and an optional JSON object for the review details. It returns an `approvalId`. Cruncher gets the workflow execution identifiers from Temporal and uses the activity ID to send a stable idempotency key on retries. Additional named activities can register with the same worker and queue.

Add a `listen` task in the main workflow for `hitly.decision`. The workflow owns the timeout and the branches for `accept` or `reject`. See the [article workflow](../workflows/article-review/workflow.yaml) and the [refund workflow](../workflows/refund-review/workflow.yaml) for complete examples.

### Run a multiline shell step

Cruncher runs `runShell` on the shared `hoverseer-activities` queue. Use a YAML literal block (`|`) to write multiple commands, like a GitHub Actions `run` block.

```yaml
- runShell:
    call: activity
    with:
      name: runShell
      taskQueue: hoverseer-activities
      arguments:
        - shell: sh
          timeoutSeconds: 10
          script: |
            printf '%s\n' 'Running shell step'
            printf 'Message: %s\n' "$MESSAGE"
          environment:
            MESSAGE: '${ $input.message }'
```

Pass workflow data through environment variables and quote it in the script. All shell steps in a workflow run start in the same working directory. One step can run `git clone … repo`, and a later step can run `cd repo` and continue from that checkout. A new workflow run gets its own directory.

Docker Compose uses the `cruncher-workspaces` named volume. Kubernetes mounts the `cruncher-workspaces` claim. The files survive a Cruncher restart while that storage is available. Hoverseer retains these files after the run, so delete unneeded workspaces through your storage administration.

Choose `sh` or `bash`. Commands run with `-eu`, return stdout, and fail on a nonzero exit, a timeout, or output above 64 KiB.

The child process starts with a limited environment, but shell scripts share the Cruncher user, filesystem, and network with the approval activity. They can potentially access credentials held by that worker. Run scripts from trusted workflow authors. The native Zigflow `run.shell` task still executes inside the Zigflow worker.

The [bundled shell example](../workflows/shell-example/workflow.yaml) opens in Studio with the Run shell inspector. Start it with the CLI and inspect the result in Temporal Web.

```bash
./hoverseer docker start shellExample '{"message":"Hello from Hoverseer"}'
./hoverseer kubernetes start shellExample '{"message":"Hello from Hoverseer"}'
```

### Add a worker node

Start with the [node guide](../nodes/README.md). Open a workflow body in Studio to add **Request approval** or **Run shell** from the palette and edit its inputs in the inspector. Studio saves standard Zigflow `call: activity` YAML using the name and queue from the node definition.
