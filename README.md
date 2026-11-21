# hoverseer

Hoverseer runs workflows with human approval. Author workflows in Zigflow Studio, run them on Temporal, and review approval requests in HITLy. The included workflows demonstrate refund decisions and editorial approval.

The sample workflow automatically approves up to **$100.00**. Larger amounts create an inbox item and wait up to five minutes for a reviewer. HITLy sends a Temporal signal with the decision. Zigflow returns `approved` or `rejected`. A missed deadline fails the execution with a timeout.

## Choose a deployment

Both paths run Zigflow, Studio, Temporal, HITLy and the approval gateway. Zigflow loads every project saved as `workflows/<project>/workflow.yaml` in the shared volume. The gateway keeps the HITLy project credentials out of the workflow definition and Temporal activity inputs. It calls the HITLy Temporal plugin over HTTP and uses a key scoped to the run and step when creating an approval. Internal DNS names are the same for both paths.

Prerequisites are Bash, OpenSSL, Docker with Compose for the Docker path, or a Kubernetes cluster with a default storage class and `kubectl` for the Kubernetes path. The example below uses kind and Docker to build the two upstream app images. First builds download the pinned upstream source and dependencies.

### Docker Compose

```bash
./hoverseer init
./hoverseer docker up
```

Check startup with `docker compose ps`. HITLy runs its database migrations at startup. Shut down with `./hoverseer docker stop`.

### Kubernetes

This example assumes a new or existing kind cluster named `hoverseer`.

```bash
kind create cluster --name hoverseer
kubectl config use-context kind-hoverseer
./hoverseer init
./hoverseer kubernetes build
kind load docker-image hoverseer-studio:local hoverseer-hitly:local --name hoverseer
./hoverseer kubernetes up
./hoverseer kubernetes forward
```

Keep port forwarding running in a separate terminal. Check startup with `kubectl -n hoverseer get pods,pvc`. On another Kubernetes cluster, publish the two images to a registry the cluster can pull from, set the corresponding image names in a Kustomize overlay or in `k8s/stack.yaml`, and run `./hoverseer kubernetes up` using that context. Use only one deployment on the same set of local ports at a time.

### Open the apps

| App | Local URL | Use |
| --- | --- | --- |
| Zigflow Studio | [localhost:3000](http://localhost:3000) | Create or edit workflow projects |
| HITLy | [localhost:3001](http://localhost:3001) | Review requests and record decisions |
| Temporal Web | [localhost:8233](http://localhost:8233) | Inspect workflow status, event history and results |

## Connect the inbox

1. Create a local HITLy account and a project using the **Temporal** plugin.
2. In the project's configuration, use `temporal:7233` for **Temporal address** and **Workflow address**, and `default` for **Temporal namespace**. Use `refund-review` if the interface asks for the task queue. No Temporal API key is needed for this local server.
3. Create a project API key. Put the project ID and API key in `.env` as `HITLY_PROJECT_ID` and `HITLY_API_KEY`. Keep the generated database and authentication secrets in that file.
4. Run `./hoverseer docker configure` or `./hoverseer kubernetes configure`. This updates the gateway. If HITLy offers a project SLA setting, set it close to the five-minute workflow wait. The Temporal deadline and HITLy inbox expiry are separate.

## Run a workflow

Use the workflow type as the first argument and pass its input as JSON. The task queue defaults to the workflow type. If `document.taskQueue` is different, specify it with `--task-queue`.

```bash
./hoverseer docker start articleReview '{"headline":"Release notes","draft":"What changed this week."}'
./hoverseer kubernetes start articleReview '{"headline":"Release notes","draft":"What changed this week."}'
./hoverseer docker start refundReview '{"orderId":"order-123","amountCents":15000}' --task-queue refund-review
```

In HITLy, open the article review and approve it to return `ready_to_publish` or reject it to return `changes_requested`. See the result in Temporal Web.

### Refund example

Use the backend you started. These commands show Docker.

```bash
./hoverseer docker start 5000 order-small
./hoverseer docker start 15000 order-approve
./hoverseer docker start 15000 order-reject
```

For Kubernetes, use `./hoverseer kubernetes start` with the same arguments.

- Open the first run in Temporal Web. Its output is `auto_approved`. It creates no inbox item.
- Approve the second request in HITLy. The same Temporal execution returns `approved`. Reject the third request to get `rejected`.
- For a timeout, start another large refund and let the five-minute wait elapse. If the HITLy item remains visible, it expires independently or can be cancelled from HITLy.
- To verify recovery, start a large refund, leave it pending, and run `./hoverseer docker reload` or `./hoverseer kubernetes reload` before approving. Restart port forwarding after the Kubernetes reload if it ends.

## Add or edit a workflow

Create a project in Studio or import an existing Zigflow YAML file. Import validates the file and creates a new Studio project. Use Studio to update an existing project.

```bash
./hoverseer docker import my-workflow path/to/workflow.yaml
./hoverseer docker reload
```

Use the same commands with `kubernetes` on that backend. Reload registers the saved definitions with Zigflow. Let active runs finish before reloading a changed definition, since a new definition can change how Temporal replays those runs. The seed step preserves existing Studio edits across restarts.

### Add a human approval

From a Zigflow HTTP task, send a JSON POST to `http://approval-gateway:8080/approvals`.

| Field | Value |
| --- | --- |
| `workflowId` | `${ $data.workflow.workflow_execution_id }` |
| `runId` | `${ $data.workflow.workflow_execution_run_id }` |
| `stepId` | A stable approval checkpoint ID. For a checkpoint inside a loop, use a distinct ID for each visit. |
| `title` | Short action name displayed in HITLy. |
| `context` | Optional Markdown that explains the decision. |
| `payload` | Optional JSON object with the details the reviewer needs. |

Then add a `listen` task in the main workflow for the Temporal signal `hitly.decision`. The workflow defines its own timeout and what to do with `accept` or `reject`. The gateway uses the configured HITLy project for all workflows.

See the [article workflow](workflows/article-review/workflow.yaml) and the [refund workflow](workflows/refund-review/workflow.yaml) for complete examples.

Open Studio and Temporal Web on localhost through Compose or kubectl port forwarding.
