/**
 * 前缀策略校验：对当前所有子网分配有序执行 prefix-list。
 *
 * 规则逐行书写：`permit|deny CIDR [ge n le m]`
 *  - CIDR 必须对齐网络地址；
 *  - 可选范围必须同时写为 `ge n le m`（顺序固定），并满足 CIDR 前缀 ≤ n ≤ m ≤ 32；
 *  - 省略范围时仅匹配与规则同前缀的分配。
 *
 * 某分配仅在「完整位于规则 CIDR 内」且「自身前缀落入 [n, m]」时命中，
 * 按首条命中决定 permit/deny，全程未命中记为 unmatched。
 * 纯本地计算，不修改规划、不产生历史记录。
 */
import { Allocation } from './model';
import { Cidr, cidrToString, contains, isAlignedCidr, parseCidr } from './ip';

export type PolicyAction = 'permit' | 'deny';

export interface PrefixRule {
  /** 物理行号（从 1 开始，空行也计入） */
  lineNo: number;
  action: PolicyAction;
  /** 规范化后的规则 CIDR */
  cidr: Cidr;
  /** 匹配前缀范围；省略 ge/le 时均等于 CIDR 前缀 */
  minPrefix: number;
  maxPrefix: number;
  /** 去空白后的原始行文本（用于报告） */
  raw: string;
}

export interface RuleParseResult {
  rules: PrefixRule[];
  /** 逐行错误信息（带行号）；非空时不执行校验、不生成结果 */
  errors: string[];
}

export type PolicyVerdict = PolicyAction | 'unmatched';

export interface PolicyMatch {
  alloc: Allocation;
  cidr: Cidr;
  verdict: PolicyVerdict;
  /** 命中的规则；unmatched 时为 null */
  rule: PrefixRule | null;
}

/** 解析单行规则（不含行号前缀）。空行返回 null；非法时 error 为错误说明。 */
function parseRuleLine(lineNo: number, line: string): { rule: PrefixRule } | { error: string } | null {
  const text = line.trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length !== 2 && tokens.length !== 6) {
    return { error: '规则格式应为 permit|deny CIDR [ge n le m]，每行一条' };
  }
  const [actionToken, cidrToken] = tokens;
  if (actionToken !== 'permit' && actionToken !== 'deny') {
    return { error: `动作必须是 permit 或 deny：${actionToken}` };
  }
  const cidr = parseCidr(cidrToken);
  if (!cidr) {
    return { error: `CIDR 非法：${cidrToken}` };
  }
  if (!isAlignedCidr(cidrToken)) {
    return { error: `CIDR 未对齐网络地址，应为 ${cidrToString(cidr)}` };
  }

  let minPrefix = cidr.prefix;
  let maxPrefix = cidr.prefix;
  if (tokens.length === 6) {
    // 范围必须同时写为 ge n le m，且顺序固定；单独出现 ge 或 le、顺序颠倒均拒绝
    const [, , geToken, nToken, leToken, mToken] = tokens;
    if (
      geToken !== 'ge' ||
      leToken !== 'le' ||
      !/^\d{1,2}$/.test(nToken) ||
      !/^\d{1,2}$/.test(mToken)
    ) {
      return { error: '可选范围必须同时写为「ge n le m」（n、m 为 0-32 的整数，顺序固定）' };
    }
    const n = Number(nToken);
    const m = Number(mToken);
    if (n > 32 || m > 32 || !(cidr.prefix <= n && n <= m)) {
      return { error: `前缀范围不合法，须满足 ${cidr.prefix} ≤ n ≤ m ≤ 32：ge=${n} le=${m}` };
    }
    minPrefix = n;
    maxPrefix = m;
  }

  return {
    rule: { lineNo, action: actionToken, cidr, minPrefix, maxPrefix, raw: text },
  };
}

/** 逐行解析 prefix-list：空行跳过；任一非空行非法即按行收集错误。 */
export function parsePrefixPolicy(text: string): RuleParseResult {
  const rules: PrefixRule[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((rawLine, i) => {
    const parsed = parseRuleLine(i + 1, rawLine);
    if (parsed === null) return;
    if ('error' in parsed) {
      errors.push(`第 ${i + 1} 行：${parsed.error}（${rawLine.trim()}）`);
      return;
    }
    rules.push(parsed.rule);
  });
  return { rules, errors };
}

/** 判断分配是否命中某条规则：完整位于规则 CIDR 内，且自身前缀落入范围。 */
export function ruleMatches(rule: PrefixRule, target: Cidr): boolean {
  return (
    contains(rule.cidr, target) &&
    target.prefix >= rule.minPrefix &&
    target.prefix <= rule.maxPrefix
  );
}

/**
 * 有序执行 prefix-list：按规则书写顺序首条命中决定 permit/deny，未命中为 unmatched。
 * 目标按地址升序输出（同地址按前缀升序）。
 */
export function evaluatePrefixPolicy(
  targets: { alloc: Allocation; cidr: Cidr }[],
  rules: PrefixRule[],
): PolicyMatch[] {
  const sorted = [...targets].sort(
    (a, b) => a.cidr.base - b.cidr.base || a.cidr.prefix - b.cidr.prefix,
  );
  return sorted.map(({ alloc, cidr }) => {
    const hit = rules.find((r) => ruleMatches(r, cidr)) ?? null;
    return { alloc, cidr, verdict: hit ? hit.action : 'unmatched', rule: hit };
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 生成可复制的纯文本校验报告（顺序与结果表格一致）。 */
export function formatPolicyReport(matches: PolicyMatch[], generatedAt = new Date()): string {
  const permit = matches.filter((m) => m.verdict === 'permit').length;
  const deny = matches.filter((m) => m.verdict === 'deny').length;
  const unmatched = matches.length - permit - deny;
  const lines: string[] = [
    '前缀策略校验报告',
    `生成时间：${formatTime(generatedAt)}`,
    `参与校验子网：${matches.length} 项 · permit ${permit} · deny ${deny} · unmatched ${unmatched}`,
    '----------------------------------------',
  ];
  for (const m of matches) {
    const hit = m.rule
      ? `命中第 ${m.rule.lineNo} 行：${m.rule.raw}`
      : '未命中任何规则（unmatched）';
    lines.push(`[${m.verdict.padEnd(9)}] ${m.alloc.name}  ${cidrToString(m.cidr)}  ${hit}`);
  }
  return lines.join('\n');
}
