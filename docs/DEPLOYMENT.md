# Deployment

Run Hoverseer with Docker Compose or Kubernetes, connect the approval inbox, and manage credentials. Back to the [README](../README.md).

## Choose a deployment

Both deployments run Zigflow for workflow orchestration and `cruncher` for Temporal activities. Zigflow loads every project saved as `workflows/<project>/workflow.yaml` in the shared volume. Cruncher registers `requestApproval` and `runShell` on `hoverseer-activities`. It calls the HITLy service at `hotl:3001` using its own credentials. Both runners connect to the same Temporal namespace.

Prerequisites are Bash, OpenSSL, Docker with Compose v2.24 or later for the Docker path, or a Kubernetes cluster with a default storage class and `kubectl` for the Kubernetes path. The example below uses kind and Docker to build the two upstream app images. First builds download the pinned upstream source and dependencies.

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
kind load docker-image hoverseer-studio:local hoverseer-hitly:local hoverseer-api:local hoverseer-cruncher:local --name hoverseer
./hoverseer kubernetes up
./hoverseer kubernetes forward
```

Keep port forwarding running in a separate terminal. Check startup with `kubectl -n hoverseer get pods,pvc`. On another Kubernetes cluster, publish the four images to a registry the cluster can pull from, set the corresponding image names in a Kustomize overlay or in `deploy/kubernetes/stack.yaml`, and run `./hoverseer kubernetes up` using that context. Use only one deployment on the same set of local ports at a time.

### Open the apps

Start at **[Hoverseer on localhost:8082](http://localhost:8082)**. Homepage groups the management tools and shows HTTP reachability for the local services. Each tool handles its own access. The dashboard is local by default and requires no access to Docker, the Kubernetes API or Infisical credentials.

| App | Local URL | Use |
| --- | --- | --- |
| Hoverseer dashboard | [localhost:8082](http://localhost:8082) | Open management tools |
| Zigflow Studio | [localhost:3000](http://localhost:3000) | Create or edit workflow projects |
| HITLy (`hotl`) | [localhost:3001](http://localhost:3001) | Review requests and record decisions |
| Temporal Web | [localhost:8233](http://localhost:8233) | Inspect workflow status, event history and results |
| Workflows | [localhost:8081/workflows](http://localhost:8081/workflows) | Start managed workflows and follow their runs |
| Workflow API | [localhost:8081/openapi.json](http://localhost:8081/openapi.json) | Discover managed workflow routes |
| Infisical | [localhost:8084](http://localhost:8084) or configured URL | Manage credentials on a separate Infisical instance |

For Docker, configure the dashboard port and allowed hosts via `HOVERSEER_DASHBOARD_PORT` and `HOVERSEER_DASHBOARD_HOSTS`. Set `HOVERSEER_STUDIO_URL`, `HOVERSEER_HOTL_URL`, `HOVERSEER_TEMPORAL_WEB_URL`, `HOVERSEER_API_DOCS_URL`, `HOVERSEER_WORKFLOWS_URL` and `HOVERSEER_INFISICAL_UI_URL` as needed for browser-reachable links. For Kubernetes, patch the corresponding `HOMEPAGE_ALLOWED_HOSTS` and `HOMEPAGE_VAR_*` settings in the dashboard Deployment. Configure [Homepage authentication](https://gethomepage.dev/installation/#security-authentication) or an authenticated reverse proxy before publishing the dashboard.

## Connect the inbox

1. Create a local HITLy account and a project using the **Temporal** plugin.
2. In the project's configuration, use `temporal:7233` for **Temporal address** and **Workflow address**, and `default` for **Temporal namespace**. Use `refund-review` if the interface asks for the task queue. No Temporal API key is needed for this local server.
3. Create a project API key. Place the project ID and API key in Infisical as described below or use `HITLY_PROJECT_ID` and `HITLY_API_KEY` in `.env`. Keep the generated database and authentication settings in `.env`.
4. Run `./hoverseer docker configure` or `./hoverseer kubernetes configure`. This reloads the HITLy credentials in Cruncher and the compatibility gateway. If HITLy offers a project SLA setting, set it close to the five-minute workflow wait. The Temporal deadline and HITLy inbox expiry are separate.

### Use Infisical for Cruncher

1. Use an existing Infisical instance or deploy one with the official [Compose setup](https://infisical.com/docs/self-hosting/deployment-options/docker-compose) or [Helm chart](https://infisical.com/docs/self-hosting/deployment-options/kubernetes-helm). Set the dashboard's Infisical link to the URL admins use in their browsers.
2. In Infisical, create a project, an environment such as `prod`, and a folder such as `/cruncher`. Save `HITLY_PROJECT_ID` and `HITLY_API_KEY` there. Give a [Universal Auth machine identity](https://infisical.com/docs/documentation/platform/identities/universal-auth) permission to read secrets in that environment and folder.
3. Create `cruncher/.env.infisical` with permissions `0600` for Docker. The file is ignored by Git. For Kubernetes, use the same keys in the `hoverseer-infisical` Secret. The SDK URL must be reachable from Cruncher. Use HTTPS for a remote instance.

   ```dotenv
   INFISICAL_SITE_URL=https://infisical.example.com
   INFISICAL_PROJECT_ID=<infisical-project-id>
   INFISICAL_CLIENT_ID=<machine-identity-client-id>
   INFISICAL_CLIENT_SECRET=<machine-identity-client-secret>
   INFISICAL_ENVIRONMENT=prod
   INFISICAL_SECRET_PATH=/cruncher
   ```

   With the Kubernetes namespace already created, you can apply the file as follows.

   ```bash
   kubectl -n hoverseer create secret generic hoverseer-infisical \
     --from-env-file=cruncher/.env.infisical --dry-run=client -o yaml |
     kubectl apply --server-side -f -
   ```

4. Run `docker compose up -d --no-deps --force-recreate cruncher` or `kubectl -n hoverseer rollout restart deployment/cruncher` to pick up the settings and after changing either HITLy secret. Cruncher reads both keys before it starts polling Temporal. Authentication or lookup failures stop worker startup. The compatibility gateway still uses `.env` for any legacy workflows that call it.

### Upgrade existing deployments

- If you deployed the separate shell worker, update the saved shell tasks to use `hoverseer-activities` and reload the workflows. Remove the old container with `docker stop hoverseer-cruncher-shell-1 && docker rm hoverseer-cruncher-shell-1` for the default Compose project, or remove the old Deployment with `kubectl -n hoverseer delete deployment cruncher-shell --ignore-not-found`.
- For Docker, stop or bring down the previous Compose stack before starting the renamed `hotl` service so both containers do not claim port `3001`. Keep the existing volumes. The database name, credentials, and HITLy volume are reused. On Kubernetes, the existing HITLy Deployment is updated in place and exposed by the new `hotl` Service.
- Seeding preserves workflow files already on the shared volume. The compatibility gateway stays available for those definitions. After their active runs finish, update their review steps to the example in [Add a human approval](AUTHORING.md#add-a-human-approval) and reload Zigflow. Keep the gateway running while any definitions still use its HTTP endpoint.

Open Studio and Temporal Web on localhost through Compose or kubectl port forwarding.
