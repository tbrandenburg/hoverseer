# Contributing to Hoverseer

Choose the row that matches what you want to add. The folder in that row is where the contribution starts.

| I want to… | Start here | Use |
| --- | --- | --- |
| Build or change a workflow | [`workflows/`](workflows/) | Add or edit `<project>/workflow.yaml`. Copy the [article review](workflows/article-review/workflow.yaml) for a Studio-friendly structure. |
| Add a side-effecting step, such as calling an API, an MCP tool, or an A2A agent | [`nodes/`](nodes/) | Add a named Temporal activity. Workflows invoke it with `call: activity`. Follow the [node recipe](nodes/README.md). |
| Share an integration client across two services | [`integrations/`](integrations/) | Use one folder per integration, as in [`integrations/hitly/`](integrations/hitly/). Keep step-specific code with its activity. |
| Add a visual preset or improve a task's form | [Studio editor checklist](#studio-editor) | Contribute to Zigflow Studio. Changes to a Hoverseer node’s fields or defaults go in `nodes/<node>/node.json`. |
| Add a workflow-level primitive to the YAML language | [Zigflow DSL checklist](#zigflow-dsl) | Contribute to Zigflow and its schema. Start with the upstream extension guide. |
| Change how callers discover or start workflows | [`api/`](api/) and [`workflows/catalog.yaml`](workflows/catalog.yaml) | Use the workflow catalog to list projects exposed through REST, MCP, and A2A. |

For a bundled workflow, add the seed entry to [`kustomization.yaml`](kustomization.yaml) and the corresponding file projection in [`deploy/kubernetes/stack.yaml`](deploy/kubernetes/stack.yaml). Compose already scans the bundled workflow folders. Wrap tasks in a named `do` entry, as in article review, to match Studio's root palette. Run `zigflow validate --disable-telemetry workflows/<project>/workflow.yaml`.

## Studio editor

Use the [Zigflow Studio repository](https://github.com/zigflow/studio) for UI contributions. Hoverseer picks the Studio revision in [`deploy/images/studio.Dockerfile`](deploy/images/studio.Dockerfile). The paths below refer to Studio. Hoverseer’s [shared node adapter](deploy/studio/) uses those editor entry points against that pinned revision.

| Change | Folder or file |
| --- | --- |
| Add fields for an existing task or variant | [`src/lib/components/forms/`](https://github.com/zigflow/studio/tree/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/src/lib/components/forms). Use `taskForms.ts` to find the registered form and reuse the common fields. |
| Add a palette preset for an existing YAML shape | [`src/lib/graph/defaults.ts`](https://github.com/zigflow/studio/blob/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/src/lib/graph/defaults.ts) for task construction and [`src/lib/components/NodePalette.svelte`](https://github.com/zigflow/studio/blob/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/src/lib/components/NodePalette.svelte) for palette entries. |
| Support an upstream DSL change | [`src/lib/types/zigflow.ts`](https://github.com/zigflow/studio/blob/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/src/lib/types/zigflow.ts). Update [`src/lib/graph/model.ts`](https://github.com/zigflow/studio/blob/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/src/lib/graph/model.ts) if the DSL adds a top-level task kind. Studio refreshes its schema from the Zigflow CLI. |

Presets for **Request approval** or **Cruncher shell** insert `call: activity` with the relevant activity name and worker queue. A native shell preset inserts `run.shell`, which executes inside the Zigflow worker. The YAML determines the execution path.

For UI changes, test that Studio can create, save, and reopen the YAML. Run `npm run check` and `npm test` in Studio. See Studio's [contributor guidance](https://github.com/zigflow/studio/blob/125ef643bcf92948dc0acc94c9ca9dfa11c4847b/AGENTS.md).

## Zigflow DSL

Use the Go extension mechanism for a deterministic Temporal workflow capability that the Open Workflow specification cannot express. `wait.until` is the upstream example.

| Code | Repository path |
| --- | --- |
| Task type, registration, and extension selection | [`pkg/zigflow/models/`](https://github.com/zigflow/zigflow/tree/main/pkg/zigflow/models) and [`pkg/zigflow/extensions/`](https://github.com/zigflow/zigflow/tree/main/pkg/zigflow/extensions) |
| Temporal workflow behavior | [`pkg/zigflow/tasks/`](https://github.com/zigflow/zigflow/tree/main/pkg/zigflow/tasks) |
| YAML validation | [`zigflow/schema`](https://github.com/zigflow/schema) |
| End-to-end test | [`tests/e2e/tests/`](https://github.com/zigflow/zigflow/tree/main/tests/e2e/tests) |

Discuss a new DSL capability in the [Zigflow repository](https://github.com/zigflow/zigflow). The [upstream extension guide](https://zigflow.dev/docs/guides/extending-the-dsl/) shows the implementation and test sequence. Once the engine and schema support the capability, use the [Studio editor checklist](#studio-editor) to add its form.

## Local checks and development

Run `make help` to see the development commands. `make install` installs the API and Cruncher dependencies. Then run `make check` for the same lint, format, and test targets used by CI. The format target reports whitespace errors without rewriting files. Lint needs Node.js 24, Docker with Buildx and Compose, and `kubectl`. Use `make lint-code` when you only need the source syntax checks.
