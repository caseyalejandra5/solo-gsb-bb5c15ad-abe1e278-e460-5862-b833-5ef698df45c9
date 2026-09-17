import { describe, expect, it } from 'vitest';
import { Allocation } from './model';
import { parseCidr } from './ip';
import {
  evaluatePrefixPolicy,
  formatPolicyReport,
  parsePrefixPolicy,
  ruleMatches,
} from './prefixPolicy';

const alloc = (name: string, cidr: string, kind: Allocation['kind'] = 'subnet'): Allocation => ({
  id: name,
  name,
  kind,
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

const targets = (allocs: Allocation[]) =>
  allocs
    .map((a) => ({ alloc: a, cidr: parseCidr(a.cidr)! }))
    .filter((x) => x.alloc.kind === 'subnet');

describe('规则解析', () => {
  it('接受 permit/deny 与可选 ge/le 范围', () => {
    const { rules, errors } = parsePrefixPolicy(
      'permit 10.0.0.0/8 ge 16 le 24\ndeny 0.0.0.0/0\npermit 192.168.0.0/16',
    );
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      lineNo: 1,
      action: 'permit',
      minPrefix: 16,
      maxPrefix: 24,
    });
    expect(rules[0].cidr).toEqual(parseCidr('10.0.0.0/8'));
    expect(rules[1]).toMatchObject({ lineNo: 2, action: 'deny', minPrefix: 0, maxPrefix: 0 });
    // 省略范围时仅匹配同前缀
    expect(rules[2]).toMatchObject({ minPrefix: 16, maxPrefix: 16 });
  });

  it('空行与纯空白行跳过且保留物理行号', () => {
    const { rules, errors } = parsePrefixPolicy(
      '\npermit 10.0.0.0/8\n\n   \ndeny 192.168.0.0/16\n',
    );
    expect(errors).toEqual([]);
    expect(rules.map((r) => r.lineNo)).toEqual([2, 5]);
  });

  it('空文本合法（空策略，全部 unmatched）', () => {
    const { rules, errors } = parsePrefixPolicy('  \n\n');
    expect(errors).toEqual([]);
    expect(rules).toEqual([]);
  });

  it('拒绝未对齐 CIDR', () => {
    const { rules, errors } = parsePrefixPolicy('permit 10.0.0.1/24');
    expect(rules).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('第 1 行');
    expect(errors[0]).toContain('未对齐');
    expect(errors[0]).toContain('10.0.0.0/24');
  });

  it('拒绝非法动作、非法 CIDR 与格式错误', () => {
    const text = 'allow 10.0.0.0/8\npermit 10.0.0.256/8\npermit\n10.0.0.0/8';
    const { errors } = parsePrefixPolicy(text);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('第 1 行');
    expect(errors[0]).toContain('permit 或 deny');
    expect(errors[1]).toContain('第 2 行');
    expect(errors[1]).toContain('CIDR 非法');
    expect(errors[2]).toContain('第 3 行');
    expect(errors[3]).toContain('第 4 行');
  });

  it('范围必须同时写为 ge n le m', () => {
    const onlyGe = parsePrefixPolicy('permit 10.0.0.0/8 ge 16');
    expect(onlyGe.errors).toHaveLength(1);
    expect(onlyGe.errors[0]).toContain('ge n le m');

    const onlyLe = parsePrefixPolicy('permit 10.0.0.0/8 le 24');
    expect(onlyLe.errors).toHaveLength(1);

    const swapped = parsePrefixPolicy('permit 10.0.0.0/8 le 16 ge 24');
    expect(swapped.errors).toHaveLength(1);
    expect(swapped.errors[0]).toContain('ge n le m');
  });

  it('范围须满足 CIDR 前缀 ≤ n ≤ m ≤ 32', () => {
    const nTooSmall = parsePrefixPolicy('permit 10.0.0.0/16 ge 8 le 24');
    expect(nTooSmall.errors).toHaveLength(1);
    expect(nTooSmall.errors[0]).toContain('16 ≤ n ≤ m ≤ 32');

    const inverted = parsePrefixPolicy('permit 10.0.0.0/8 ge 24 le 16');
    expect(inverted.errors).toHaveLength(1);
    expect(inverted.errors[0]).toContain('8 ≤ n ≤ m ≤ 32');

    const tooBig = parsePrefixPolicy('permit 0.0.0.0/0 ge 16 le 33');
    expect(tooBig.errors).toHaveLength(1);

    const boundaries = parsePrefixPolicy('permit 0.0.0.0/0 ge 0 le 32');
    expect(boundaries.errors).toEqual([]);
  });

  it('非数字范围值与多余 token 报错', () => {
    expect(parsePrefixPolicy('permit 10.0.0.0/8 ge x le 24').errors).toHaveLength(1);
    expect(parsePrefixPolicy('permit 10.0.0.0/8 ge 16 le 24 extra').errors).toHaveLength(1);
    expect(parsePrefixPolicy('PERMIT 10.0.0.0/8').errors).toHaveLength(1);
  });
});

