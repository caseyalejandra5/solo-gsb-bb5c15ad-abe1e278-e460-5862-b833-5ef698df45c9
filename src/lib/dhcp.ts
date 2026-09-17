/**
 * DHCP 地址池生成：基于 uint32 区间运算，从子网可用范围中扣除排除项。
 * 全程区间合并/扣除，不逐地址枚举。
 */
import { Cidr, ipv4ToLong, lastAddr, longToIpv4, parseCidr } from './ip';

/** 闭区间 [start, end]，uint32 地址 */
export interface IpRange {
  start: number;
  end: number;
}

/**
 * 子网的默认可用范围：/0～/30 自动排除网络地址与广播地址；
 * /31、/32 沿用可用主机规则（/31 两个地址均可用，/32 唯一地址可用）。
 */
export function usableRangeOf(c: Cidr): IpRange {
  if (c.prefix <= 30) {
    return { start: (c.base + 1) >>> 0, end: (lastAddr(c) - 1) >>> 0 };
  }
  return { start: c.base, end: lastAddr(c) };
}

/** 解析一行排除项：单个 IPv4 地址或 CIDR（CIDR 规范化到其网段）。非法返回 null。 */
export function parseExclusionLine(line: string): IpRange | null {
  const text = line.trim();
  if (!text) return null;
  if (text.includes('/')) {
    const c = parseCidr(text);
    if (!c) return null;
    return { start: c.base, end: lastAddr(c) };
  }
  const addr = ipv4ToLong(text);
  if (addr === null) return null;
  return { start: addr, end: addr };
}

export interface ExclusionParseResult {
  /** 全部合法且越界检查通过的排除区间（未合并） */
  ranges: IpRange[];
  /** 逐行错误信息（带行号）；非空时不应生成结果 */
  errors: string[];
}

/** 逐行解析并校验排除项：必须完整位于子网内。空行跳过。 */
export function parseExclusions(subnet: Cidr, text: string): ExclusionParseResult {
  const errors: string[] = [];
  const ranges: IpRange[] = [];
  const subnetEnd = lastAddr(subnet);
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const range = parseExclusionLine(line);
    if (!range) {
      errors.push(`第 ${i + 1} 行：无法识别的 IPv4 地址或 CIDR：${line}`);
      return;
    }
    if (range.start < subnet.base || range.end > subnetEnd) {
      errors.push(
        `第 ${i + 1} 行：${line} 越界，排除项必须完整位于子网 ${longToIpv4(subnet.base)} - ${longToIpv4(subnetEnd)} 内`,
      );
      return;
    }
    ranges.push(range);
  });
  return { ranges, errors };
}

/** 合并重叠或相邻的区间，结果按起始地址升序。 */
export function mergeRanges(ranges: IpRange[]): IpRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: IpRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    // 相邻即 r.start === last.end + 1；end 为 uint32 最大值时无后继，但此时 r 必被包含
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * 计算 DHCP 地址池：子网可用范围扣除排除区间后的剩余连续范围。
 * 区间运算实现，返回最少数量的 [start, end] 段（升序、互不相邻）。
 */
export function computeDhcpPool(subnet: Cidr, exclusions: IpRange[]): IpRange[] {
  const pool = usableRangeOf(subnet);
  const out: IpRange[] = [];
  let cursor = pool.start;
  for (const ex of mergeRanges(exclusions)) {
    if (ex.end < cursor) continue;
    if (ex.start > pool.end) break;
    if (ex.start > cursor) {
      out.push({ start: cursor, end: ex.start - 1 });
    }
    cursor = Math.max(cursor, ex.end + 1);
    if (cursor > pool.end) return out;
  }
  if (cursor <= pool.end) {
    out.push({ start: cursor, end: pool.end });
  }
  return out;
}

/** 区间包含的地址总数（double 精确表示 uint32 范围） */
export function rangeSize(r: IpRange): number {
  return r.end - r.start + 1;
}

/** 格式化为「起始 IP - 结束 IP」 */
export function formatRange(r: IpRange): string {
  return `${longToIpv4(r.start)} - ${longToIpv4(r.end)}`;
}
