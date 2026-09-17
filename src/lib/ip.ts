/**
 * IPv4 / CIDR 基础运算。
 * 解析与合法性校验基于 ipaddr.js，地址运算统一在 uint32 上进行。
 */
import ipaddr from 'ipaddr.js';

/** 一个规范化后的 CIDR：base 为网络地址（uint32），prefix 为前缀长度 0-32 */
export interface Cidr {
  base: number;
  prefix: number;
}

export function ipv4ToLong(ip: string): number | null {
  const text = ip.trim();
  if (!ipaddr.IPv4.isValid(text)) return null;
  const octets = ipaddr.IPv4.parse(text).octets;
  let v = 0;
  for (const o of octets) v = (v * 256 + o) >>> 0;
  return v >>> 0;
}

export function longToIpv4(v: number): string {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export function maskFor(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (~0 << (32 - prefix)) >>> 0;
}

/** 解析 "a.b.c.d/n"，并规范化到网络地址。输入非法返回 null。 */
export function parseCidr(input: string): Cidr | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const ipPart = text.slice(0, slash).trim();
  const prefixPart = text.slice(slash + 1).trim();
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const addr = ipv4ToLong(ipPart);
  if (addr === null) return null;
  return { base: networkOf(addr, prefix), prefix };
}

/** 输入是否为已对齐网络地址的合法 CIDR（如 10.0.0.0/24 是，10.0.0.1/24 否） */
export function isAlignedCidr(input: string): boolean {
  const text = input.trim();
  const slash = text.indexOf('/');
  if (slash < 0) return false;
  const c = parseCidr(text);
  if (!c) return false;
  return c.base === ipv4ToLong(text.slice(0, slash).trim());
}

export function cidrToString(c: Cidr): string {
  return `${longToIpv4(c.base)}/${c.prefix}`;
}

export function networkOf(addr: number, prefix: number): number {
  return (addr & maskFor(prefix)) >>> 0;
}

/** 块内地址总数（/0 为 2^32，用 double 精确表示） */
export function blockSize(prefix: number): number {
  return Math.pow(2, 32 - prefix);
}

export function broadcastOf(c: Cidr): number {
  return (c.base + blockSize(c.prefix) - 1) >>> 0;
}

export function lastAddr(c: Cidr): number {
  return c.base + blockSize(c.prefix) - 1;
}

/**
 * 可用主机数：网络地址与广播地址不计入容量。
 * /31 按 RFC 3021 点对点链路计 2，/32 主机路由计 1。
 */
export function usableHosts(prefix: number): number {
  if (prefix <= 30) return blockSize(prefix) - 2;
  if (prefix === 31) return 2;
  return 1;
}

/** 容纳 hosts 个可用主机的最小网段（最大前缀）。hosts 需 >= 1。 */
export function prefixForHosts(hosts: number): number {
  if (!Number.isInteger(hosts) || hosts < 1) {
    throw new Error('主机数必须为不小于 1 的整数');
  }
  for (let p = 32; p >= 0; p--) {
    if (usableHosts(p) >= hosts) return p;
  }
  return 0;
}

export function contains(parent: Cidr, child: Cidr): boolean {
  return (
    child.prefix >= parent.prefix &&
    child.base >= parent.base &&
    lastAddr(child) <= lastAddr(parent)
  );
}

export function overlaps(a: Cidr, b: Cidr): boolean {
  return a.base <= lastAddr(b) && b.base <= lastAddr(a);
}

export function alignUp(addr: number, prefix: number): number {
  const size = blockSize(prefix);
  return Math.ceil(addr / size) * size;
}

export function compareCidr(a: Cidr, b: Cidr): number {
  return a.base - b.base || a.prefix - b.prefix;
}

/**
 * 从空闲块 free 中扣除已占用块 used（假设二者相交）。
 * 返回扣除后的空闲 CIDR 列表。
 */
export function subtractCidr(free: Cidr, used: Cidr): Cidr[] {
  if (!overlaps(free, used)) return [free];
  if (contains(used, free)) return [];
  // free 必然严格包含 used 的相交部分：二分 free，递归扣除
  const childPrefix = free.prefix + 1;
  if (childPrefix > 32) return [];
  const half = blockSize(childPrefix);
  const low: Cidr = { base: free.base, prefix: childPrefix };
  const high: Cidr = { base: free.base + half, prefix: childPrefix };
  const out: Cidr[] = [];
  for (const child of [low, high]) {
    if (overlaps(child, used)) {
      out.push(...subtractCidr(child, used));
    } else {
      out.push(child);
    }
  }
  return out;
}

/** 两个 CIDR 是否互为可合并的伙伴块（同前缀、相邻、对齐到父块） */
export function areBuddies(a: Cidr, b: Cidr): boolean {
  if (a.prefix !== b.prefix || a.prefix === 0) return false;
  const parentPrefix = a.prefix - 1;
  return (
    networkOf(a.base, parentPrefix) === networkOf(b.base, parentPrefix)
  );
}

/** 递归合并可组成上级 CIDR 的空闲伙伴块，直到不能再合并。结果按地址升序。 */
export function mergeBuddies(cidrs: Cidr[]): Cidr[] {
  let list = [...cidrs].sort(compareCidr);
  let merged = true;
  while (merged) {
    merged = false;
    const out: Cidr[] = [];
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const nxt = list[i + 1];
      if (nxt && areBuddies(cur, nxt) && lastAddr(cur) + 1 === nxt.base) {
        out.push({ base: cur.base, prefix: cur.prefix - 1 });
        i++;
        merged = true;
      } else {
        out.push(cur);
      }
    }
    list = out;
  }
  return list;
}

/** 计算 root 内扣除 occupied 后的空闲块（已做伙伴合并，按地址升序）。 */
export function freeBlocks(root: Cidr, occupied: Cidr[]): Cidr[] {
  let free: Cidr[] = [root];
  const sorted = [...occupied].filter((o) => overlaps(o, root)).sort(compareCidr);
  for (const used of sorted) {
    const next: Cidr[] = [];
    for (const f of free) {
      next.push(...subtractCidr(f, used));
    }
    free = next;
  }
  return mergeBuddies(free);
}
