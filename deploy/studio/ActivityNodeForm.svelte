<script lang="ts">
  import type { CallActivityTask } from '#lib/types/zigflow.js';

  import { activityInput, formatField, nodeForTask, parseField } from './nodes';

  let {
    task,
    onchange,
  }: {
    task: CallActivityTask;
    onchange: (next: CallActivityTask) => void;
  } = $props();

  const definition = $derived(nodeForTask(task));
  const input = $derived(activityInput(task));
  let invalid = $state<Record<string, boolean>>({});

  function update(key: string, value: string) {
    if (!definition) return;
    const args = { ...input };
    try {
      if (value === '' && !definition.inputSchema.required?.includes(key)) {
        delete args[key];
      } else {
        args[key] = parseField(definition.inputSchema.properties[key], value);
      }
      invalid[key] = false;
      onchange({ ...task, with: { ...task.with, arguments: [args] } });
    } catch {
      invalid[key] = true;
    }
  }

  function label(key: string) {
    return key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (letter) => letter.toUpperCase());
  }
</script>

{#if definition}
  <p><strong>{definition.label}</strong></p>
  {#each Object.entries(definition.inputSchema.properties) as [key, field] (key)}
    <label>
      <span>{label(key)}</span>
      {#if field.type === 'object' || definition.multiline?.includes(key)}
        <textarea
          value={formatField(input[key])}
          rows={definition.multiline?.includes(key) ? 6 : 3}
          aria-invalid={invalid[key] ?? false}
          onchange={(event) => update(key, event.currentTarget.value)}
        ></textarea>
      {:else if field.enum && (input[key] === undefined || field.enum.includes(String(input[key])))}
        <select
          value={String(input[key] ?? field.default ?? '')}
          onchange={(event) => update(key, event.currentTarget.value)}
        >
          {#each field.enum as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      {:else}
        <input
          value={formatField(input[key])}
          aria-invalid={invalid[key] ?? false}
          onchange={(event) => update(key, event.currentTarget.value)}
        />
      {/if}
      {#if field.description}<small>{field.description}</small>{/if}
      {#if invalid[key]}<small role="alert"
          >Invalid value. The previous value was kept.</small
        >{/if}
    </label>
  {/each}
{/if}

<style>
  p {
    margin: 0;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  textarea {
    font-family: monospace;
  }
  small[role='alert'] {
    color: #b91c1c;
  }
</style>
