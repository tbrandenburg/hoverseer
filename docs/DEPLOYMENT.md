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

4. Run `docker compose up -d --no-deps --force-recreate cruncher` or `kubectl -n hoverseer rollout restart deployment/cruncher` to pick up the settings and after changing either HITLy secret. Cruncher verifies both keys before it starts polling Temporal, then resolves fresh credentials inside each approval activity. Authentication or lookup failures stop worker startup; a later lookup failure fails the activity rather than falling back to direct credentials. The compatibility gateway still uses `.env` for any legacy workflows that call it.

### Upgrade existing deployments

- If you deployed the separate shell worker, update the saved shell tasks to use `hoverseer-activities` and reload the workflows. Remove the old container with `docker stop hoverseer-cruncher-shell-1 && docker rm hoverseer-cruncher-shell-1` for the default Compose project, or remove the old Deployment with `kubectl -n hoverseer delete deployment cruncher-shell --ignore-not-found`.
- For Docker, stop or bring down the previous Compose stack before starting the renamed `hotl` service so both containers do not claim port `3001`. Keep the existing volumes. The database name, credentials, and HITLy volume are reused. On Kubernetes, the existing HITLy Deployment is updated in place and exposed by the new `hotl` Service.
- Seeding preserves workflow files already on the shared volume. The compatibility gateway stays available for those definitions. After their active runs finish, update their review steps to the example in [Add a human approval](AUTHORING.md#add-a-human-approval) and reload Zigflow. Keep the gateway running while any definitions still use its HTTP endpoint.

Open Studio and Temporal Web on localhost through Compose or kubectl port forwarding.

## Optional static workspace execution (Docker Compose)

The original single-environment stack still works. For a trusted internal multi-workspace deployment, use the included [Compose overlay](../compose.workspaces.yaml). It provides three example Studio instances and worker pairs (two personal workspaces and a shared team); reuse or copy a group when needed. It does not create resources dynamically.

1. Start the regular stack with `./hoverseer init` and `./hoverseer docker up`. Create users/workspaces and memberships in HITLy. Obtain the actual workspace IDs from the authenticated Hoverseer `GET /v1/me`.
2. Create the Temporal namespaces and copy the starter workflows into independent directories:

   ```sh
   for namespace in workspace-a workspace-b workspace-team; do
     docker compose exec -T temporal temporal operator namespace create --namespace "$namespace"
     mkdir -p "workspace-data/$namespace"
     cp -R workflows/. "workspace-data/$namespace/"
     sudo chown -R 1000:1000 "workspace-data/$namespace"
   done
   ```

   Run the copy only for new workspaces; do not overwrite edited workflows on upgrades.

3. Add a one-to-one mapping to `.env` using the real HITLy workspace IDs, for example:

   ```dotenv
   HOVERSEER_WORKSPACE_NAMESPACES={"ws-real-alice":"workspace-a","ws-real-bob":"workspace-b","ws-real-team":"workspace-team"}
   ```

4. If approvals are required, create a separate HITLy project in each workspace, configure the corresponding Temporal namespace and address, and put that project's credentials into the workspace-specific `WORKSPACE_A_HITLY_PROJECT_ID` / `WORKSPACE_A_HITLY_API_KEY` (or B/TEAM) variables in `.env`. Missing keys disable approvals, not shell execution. Do not copy the default workspace's keys.
5. Apply the overlay:

   ```sh
   docker compose -f compose.yaml -f compose.workspaces.yaml up -d
   ```

   Restart the matching Zigflow worker and API after changing a workspace's YAML or catalog, once its active executions have finished. Use the same two Compose files for logs, stop and teardown.

The mapping must be explicit; unmapped user workspaces cannot start or read runs in overlay mode. The service token continues to use only the legacy default namespace. The public catalog's aliases and input schemas must match in each workspace; implementations and task queues can differ. Workspace directories and Cruncher volumes are separate. The overlay publishes protected Studio instances on localhost ports 3002, 3003 and 3004, unpublishes the legacy Studio, and points the shared Homepage's Studio link to Workflows. Sign in to HITLy, switch workspaces there, then use Edit in Studio from Workflows. Each Studio checks live membership for its own fixed namespace on every application request (including its API), requires same-origin writes, and mounts only that workspace's directory. All workspace members can author workflows in this trusted-team MVP. To add a workspace, copy its Studio and worker services and extend the namespace and Studio URL mappings; keep Studio's `ORIGIN` and the advertised URL identical, on the same hostname as HITLy. The administrator still reloads Zigflow and the API after edits, and maintains the shared public workflow contract. Temporal UI remains trusted/admin-only and Temporal namespaces alone are not a security sandbox. No user runs are migrated from the default namespace; finish them before enabling the overlay, and avoid reusing pre-upgrade idempotency keys. Kubernetes continues to use the original single-environment configuration.

### Workspace credentials (optional Infisical)

Use a single existing Infisical installation, or the optional `compose.infisical.yaml` overlay (pinned upstream server, its PostgreSQL database and Redis). Generate independent server secrets, using `openssl rand -hex 16` for `INFISICAL_ENCRYPTION_KEY`, `openssl rand -base64 32` for `INFISICAL_AUTH_SECRET`, and `openssl rand -hex 32` for `INFISICAL_DB_PASSWORD`. Put those three values in the private `.env` file. Start only the optional vault with:

```sh
docker compose -f compose.yaml -f compose.workspaces.yaml -f compose.infisical.yaml up -d infisical
```

Open http://localhost:8084, complete the instance administrator setup immediately and keep it on a trusted network. For each personal or shared workspace, create a **distinct Infisical secret project**, give only its corresponding users access in Infisical, and create a distinct Universal Auth machine identity with the project Viewer role and no organization-wide access. In its `prod` environment create `HITLY_PROJECT_ID` and `HITLY_API_KEY` for that workspace's separate HITLy approval project.

Configure `cruncher/.env.infisical-a`, `cruncher/.env.infisical-b` and `cruncher/.env.infisical-team` individually (mode 0600, ignored by Git). Do not put these files in the writable workflow directory. Example for A:

```dotenv
INFISICAL_SITE_URL=http://infisical:8080
INFISICAL_PROJECT_ID=<only-workspace-a-project-id>
INFISICAL_CLIENT_ID=<workspace-a-machine-client-id>
INFISICAL_CLIENT_SECRET=<workspace-a-machine-client-secret>
INFISICAL_ENVIRONMENT=prod
INFISICAL_SECRET_PATH=/
```

Remove the corresponding direct `WORKSPACE_A_HITLY_PROJECT_ID` and `WORKSPACE_A_HITLY_API_KEY` values (likewise B/TEAM) and recreate the configured Cruncher services using the same Compose files. External Infisical installations only need the worker env files and a reachable HTTPS URL; no local vault overlay is needed.

HITLy membership selects the execution workspace. Infisical independently enforces the machine identity's project grants. Personal credentials in the MVP belong to the personal workspace; team credentials are shared with trusted team authors. Infisical user accounts/project grants are administered manually, not synchronized with HITLy. There is deliberately no per-user override within a team execution, no user impersonation and no general secret-return activity. The existing approval connector consumes the two secret values in Cruncher, never in the workflow input or result. Shell execution is not a security sandbox: trusted authors with arbitrary shell access can potentially access credentials within their worker. Do not treat this arrangement as protection against malicious authors or administrators.
