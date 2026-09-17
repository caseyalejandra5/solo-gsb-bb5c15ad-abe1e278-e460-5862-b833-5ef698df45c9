import { describe, expect, it } from 'vitest';
import { parseCidr } from './ip';
import { Allocation, RootBlock, validateAllocation, validatePlan, validateRoots } from './model';
import { applyMigration, findLowestSlot, planMigration } from './planner';

const root = (name: string, cidr: string): RootBlock => ({ id: `r_${name}`, name, cidr });
const alloc = (name: string, cidr: string, kind: Allocation['kind'] = 'subnet'): Allocation => ({
  id: `a_${name}`,
  name,
  kind,
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

describe('findLowestSlot 最低可用地址', () => {
  const roots = [parseCidr('10.0.0.0/24')!];

  it('空空间从头部分配', () => {
    expect(findLowestSlot(roots, [], 25)!.base).toBe(parseCidr('10.0.0.0/25')!.base);
  });

  it('跳过已占用块并对齐边界', () => {
    const occupied = [parseCidr('10.0.0.0/26')!];
    const slot = findLowestSlot(roots, occupied, 25)!;
    // .0/26 被占，/25 无法放在 .0，最低对齐位置是 .128
    expect(slot.base).toBe(parseCidr('10.0.0.128/25')!.base);
  });

  it('空间不足返回 null', () => {
    const occupied = [parseCidr('10.0.0.0/24')!];
    expect(findLowestSlot(roots, occupied, 24)).toBeNull();
    expect(findLowestSlot(roots, [], 23)).toBeNull();
  });

  it('跨根网段按地址升序选择', () => {
    const r1 = parseCidr('10.0.0.0/24')!;
    const r2 = parseCidr('172.16.0.0/16')!;
    const slot = findLowestSlot([r2, r1], [parseCidr('10.0.0.0/25')!], 25)!;
    expect(slot.base).toBe(parseCidr('10.0.0.128/25')!.base);
  });
});

describe('校验', () => {
  it('根网段重叠被拒绝', () => {
    const errors = validateRoots([
      root('A', '10.0.0.0/8'),
      root('B', '10.1.0.0/16'),
    ]);
    expect(errors.some((e) => e.includes('重叠'))).toBe(true);
  });

  it('未对齐的根网段被拒绝', () => {
    const errors = validateRoots([root('A', '10.0.0.1/24')]);
    expect(errors.some((e) => e.includes('对齐'))).toBe(true);
  });

  it('分配越界与重叠被拒绝', () => {
    const plan = {
      version: 1 as const,
      roots: [root('A', '10.0.0.0/24')],
      allocations: [alloc('X', '10.0.0.0/25')],
    };
    expect(validateAllocation(plan, { name: 'Y', cidr: '10.0.1.0/25' }).some((e) => e.includes('越界'))).toBe(true);
    expect(validateAllocation(plan, { name: 'Y', cidr: '10.0.0.64/26' }).some((e) => e.includes('重叠'))).toBe(true);
    expect(validateAllocation(plan, { name: 'Y', cidr: '10.0.0.128/25' })).toEqual([]);
  });

  it('整体校验通过合法规划', () => {
    const plan = {
      version: 1 as const,
      roots: [root('A', '10.0.0.0/8'), root('B', '192.168.0.0/16')],
      allocations: [alloc('X', '10.0.0.0/16'), alloc('Y', '192.168.0.0/24', 'reserved')],
    };
    expect(validatePlan(plan)).toEqual([]);
  });
});

describe('迁移预演', () => {
  const roots = [root('A', '10.0.0.0/24')];

  it('根网段不变时全部原位保留', () => {
    const allocs = [alloc('X', '10.0.0.0/25'), alloc('Y', '10.0.0.128/25')];
    const mig = planMigration(roots, allocs);
    expect(mig.ok).toBe(true);
    expect(mig.items.every((i) => i.status === 'kept')).toBe(true);
  });

  it('越界项迁移到最低可用地址，保留项不动', () => {
    const allocs = [alloc('X', '10.0.0.0/25'), alloc('Y', '10.0.0.128/25')];
    // 根缩小为 /25：Y 越界需要迁移，X 保留
    const mig = planMigration([root('A', '10.0.0.0/25')], allocs);
    expect(mig.ok).toBe(false); // /25 放不下两个 /25
    const x = mig.items.find((i) => i.name === 'X')!;
    const y = mig.items.find((i) => i.name === 'Y')!;
    expect(x.status).toBe('kept');
    expect(y.status).toBe('failed');
  });

  it('扩容根网段后越界项落位到最低可用地址', () => {
    const allocs = [alloc('X', '10.0.0.0/25'), alloc('Y', '10.0.0.128/25')];
    const mig = planMigration([root('A', '10.0.0.0/24'), root('B', '10.0.1.0/24')], allocs);
    expect(mig.ok).toBe(true);
    expect(mig.items.every((i) => i.status === 'kept')).toBe(true);
  });

  it('迁移按网段从大到小、原地址升序安置', () => {
    // 新根 10.0.0.0/24，三个分配都需要重新安置
    const allocs = [
      alloc('small1', '192.168.0.0/26'),
      alloc('big', '192.168.1.0/24'),
      alloc('small2', '192.168.0.64/26'),
    ];
    // 把 big 的容量改为 /25 使其可放入 /24 根
    const next = allocs.map((a) => (a.name === 'big' ? { ...a, prefix: 25 } : a));
    const mig = planMigration(roots, next);
    expect(mig.ok).toBe(true);
    const big = mig.items.find((i) => i.name === 'big')!;
    const s1 = mig.items.find((i) => i.name === 'small1')!;
    const s2 = mig.items.find((i) => i.name === 'small2')!;
    // big（/25）先安置到 .0/25；small1 原地址 .0 < small2 原地址 .64
    // small1 先安置到 .128/26，small2 安置到 .192/26
    expect(big.to).toBe('10.0.0.0/25');
    expect(s1.to).toBe('10.0.0.128/26');
    expect(s2.to).toBe('10.0.0.192/26');
  });

  it('容量调整触发迁移，其余保留', () => {
    const allocs = [alloc('X', '10.0.0.0/26'), alloc('Y', '10.0.0.64/26')];
    // X 扩容为 /25：原位置放不下（与 Y 冲突），需迁移到 .128/25
    const next = allocs.map((a) => (a.name === 'X' ? { ...a, prefix: 25 } : a));
    const mig = planMigration(roots, next);
    expect(mig.ok).toBe(true);
    const x = mig.items.find((i) => i.name === 'X')!;
    const y = mig.items.find((i) => i.name === 'Y')!;
    expect(y.status).toBe('kept');
    expect(x.status).toBe('moved');
    expect(x.to).toBe('10.0.0.128/25');
  });

  it('空间不足时标记失败且禁止确认', () => {
    const allocs = [alloc('X', '10.0.0.0/24')];
    const next = allocs.map((a) => ({ ...a, prefix: 23 }));
    const mig = planMigration(roots, next);
    expect(mig.ok).toBe(false);
    expect(mig.items[0].status).toBe('failed');
  });

  it('applyMigration 整批替换落位', () => {
    const allocs = [alloc('X', '10.0.0.0/26'), alloc('Y', '10.0.0.64/26')];
    const next = allocs.map((a) => (a.name === 'X' ? { ...a, prefix: 25 } : a));
    const mig = planMigration(roots, next);
    const applied = applyMigration(next, mig);
    expect(applied.find((a) => a.name === 'X')!.cidr).toBe('10.0.0.128/25');
    expect(applied.find((a) => a.name === 'Y')!.cidr).toBe('10.0.0.64/26');
    // 应用后整体校验通过
    expect(
      validatePlan({ version: 1, roots, allocations: applied }),
    ).toEqual([]);
  });

  it('删除根网段后无家可归的分配迁移到其他根', () => {
    const allocs = [alloc('X', '10.0.0.0/25'), alloc('Y', '10.0.1.0/25')];
    const twoRoots = [root('A', '10.0.0.0/24'), root('B', '10.0.1.0/24')];
    const mig = planMigration([twoRoots[1]], allocs);
    expect(mig.ok).toBe(true);
    const x = mig.items.find((i) => i.name === 'X')!;
    const y = mig.items.find((i) => i.name === 'Y')!;
    expect(y.status).toBe('kept');
    expect(x.status).toBe('moved');
    expect(x.to).toBe('10.0.1.128/25');
  });
});
