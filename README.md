# hoverseer

A local proof of concept for workflows with human approval. Author the workflow in Zigflow Studio, run it on Temporal, and review approvals in HITLy. The demo returns a simulated refund result. It never calls a payment provider.

The sample workflow automatically approves up to **$100.00**. Larger amounts create an inbox item and wait up to five minutes for a reviewer. HITLy sends a Temporal signal with the decision. Zigflow returns `approved` or `rejected`. A missed deadline fails the execution with a timeout.

## Choose a deployment

Both paths run the same worker, workflow YAML, gateway, Studio, HITLy and Temporal. The gateway keeps the HITLy project credentials out of the workflow definition and Temporal activity inputs. It calls the HITLy Temporal plugin over HTTP and uses a key scoped to the run and step when creating an approval. Internal DNS names are the same for both paths.

Prerequisites are Bash, OpenSSL, Docker with Compose for the Docker path, or a Kubernetes cluster with a default storage class and `kubectl` for the Kubernetes path. The example below uses kind and Docker to build the two upstream app images. First builds download the pinned upstream source and dependencies.

### Docker Compose

```bash
./poc init
./poc docker up
```

Check startup with `docker compose ps`. HITLy runs its database migrations at startup. Shut down with `./poc docker stop`.

### Kubernetes

This example assumes a new or existing kind cluster named `hoverseer`.

```bash
kind create cluster --name hoverseer
kubectl config use-context kind-hoverseer
./poc init
./poc kubernetes build
kind load docker-image hoverseer-studio:local hoverseer-hitly:local --name hoverseer
./poc kubernetes up
./poc kubernetes forward
```

Keep port forwarding running in a separate terminal. Check startup with `kubectl -n hoverseer get pods,pvc`. On another Kubernetes cluster, publish the two images to a registry the cluster can pull from, set the corresponding image names in a Kustomize overlay or in `k8s/stack.yaml`, and run `./poc kubernetes up` using that context. Use only one deployment on the same set of local ports at a time.

### Open the apps

| App | Local URL | Use |
| --- | --- | --- |
| Zigflow Studio | [localhost:3000](http://localhost:3000) | Open the **Refund review** project and inspect or edit the workflow |
| HITLy | [localhost:3001](http://localhost:3001) | Review requests and record decisions |
| Temporal Web | [localhost:8233](http://localhost:8233) | Inspect workflow status, event history and results |

## Connect the inbox

1. Create a local HITLy account and a project using the **Temporal** plugin.
2. In the project's configuration, use `temporal:7233` for **Temporal address** and **Workflow address**, and `default` for **Temporal namespace**. Use `refund-review` if the interface asks for the task queue. No Temporal API key is needed for this local server.
3. Create a project API key. Put the project ID and API key in `.env` as `HITLY_PROJECT_ID` and `HITLY_API_KEY`. Keep the generated database and authentication secrets in that file.
4. Run `./poc docker configure` or `./poc kubernetes configure`. This updates the gateway. If HITLy offers a project SLA setting, set it close to the five-minute workflow wait. The Temporal deadline and HITLy inbox expiry are separate.

## Try it

Use the backend you started. These commands show Docker.

```bash
./poc docker start 5000 order-small
./poc docker start 15000 order-approve
./poc docker start 15000 order-reject
```

For Kubernetes, use `./poc kubernetes start` with the same arguments.

- Open the first run in Temporal Web. Its output is `auto_approved`. It creates no inbox item.
- Approve the second request in HITLy. The same Temporal execution returns `approved`. Reject the third request to get `rejected`.
- For a timeout, start another large refund and let the five-minute wait elapse. If the HITLy item remains visible, it expires independently or can be cancelled from HITLy.
- To demo recovery, start a large refund, leave it pending, and run `./poc docker reload` or `./poc kubernetes reload` before approving. Restart port forwarding after the Kubernetes reload if it ends.

## Edit the workflow

The editable copy is on a shared persistent volume. In Studio, open **Refund review**, open the `refundReview` workflow and change the threshold in `checkAmount`. Save the change. After active runs have finished, use the deployment's `reload` command so Zigflow loads the saved YAML before starting another run. Reloading an edited definition while executions are active can change how Temporal replays them.

The initial file is [workflows/refund-review/workflow.yaml](workflows/refund-review/workflow.yaml). The seeding step preserves existing Studio edits across restarts. Zigflow evaluates the request, conditionally creates and waits for approval, then returns the result. The same approval pattern can be reused with other workflows by changing the request data and decision paths.

These are local demo deployments. Studio and Temporal Web are exposed only on localhost through Compose or kubectl port forwarding.
