import type { PlanNode } from "../model/profile";

export const describe = (node: PlanNode): string => [node.kind, node.label].filter(Boolean).join(" ");

/** The physical nodes one plan has and the other has not. */
export function planDiff(now: PlanNode[], before: PlanNode[]): { added: string[]; dropped: string[]; same: number } {
  const counts = new Map<string, number>();
  for (const node of before) counts.set(describe(node), (counts.get(describe(node)) ?? 0) + 1);
  const added: string[] = [];
  for (const node of now) {
    const left = counts.get(describe(node)) ?? 0;
    if (left > 0) counts.set(describe(node), left - 1);
    else added.push(describe(node));
  }
  const dropped = [...counts].flatMap(([text, n]) => Array<string>(n).fill(text));
  return { added, dropped, same: now.length - added.length };
}

