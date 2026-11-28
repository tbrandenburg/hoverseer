<script lang="ts">
  import favicon from '#lib/assets/favicon.svg';
  import type { LayoutData } from './$types';

  let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{#if data.workspaceNamespace}
  <div class="workspace-mode">
    <div class="workspace-bar">
      <strong>Workspace: {data.workspaceNamespace}</strong>
      <span>Save writes YAML; an administrator validates and reloads to deploy.</span>
      <a href={data.workflowsUrl}>Back to Hoverseer</a>
    </div>
    {@render children()}
  </div>
{:else}
  {@render children()}
{/if}

<style>
  :global(body) { margin: 0; }
  .workspace-bar { box-sizing: border-box; display: flex; align-items: center; flex-wrap: wrap; gap: .4rem 1rem; min-height: 3rem; padding: .5rem 1rem; font: 13px ui-sans-serif, system-ui, sans-serif; background: #e2e8f0; color: #334155; border-bottom: 1px solid #cbd5e1; }
  .workspace-bar a { color: #075985; margin-left: auto; }
  .workspace-mode :global(.editor) { height: calc(100vh - 3rem); }
</style>
