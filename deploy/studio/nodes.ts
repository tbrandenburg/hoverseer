import type { CallActivityTask } from '#lib/types/zigflow.js';

type Input = Record<string, unknown>;
type Field = {
  type?: 'string' | 'integer' | 'object';
  enum?: string[];
  default?: unknown;
  description?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

type NodeDefinition = {
  id: string;
  label: string;
  activity: string;
  taskQueue: string;
  multiline?: string[];
  activityOptions?: Record<string, unknown>;
  inputSchema: { properties: Record<string, Field>; required?: string[] };
};

const manifests = import.meta.glob<NodeDefinition>(
  '../../../hoverseer-nodes/*/node.json',
  { eager: true, import: 'default' },
);
export const workerNodes = Object.values(manifests).sort((left, right) =>
  left.label.localeCompare(right.label),
);

export function makeActivityTask(definition: NodeDefinition): CallActivityTask {
  const args = Object.fromEntries(
    Object.entries(definition.inputSchema.properties)
      .filter(([, field]) => 'default' in field)
      .map(([key, field]) => [key, structuredClone(field.default)]),
  );
  return {
    call: 'activity',
    ...(definition.activityOptions && {
      metadata: {
        activityOptions: structuredClone(definition.activityOptions),
      },
    }),
    with: {
      name: definition.activity,
      taskQueue: definition.taskQueue,
      arguments: [args],
    },
  };
}

function isObject(value: unknown): value is Input {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function nodeForTask(task: CallActivityTask) {
  const args = task.with.arguments ?? [];
  if (args.length > 1 || (args.length === 1 && !isObject(args[0]))) return;
  return workerNodes.find(
    (node) =>
      node.activity === task.with.name &&
      node.taskQueue === task.with.taskQueue,
  );
}

export function activityInput(task: CallActivityTask): Input {
  const value = task.with.arguments?.[0];
  return isObject(value) ? value : {};
}

export function formatField(value: unknown) {
  return typeof value === 'string'
    ? value
    : value === undefined
      ? ''
      : JSON.stringify(value, null, 2);
}

export function parseField(field: Field, text: string) {
  if (/^\s*\$\{[\s\S]*\}\s*$/.test(text)) return text;
  if (field.enum?.includes(text)) return text;
  if (
    field.type === 'string' &&
    text.length >= (field.minLength ?? 0) &&
    text.length <= (field.maxLength ?? Infinity) &&
    (!field.pattern || new RegExp(field.pattern).test(text))
  ) {
    return text;
  }
  if (field.type === 'integer' && /^-?\d+$/.test(text)) {
    const value = Number(text);
    if (
      Number.isSafeInteger(value) &&
      value >= (field.minimum ?? -Infinity) &&
      value <= (field.maximum ?? Infinity)
    )
      return value;
  }
  if (field.type === 'object') {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) return value;
  }
  throw new Error('Enter a valid value.');
}
