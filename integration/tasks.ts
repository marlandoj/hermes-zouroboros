import { z } from 'zod';
// A small explicit input contract; no model can override executor or host configuration.
export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), task: z.string().min(1).max(20000),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  dependsOn: z.array(z.string()).max(20).optional(),
  timeoutSeconds: z.number().int().min(10).max(600).default(300),
}).strict();
export function validateTasks(input: unknown) {
  const tasks = z.array(taskSchema).min(1).max(20).parse(input);
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) throw new Error('Duplicate task IDs');
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Task dependency cycle');
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.find(t => t.id === id)!.dependsOn || []) {
      if (!ids.has(dependency)) throw new Error('Unknown task dependency');
      visit(dependency);
    }
    visiting.delete(id); done.add(id);
  };
  tasks.forEach(t => visit(t.id));
  return tasks.map(task => ({ ...task, persona: 'hermes-vps', executor: 'hermes-vps', memoryStrategy: 'none' as const, outputToMemory: false }));
}
