/**
 * 本机多标签页协同：基于修订图（revision graph）的持久化与广播同步。
 *
 * - 每次改变 Plan 的操作生成一个 Revision（crypto.randomUUID），
 *   记录 parentRevisionIds / clientId / 完整 Plan；
 * - 修订全集与 head 指针持久化到 localStorage，并通过 BroadcastChannel 广播；
 * - 同步判定只看修订图的祖先关系，禁止按时间戳覆盖：
 *   - 当前 head 是收到修订的祖先 → 快进；
 *   - 收到修订是当前 head 的祖先 → 忽略；
 *   - 互不为祖先（或祖先链缺失无法证明）→ 分叉冲突，保留两份；
 * - 冲突由用户显式选择后生成同时引用两个父版本的合并修订。
 */
import { Plan, emptyPlan, validatePlan } from './model';

export interface Revision {
  id: string;
  parentRevisionIds: string[];
  clientId: string;
  plan: Plan;
}

/** 持久化在 localStorage 中的修订全集文档。 */
interface RevisionDoc {
  version: 1;
  revisions: Revision[];
}

interface ParsedDoc {
  doc: RevisionDoc;
  badCount: number;
}

export const REVISIONS_STORAGE_KEY = 'ipv4-subnet-planner/revisions/v1';
export const HEAD_STORAGE_KEY = 'ipv4-subnet-planner/head/v1';
export const CHANNEL_NAME = 'ipv4-subnet-planner/revisions/v1';

/** 修订全集上限，超出后从最早的修订开始裁剪（head 与冲突分支最后裁剪）。 */
const MAX_REVISIONS = 400;

/** 所有客户端共享的空规划创世修订 id（内容恒定，无需随机）。 */
export const GENESIS_REVISION_ID = 'genesis:empty-plan:v1';

export type RevisionRelation = 'same' | 'fast-forward' | 'stale' | 'diverged';

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 沿 parentRevisionIds 判断 maybeAncestor 是否为 descendant 的祖先（含父链缺失即终止）。 */
export function isAncestor(
  maybeAncestorId: string,
  descendantId: string,
  revisions: ReadonlyMap<string, Revision>,
): boolean {
  if (maybeAncestorId === descendantId) return true;
  const seen = new Set<string>();
  const stack = [descendantId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rev = revisions.get(id);
    if (!rev) continue; // 父链上的修订已被裁剪：无法继续证明祖先关系
    for (const parent of rev.parentRevisionIds) {
      if (parent === maybeAncestorId) return true;
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

/**
 * 按修订图判定 remote 相对当前 head 的关系。
 * 创世空规划使用全局固定 id，空存储的标签页之间自然收敛到同一节点。
 */
export function relationOf(
  headId: string,
  remoteId: string,
  revisions: ReadonlyMap<string, Revision>,
): RevisionRelation {
  if (headId === remoteId) return 'same';
  if (isAncestor(headId, remoteId, revisions)) return 'fast-forward';
  if (isAncestor(remoteId, headId, revisions)) return 'stale';
  return 'diverged';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 解析单个修订快照：结构校验 + 现有 Plan 校验；任何损坏都返回错误而不是抛出。 */
export function parseRevision(raw: unknown): ParseResult<Revision> {
  if (!isRecord(raw)) return { ok: false, error: '修订不是对象' };
  const { id, parentRevisionIds, clientId, plan } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: '修订缺少字符串 id' };
  }
  if (!Array.isArray(parentRevisionIds) || !parentRevisionIds.every((p) => typeof p === 'string')) {
    return { ok: false, error: `修订 ${id} 的 parentRevisionIds 非法` };
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return { ok: false, error: `修订 ${id} 缺少 clientId` };
  }
  if (!isRecord(plan) || !Array.isArray(plan.roots) || !Array.isArray(plan.allocations)) {
    return { ok: false, error: `修订 ${id} 缺少完整 Plan` };
  }
  const planObj = plan as unknown as Plan;
  if (planObj.version !== 1) {
    return { ok: false, error: `修订 ${id} 的 Plan 版本不受支持` };
  }
  const errors = validatePlan(planObj);
  if (errors.length > 0) {
    return { ok: false, error: `修订 ${id} 的规划校验未通过：${errors.join('；')}` };
  }
  return {
    ok: true,
    value: { id, parentRevisionIds: [...parentRevisionIds], clientId, plan: planObj },
  };
}

function parseRevisionDoc(raw: string): ParseResult<ParsedDoc> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '本地修订文档不是合法 JSON' };
  }
  if (!isRecord(json) || !Array.isArray(json.revisions)) {
    return { ok: false, error: '本地修订文档结构损坏' };
  }
  const revisions: Revision[] = [];
  const seen = new Set<string>();
  let badCount = 0;
  for (const item of json.revisions as unknown[]) {
    const r = parseRevision(item);
    if (!r.ok) {
      badCount += 1;
      continue;
    }
    if (seen.has(r.value.id)) {
      badCount += 1;
      continue;
    }
    seen.add(r.value.id);
    revisions.push(r.value);
  }
  return { ok: true, value: { doc: { version: 1, revisions }, badCount } };
}

