# Architecture

How Hoverseer's services fit together, and where things live in the repository. Back to the [README](../README.md).

## Services

| Container | Type | Purpose |
| --- | --- | --- |
| `dashboard` | Management dashboard | Homepage launchpad for Studio, HITLy, Temporal Web, OpenAPI and Infisical on `8082`. |
| `api` | API server | Exposes managed workflows through REST, MCP, A2A, and OpenAPI on `8081`. |
| `studio` | Authoring server | Edits the shared Zigflow YAML on `3000`. |
| `temporal` | Orchestration server | Persists workflow history, timers, and signals. Serves Temporal clients on `7233` and Temporal Web on `8233`. |
| `hotl` | Review server | Runs the HITLy inbox on `3001` and sends reviewer decisions to Temporal. |
| `postgres` | Database server | Stores HITLy inbox and project data. |
| `zigflow` | Workflow runner | Loads the YAML and polls the workflow task queues. Handles control flow and approval waits. |
| `cruncher` | Activity runner | Runs HITLy approval and shell steps. Polls the shared `hoverseer-activities` queue. |
| `approval-gateway` | Compatibility server | Accepts approval requests from older saved workflows that still use HTTP. |

Docker Compose runs nine long-running containers during migration and eight after the compatibility gateway is retired. On Kubernetes, API, Studio and Zigflow share the `workflow` pod and YAML volume. The dashboard, Cruncher, Temporal, HITLy, Postgres and compatibility gateway each have their own deployment. Infisical runs separately if enabled.

```mermaid
flowchart TD
    Callers["Apps and agents"] -->|"REST, MCP, A2A"| API
    People["Authors, reviewers and admins"] --> Dashboard["Hoverseer dashboard"]
    Dashboard -.-> Studio
    Dashboard -.-> HOTL
    Dashboard -.-> API
    Dashboard -.-> Temporal
    Dashboard -.-> Infisical["Infisical admin"]
    Cruncher -->|"Read credentials at startup when enabled"| Infisical

    subgraph Workflows["Workflow services"]
        Studio["Zigflow Studio"]
        YAML[("Shared workflow YAML")]
        API["Hoverseer API"]
        Zigflow["Zigflow workflow runner"]
        Studio -->|"Save definitions"| YAML
        YAML -->|"Read schemas and workflow types"| API
        YAML -->|"Load workflow definitions"| Zigflow
    end

    API -->|"Start runs and read results"| Temporal["Temporal Server and history"]
    Zigflow -->|"Poll workflow queues and schedule activities"| Temporal
    Cruncher["Cruncher activity runner"] -->|"Poll hoverseer-activities"| Temporal
    Cruncher -->|"Create approval request"| HOTL["HITLy inbox · hotl"]
    HOTL -->|"Send hitly.decision signal"| Temporal
    HOTL -->|"Store review data"| Postgres[("HITLy Postgres")]
    Zigflow -.->|"Older HTTP workflows"| Gateway["Compatibility approval gateway"]
    Gateway -.-> HOTL
```

## Repository layout

| Path | Contents |
| --- | --- |
| `api/` | REST, MCP and A2A workflow endpoints |
| `cruncher/` | Temporal activity worker startup and credentials |
| `nodes/` | Shared Studio definitions, activity handlers, tests and YAML examples |
| `gateway/` | Compatibility gateway for older approval workflows |
| `integrations/` | Integration clients shared by services |
| `workflows/` | Bundled workflows and their public catalog |
| `deploy/` | Dockerfiles, Kubernetes manifests, dashboard settings and workflow seeding |

The root `compose.yaml`, `kustomization.yaml` and `./hoverseer` are deployment entry points. Kustomize resolves the workflow files and shared source from the repository root.
