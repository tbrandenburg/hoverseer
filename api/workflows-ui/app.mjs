function joinedUrl(base, path) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function readFields(fields) {
  return Object.fromEntries(fields.flatMap(([name, type, value]) => {
    if (value === '') return [];
    if (type === 'boolean') return [[name, value === 'true']];
    if (type === 'number' || type === 'integer') return [[name, Number(value)]];
    return [[name, value]];
  }));
}

export function supportsFields(schema) {
  return schema?.type === 'object' && schema.properties && !schema.$ref
    && !schema.oneOf && !schema.anyOf && !schema.allOf
    && Object.values(schema.properties).every(field => (
      ['string', 'number', 'integer', 'boolean'].includes(field?.type) && !field.enum && !field.const
    ));
}

async function getJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || `Request failed (${response.status})`);
  if (data === null) throw new Error('The workflow API returned an invalid response.');
  return data;
}

function fieldControl(property, required) {
  const { type, default: initial, minimum, maximum, minLength, maxLength } = property;
  const control = document.createElement(type === 'boolean' ? 'select' : 'input');
  if (type === 'boolean') {
    for (const [value, title] of [['', 'Select…'], ['true', 'True'], ['false', 'False']]) {
      control.add(new Option(title, value));
    }
  } else if (type === 'string') {
    control.type = 'text';
    if (minLength !== undefined) control.minLength = minLength;
    if (maxLength !== undefined) control.maxLength = maxLength;
  } else {
    control.type = 'number';
    control.step = type === 'integer' ? '1' : 'any';
    if (minimum !== undefined) control.min = minimum;
    if (maximum !== undefined) control.max = maximum;
  }
  control.required = required;
  if (initial !== undefined) control.value = initial;
  return control;
}

