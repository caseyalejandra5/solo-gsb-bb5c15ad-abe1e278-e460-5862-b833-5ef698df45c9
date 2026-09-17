import { describe, expect, it } from 'vitest';
import {
  computeDhcpPool,
  formatRange,
  mergeRanges,
  parseExclusionLine,
  parseExclusions,
  rangeSize,
  usableRangeOf,
} from './dhcp';
import { longToIpv4, parseCidr } from './ip';

const cidr = (s: string) => parseCidr(s)!;
const fmt = (ranges: { start: number; end: number }[]) => ranges.map(formatRange);

describe('可用范围（自动排除规则）', () => {
  it('/0～/30 排除网络地址与广播地址', () => {
    expect(formatRange(usableRangeOf(cidr('10.0.0.0/24')))).toBe('10.0.0.1 - 10.0.0.254');
    expect(formatRange(usableRangeOf(cidr('10.0.0.0/30')))).toBe('10.0.0.1 - 10.0.0.2');
    expect(formatRange(usableRangeOf(cidr('0.0.0.0/0')))).toBe('0.0.0.1 - 255.255.255.254');
  });

  it('/31、/32 沿用可用主机规则，不额外排除', () => {
    expect(formatRange(usableRangeOf(cidr('10.0.0.0/31')))).toBe('10.0.0.0 - 10.0.0.1');
    expect(formatRange(usableRangeOf(cidr('10.0.0.7/32')))).toBe('10.0.0.7 - 10.0.0.7');
    expect(formatRange(usableRangeOf(cidr('255.255.255.255/32')))).toBe(
      '255.255.255.255 - 255.255.255.255',
    );
  });
});

describe('排除项解析与校验', () => {
  it('解析单个地址与 CIDR', () => {
    expect(parseExclusionLine('10.0.0.5')).toEqual({
      start: cidr('10.0.0.5/32').base,
      end: cidr('10.0.0.5/32').base,
    });
    expect(parseExclusionLine('10.0.0.64/26')).toEqual({
      start: cidr('10.0.0.64/26').base,
      end: cidr('10.0.0.127/32').base,
    });
    // 未对齐的 CIDR 规范化到其网段
    expect(parseExclusionLine('10.0.0.200/24')).toEqual({
      start: cidr('10.0.0.0/24').base,
      end: cidr('10.0.0.255/32').base,
    });
  });

  it('拒绝非法输入', () => {
    expect(parseExclusionLine('10.0.0.256')).toBeNull();
    expect(parseExclusionLine('10.0.0.0/33')).toBeNull();
    expect(parseExclusionLine('abc')).toBeNull();
    expect(parseExclusionLine('10.0.0.1-10.0.0.9')).toBeNull();
  });

  it('空行跳过，合法行全部通过', () => {
    const { ranges, errors } = parseExclusions(
      cidr('10.0.0.0/24'),
      '10.0.0.5\n\n  \n10.0.0.64/26\n',
    );
    expect(errors).toEqual([]);
    expect(ranges).toHaveLength(2);
  });

  it('非法行与越界行逐条报错（带行号）', () => {
    const { ranges, errors } = parseExclusions(
      cidr('10.0.0.0/25'),
      '10.0.0.5\nnonsense\n10.0.0.128\n10.0.0.0/24\n10.0.0.200/24',
    );
    expect(ranges).toHaveLength(1);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('第 2 行');
    expect(errors[1]).toContain('第 3 行');
    expect(errors[1]).toContain('越界');
    expect(errors[2]).toContain('第 4 行'); // /24 超出 /25 边界
    expect(errors[3]).toContain('第 5 行'); // 部分在子网内也算越界
  });

  it('网络地址与广播地址作为排除项不算越界', () => {
    const { errors } = parseExclusions(cidr('10.0.0.0/24'), '10.0.0.0\n10.0.0.255');
    expect(errors).toEqual([]);
  });
});

describe('区间合并', () => {
  it('重叠与相邻区间合并，不相邻保持分开', () => {
    const merged = mergeRanges([
      { start: 20, end: 30 },
      { start: 10, end: 15 },
      { start: 16, end: 19 }, // 与 [10,15] 相邻
      { start: 25, end: 28 }, // 被 [20,30] 包含
      { start: 40, end: 41 },
    ]);
    expect(merged).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 41 },
    ]);
  });
});

