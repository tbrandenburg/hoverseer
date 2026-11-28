# Workflow API

Expose managed workflows to apps and agents over REST, MCP and A2A. Back to the [README](../README.md).

## Managed workflow catalog

The [managed workflow catalog](../workflows/catalog.yaml) maps each public name to a Studio project directory. The refund and article approval projects are listed. Add another entry after creating or importing its project. Zigflow still loads the saved YAML from the shared volume. The API reads the target workflow type, task queue and input schema from that same file. Projects outside the catalog remain available through Studio and the CLI.

Run `./hoverseer docker reload` after changing a catalog entry or a saved workflow. After upgrading from a checkout that stored the catalog in `deploy/`, run `./hoverseer docker up` once to recreate the API container with the new mount. On Kubernetes, use `./hoverseer kubernetes up` after changing the catalog and `./hoverseer kubernetes reload` after changing a saved workflow. If upgrading from an older checkout, run `./hoverseer init` and bring up the stack to add the API and its token while retaining your existing credentials.

## Discover and call a workflow

| Endpoint | Purpose |
| --- | --- |
| `GET /openapi.json` | OpenAPI 3.1 document with one start operation and its Zigflow input schema per managed workflow |
| `GET /v1/workflows` | Managed workflow names and start URLs |
| `POST /v1/workflows/{name}/runs` | Start a named workflow with a JSON body and return `202 Accepted` and a URL to check its status |
| `GET /v1/runs/{workflowId}` | Read the execution status and the result when it completes |

Discovery remains public during the identity-only transition. Start and status requests accept a HITLy session bearer token (or a same-host HITLy browser session for REST), or the existing privileged service bearer token in `.env`. The API accepts valid JSON and Zigflow enforces the workflow's input schema during execution.

```bash
token=$(sed -n 's/^HOVERSEER_API_TOKEN=//p' .env)
curl -i http://localhost:8081/v1/workflows/article-review/runs \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-notes-2026-11-21' \
  --data '{"headline":"Release notes","draft":"What changed this week."}'
```

Call the returned `Location` URL with the same bearer token. Individual users can read or cancel only runs they initiated; service-token callers can access all managed runs, including legacy executions. Idempotency keys are scoped to each user. A run waiting for a HITLy decision remains `RUNNING`. Retrying the same workflow with the same idempotency key and input returns the existing execution for as long as Temporal retains it. Reusing the key with different input returns `409 Conflict`.

For remote callers, route HTTPS through a reverse proxy to the Compose API port or through an Ingress to the Kubernetes Service `api:8081`. The API binds to loopback through Compose and uses a ClusterIP Service in Kubernetes. Keep the approval gateway internal. Its own OpenAPI document is available at `http://approval-gateway:8080/openapi.json` from within the stack.

## Identity-only milestone

Sign in at HITLy and return to Workflows on the same browser hostname (`localhost` in the reference deployment). The Workflows page uses the HTTP-only session cookie and requires same-origin writes. Hoverseer verifies each request with HITLy; it does not store passwords or session records. For browser deployments, configure `HOVERSEER_PUBLIC_URL` to the exact Workflows origin, `HOVERSEER_HOTL_URL` to the browser-visible HITLy URL, and keep both on the same host (ports may differ). `HITLY_URL` is the internal identity service address.

HITLy owns workspace membership. Every authenticated user operation verifies the selected workspace against its existing `/api/v1/workspace` endpoint. `GET /v1/me` includes the verified workspace ID, name and role. Use the existing HITLy workspace switcher in the browser, then return to Workflows. For REST, MCP and A2A send `X-Hitly-Workspace-Id: <workspace-id>` with the session bearer token; without the header, HITLy selects its default membership. Explicit invalid or revoked memberships return 403, even if HITLy would fall back to another workspace. Newly started user runs and idempotency keys are scoped to both user and workspace; shared membership does not yet grant access to another user's run. Pre-workspace runs retain their original owner-only access, and retry keys from before this upgrade do not deduplicate new workspace-scoped runs. The privileged service token cannot select a workspace and remains unscoped for existing automation and CI.