export interface SyncHandlers {
  /** 当前 head 是该修订祖先：已自动快进（应用需作为一次可撤销变更处理）。 */
  onFastForward: (revision: Revision) => void;
  /** 修订图分叉：已保留两份，等待用户选择合并方式，期间应禁用编辑。 */
  onConflict: (revision: Revision) => void;
  /** 损坏快照被忽略等需要提示用户的情况。 */
  onWarning: (message: string) => void;
}

export interface SyncDeps {
  storage?: Storage | null;
  channel?: BroadcastChannel | null;
  clientId?: string;
  uuid?: () => string;
}

/**
 * 一个标签页的修订同步会话。open() 恢复 head、接入广播；
 * 所有读写都经过本类，App 只负责在回调里更新界面与本地撤销/重做栈。
 */
export class RevisionSync {
  private readonly revisions = new Map<string, Revision>();
  /** 文档内的原始顺序，用于裁剪时从最早修订开始丢弃。 */
  private order: string[] = [];
  private headId: string;
  private readonly clientId: string;
  private readonly storage: Storage | null;
  private readonly channel: BroadcastChannel | null;
  private readonly uuid: () => string;
  private readonly handlers: SyncHandlers;

  /** 冲突打开期间收到的修订先入库挂起，合并完成后再逐个判定。 */
  private conflictId: string | null = null;
  private pendingIds: string[] = [];
  private destroyed = false;
  private storageListener: ((e: StorageEvent) => void) | null = null;

  private constructor(handlers: SyncHandlers, deps: SyncDeps, warnings: string[]) {
    this.handlers = handlers;
    this.storage = deps.storage ?? null;
    this.channel = deps.channel === undefined ? null : deps.channel;
    this.uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
    this.clientId = deps.clientId ?? this.uuid();

    const loaded = this.load();
    warnings.push(...loaded.warnings);

    if (loaded.headId) {
      this.headId = loaded.headId;
    } else {
      // 没有任何可用修订：以空规划作为创世修订（无父版本，全客户端共享同一 id）。
      const root: Revision = {
        id: GENESIS_REVISION_ID,
        parentRevisionIds: [],
        clientId: this.clientId,
        plan: emptyPlan(),
      };
      this.revisions.set(root.id, root);
      this.order.push(root.id);
      this.headId = root.id;
      this.persist();
      this.post(root);
    }
  }