describe('DHCP 地址池计算', () => {
  it('无排除项时输出整个可用范围', () => {
    expect(fmt(computeDhcpPool(cidr('10.0.0.0/24'), []))).toEqual(['10.0.0.1 - 10.0.0.254']);
  });

  it('中间扣除产生两段，边界扣除产生一段', () => {
    const mid = computeDhcpPool(cidr('10.0.0.0/24'), [
      { start: cidr('10.0.0.10/32').base, end: cidr('10.0.0.20/32').base },
    ]);
    expect(fmt(mid)).toEqual(['10.0.0.1 - 10.0.0.9', '10.0.0.21 - 10.0.0.254']);

    const head = computeDhcpPool(cidr('10.0.0.0/24'), [
      { start: cidr('10.0.0.1/32').base, end: cidr('10.0.0.1/32').base },
    ]);
    expect(fmt(head)).toEqual(['10.0.0.2 - 10.0.0.254']);

    const tail = computeDhcpPool(cidr('10.0.0.0/24'), [
      { start: cidr('10.0.0.254/32').base, end: cidr('10.0.0.254/32').base },
    ]);
    expect(fmt(tail)).toEqual(['10.0.0.1 - 10.0.0.253']);
  });

  it('重叠与相邻排除项先合并，输出最少数量的范围', () => {
    const pool = computeDhcpPool(cidr('10.0.0.0/24'), [
      { start: cidr('10.0.0.10/32').base, end: cidr('10.0.0.12/32').base },
      { start: cidr('10.0.0.11/32').base, end: cidr('10.0.0.14/32').base }, // 重叠
      { start: cidr('10.0.0.15/32').base, end: cidr('10.0.0.15/32').base }, // 相邻
      { start: cidr('10.0.0.100/32').base, end: cidr('10.0.0.100/32').base },
    ]);
    expect(fmt(pool)).toEqual([
      '10.0.0.1 - 10.0.0.9',
      '10.0.0.16 - 10.0.0.99',
      '10.0.0.101 - 10.0.0.254',
    ]);
  });

  it('排除项覆盖网络/广播地址时按可用范围截断', () => {
    // 排除整个 /24（含网络与广播地址），可用范围内什么都不剩
    expect(computeDhcpPool(cidr('10.0.0.0/24'), [{ start: cidr('10.0.0.0/24').base, end: cidr('10.0.0.255/32').base }])).toEqual([]);
    // 排除 10.0.0.0/25：网络地址本就不在池中，剩余从 .129 开始
    const pool = computeDhcpPool(cidr('10.0.0.0/24'), [
      { start: cidr('10.0.0.0/25').base, end: cidr('10.0.0.127/32').base },
    ]);
    expect(fmt(pool)).toEqual(['10.0.0.128 - 10.0.0.254']);
  });

  it('/31 与 /32 不排除任何默认地址', () => {
    expect(fmt(computeDhcpPool(cidr('10.0.0.0/31'), []))).toEqual(['10.0.0.0 - 10.0.0.1']);
    expect(fmt(computeDhcpPool(cidr('10.0.0.9/32'), []))).toEqual(['10.0.0.9 - 10.0.0.9']);
    // /31 排除一个地址后剩另一个
    const pool = computeDhcpPool(cidr('10.0.0.0/31'), [
      { start: cidr('10.0.0.0/32').base, end: cidr('10.0.0.0/32').base },
    ]);
    expect(fmt(pool)).toEqual(['10.0.0.1 - 10.0.0.1']);
  });

  it('端到端：文本输入 → 池范围，地址总数守恒', () => {
    const subnet = cidr('192.168.1.0/24');
    const { ranges, errors } = parseExclusions(
      subnet,
      '192.168.1.1\n192.168.1.10\n192.168.1.11\n192.168.1.64/26',
    );
    expect(errors).toEqual([]);
    const pool = computeDhcpPool(subnet, ranges);
    expect(fmt(pool)).toEqual([
      '192.168.1.2 - 192.168.1.9',
      '192.168.1.12 - 192.168.1.63',
      '192.168.1.128 - 192.168.1.254',
    ]);
    const excluded = mergeRanges(ranges).reduce((n, r) => n + rangeSize(r), 0);
    const remaining = pool.reduce((n, r) => n + rangeSize(r), 0);
    expect(remaining).toBe(254 - excluded);
  });

  it('结果可格式化回 IP 字符串', () => {
    const pool = computeDhcpPool(cidr('10.0.0.0/30'), []);
    expect(pool.map((r) => longToIpv4(r.start))).toEqual(['10.0.0.1']);
    expect(pool.map((r) => longToIpv4(r.end))).toEqual(['10.0.0.2']);
  });
});
