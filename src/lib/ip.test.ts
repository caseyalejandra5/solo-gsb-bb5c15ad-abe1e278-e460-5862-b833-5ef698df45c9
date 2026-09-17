import { describe, expect, it } from 'vitest';
import {
  alignUp,
  areBuddies,
  blockSize,
  broadcastOf,
  cidrToString,
  contains,
  freeBlocks,
  isAlignedCidr,
  mergeBuddies,
  overlaps,
  parseCidr,
  prefixForHosts,
  subtractCidr,
  usableHosts,
} from './ip';

describe('CIDR 解析与规范化', () => {
  it('解析合法 CIDR 并对齐到网络地址', () => {
    expect(cidrToString(parseCidr('10.1.2.3/24')!)).toBe('10.1.2.0/24');
    expect(cidrToString(parseCidr('192.168.0.0/16')!)).toBe('192.168.0.0/16');
    expect(cidrToString(parseCidr('0.0.0.0/0')!)).toBe('0.0.0.0/0');
    expect(cidrToString(parseCidr('255.255.255.255/32')!)).toBe('255.255.255.255/32');
  });

  it('拒绝非法输入', () => {
    expect(parseCidr('10.0.0.0')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
    expect(parseCidr('10.0.0.256/24')).toBeNull();
    expect(parseCidr('abc/24')).toBeNull();
    expect(parseCidr('10.0.0.0/abc')).toBeNull();
    expect(parseCidr('')).toBeNull();
  });

  it('判断对齐', () => {
    expect(isAlignedCidr('10.0.0.0/24')).toBe(true);
    expect(isAlignedCidr('10.0.0.1/24')).toBe(false);
    expect(isAlignedCidr('10.0.0.64/26')).toBe(true);
    expect(isAlignedCidr('10.0.0.65/26')).toBe(false);
  });
});

describe('容量计算（网络/广播地址不计入）', () => {
  it('常规前缀', () => {
    expect(usableHosts(24)).toBe(254);
    expect(usableHosts(30)).toBe(2);
    expect(blockSize(24)).toBe(256);
    expect(blockSize(0)).toBe(4294967296);
  });

  it('特殊前缀 /31、/32', () => {
    expect(usableHosts(31)).toBe(2);
    expect(usableHosts(32)).toBe(1);
  });

  it('按主机数求最小前缀', () => {
    expect(prefixForHosts(1)).toBe(32);
    expect(prefixForHosts(2)).toBe(31);
    expect(prefixForHosts(3)).toBe(29);
    expect(prefixForHosts(254)).toBe(24);
    expect(prefixForHosts(255)).toBe(23);
    expect(prefixForHosts(500)).toBe(23);
    expect(prefixForHosts(65534)).toBe(16);
    expect(prefixForHosts(65535)).toBe(15);
  });

  it('广播地址', () => {
    expect(broadcastOf(parseCidr('10.0.0.0/24')!)).toBe(
      parseCidr('10.0.0.255/32')!.base,
    );
    expect(broadcastOf(parseCidr('255.255.255.0/24')!)).toBe(4294967295);
  });
});

describe('包含与重叠', () => {
  it('contains', () => {
    const root = parseCidr('10.0.0.0/8')!;
    expect(contains(root, parseCidr('10.1.0.0/16')!)).toBe(true);
    expect(contains(root, parseCidr('11.0.0.0/16')!)).toBe(false);
    expect(contains(root, root)).toBe(true);
    expect(contains(parseCidr('10.0.0.0/16')!, root)).toBe(false);
  });

  it('overlaps', () => {
    expect(overlaps(parseCidr('10.0.0.0/24')!, parseCidr('10.0.0.128/25')!)).toBe(true);
    expect(overlaps(parseCidr('10.0.0.0/25')!, parseCidr('10.0.0.128/25')!)).toBe(false);
    expect(overlaps(parseCidr('10.0.0.0/24')!, parseCidr('10.0.1.0/24')!)).toBe(false);
  });
});

describe('扣除与伙伴合并', () => {
  it('subtractCidr 基本扣除', () => {
    const root = parseCidr('10.0.0.0/24')!;
    const used = parseCidr('10.0.0.0/25')!;
    const rest = subtractCidr(root, used);
    expect(rest.map(cidrToString)).toEqual(['10.0.0.128/25']);
  });

  it('subtractCidr 中间扣除产生多块', () => {
    const root = parseCidr('10.0.0.0/24')!;
    const used = parseCidr('10.0.0.64/26')!;
    const rest = subtractCidr(root, used).map(cidrToString);
    expect(rest).toEqual(['10.0.0.0/26', '10.0.0.128/25']);
  });

  it('areBuddies 与 mergeBuddies 递归合并', () => {
    const a = parseCidr('10.0.0.0/25')!;
    const b = parseCidr('10.0.0.128/25')!;
    expect(areBuddies(a, b)).toBe(true);
    const merged = mergeBuddies([b, a]);
    expect(merged.map(cidrToString)).toEqual(['10.0.0.0/24']);
  });

  it('mergeBuddies 多级递归', () => {
    const parts = ['10.0.0.0/26', '10.0.0.64/26', '10.0.0.128/26', '10.0.0.192/26'].map(
      (s) => parseCidr(s)!,
    );
    expect(mergeBuddies(parts).map(cidrToString)).toEqual(['10.0.0.0/24']);
  });

  it('非伙伴不合并', () => {
    const a = parseCidr('10.0.0.0/26')!;
    const b = parseCidr('10.0.0.128/26')!;
    expect(areBuddies(a, b)).toBe(false);
    expect(mergeBuddies([a, b]).map(cidrToString)).toEqual([
      '10.0.0.0/26',
      '10.0.0.128/26',
    ]);
  });

  it('freeBlocks 释放后递归合并', () => {
    const root = parseCidr('10.0.0.0/24')!;
    // 占用 .0/26，释放其余 → 空闲应合并为尽可能大的块
    const free = freeBlocks(root, [parseCidr('10.0.0.0/26')!]);
    expect(free.map(cidrToString)).toEqual(['10.0.0.64/26', '10.0.0.128/25']);
    // 全部释放 → 合并回整个根
    expect(freeBlocks(root, []).map(cidrToString)).toEqual(['10.0.0.0/24']);
  });

  it('alignUp', () => {
    expect(alignUp(0, 24)).toBe(0);
    const x = parseCidr('10.0.0.1/32')!.base;
    expect(alignUp(x, 24)).toBe(parseCidr('10.0.1.0/24')!.base);
  });
});
