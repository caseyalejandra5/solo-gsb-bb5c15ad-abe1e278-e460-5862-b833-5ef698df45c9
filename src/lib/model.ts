/**
 * 规划数据模型与校验。
 */
import {
  Cidr,
  cidrToString,
  contains,
  isAlignedCidr,
  overlaps,
  parseCidr,
} from './ip';

export type AllocationKind = 'reserved' | 'subnet';

export interface RootBlock {
  id: string;
  name: string;
  /** 规范化 CIDR 字符串，如 10.0.0.0/8 */
  cidr: string;
}

export interface Allocation {
  id: string;
  name: string;
  kind: AllocationKind;
  /** 期望容量（前缀长度），与 cidr 的前缀一致 */
  prefix: number;
  /** 当前落位（规范化 CIDR 字符串） */
  cidr: string;
  note?: string;
}

export interface Plan {
  version: 1;
  roots: RootBlock[];
  allocations: Allocation[];
}

export const PLAN_VERSION = 1 as const;

export function emptyPlan(): Plan {
  return { version: PLAN_VERSION, roots: [], allocations: [] };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function rootCidrs(plan: Plan): Cidr[] {
  return plan.roots
    .map((r) => parseCidr(r.cidr))
    .filter((c): c is Cidr => c !== null)
    .sort((a, b) => a.base - b.base);
}

export function allocationCidrs(plan: Plan): { alloc: Allocation; cidr: Cidr }[] {
  const out: { alloc: Allocation; cidr: Cidr }[] = [];
  for (const alloc of plan.allocations) {
    const c = parseCidr(alloc.cidr);
    if (c) out.push({ alloc, cidr: c });
  }
  return out.sort((a, b) => a.cidr.base - b.cidr.base);
}

/** 校验根网段集合：格式合法、已对齐、互不重叠。返回错误信息列表（空为通过）。 */
export function validateRoots(roots: RootBlock[]): string[] {
  const errors: string[] = [];
  const parsed: { root: RootBlock; cidr: Cidr }[] = [];
  for (const root of roots) {
    if (!root.name.trim()) errors.push(`根网段 ${root.cidr || '(未填写)'} 缺少名称`);
    const c = parseCidr(root.cidr);
    if (!c) {
      errors.push(`根网段「${root.name}」CIDR 非法：${root.cidr}`);
      continue;
    }
    if (!isAlignedCidr(root.cidr)) {
      errors.push(`根网段「${root.name}」未对齐网络地址，应为 ${cidrToString(c)}`);
    }
    parsed.push({ root, cidr: c });
  }
  parsed.sort((a, b) => a.cidr.base - b.cidr.base);
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (overlaps(parsed[i].cidr, parsed[j].cidr)) {
        errors.push(
          `根网段「${parsed[i].root.name}」(${parsed[i].root.cidr}) 与「${parsed[j].root.name}」(${parsed[j].root.cidr}) 重叠`,
        );
      }
    }
  }
  return errors;
}

/**
 * 校验单个待加入的分配：格式、对齐、须落在某个根网段内、与既有分配不重叠。
 * ignoreId 用于编辑场景排除自身。
 */
export function validateAllocation(
  plan: Plan,
  candidate: { name: string; cidr: string },
  ignoreId?: string,
): string[] {
  const errors: string[] = [];
  if (!candidate.name.trim()) errors.push('名称不能为空');
  const c = parseCidr(candidate.cidr);
  if (!c) {
    errors.push(`CIDR 非法：${candidate.cidr}`);
    return errors;
  }
  if (!isAlignedCidr(candidate.cidr)) {
    errors.push(`未对齐 CIDR 边界，应为 ${cidrToString(c)}`);
  }
  const roots = rootCidrs(plan);
  if (roots.length === 0) {
    errors.push('尚未定义任何根网段');
  } else if (!roots.some((r) => contains(r, c))) {
    errors.push(`${cidrToString(c)} 越界：不在任何根网段内`);
  }
  for (const { alloc, cidr } of allocationCidrs(plan)) {
    if (alloc.id === ignoreId) continue;
    if (overlaps(cidr, c)) {
      errors.push(`与分配「${alloc.name}」(${alloc.cidr}) 重叠`);
    }
  }
  return errors;
}

/** 整体校验（导入时使用）。返回错误列表，空为通过。 */
export function validatePlan(plan: Plan): string[] {
  const errors = validateRoots(plan.roots);
  const seen = new Set<string>();
  for (const alloc of plan.allocations) {
    if (seen.has(alloc.id)) errors.push(`分配 id 重复：${alloc.id}`);
    seen.add(alloc.id);
    if (!alloc.name.trim()) errors.push(`分配 ${alloc.id} 缺少名称`);
    const c = parseCidr(alloc.cidr);
    if (!c) {
      errors.push(`分配「${alloc.name}」CIDR 非法：${alloc.cidr}`);
      continue;
    }
    if (!isAlignedCidr(alloc.cidr)) {
      errors.push(`分配「${alloc.name}」未对齐，应为 ${cidrToString(c)}`);
    }
    if (c.prefix !== alloc.prefix) {
      errors.push(`分配「${alloc.name}」容量前缀 /${alloc.prefix} 与落位 ${alloc.cidr} 不一致`);
    }
    if (!rootCidrs(plan).some((r) => contains(r, c))) {
      errors.push(`分配「${alloc.name}」(${alloc.cidr}) 越界：不在任何根网段内`);
    }
  }
  const sorted = allocationCidrs(plan);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (overlaps(sorted[i].cidr, sorted[j].cidr)) {
        errors.push(
          `分配「${sorted[i].alloc.name}」(${sorted[i].alloc.cidr}) 与「${sorted[j].alloc.name}」(${sorted[j].alloc.cidr}) 重叠`,
        );
      }
    }
  }
  return errors;
}

/** 解析并校验导入的 JSON。成功返回 Plan，失败抛出带中文信息的 Error。 */
export function parsePlanJson(text: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败：文件不是合法 JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('规划文件格式错误：顶层应为对象');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.roots) || !Array.isArray(obj.allocations)) {
    throw new Error('规划文件格式错误：缺少 roots / allocations 数组');
  }
  const plan: Plan = {
    version: PLAN_VERSION,
    roots: (obj.roots as unknown[]).map((r, i) => {
      const o = r as Record<string, unknown>;
      if (typeof o?.cidr !== 'string') throw new Error(`roots[${i}] 缺少 cidr 字符串`);
      return {
        id: typeof o.id === 'string' ? o.id : newId('root'),
        name: typeof o.name === 'string' ? o.name : '',
        cidr: o.cidr,
      };
    }),
    allocations: (obj.allocations as unknown[]).map((a, i) => {
      const o = a as Record<string, unknown>;
      if (typeof o?.cidr !== 'string') throw new Error(`allocations[${i}] 缺少 cidr 字符串`);
      const c = parseCidr(o.cidr);
      return {
        id: typeof o.id === 'string' ? o.id : newId('alloc'),
        name: typeof o.name === 'string' ? o.name : '',
        kind: o.kind === 'reserved' ? 'reserved' : 'subnet',
        prefix: typeof o.prefix === 'number' ? o.prefix : c ? c.prefix : 0,
        cidr: o.cidr,
        note: typeof o.note === 'string' ? o.note : undefined,
      };
    }),
  };
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new Error(`规划文件校验未通过：\n${errors.map((e) => `· ${e}`).join('\n')}`);
  }
  return plan;
}

export function serializePlan(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}
