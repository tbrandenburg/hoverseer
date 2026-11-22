# Running workflows

Start the bundled workflows from the Workflows page or the command line, and follow their runs. Back to the [README](../README.md).

## Run from the Workflows page

Open **Workflows** from the dashboard and select a managed workflow. Enter its inputs and the local `HOVERSEER_API_TOKEN` from `.env`. The form uses the workflow’s OpenAPI input schema where possible and accepts raw JSON for complex inputs. The page shows the current run status, completed output, and a link to Temporal Web. The token stays on the page for its session.

The displayed catalog revision identifies the YAML snapshot the API loaded. It does not verify that Zigflow has loaded that same revision. Reload both services after publishing workflow changes. The page’s Studio and Temporal links use `HOVERSEER_STUDIO_URL` and `HOVERSEER_TEMPORAL_WEB_URL`.

## Run a workflow from the command line

Use the workflow type as the first argument and pass its input as JSON. The task queue defaults to the workflow type. If `document.taskQueue` is different, specify it with `--task-queue`.

```bash
./hoverseer docker start articleReview '{"headline":"Release notes","draft":"What changed this week."}'
./hoverseer kubernetes start articleReview '{"headline":"Release notes","draft":"What changed this week."}'
./hoverseer docker start refundReview '{"orderId":"order-123","amountCents":15000}' --task-queue refund-review
```

In HITLy, open the article review and approve it to return `ready_to_publish` or reject it to return `changes_requested`. See the result in Temporal Web.

## Refund example

The sample refund workflow automatically approves up to **$100.00**. Larger amounts create an inbox item and wait up to five minutes for a reviewer. HITLy sends a Temporal signal with the decision. Zigflow returns `approved` or `rejected`. A missed deadline fails the execution with a timeout.

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