describe('规则命中', () => {
  const [rule] = parsePrefixPolicy('permit 10.0.0.0/8 ge 16 le 24').rules;

  it('完整位于规则 CIDR 且前缀落入范围才命中', () => {
    expect(ruleMatches(rule, parseCidr('10.1.0.0/18')!)).toBe(true);
    expect(ruleMatches(rule, parseCidr('10.0.0.0/24')!)).toBe(true);
    // 范围边界含端点；/15、/25 超出范围
    expect(ruleMatches(rule, parseCidr('10.0.0.0/15')!)).toBe(false);
    expect(ruleMatches(rule, parseCidr('10.0.0.0/25')!)).toBe(false);
    // 不在规则 CIDR 内（对齐块与规则 CIDR 要么完整包含、要么互不相交）
    expect(ruleMatches(rule, parseCidr('192.168.0.0/24')!)).toBe(false);
    // 规则 CIDR 内但前缀范围外，不命中
    expect(ruleMatches(rule, parseCidr('10.0.0.0/8')!)).toBe(false);
    // 范围约束要求 ge ≥ CIDR 前缀，否则该行非法
    expect(parsePrefixPolicy('permit 10.64.0.0/11 ge 8 le 32').errors).toHaveLength(1);
    const inside = parsePrefixPolicy('permit 10.64.0.0/11 ge 11 le 32').rules[0];
    expect(ruleMatches(inside, parseCidr('10.64.0.0/11')!)).toBe(true);
    expect(ruleMatches(inside, parseCidr('10.96.0.0/12')!)).toBe(false);
  });

  it('省略范围时仅匹配同前缀', () => {
    const [exact] = parsePrefixPolicy('deny 10.0.0.0/24').rules;
    expect(ruleMatches(exact, parseCidr('10.0.0.0/24')!)).toBe(true);
    expect(ruleMatches(exact, parseCidr('10.0.0.0/25')!)).toBe(false);
    expect(ruleMatches(exact, parseCidr('10.0.0.0/16')!)).toBe(false);
  });
});

describe('有序策略执行', () => {
  const allocs = [
    alloc('数据中心-A', '10.1.0.0/18'),
    alloc('办公有线', '192.168.0.0/22'),
    alloc('访客网络', '192.168.8.0/24'),
    alloc('核心交换区', '10.0.0.0/16', 'reserved'),
  ];

  it('首条命中决定 permit/deny，未命中记 unmatched', () => {
    const { rules } = parsePrefixPolicy(
      'deny 192.168.8.0/24\npermit 10.0.0.0/8 ge 16 le 24\npermit 192.168.0.0/16 ge 16 le 23',
    );
    const result = evaluatePrefixPolicy(targets(allocs), rules);
    // 保留段不参与；输出按地址升序
    expect(result.map((m) => m.alloc.name)).toEqual(['数据中心-A', '办公有线', '访客网络']);
    expect(result[0].verdict).toBe('permit');
    expect(result[0].rule?.lineNo).toBe(2);
    // /22 命中第 3 条（le 23）
    expect(result[1].verdict).toBe('permit');
    expect(result[1].rule?.lineNo).toBe(3);
    // /24 不满足 le 23，第 3 条不匹配；第 1 条精确 deny 命中
    expect(result[2].verdict).toBe('deny');
    expect(result[2].rule?.lineNo).toBe(1);
  });

  it('首条命中优先：先 deny 后 permit 同范围仍 deny', () => {
    const { rules } = parsePrefixPolicy('deny 10.0.0.0/8 ge 8 le 32\npermit 0.0.0.0/0 ge 0 le 32');
    const [m] = evaluatePrefixPolicy(targets([alloc('a', '10.5.0.0/24')]), rules);
    expect(m.verdict).toBe('deny');
    expect(m.rule?.lineNo).toBe(1);
  });

  it('无规则或无命中时全部 unmatched 且 rule 为 null', () => {
    const noRules = evaluatePrefixPolicy(targets([alloc('a', '10.0.0.0/8')]), []);
    expect(noRules[0].verdict).toBe('unmatched');
    expect(noRules[0].rule).toBeNull();

    const { rules } = parsePrefixPolicy('permit 172.16.0.0/12');
    const miss = evaluatePrefixPolicy(targets([alloc('a', '10.0.0.0/8')]), rules);
    expect(miss[0].verdict).toBe('unmatched');
    expect(miss[0].rule).toBeNull();
  });

  it('边界前缀范围 ge 0 le 32 对 /0 规则命中任意分配', () => {
    const { rules } = parsePrefixPolicy('permit 0.0.0.0/0 ge 0 le 32');
    const result = evaluatePrefixPolicy(
      targets([alloc('a', '0.0.0.0/0'), alloc('b', '10.0.0.0/32')]),
      rules,
    );
    expect(result.every((m) => m.verdict === 'permit')).toBe(true);
  });
});

describe('文本报告', () => {
  it('包含统计与每条结论、命中行', () => {
    const { rules } = parsePrefixPolicy(
      'deny 10.0.0.0/8 ge 8 le 32\npermit 192.168.0.0/16 ge 16 le 24',
    );
    const matches = evaluatePrefixPolicy(
      targets([
        alloc('内部', '10.1.0.0/16'),
        alloc('办公', '192.168.0.0/22'),
        alloc('外部', '172.16.0.0/12'),
      ]),
      rules,
    );
    const report = formatPolicyReport(matches, new Date('2026-09-17T08:30:00'));
    expect(report).toContain('前缀策略校验报告');
    expect(report).toContain('2026-09-17 08:30:00');
    expect(report).toContain('permit 1 · deny 1 · unmatched 1');
    expect(report).toContain('[deny     ] 内部  10.1.0.0/16  命中第 1 行：deny 10.0.0.0/8 ge 8 le 32');
    expect(report).toContain(
      '[permit   ] 办公  192.168.0.0/22  命中第 2 行：permit 192.168.0.0/16 ge 16 le 24',
    );
    expect(report).toContain('[unmatched] 外部  172.16.0.0/12  未命中任何规则（unmatched）');
  });
});