  static open(handlers: SyncHandlers, deps: SyncDeps = {}): RevisionSync {
    const warnings: string[] = [];
    const sync = new RevisionSync(handlers, deps, warnings);
    if (typeof window !== 'undefined' && sync.storage) {
      const listener = (e: StorageEvent) => {
        if (e.key !== REVISIONS_STORAGE_KEY || !e.newValue) return;
        const doc = parseRevisionDoc(e.newValue);
        if (!doc.ok) {
          handlers.onWarning('收到损坏的修订文档，已忽略');
          return;
        }
        if (doc.value.badCount > 0) {
          handlers.onWarning(`收到的修订中有 ${doc.value.badCount} 个损坏快照，已忽略`);
        }
        for (const rev of doc.value.doc.revisions) sync.ingest(rev);
      };
      window.addEventListener('storage', listener);
      sync.storageListener = listener;
    }
    if (sync.channel) {
      sync.channel.onmessage = (e: MessageEvent) => {
        const data = e.data as
          | { type?: string; revision?: unknown }
          | null;
        if (!data || data.type !== 'revision') return;
        const parsed = parseRevision(data.revision);
        if (!parsed.ok) {
          handlers.onWarning(`收到损坏的修订快照，已忽略（${parsed.error}）`);
          return;
        }
        if (parsed.value.clientId === sync.clientId) return;
        sync.ingest(parsed.value);
      };
    }
    // 恢复阶段发现的损坏快照统一提示。
    for (const w of warnings) handlers.onWarning(w);
    return sync;
  }

  get head(): Revision {
    return this.revisions.get(this.headId)!;
  }

  get inConflict(): boolean {
    return this.conflictId !== null;
  }

  getRevision(id: string): Revision | undefined {
    return this.revisions.get(id);
  }