function setup() {
  const find = id => document.getElementById(id);
  const { hitly, studio, temporal, namespace } = document.body.dataset;
  find('account-link').href = hitly;
  find('workspace-switch').href = joinedUrl(hitly, 'inbox');
  find('login-link').href = joinedUrl(hitly, 'login');
  let studioUrl = studio;
  find('temporal-link').href = temporal;
  const catalog = find('catalog');
  const form = find('run-form');
  const fields = find('fields');
  const rawMode = find('raw-mode');
  const rawInput = find('raw-input');
  const start = find('start');
  const requestStatus = find('request-status');
  let selection;
  let workspaceId;
  let executionNamespace = namespace;
  let workspaceMode = false;
  let controls = [];
  let pending;
  let activeRun;
  let starting = false;

  const fieldValues = () => readFields(controls.map(([name, type, control]) => [name, type, control.value]));

  function showInputMode(raw) {
    find('raw-input-label').hidden = !raw;
    rawInput.disabled = !raw;
    fields.hidden = raw;
    for (const [, , control] of controls) control.disabled = raw;
  }

  function select(workflow, button, schema) {
    selection = workflow;
    pending = undefined;
    requestStatus.textContent = '';
    for (const item of catalog.querySelectorAll('button')) {
      item.setAttribute('aria-pressed', String(item === button));
    }
    find('workflow-title').textContent = workflow.title;
    find('summary').textContent = workflow.summary ?? '';
    find('edit-link').hidden = !studioUrl;
    if (studioUrl) find('edit-link').href = joinedUrl(studioUrl, `workflows/${encodeURIComponent(workflow.project)}`);
    const revision = find('revision');
    revision.textContent = [workflow.version && `v${workflow.version}`, workflow.revision.slice(0, 12)]
      .filter(Boolean).join(' · ');
    revision.title = workflow.revision;
    find('deploy-note').hidden = !studioUrl;
    fields.replaceChildren();
    controls = [];
    const simple = supportsFields(schema);
    find('raw-mode-label').hidden = !simple;
    rawMode.checked = !simple;
    if (simple) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const control = fieldControl(property, schema.required?.includes(name) ?? false);
        const label = document.createElement('label');
        label.append(property.title ?? name, control);
        fields.append(label);
        controls.push([name, property.type, control]);
      }
      if (!controls.length) fields.textContent = 'This workflow has no required inputs.';
    }
    rawInput.value = '{}';
    showInputMode(!simple);
    find('details').hidden = false;
  }

  rawMode.addEventListener('change', () => {
    if (rawMode.checked) rawInput.value = JSON.stringify(fieldValues(), null, 2);
    showInputMode(rawMode.checked);
  });

  async function poll(run, signal) {
    try {
      const info = await getJson(run.statusUrl, { signal, headers: { 'x-hitly-workspace-id': workspaceId } });
      if (signal.aborted) return;
      find('run-status').textContent = info.status;
      if (Object.hasOwn(info, 'result')) {
        const result = find('run-result');
        result.textContent = JSON.stringify(info.result, null, 2);
        result.hidden = false;
      }
      if (info.status === 'RUNNING') {
        setTimeout(() => {
          if (!signal.aborted) void poll(run, signal);
        }, 2000);
      }
    } catch (error) {
      if (!signal.aborted) find('run-status').textContent = error.message;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!selection || starting) return;
    let body;
    try {
      body = JSON.stringify(rawMode.checked ? JSON.parse(rawInput.value) : fieldValues());
    } catch {
      requestStatus.textContent = 'Enter valid JSON input.';
      return;
    }
    const workflow = selection;
    if (pending?.body !== body) {
      const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      pending = { body, key };
    }
    starting = true;
    start.disabled = true;
    requestStatus.textContent = 'Starting workflow…';
    try {
      const run = await getJson(workflow.startUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': pending.key,
          'x-hitly-workspace-id': workspaceId,
        },
        body,
      });
      pending = undefined;
      requestStatus.textContent = 'Workflow started.';
      find('run-title').textContent = workflow.title;
      find('run-status').textContent = 'Checking run status…';
      find('run-id').textContent = run.workflowId;
      if (!workspaceMode) {
        const path = [executionNamespace, run.workflowId, run.runId].map(encodeURIComponent);
        find('run-link').href = joinedUrl(temporal, `namespaces/${path[0]}/workflows/${path[1]}/${path[2]}/history`);
        find('run-link').hidden = false;
      }
      find('run-result').hidden = true;
      find('run').hidden = false;
      activeRun?.abort();
      activeRun = new AbortController();
      void poll(run, activeRun.signal);
    } catch (error) {
      requestStatus.textContent = error.message;
    } finally {
      starting = false;
      start.disabled = false;
    }
  });

  async function loadCatalog() {
    const status = find('catalog-status');
    try {
      const [workflows, spec] = await Promise.all([
        getJson('/v1/workspace/workflows', { headers: { 'x-hitly-workspace-id': workspaceId } }),
        getJson('/openapi.json'),
      ]);
      for (const workflow of workflows) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = workflow.title;
        const schema = spec.paths[workflow.startUrl]?.post?.requestBody?.content?.['application/json']?.schema;
        button.addEventListener('click', () => {
          if (!starting) select(workflow, button, schema);
        });
        item.append(button);
        catalog.append(item);
      }
      if (catalog.firstElementChild) {
        status.hidden = true;
        catalog.firstElementChild.firstElementChild.click();
      } else {
        status.textContent = 'No managed workflows.';
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function authenticate() {
    try {
      const identity = await getJson('/v1/me');
      if (identity.kind !== 'user') throw new Error('Sign in with a HITLy user account.');
      find('identity').textContent = `Signed in as ${identity.name}`;
      if (!identity.workspace) throw new Error('No authorized workspace.');
      workspaceId = identity.workspace.id;
      workspaceMode = identity.workspaceExecution;
      find('temporal-link').hidden = workspaceMode;
      find('workspace-name').textContent = `${identity.workspace.name} (${identity.workspace.role})`;
      find('workspace-context').hidden = false;
      if (identity.executionNamespace === null) {
        find('execution-context').textContent = 'Execution is not configured for this workspace.';
        return;
      }
      executionNamespace = identity.executionNamespace ?? namespace;
      find('execution-context').textContent = identity.workspaceExecution
        ? `Execution namespace: ${executionNamespace}. Switch in HITLy, then return here. Runs belong to their initiating user.`
        : 'Workflow resources are still shared.';
      if (identity.workspaceExecution) studioUrl = identity.studioUrl;
      find('studio-link').hidden = !studioUrl;
      if (studioUrl) find('studio-link').href = studioUrl;
      find('workspace').hidden = false;
      await loadCatalog();
    } catch (error) {
      find('identity').textContent = error.message;
      find('sign-in').hidden = false;
    }
  }

  // A return from HITLy via browser history must not display a stale workspace.
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  void authenticate();
}

if (typeof document !== 'undefined') setup();