By default the catalog, Studio, workers and Temporal namespace remain shared. The optional [static workspace execution overlay](DEPLOYMENT.md#optional-static-workspace-execution-docker-compose) routes each verified workspace to its configured namespace, separate workflow directory and worker pair. An unmapped workspace returns 403 on protected execution endpoints; the service token only accesses the legacy namespace. `GET /v1/me` reports `executionNamespace` (null if not provisioned) and `workspaceExecution`. Public discovery still shares the same aliases and input schemas. The authenticated `GET /v1/workspace/workflows` returns the selected workspace's actual catalog metadata, and `GET /v1/me` includes its configured Studio origin. Studio access is checked live for the instance's fixed workspace; personal credentials and fully independent public discovery are later steps. Do not expose this trusted deployment to untrusted users or publish raw services.

## Call workflows through MCP or A2A

MCP tools and A2A skills use the same managed catalog and Temporal runs as the HTTP API. A run started through one interface can be read through another using its workflow ID.

| Interface | Discovery | Call and follow |
| --- | --- | --- |
| MCP | Connect to `/mcp` using Streamable HTTP and list tools. | Call a tool such as `start_article_review` with the advertised Zigflow input. Read the run through `get_run`. |
| A2A 1.0 HTTP+JSON | Read `/.well-known/agent-card.json` to discover the endpoint and its skills. | Send a data part with `workflow` and `input`, then get the resulting task and its output artifact. |

Configure the same `Authorization: Bearer <token>` header as the workflow HTTP API. For individual CLI/REST/MCP/A2A access, sign in through HITLy's existing Better Auth `POST /api/auth/sign-in/email` endpoint (including any required MFA); use its issued session bearer token. It is an expiring/revocable session credential, not a newly invented permanent API key. Keep it private. `GET /v1/me` identifies the authenticated principal without returning the session token. MCP clients must support setting a bearer header for this deployment. For public deployments, set `HOVERSEER_PUBLIC_URL` to the HTTPS origin callers use. The Agent Card advertises this origin and the MCP endpoint checks it alongside the local hostnames. The reverse proxy should preserve the original Host header.

An MCP caller can supply an `Idempotency-Key` header on a start call. An A2A caller can retry the same message ID with the same input to recover the existing task. Each interface returns the same Temporal workflow ID for the same execution.

```bash
curl http://localhost:8081/a2a/message:send \
  -H "Authorization: Bearer $token" \
  -H 'A2A-Version: 1.0' \
  -H 'Content-Type: application/json' \
  --data '{
    "message": {
      "messageId": "article-review-1",
      "role": "ROLE_USER",
      "parts": [{"data": {
        "workflow": "article-review",
        "input": {"headline": "Release notes", "draft": "What changed this week."}
      }}]
    },
    "configuration": {"returnImmediately": true}
  }'
```

Set `returnImmediately` for workflows that wait on a reviewer. Poll `GET /a2a/tasks/{id}` with the same version and auth headers until the task finishes. `POST /a2a/tasks/{id}:cancel` requests cancellation in Temporal. An existing HITLy item can still expire or be closed in its inbox. OpenAPI documents the transport endpoints, and the respective protocol provides tool or skill discovery.

## Components

- Zigflow already loads, validates, and executes multiple YAML definitions. [Zigflow CLI](https://zigflow.dev/docs/cli/using-the-cli/)
- Temporal already owns starting, describing, and deduplicating executions. Hoverseer uses the official TypeScript SDK. Temporal also defines a lower-level HTTP mapping, which exposes Temporal's own workflow service contract. [Temporal API](https://docs.temporal.io/self-hosted-guide/server-frontend-api-reference) · [HTTP protocol mappings](https://github.com/temporalio/api/blob/main/temporal/api/workflowservice/v1/service.proto)
- The official A2A JavaScript SDK handles A2A HTTP+JSON, and the official MCP TypeScript SDK serves Streamable HTTP with Fastify. Both use the same Temporal run service. [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) · [MCP Fastify guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html)
- Fastify and its Swagger plugin generate the OpenAPI document from the registered routes. Hono's Zod OpenAPI integration is another option. Using Fastify here lets us publish the JSON Schema already stored in Zigflow YAML. [Fastify Swagger](https://github.com/fastify/fastify-swagger) · [Hono Zod OpenAPI](https://hono.dev/examples/zod-openapi)