  /** 发布一个普通修订（撤销、重做、导入、清空、普通编辑都走这里）。冲突锁定时拒绝发布。 */
  commit(plan: Plan): Revision {
    // 冲突期间禁止规划编辑：调用方应已锁定入口，这里做最后一道防线。
    if (this.conflictId !== null) return this.head;
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: [this.headId],
      clientId: this.clientId,
      plan,
    };
    this.revisions.set(rev.id, rev);
    this.order.push(rev.id);
    this.headId = rev.id;
    this.persist();
    this.post(rev);
    return rev;
  }

  /**
   * 解决冲突：生成同时引用当前 head 与外部修订的合并修订并继续广播。
   * 调用方随后应调用 resume() 以重新判定冲突期间挂起的其他修订。
   */
  mergeAndHead(plan: Plan, remoteRevisionId: string): Revision {
    const parents = [...new Set([this.headId, remoteRevisionId])];
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: parents,
      clientId: this.clientId,
      plan,
    };
    this.revisions.set(rev.id, rev);
    this.order.push(rev.id);
    this.headId = rev.id;
    this.conflictId = null;
    this.persist();
    this.post(rev);
    return rev;
  }

  /** 合并完成后重新判定冲突期间挂起的修订（可能再次快进或再次冲突）。 */
  resume(): void {
    const pending = this.pendingIds;
    this.pendingIds = [];
    for (const id of pending) {
      const rev = this.revisions.get(id);
      if (rev) this.classify(rev);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
    this.channel?.close();
  }

  // ---- 内部 ----

  /** 接收一个外部修订：先落库保留，再按修订图判定。 */
  private ingest(rev: Revision): void {
    if (this.destroyed) return;
    const isNew = !this.revisions.has(rev.id);
    if (!isNew) {
      // 重复投递（storage 事件与频道消息可能各来一次）：无需再判定。
      return;
    }
    this.revisions.set(rev.id, rev);
    this.order.push(rev.id);
    this.persist();
    if (this.conflictId !== null) {
      const conflictId = this.conflictId;
      const relHead = relationOf(this.headId, rev.id, this.revisions);
      if (
        relHead === 'fast-forward' &&
        isAncestor(conflictId, rev.id, this.revisions)
      ) {
        // 对方（或某个标签页）已生成同时覆盖本页 head 与冲突版本的合并修订：
        // 冲突自动消解，直接快进，再逐条重新判定挂起队列。
        this.headId = rev.id;
        this.conflictId = null;
        this.persist();
        this.handlers.onFastForward(rev);
        const pending = this.pendingIds;
        this.pendingIds = [];
        for (const id of pending) {
          const queued = this.revisions.get(id);
          if (queued && queued.id !== rev.id) this.classify(queued);
        }
        return;
      }
      if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
      return;
    }
    this.classify(rev);
  }

  private classify(rev: Revision): void {
    const relation = relationOf(this.headId, rev.id, this.revisions);
    if (relation === 'same' || relation === 'stale') return;
    if (relation === 'fast-forward') {
      this.headId = rev.id;
      this.persist();
      this.handlers.onFastForward(rev);
      return;
    }
    // 分叉（含祖先链缺失无法证明先后的情况）：保留两份，等待人工合并。
    this.conflictId = rev.id;
    if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
    this.handlers.onConflict(rev);
  }

  private post(rev: Revision): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({ type: 'revision', revision: rev });
    } catch {
      this.handlers.onWarning('修订广播失败，其他标签页可能无法即时同步');
    }
  }

  private load(): { headId: string | null; warnings: string[] } {
    const warnings: string[] = [];
    if (!this.storage) return { headId: null, warnings };
    const raw = this.storage.getItem(REVISIONS_STORAGE_KEY);
    if (raw === null) return { headId: null, warnings };

    const doc = parseRevisionDoc(raw);
    if (!doc.ok) {
      warnings.push(`本地修订快照已损坏（${doc.error}），已忽略并从空规划开始`);
      return { headId: null, warnings };
    }
    for (const rev of doc.value.doc.revisions) {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
    }
    if (doc.value.badCount > 0) {
      warnings.push(`检测到 ${doc.value.badCount} 个损坏的修订快照，已忽略`);
    }

    const storedHead = this.storage.getItem(HEAD_STORAGE_KEY);
    if (storedHead && this.revisions.has(storedHead)) {
      return { headId: storedHead, warnings };
    }

    // head 缺失或指向损坏修订：从可用修订中恢复一个叶子（无其他可用后裔）。
    const recovered = this.recoverHead();
    if (recovered) {
      warnings.push('本地 head 指针损坏，已自动恢复到最近的完整修订');
      return { headId: recovered, warnings };
    }
    warnings.push('本地修订快照均已损坏，已忽略并从空规划开始');
    this.revisions.clear();
    this.order = [];
    return { headId: null, warnings };
  }

  /** 选择一个没有可用后裔的修订；多个叶子时取祖先链最长者，再按 id 确定性决胜。 */
  private recoverHead(): string | null {
    const leaves: string[] = [];
    for (const id of this.revisions.keys()) {
      let hasDescendant = false;
      for (const other of this.revisions.values()) {
        if (other.id !== id && isAncestor(id, other.id, this.revisions)) {
          hasDescendant = true;
          break;
        }
      }
      if (!hasDescendant) leaves.push(id);
    }
    if (leaves.length === 0) return null;
    const depth = (id: string): number => {
      const memo = new Map<string, number>();
      const walk = (cur: string, trail: Set<string>): number => {
        const cached = memo.get(cur);
        if (cached !== undefined) return cached;
        const rev = this.revisions.get(cur);
        if (!rev || rev.parentRevisionIds.length === 0 || trail.has(cur)) return 0;
        trail.add(cur);
        const d = 1 + Math.max(...rev.parentRevisionIds.map((p) => walk(p, trail)));
        trail.delete(cur);
        memo.set(cur, d);
        return d;
      };
      return walk(id, new Set());
    };
    return leaves.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0))[0];
  }

  private persist(): void {
    if (!this.storage) return;
    this.prune();
    const doc: RevisionDoc = { version: 1, revisions: this.order.map((id) => this.revisions.get(id)!) };
    try {
      this.storage.setItem(REVISIONS_STORAGE_KEY, JSON.stringify(doc));
      this.storage.setItem(HEAD_STORAGE_KEY, this.headId);
    } catch (e) {
      this.handlers.onWarning(`修订无法写入本地存储：${(e as Error).message}`);
    }
  }

  /** 超出上限时按文档顺序从最早修订开始裁剪；head 与冲突分支最后被丢弃。 */
  private prune(): void {
    while (this.order.length > MAX_REVISIONS) {
      const protectedId = this.conflictId;
      const idx = this.order.findIndex((id) => id !== this.headId && id !== protectedId);
      if (idx < 0) break;
      const [removed] = this.order.splice(idx, 1);
      this.revisions.delete(removed);
    }
  }
}

