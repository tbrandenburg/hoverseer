import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({
  workspaceNamespace: process.env.HOVERSEER_STUDIO_NAMESPACE ?? '',
  workflowsUrl: process.env.HOVERSEER_WORKFLOWS_URL ?? 'http://localhost:8081/workflows',
});
