/* ==========================================================================
 * app.js — 个人导航页的全部交互逻辑
 * --------------------------------------------------------------------------
 * 纯静态实现：无需构建、无框架依赖，直接放到 GitHub Pages 即可运行。
 *
 * 模块目录
 *   1. 常量与状态
 *   2. 通用工具
 *   3. 数据规范化（兼容 v1 旧格式 / v2 新格式）
 *   4. 差异引擎（多阶段实体对齐 + LIS 最小移动集）
 *   5. 渲染层（阅读态 / 编辑态 / 排序态 / 搜索结果）
 *   6. 拖动排序引擎（排序模式专用，与增删改独立）
 *   7. 编辑操作（分组·分类·条目的增删改）
 *   8. 弹窗与轻提示
 *   9. 导入 / 导出 / 恢复线上版本
 *  10. GitHub 推送（Contents API）
 *  11. 初始化与事件绑定
 *
 * 设计约定
 *   · 数据只有两份：baseline（线上快照）与 data（当前工作副本）。
 *   · 所有"是否算修改"的判断都基于这两份数据的【最终状态】比较，
 *     因此"新增后又删除""移动后又移回"天然不产生差异。
 *   · 编辑操作一律走 commit()，保证差异实时重算、UI 同步。
 * ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
   * 1. 常量与状态
   * ====================================================================== */

  /** 基础鉴权密码（按需求写死在代码里，不做加密） */
  const ADMIN_PASSWORD = 'admin123';

  const DATA_URL = 'data.json';

  const LS = {
    cache: 'nav:cache:v2',      // 线上数据本地缓存，网络异常时兜底
    github: 'nav:github',       // GitHub 推送配置（含 token）
    unlocked: 'nav:unlocked',   // 当前会话是否已通过鉴权
    collapsed: 'nav:collapsed'  // 编辑态的折叠状态（只影响显示）
  };

  /** GitHub 推送默认配置，可在设置弹窗中修改 */
  const GH_DEFAULT = { owner: 'PasserJang', repo: 'nav', branch: 'main', path: 'data.json', token: '' };

  /** v1 旧数据没有分组名，用这些名字兜底 */
  const V1_GROUP_NAMES = { project1: '工具', project2: '阅读', project3: '网站' };

  /** 全局状态 */
  const state = {
    baseline: null,   // 线上快照（差异比较的基准）
    data: null,       // 当前工作副本
    diff: { changes: [], count: 0 },
    editing: false,   // 是否处于管理模式
    sorting: false,   // 是否处于拖动排序模式（编辑模式的子状态）
    active: {},       // groupId -> 当前选中的分类下标
    search: '',       // 搜索关键词
    // 编辑态的折叠状态（纯显示层，不参与数据与差异比较）
    collapsed: { groups: new Set(), cats: new Set() }
  };

  /* ========================================================================
   * 2. 通用工具
   * ====================================================================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.prototype.slice.call(root.querySelectorAll(sel));

  /** 深拷贝（数据量小，JSON 方式足够且最快） */
  const clone = (obj) => JSON.parse(JSON.stringify(obj));

  /** HTML 转义，防止数据里的尖括号破坏结构 */
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  /** 仅允许安全的链接协议，避免导入数据里出现 javascript: 之类的地址 */
  function safeUrl(u) {
    const s = String(u || '').trim();
    return /^(https?:\/\/|mailto:|tel:|\/|\.\/|#)/i.test(s) ? s : '';
  }

  /** 防抖：搜索输入等高频操作使用 */
  function debounce(fn, delay) {
    let timer = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(ctx, args), delay);
    };
  }

  /** 取主机名，用于 favicon 与占位文案 */
  function hostname(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  /** 由名称哈希出稳定的占位底色，保证同一站点颜色不变 */
  const PALETTE = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#e74c3c'];
  function colorOf(name) {
    let hash = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  /**
   * 数组内移动元素（就地修改）。
   * splice 实现为 O(n)，在导航页这种量级下比链表结构更省内存、更快。
   * @returns {boolean} 是否真的发生了移动
   */
  function arrayMove(arr, from, to) {
    if (from === to || to < 0 || to >= arr.length || from < 0 || from >= arr.length) return false;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    return true;
  }

  /* ========================================================================
   * 3. 数据规范化
   * ------------------------------------------------------------------------
   * 统一成 v2 结构：
   * {
   *   version: 2,
   *   title: "站点标题",
   *   groups: [
   *     { id, name, categories: [ { id, name, items: [ { name, url, desc } ] } ] }
   *   ]
   * }
   *
   * 同时兼容 v1：{ project1: [ { category, items } ], ... }
   * ====================================================================== */

  /**
   * id 分配器：优先沿用已有 id，缺失时按「前缀:名称」确定性生成。
   * 确定性很关键 —— 同一份数据多次 normalize 必须得到相同 id，
   * 否则差异比较会把一切都判成「删除 + 新增」。
   */
  function createIdAllocator() {
    const used = new Set();
    return function take(preferred, prefix, name) {
      let id = preferred && !used.has(preferred) ? preferred : prefix + ':' + name;
      let n = 2;
      while (used.has(id)) id = prefix + ':' + name + '#' + (n++);
      used.add(id);
      return id;
    };
  }

  function normalizeItem(raw) {
    return {
      name: String(raw && raw.name != null ? raw.name : '').trim(),
      url: String(raw && raw.url != null ? raw.url : '').trim(),
      desc: String(raw && raw.desc != null ? raw.desc : '').trim()
    };
  }

  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const takeG = createIdAllocator();
    const takeC = createIdAllocator();

    let groups = [];

    if (Array.isArray(src.groups)) {
      // ---- v2 ----
      groups = src.groups.map((g, gi) => {
        const name = String(g.name || '').trim() || '分组 ' + (gi + 1);
        return {
          id: takeG(g.id, 'g', name),
          name: name,
          categories: (Array.isArray(g.categories) ? g.categories : []).map((c, ci) => {
            const cname = String(c.name || c.category || '').trim() || '分类 ' + (ci + 1);
            return {
              id: takeC(c.id, 'c', cname),
              name: cname,
              items: (Array.isArray(c.items) ? c.items : []).map(normalizeItem)
            };
          })
        };
      });
    } else {
      // ---- v1：顶层每个数组键就是一个分组 ----
      groups = Object.keys(src)
        .filter((k) => Array.isArray(src[k]))
        .map((k, gi) => ({
          id: takeG(k, 'g', k),
          name: V1_GROUP_NAMES[k] || '分组 ' + (gi + 1),
          categories: src[k].map((c, ci) => {
            const cname = String((c && (c.name || c.category)) || '').trim() || '分类 ' + (ci + 1);
            return {
              id: takeC(c && c.id, 'c', cname),
              name: cname,
              items: (Array.isArray(c && c.items) ? c.items : []).map(normalizeItem)
            };
          })
        }));
    }

    return {
      version: 2,
      title: String(src.title || "PasserJ's Nav").trim(),
      groups: groups
    };
  }

  /** 序列化为写入 data.json 的字符串（固定 2 空格缩进，便于 diff 与人工编辑） */
  function serialize(data) {
    return JSON.stringify(
      { version: 2, title: data.title, groups: data.groups },
      null,
      2
    ) + '\n';
  }

  /* ========================================================================
   * 4. 差异引擎
   * ------------------------------------------------------------------------
   * 目标：给出「人话版」的变更清单，且不误报。
   *
   * 两条关键设计：
   *   a) 只比较最终状态，不记录操作流水 —— 新增后删除、移动后移回，
   *      最终状态与基准一致，自然没有差异。
   *   b) 实体对齐用「多阶段匹配」而非纯 id：先按 id 精确匹配（可识别重命名），
   *      再按名称匹配剩余项（可识别 id 变化）。对齐完成后，用 LIS（最长递增
   *      子序列）求出「保持相对顺序的最大子集」，不在该子集里的才算被移动，
   *      这样能把移动报告压缩到最小集合，O(n log n)。
   * ====================================================================== */

  /**
   * 最长递增子序列：返回构成 LIS 的下标数组。
   * 经典 patience sorting + 二分，时间 O(n log n)，空间 O(n)。
   */
  function lisIndices(seq) {
    const n = seq.length;
    if (!n) return [];
    const prev = new Int32Array(n).fill(-1);
    const tails = []; // tails[k] = 长度 k+1 的递增子序列的末尾元素下标

    for (let i = 0; i < n; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }

    const out = new Array(tails.length);
    let k = tails[tails.length - 1];
    for (let i = tails.length - 1; i >= 0; i--) { out[i] = k; k = prev[k]; }
    return out;
  }

  /**
   * 两个列表的实体对齐。
   * 三个阶段，逐级放宽：
   *   1) 强键（唯一标识，如 id / 名称+链接）—— 精确命中
   *   2) 弱键（名称）—— 兜住 id 被重建的情况
   *   3) 备用键（如链接）—— 兜住"只改了名字、链接没变"的修改，
   *      否则这种改动会被误报成「删除 + 新增」
   * @param {Array} before 变更前
   * @param {Array} after  变更后
   * @param {Function} idOf   强键，无则返回 null
   * @param {Function} nameOf 弱键
   * @param {Function} altOf  备用键（可选）
   * @returns {{pairs:Array, moved:Set, removed:Array, added:Array}}
   */
  function align(before, after, idOf, nameOf, altOf) {
    const usedA = new Uint8Array(before.length);
    const usedB = new Uint8Array(after.length);
    const pairs = [];

    // 阶段一：强键精确匹配
    const byId = new Map();
    for (let j = 0; j < after.length; j++) {
      const k = idOf(after[j]);
      if (k != null && !byId.has(k)) byId.set(k, j);
    }
    for (let i = 0; i < before.length; i++) {
      const k = idOf(before[i]);
      if (k == null) continue;
      const j = byId.get(k);
      if (j != null && !usedB[j]) {
        usedA[i] = 1; usedB[j] = 1;
        pairs.push({ i: i, j: j });
      }
    }

    // 阶段二：弱键（名称）匹配，兜住 id 被重建的情况
    const byName = new Map();
    for (let j = 0; j < after.length; j++) {
      if (usedB[j]) continue;
      const n = nameOf(after[j]);
      if (!byName.has(n)) byName.set(n, j);
    }
    for (let i = 0; i < before.length; i++) {
      if (usedA[i]) continue;
      const j = byName.get(nameOf(before[i]));
      if (j != null && !usedB[j]) {
        usedA[i] = 1; usedB[j] = 1;
        pairs.push({ i: i, j: j });
      }
    }

    // 阶段三：备用键匹配（仅条目使用，键为链接）
    if (altOf) {
      const byAlt = new Map();
      for (let j = 0; j < after.length; j++) {
        if (usedB[j]) continue;
        const k = altOf(after[j]);
        if (k && !byAlt.has(k)) byAlt.set(k, j);
      }
      for (let i = 0; i < before.length; i++) {
        if (usedA[i]) continue;
        const k = altOf(before[i]);
        if (!k) continue;
        const j = byAlt.get(k);
        if (j != null && !usedB[j]) {
          usedA[i] = 1; usedB[j] = 1;
          pairs.push({ i: i, j: j });
        }
      }
    }

    pairs.sort((a, b) => a.i - b.i);

    // 用 LIS 标记「被移动」的项
    const keep = new Set(lisIndices(pairs.map((p) => p.j)).map((k) => pairs[k].i));
    const moved = new Set();
    for (let k = 0; k < pairs.length; k++) {
      if (!keep.has(pairs[k].i)) moved.add(pairs[k].i);
    }

    const removed = [];
    const added = [];
    for (let i = 0; i < before.length; i++) if (!usedA[i]) removed.push(i);
    for (let j = 0; j < after.length; j++) if (!usedB[j]) added.push(j);

    return { pairs: pairs, moved: moved, removed: removed, added: added };
  }

  /** 条目对齐用的强键：名称 + 链接 */
  const itemKey = (it) => it.name + '\u0000' + it.url;

  /** 比对「新增分类」的条目时用的空基线（只读，全局复用一份） */
  const EMPTY_CAT = { items: [] };

  /**
   * 计算两份数据的语义差异。
   * @returns {{changes: Array<{level,type,text}>, count: number}}
   */
  function diffData(before, after) {
    const changes = [];
    const push = (level, type, text) => changes.push({ level: level, type: type, text: text });

    // 全局分类归属索引：用于识别「分类跨分组移动」（否则会被报成删除 + 新增）
    const ownerBefore = new Map();
    before.groups.forEach((g) => g.categories.forEach((c) => ownerBefore.set(c.id, g.name)));
    const ownerAfter = new Map();
    after.groups.forEach((g) => g.categories.forEach((c) => ownerAfter.set(c.id, g.name)));

    // 分类对象索引（变更前）：分类被移组后，仍能拿它移动前的样子比对条目
    const catBefore = new Map();
    before.groups.forEach((g) => g.categories.forEach((c) => catBefore.set(c.id, c)));

    const G = align(before.groups, after.groups, (g) => g.id, (g) => g.name);

    G.removed.forEach((i) => {
      const g = before.groups[i];
      push('group', 'remove', '删除分组「' + g.name + '」（含 ' + g.categories.length + ' 个分类）');
    });
    G.added.forEach((j) => {
      const g = after.groups[j];
      push('group', 'add', '新增分组「' + g.name + '」');
      // 新增分组是「全新子树」，分类和条目同样要逐条记录。
      // 否则「建分组 → 建分类 → 加条目」在预览里只看得到第一层，后面的改动像丢了。
      g.categories.forEach((c) => {
        push('category', 'add', '「' + g.name + '」新增分类「' + c.name + '」');
        diffItems(EMPTY_CAT, c, g.name + ' / ' + c.name, push);
      });
    });

    G.pairs.forEach((p) => {
      const a = before.groups[p.i];
      const b = after.groups[p.j];
      if (a.name !== b.name) push('group', 'rename', '分组「' + a.name + '」重命名为「' + b.name + '」');
      if (G.moved.has(p.i)) push('group', 'move', '分组「' + b.name + '」调整了顺序');
      diffCategories(a, b, ownerBefore, ownerAfter, catBefore, push);
    });

    return { changes: changes, count: changes.length };
  }

  function diffCategories(ga, gb, ownerBefore, ownerAfter, catBefore, push) {
    const C = align(ga.categories, gb.categories, (c) => c.id, (c) => c.name);

    C.removed.forEach((i) => {
      const c = ga.categories[i];
      const target = ownerAfter.get(c.id);
      if (target && target !== gb.name) {
        // 分类还在，只是换了分组 —— 报「移动」而不是「删除 + 新增」
        push('category', 'move', '分类「' + c.name + '」从「' + ga.name + '」移动到「' + target + '」');
      } else {
        push('category', 'remove', '「' + ga.name + '」删除分类「' + c.name + '」（含 ' + c.items.length + ' 个条目）');
      }
    });

    C.added.forEach((j) => {
      const c = gb.categories[j];
      const from = ownerBefore.get(c.id);
      const ctx = gb.name + ' / ' + c.name;
      if (from && from !== ga.name) {
        // 已在「移动」中报告过分类本身；但移组之后可能又增删改了条目，
        // 用移动前的那份比一次，否则这些条目会从变更记录里消失
        const prev = catBefore.get(c.id);
        if (prev) diffItems(prev, c, ctx, push);
        return;
      }
      push('category', 'add', '「' + gb.name + '」新增分类「' + c.name + '」');
      // 新增分类里的条目必须逐条记录：新建分类 → 往里加条目，
      // 若只报「新增分类」，预览里看不到这些条目，用户会以为变更丢了
      diffItems(EMPTY_CAT, c, ctx, push);
    });

    C.pairs.forEach((p) => {
      const a = ga.categories[p.i];
      const b = gb.categories[p.j];
      if (a.name !== b.name) {
        push('category', 'rename', '「' + gb.name + '」分类「' + a.name + '」重命名为「' + b.name + '」');
      }
      if (C.moved.has(p.i)) push('category', 'move', '「' + gb.name + '」分类「' + b.name + '」调整了顺序');
      diffItems(a, b, gb.name + ' / ' + b.name, push);
    });
  }

  function diffItems(ca, cb, ctx, push) {
    // 强键：名称+链接；弱键：名称；备用键：链接（识别「只改名」）
    const I = align(ca.items, cb.items, itemKey, (it) => it.name, (it) => it.url);

    I.removed.forEach((i) => {
      push('item', 'remove', ctx + '：删除条目「' + ca.items[i].name + '」');
    });
    I.added.forEach((j) => {
      push('item', 'add', ctx + '：新增条目「' + cb.items[j].name + '」');
    });

    I.pairs.forEach((p) => {
      const a = ca.items[p.i];
      const b = cb.items[p.j];
      const parts = [];
      if (a.name !== b.name) parts.push('名称「' + a.name + '」→「' + b.name + '」');
      if (a.url !== b.url) parts.push('链接 ' + (a.url || '空') + ' → ' + (b.url || '空'));
      if (a.desc !== b.desc) parts.push('描述「' + (a.desc || '空') + '」→「' + (b.desc || '空') + '」');
      if (parts.length) push('item', 'update', ctx + '：修改「' + b.name + '」（' + parts.join('；') + '）');
      if (I.moved.has(p.i)) push('item', 'move', ctx + '：条目「' + b.name + '」调整了顺序');
    });
  }

  /* ========================================================================
   * 5. 渲染层
   * ====================================================================== */

  const TAB_ON = 'shrink-0 px-3 py-1.5 rounded-lg text-[13px] leading-5 font-semibold bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 shadow-sm transition-colors';
  const TAB_OFF = 'shrink-0 px-3 py-1.5 rounded-lg text-[13px] leading-5 font-medium bg-white text-gray-600 border border-gray-200/80 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors';

  function iconUrl(host) {
    return 'https://favicon.yandex.net/favicon/' + encodeURIComponent(host || 'example.com') + '?size=32';
  }

  /**
   * 单个条目卡片。
   * 阅读态渲染为 <a>，编辑态渲染为 <div>（内含删除按钮，避免交互元素嵌套）。
   * @param {object} it 条目
   * @param {object|null} ctx 编辑上下文 {gid, cid, idx}
   */
  function cardHTML(it, ctx) {
    const host = hostname(it.url);
    const name = it.name || host || '未命名';
    const initial = name.charAt(0).toUpperCase();
    const color = colorOf(name);
    const href = safeUrl(it.url);
    const editable = !!ctx;

    const tag = editable ? 'div' : 'a';
    const sorting = editable && state.sorting;

    // 排序模式：卡片本身是拖动单元，不响应点击/编辑
    const attrs = sorting
      ? 'data-drag="item" role="listitem"'
      : editable
        ? 'role="button" tabindex="0" data-act="item-edit" data-gid="' + esc(ctx.gid) + '" data-cid="' + esc(ctx.cid) + '" data-idx="' + ctx.idx + '"'
        : (href ? 'href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"' : 'role="button"');

    return '<' + tag + ' ' + attrs + ' class="group relative flex items-center gap-2.5 p-2.5 sm:p-3 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800/70 shadow-sm hover:shadow-md hover:border-blue-500/40 dark:hover:border-blue-500/40 transition-all duration-200 min-h-[3.5rem] h-full overflow-hidden cursor-pointer">' +
      '<div class="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-lg overflow-hidden relative bg-gray-100 dark:bg-gray-800 flex items-center justify-center">' +
        '<span class="absolute inset-0 flex items-center justify-center text-white text-xs font-bold select-none" style="background-color:' + color + '">' + esc(initial) + '</span>' +
        '<img src="' + esc(iconUrl(host)) + '" data-url="' + esc(it.url) + '" alt="" class="favicon-img relative z-10 w-full h-full object-contain p-1 bg-white dark:bg-gray-800" onload="__navImgLoad(this)" onerror="__navImgError(this)" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
      '</div>' +
      '<div class="min-w-0 flex-1' + (editable && !sorting ? ' pr-4' : '') + '">' +
        // 字号四级递减：分组 15px > 分类 13px > 条目 12.5px > 描述 10.5px
        // 管理态把条目压到最小一级，一眼就能分出层级；阅读态维持原样
        '<div class="' + (editable ? 'text-[12px] sm:text-[12.5px] font-medium' : 'text-[13px] sm:text-sm font-semibold') + ' text-gray-800 dark:text-gray-100 truncate leading-5">' + esc(name) + '</div>' +
        '<div class="' + (editable ? 'text-[10px] sm:text-[10.5px]' : 'text-[10px] sm:text-xs') + ' text-gray-400 dark:text-gray-500 truncate mt-0.5 leading-4">' + esc(it.desc || host) + '</div>' +
      '</div>' +
      (editable && !sorting
        ? '<button type="button" data-act="item-del" data-gid="' + esc(ctx.gid) + '" data-cid="' + esc(ctx.cid) + '" data-idx="' + ctx.idx + '" title="删除条目" aria-label="删除条目" class="absolute top-1 right-1 w-6 h-6 rounded-md bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-500 hover:border-red-300 text-[14px] leading-none flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity">×</button>'
        : '') +
      '</' + tag + '>';
  }

  /** 拖动排序模式下的六点手柄图标 */
  function gripHTML(cls) {
    return '<svg class="' + (cls || '') + '" width="9" height="13" viewBox="0 0 9 13" fill="currentColor" aria-hidden="true">' +
      '<circle cx="2.5" cy="2" r="1.15"/><circle cx="6.5" cy="2" r="1.15"/>' +
      '<circle cx="2.5" cy="6.5" r="1.15"/><circle cx="6.5" cy="6.5" r="1.15"/>' +
      '<circle cx="2.5" cy="11" r="1.15"/><circle cx="6.5" cy="11" r="1.15"/>' +
      '</svg>';
  }

  /** 阅读态：一个分组 = 分组名 + 横向标签栏 + 当前分类的卡片网格 */
  function groupViewHTML(g) {
    const cats = g.categories;
    if (!cats.length) return '';

    let active = state.active[g.id] || 0;
    if (active < 0 || active >= cats.length) active = 0;
    state.active[g.id] = active;

    const tabs = cats.map((c, i) =>
      '<button type="button" data-act="tab" data-gid="' + esc(g.id) + '" data-idx="' + i + '" class="' + (i === active ? TAB_ON : TAB_OFF) + '">' + esc(c.name) + '</button>'
    ).join('');

    const panes = cats.map((c, i) =>
      '<div data-pane data-gid="' + esc(g.id) + '" data-idx="' + i + '" class="' + (i === active ? 'grid' : 'hidden') + ' grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3.5">' +
        c.items.map((it) => cardHTML(it, null)).join('') +
      '</div>'
    ).join('');

    return '<section class="fade-in mb-6 sm:mb-8">' +
      '<div class="flex items-center gap-2 px-0.5 mb-2.5">' +
        '<h2 class="text-[11px] font-semibold tracking-wider text-gray-400 dark:text-gray-500 uppercase shrink-0">' + esc(g.name) + '</h2>' +
        '<div class="flex-1 h-px bg-gray-200/70 dark:bg-gray-800/70"></div>' +
      '</div>' +
      '<nav class="scroll-container flex gap-1.5 sm:gap-2 overflow-x-auto pb-2">' + tabs + '</nav>' +
      '<div class="mt-1.5">' + panes + '</div>' +
    '</section>';
  }

  /* ---------- 折叠状态（仅编辑态生效） ----------
   * 折叠纯粹是「显示状态」：不写入数据、不参与差异比较，
   * 所以随便折来折去都不会产生「N 处修改」。
   * 用 Set 存 id，重绘 / 切换模式后依然保持；同时落 localStorage，刷新后还在。
   */

  function loadCollapsed() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.collapsed) || '{}');
      return {
        groups: new Set(Array.isArray(raw.g) ? raw.g : []),
        cats: new Set(Array.isArray(raw.c) ? raw.c : [])
      };
    } catch (e) {
      return { groups: new Set(), cats: new Set() }; // 隐私模式 / 脏数据：退化成全展开
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(LS.collapsed, JSON.stringify({
        g: Array.from(state.collapsed.groups),
        c: Array.from(state.collapsed.cats)
      }));
    } catch (e) { /* 写不了就算了，不影响功能 */ }
  }

  const collapsedSet = (kind) => (kind === 'g' ? state.collapsed.groups : state.collapsed.cats);
  const isCollapsed = (kind, id) => collapsedSet(kind).has(id);

  /** 展开某一项（新增 / 移入后调用，保证结果可见） */
  function expandOne(kind, id) {
    if (collapsedSet(kind).delete(id)) saveCollapsed();
  }

  /** 丢弃已不存在的 id，避免 localStorage 里堆积僵尸条目 */
  function forgetCollapsed(kind, id) {
    if (collapsedSet(kind).delete(id)) saveCollapsed();
  }

  /**
   * 折叠 / 展开切换。
   * 只改目标区块上的一个 class，不整页重绘 —— 这样滚动位置、已加载的图标、
   * 以及可能存在的拖动会话都不受影响，切换手感是瞬时的。
   */
  function toggleCollapse(kind, id, btn) {
    const set = collapsedSet(kind);
    const next = !set.has(id);
    if (next) set.add(id); else set.delete(id);
    saveCollapsed();

    const box = kind === 'g' ? btn.closest('section[data-gid]') : btn.closest('[data-cat]');
    if (box) box.classList.toggle('is-collapsed', next);
    btn.setAttribute('aria-expanded', next ? 'false' : 'true');
  }

  /** 折叠箭头：旋转交给 CSS（.is-collapsed），JS 不碰 transform */
  function chevHTML() {
    return '<svg class="chev shrink-0" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
      '<path d="M2.5 4.25L6 7.75L9.5 4.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /** 编辑态：分组内所有分类全部展开，每个层级都带操作按钮 */
  function groupEditHTML(g, gi) {
    const gid = esc(g.id);
    const sorting = state.sorting;
    // 排序模式必须全部展开：折叠会让被隐藏元素的几何全是 0，拖动定位会失效
    const folded = !sorting && isCollapsed('g', g.id);

    const itemCount = g.categories.reduce((s, c) => s + c.items.length, 0);

    const catsHTML = g.categories.length
      ? g.categories.map((c, ci) => categoryEditHTML(g, c, ci)).join('')
      : '<div class="text-[12px] text-gray-400 dark:text-gray-500 px-1 py-2">该分组暂无分类</div>';

    // 排序模式：标题栏变成拖动手柄，隐藏全部编辑按钮
    const head = sorting
      ? '<div data-drag-handle class="flex items-center gap-1.5 px-1.5 py-1.5 mb-1 rounded-md text-gray-400 dark:text-gray-500">' +
          gripHTML('shrink-0 text-gray-300 dark:text-gray-600') +
          '<span class="text-[13px] font-bold text-gray-700 dark:text-gray-200 truncate">' + esc(g.name) + '</span>' +
          '<span class="shrink-0 text-[11px] ml-0.5">' + g.categories.length + ' 分类</span>' +
          '<div class="flex-1 h-px bg-gray-200 dark:bg-gray-800 mx-1.5"></div>' +
        '</div>'
      : '<div class="flex items-center gap-1 px-0.5 mb-2">' +
          // 分隔线放进按钮内部：整行（除右侧按钮）都是折叠热区，不会出现「点空白没反应」
          '<button type="button" data-act="group-toggle" data-gid="' + gid + '"' +
            ' aria-expanded="' + (folded ? 'false' : 'true') + '" title="折叠 / 展开分组" class="edit-toggle">' +
            chevHTML() +
            '<span class="text-[15px] font-bold text-gray-700 dark:text-gray-200 truncate">' + esc(g.name) + '</span>' +
            '<span class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500 ml-0.5">' + g.categories.length + ' 分类</span>' +
            '<span data-collapse-only class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">· ' + itemCount + ' 条目</span>' +
            '<span class="flex-1 h-px bg-gray-200 dark:bg-gray-800 mx-1.5"></span>' +
          '</button>' +
          '<button type="button" data-act="group-rename" data-gid="' + gid + '" class="ebtn" title="重命名分组">改名</button>' +
          '<button type="button" data-act="group-del" data-gid="' + gid + '" class="ebtn ebtn-danger" title="删除分组">删除</button>' +
        '</div>';

    return '<section data-gid="' + gid + '" class="fade-in mb-5' + (folded ? ' is-collapsed' : '') + '"' +
        (sorting ? ' data-drag="group"' : '') + '>' +
      head +
      '<div data-cat-list data-collapse-body class="rounded-xl border border-gray-200/80 dark:border-gray-800 bg-white/70 dark:bg-gray-900/40 p-2 sm:p-2.5 space-y-2.5">' +
        catsHTML +
        (sorting ? '' :
          '<button type="button" data-act="cat-add" data-gid="' + gid + '" class="w-full h-8 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 text-[12.5px] text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">+ 新增分类</button>') +
      '</div>' +
    '</section>';
  }

  function categoryEditHTML(g, c, ci) {
    const gid = esc(g.id);
    const cid = esc(c.id);
    const sorting = state.sorting;
    const folded = !sorting && isCollapsed('c', c.id);

    const cards = c.items.map((it, ii) => cardHTML(it, { gid: g.id, cid: c.id, idx: ii })).join('');

    // 「分组」选择器：直接列出其它分组，选中即把本分类移过去
    const groupOptions = state.data.groups.map((x) =>
      '<option value="' + esc(x.id) + '"' + (x.id === g.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'
    ).join('');

    // 排序模式：标题栏变成拖动手柄，隐藏选择器/编辑/删除/新增
    const head = sorting
      ? '<div data-drag-handle class="flex items-center gap-1.5 mb-1.5 px-1 py-1 rounded-md text-gray-400 dark:text-gray-500">' +
          gripHTML('shrink-0 text-gray-300 dark:text-gray-600') +
          '<span class="text-[12.5px] font-semibold text-gray-700 dark:text-gray-200 truncate">' + esc(c.name) + '</span>' +
          '<span class="shrink-0 text-[11px] ml-0.5">' + c.items.length + '</span>' +
          '<div class="flex-1"></div>' +
        '</div>'
      : '<div class="flex items-center gap-1 mb-1.5">' +
          '<button type="button" data-act="cat-toggle" data-cid="' + cid + '"' +
            ' aria-expanded="' + (folded ? 'false' : 'true') + '" title="折叠 / 展开分类" class="edit-toggle">' +
            chevHTML() +
            '<span class="text-[13px] font-semibold text-gray-700 dark:text-gray-200 truncate">' + esc(c.name) + '</span>' +
            '<span class="shrink-0 text-[10.5px] text-gray-400 dark:text-gray-500 ml-0.5">' + c.items.length + '</span>' +
          '</button>' +
          '<select data-act="cat-group" data-gid="' + gid + '" data-cid="' + cid + '"' +
            (state.data.groups.length < 2 ? ' disabled' : '') +
            ' class="cat-group-sel" title="移动到其它分组" aria-label="移动到其它分组">' + groupOptions + '</select>' +
          '<button type="button" data-act="cat-edit" data-gid="' + gid + '" data-cid="' + cid + '" class="ebtn" title="编辑分类（名称）">改名</button>' +
          '<button type="button" data-act="cat-del" data-gid="' + gid + '" data-cid="' + cid + '" class="ebtn ebtn-danger" title="删除分类">删除</button>' +
        '</div>';

    return '<div data-cat="' + cid + '"' + (sorting ? ' data-drag="cat"' : '') +
      ' class="rounded-lg bg-gray-100/70 dark:bg-gray-800/50 border border-gray-200/60 dark:border-gray-700/50 p-2 sm:p-2.5' +
      (folded ? ' is-collapsed' : '') + '">' +
      head +
      '<div data-item-grid data-collapse-body class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 sm:gap-3">' +
        cards +
        (sorting ? '' :
          '<button type="button" data-act="item-add" data-gid="' + gid + '" data-cid="' + cid + '" class="min-h-[3.5rem] rounded-xl border border-dashed border-gray-300 dark:border-gray-700 text-[12.5px] text-gray-400 dark:text-gray-500 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex items-center justify-center">+ 条目</button>') +
      '</div>' +
    '</div>';
  }

  function emptyHTML() {
    return '<div class="text-center py-16 text-gray-400 dark:text-gray-500 text-sm fade-in">' +
      (state.editing ? '还没有任何分组，点击下方按钮开始添加' : '暂无数据') +
      '</div>';
  }

  function render() {
    if (!state.data) return;

    const searching = !!state.search;
    $('#listView').hidden = searching;
    $('#searchView').hidden = !searching;

    // 排序模式用 body 上的类驱动 CSS（手型、hover 高亮、禁用选择）
    document.body.classList.toggle('sort-mode', !!(state.editing && state.sorting));

    if (searching) {
      renderSearch();
    } else {
      const groups = state.data.groups;
      const html = groups.map((g, gi) => (state.editing ? groupEditHTML(g, gi) : groupViewHTML(g))).join('');

      let extra = '';
      if (state.editing && !state.sorting) {
        extra = '<button type="button" data-act="group-add" class="w-full h-10 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 text-[13px] text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">+ 新增分组</button>';
      }

      $('#listView').innerHTML = (html || (state.editing ? '' : emptyHTML())) + extra;
    }

    renderToolbar();
    syncTitle();
  }

  function syncTitle() {
    const t = (state.data && state.data.title) || "PasserJ's Nav";
    $('#siteTitle').textContent = t;
    document.title = '个人导航 | ' + t;
  }

  /** 搜索结果：跨分组、跨分类的扁平化匹配 */
  function renderSearch() {
    const kw = state.search.toLowerCase();
    const groups = [];

    state.data.groups.forEach((g) => {
      g.categories.forEach((c) => {
        const hits = c.items.filter((it) =>
          (it.name + ' ' + it.desc + ' ' + it.url).toLowerCase().indexOf(kw) !== -1
        );
        if (hits.length) groups.push({ title: g.name + ' / ' + c.name, items: hits });
      });
    });

    if (!groups.length) {
      $('#searchView').innerHTML = '<div class="text-center py-20 text-gray-400 dark:text-gray-500 fade-in">' +
        '<div class="text-sm">未找到「' + esc(state.search) + '」</div>' +
        '<div class="text-[11px] mt-1.5 opacity-70">按 Enter 用 Google 搜索</div></div>';
      return;
    }

    $('#searchView').innerHTML = groups.map((g) =>
      '<div class="fade-in mb-6">' +
        '<h3 class="text-[11px] font-semibold tracking-wider text-gray-400 dark:text-gray-500 uppercase mb-2 px-0.5">' + esc(g.title) + '</h3>' +
        '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3.5">' +
          g.items.map((it) => cardHTML(it, null)).join('') +
        '</div>' +
      '</div>'
    ).join('');
  }

  function renderToolbar() {
    const tb = $('#toolbar');
    tb.hidden = !state.editing;
    if (!state.editing) return;

    const sorting = state.sorting;
    const n = state.diff.count;

    // 排序模式下额外提示操作方式，但变更数始终可见（拖完能立刻看到有没有变化）
    const countHTML = n
      ? '<span data-count="' + n + '" class="text-amber-600 dark:text-amber-400 font-semibold">' + n + ' 处修改</span>'
      : '<span data-count="0" class="text-gray-400 dark:text-gray-500">无修改</span>';

    $('#diffBadge').innerHTML = sorting
      ? '<span class="text-blue-600 dark:text-blue-400 font-medium">拖动调整顺序</span>' +
        '<span class="mx-1.5 text-gray-300 dark:text-gray-600">·</span>' + countHTML
      : countHTML;

    const sortBtn = $('[data-tb="sort"]');
    sortBtn.textContent = sorting ? '完成' : '排序';
    sortBtn.classList.toggle('tb-btn-primary', sorting);
    sortBtn.title = sorting ? '退出排序模式' : '进入拖动排序模式';

    // 排序进行中禁用其余操作，避免误触打断拖动
    ['preview', 'import', 'export', 'restore', 'push', 'exit'].forEach((k) => {
      const btn = $('[data-tb="' + k + '"]');
      if (btn) btn.disabled = sorting;
    });

    if (sorting) return;

    const pushBtn = $('[data-tb="push"]');
    pushBtn.disabled = n === 0;
    pushBtn.title = n === 0 ? '没有需要提交的修改' : '通过 GitHub Token 推送到线上';
  }

  /** 排序模式开关：与增删改完全独立，进出都不改数据 */
  function toggleSort() {
    if (!state.editing) return;
    if (dnd) finishDrag(false); // 有未收尾的会话先结束，避免引用已重绘的节点

    if (!state.sorting) {
      // 搜索态下没有可拖的元素，先退出搜索
      if (state.search) {
        state.search = '';
        $('#searchInput').value = '';
      }
      state.sorting = true;
      render();
      toast('拖动分组标题 / 分类标题 / 卡片即可排序', 'success');
    } else {
      state.sorting = false;
      render();
      // 只说「完成」：数据已写入工作副本，是否上线由「推送」决定
      toast(state.diff.count ? '排序完成，可预览变更后推送' : '排序完成，无变更', 'success');
    }
  }

  /* ========================================================================
   * 6. 拖动排序引擎
   * ------------------------------------------------------------------------
   * 只在「排序模式」下启用，与增删改完全独立：进入排序后所有编辑按钮消失，
   * 退出时统一提交一次数据变更（差异引擎照常工作）。
   *
   * 三个性能关键点：
   *   1) 读写分离 —— pointermove 里只记录坐标，几何读取与 transform 写入
   *      合并到 requestAnimationFrame，一帧最多一次布局计算。
   *   2) 缓存几何 + 二分定位 —— 拖动开始时缓存各项中心点，之后每帧只做
   *      O(log n) 比较（网格按「行 → 列」两级二分），不重复读 DOM。
   *   3) FLIP 让位 —— 索引变化时才移动 DOM 节点，随后用 transform 反向补偿
   *      再过渡回 0，动画只发生在合成层，不触发重排。
   *
   * DOM 约定：
   *   [data-drag]         拖动单元（group / cat / item）
   *   [data-drag-handle]  触发区（标题栏）；条目卡片没有手柄，整卡即触发区
   * ====================================================================== */

  let dnd = null;          // 当前拖动会话
  const DRAG_THRESHOLD = 4; // 激活阈值（px），避免点击被误判成拖动

  /** 找出拖动单元所属的容器与同级项 */
  function dragContext(unit, kind) {
    if (kind === 'group') {
      return { container: $('#listView'), items: $$('#listView > section[data-drag="group"]'), axis: 'y' };
    }
    if (kind === 'cat') {
      const container = unit.closest('[data-cat-list]');
      if (!container) return null;
      return { container: container, items: $$(':scope > [data-drag="cat"]', container), axis: 'y' };
    }
    if (kind === 'item') {
      const container = unit.closest('[data-item-grid]');
      if (!container) return null;
      return { container: container, items: $$(':scope > [data-drag="item"]', container), axis: 'grid' };
    }
    return null;
  }

  /**
   * 缓存「槽位」几何。
   *
   * 关键设计：占位元素（opacity:0）仍然占着一个布局槽位，所以拖动过程中
   * 容器的槽位布局是**不变**的 —— 变的只是哪个元素坐在哪个槽位上。
   * 因此只需在激活时量一次，之后每帧只做二分比较，完全不读 DOM。
   *
   * 槽位 i = 拖动开始时第 i 个元素占据的视觉位置，坐标统一取「容器局部坐标」。
   * 这样「指针落在槽位 j」就直接等价于「目标下标 = j」，不存在
   * 「量一次 → 移动 DOM → 再量」的自我反馈漂移。
   *
   * 定位用「右下边界」而不是「中心点」：指针压在某张卡片上就命中那张卡片，
   * 不会被中心点判到隔壁去（否则按下瞬间就会莫名跳一格）。
   */
  function measureDrag() {
    const d = dnd;
    if (!d) return;

    const cRect = d.container.getBoundingClientRect();
    // 激活瞬间没有任何 FLIP transform，此时的 rect 就是纯布局位置
    d.slots = d.items.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        t: r.top - cRect.top,
        b: r.bottom - cRect.top,
        r: r.right - cRect.left,
        cx: r.left - cRect.left + r.width / 2,
        cy: r.top - cRect.top + r.height / 2
      };
    });

    // others 的顺序在整个拖动过程中不会变，算一次即可
    d.others = d.items.filter((el) => el !== d.unit);

    if (d.axis === 'y') {
      d.edges = d.slots.map((s) => s.b); // 纵向：各槽位底边
      return;
    }

    // 网格：按中心 y 分行，行内记录各槽位右边界（用于两级二分）
    const rows = [];
    d.slots.forEach((s, i) => {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.cy - s.cy) <= 8) {
        last.idx.push(i);
        last.rights.push(s.r);
        if (s.b > last.b) last.b = s.b;
      } else {
        rows.push({ cy: s.cy, b: s.b, idx: [i], rights: [s.r] });
      }
    });
    d.rows = rows;
  }

  /** 纵向插入位置：二分找第一个「底边大于指针」的槽位，O(log n) */
  function locateY(edges, y) {
    let lo = 0, hi = edges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] < y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** 网格插入位置：先按 y 二分找行，再在行内按 x 二分找列，O(log n) */
  function locateGrid(rows, x, y) {
    if (!rows.length) return 0;

    // 行：第一个「底边 > y」的行；超出最后一行时归到最后一行
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].b < y) lo = mid + 1; else hi = mid;
    }
    const row = rows[Math.min(lo, rows.length - 1)];

    // 列：行内第一个「右边界 > x」的槽位
    let a = 0, b = row.rights.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (row.rights[mid] < x) a = mid + 1; else b = mid;
    }

    // 落在该行最后一个槽位右侧 → 插到它后面（即下一个槽位）
    return a < row.idx.length ? row.idx[a] : row.idx[row.idx.length - 1] + 1;
  }

  /** 创建跟随指针的克隆体，原元素留作透明占位 */
  function activateDrag() {
    const d = dnd;
    const rect = d.unit.getBoundingClientRect();

    d.active = true;
    d.offsetX = d.lastX - rect.left;
    d.offsetY = d.lastY - rect.top;

    const ghost = d.unit.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('drag-placeholder');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    d.ghost = ghost;

    d.unit.classList.add('drag-placeholder');
    document.body.classList.add('is-dragging');
    // 拖动会移动整块 DOM（分组区块可达上千像素），浏览器的滚动锚定会把视口
    // 拽到别处；拖动期间关掉它，让「自动滚动」成为唯一控制者
    document.documentElement.style.overflowAnchor = 'none';

    measureDrag();
    moveGhost(d.lastX, d.lastY);
  }

  function moveGhost(x, y) {
    const d = dnd;
    if (!d || !d.ghost) return;
    d.ghost.style.transform = 'translate3d(' + (x - d.offsetX) + 'px,' + (y - d.offsetY) + 'px,0)';
  }

  /**
   * 把占位元素移动到 target 位置，并用 FLIP 让其它元素平滑让位。
   * 只改 transform，不触发重排（除了必要的 DOM 移动）。
   */
  function applyDragIndex(target) {
    const d = dnd;
    if (!d || target === d.targetIndex) return;
    d.targetIndex = target;

    const before = new Map();
    d.items.forEach((el) => before.set(el, el.getBoundingClientRect()));

    const ref = target < d.others.length ? d.others[target] : null;
    if (ref) d.container.insertBefore(d.unit, ref);
    else d.container.appendChild(d.unit);

    // 同步内存顺序，保持与 DOM 一致
    const from = d.items.indexOf(d.unit);
    d.items.splice(from, 1);
    d.items.splice(target, 0, d.unit);

    // FLIP：先反向补偿到旧位置，再过渡回 0
    const moved = [];
    d.items.forEach((el) => {
      if (el === d.unit) return;
      const b = before.get(el);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.style.transition = 'none';
        el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
        moved.push(el);
      }
    });

    if (moved.length) {
      void d.container.offsetHeight; // 一次性强制回流，避免逐个读触发多次布局
      moved.forEach((el) => {
        el.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
        el.style.transform = '';
      });
    }
    // 槽位表是静态的，DOM 移动后无需重新测量 —— 这正是不会「越拖越偏」的原因
  }

  /** 每帧：更新克隆体位置 + 重新定位插入点 */
  function dragFrame() {
    const d = dnd;
    if (!d) return;
    d.rafId = 0;
    if (!d.active) return;

    const x = d.lastX, y = d.lastY;
    moveGhost(x, y);

    // 容器 rect 每帧读一次：滚轮滚动 / 自动滚动都能立刻跟上（单次 rect 读取开销极小）
    // 槽位坐标是「容器局部」的，所以页面滚动不会让缓存失效
    const cRect = d.container.getBoundingClientRect();
    const localX = x - cRect.left;
    const localY = y - cRect.top;

    let target = d.axis === 'y'
      ? locateY(d.edges, localY)
      : locateGrid(d.rows, localX, localY);

    // 目标下标的合法区间是 [0, others.length]（= others.length 表示追加到末尾）
    if (target > d.others.length) target = d.others.length;
    if (target < 0) target = 0;

    if (target !== d.targetIndex) applyDragIndex(target);

    // 边缘自动滚动：分组区块常有上千像素高，指针到视口边缘就带着页面滚
    // （移动端 touch-action:none 禁掉了原生滚动，这一步是必需的）
    const vy = autoScrollSpeed(y);
    if (vy) {
      window.scrollBy(0, vy);
      d.rafId = requestAnimationFrame(dragFrame); // 指针不动也要继续滚
    }
  }

  /** 指针贴近视口上下边缘时的滚动速度（px/帧），中间区域返回 0 */
  function autoScrollSpeed(y) {
    const EDGE = 80, MAX = 20;
    if (y < EDGE) {
      const t = (EDGE - y) / EDGE;          // 0 → 1，越靠边越快
      return -Math.max(2, Math.round(t * t * MAX));
    }
    const h = window.innerHeight;
    if (y > h - EDGE) {
      const t = (y - (h - EDGE)) / EDGE;
      return Math.max(2, Math.round(Math.min(t, 1.4) * t * MAX));
    }
    return 0;
  }

  function onDragMove(e) {
    const d = dnd;
    if (!d || e.pointerId !== d.pointerId) return;

    d.lastX = e.clientX;
    d.lastY = e.clientY;

    if (!d.active) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      activateDrag();
    }

    e.preventDefault(); // 阻止触摸滚动 / 文本选择
    if (!d.rafId) d.rafId = requestAnimationFrame(dragFrame);
  }

  function onDragUp(e) {
    const d = dnd;
    if (!d || (e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
    finishDrag(d.active);
  }

  /** 窗口失焦（切标签页 / 切应用）时指针事件会断流，必须主动收尾，否则会话卡住 */
  function onDragBlur() {
    if (dnd) finishDrag(dnd.active);
  }

  /**
   * 结束拖动。
   * @param {boolean} commitMove 是否把新顺序写回数据（未激活的点击不写）
   */
  function finishDrag(commitMove) {
    const d = dnd;
    if (!d) return;
    dnd = null;

    if (d.rafId) cancelAnimationFrame(d.rafId);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragUp);
    window.removeEventListener('blur', onDragBlur);

    if (d.ghost) d.ghost.remove();
    d.unit.classList.remove('drag-placeholder');
    d.items.forEach((el) => {
      el.style.transition = '';
      el.style.transform = '';
    });
    document.body.classList.remove('is-dragging');
    document.documentElement.style.overflowAnchor = '';

    if (!commitMove) return;

    const from = d.startIndex;
    const to = d.items.indexOf(d.unit);
    if (from === to) return;

    // 写回数据：只改数组顺序，差异引擎会算出「排序变化」
    if (d.kind === 'group') {
      arrayMove(state.data.groups, from, to);
    } else if (d.kind === 'cat') {
      const section = d.unit.closest('section[data-gid]');
      const g = section && findGroup(section.dataset.gid);
      if (g) arrayMove(g.categories, from, to);
    } else {
      const catEl = d.unit.closest('[data-cat]');
      const section = d.unit.closest('section[data-gid]');
      const c = catEl && section ? findCategory(section.dataset.gid, catEl.dataset.cat) : null;
      if (c) arrayMove(c.items, from, to);
    }

    commit(() => {}); // 数据已改，这里只负责重算差异 + 重绘
  }

  /** 按下：只登记会话，真正激活要等移动超过阈值 */
  function onDragDown(e) {
    if (!state.editing || !state.sorting || dnd) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const trigger = e.target.closest('[data-drag-handle]') || e.target.closest('[data-drag="item"]');
    if (!trigger) return;

    const unit = trigger.closest('[data-drag]');
    if (!unit) return;

    const ctx = dragContext(unit, unit.dataset.drag);
    if (!ctx || ctx.items.length < 2) return;

    dnd = {
      kind: unit.dataset.drag,
      unit: unit,
      container: ctx.container,
      items: ctx.items,
      axis: ctx.axis,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      startIndex: ctx.items.indexOf(unit),
      targetIndex: ctx.items.indexOf(unit),
      active: false,
      ghost: null,
      rafId: 0,
      others: [],
      slots: [],
      edges: [],
      rows: []
    };

    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragUp);
    window.addEventListener('blur', onDragBlur);
  }

  /* ========================================================================
   * 7. 编辑操作
   * ====================================================================== */

  const findGroup = (gid) => state.data.groups.find((g) => g.id === gid);
  const findCategory = (gid, cid) => {
    const g = findGroup(gid);
    return g ? g.categories.find((c) => c.id === cid) : null;
  };

  /** 所有写操作的唯一入口：改数据 → 重算差异 → 重绘 */
  function commit(mutator) {
    mutator();
    recompute();
    render();
  }

  function recompute() {
    try {
      state.diff = diffData(state.baseline, state.data);
    } catch (e) {
      console.error('[nav] 差异计算失败', e);
      state.diff = { changes: [], count: 0 };
    }
  }

  /** 生成一个不重复的本地 id */
  function newId(prefix, exists) {
    let id;
    do { id = prefix + ':' + Math.random().toString(36).slice(2, 8); } while (exists(id));
    return id;
  }

  const groupIdExists = (id) => state.data.groups.some((g) => g.id === id);
  const catIdExists = (id) => state.data.groups.some((g) => g.categories.some((c) => c.id === id));

  /* ---------- 分组 ---------- */

  function addGroup() {
    openModal({
      title: '新增分组',
      fields: [{ name: 'name', label: '分组名称', value: '', placeholder: '例如：工具' }],
      onOk: (v) => {
        const name = v.name.trim();
        if (!name) { toast('分组名称不能为空', 'error'); return false; }
        commit(() => {
          state.data.groups.push({ id: newId('g', groupIdExists), name: name, categories: [] });
        });
        toast('已新增分组「' + name + '」', 'success');
      }
    });
  }

  function renameGroup(gid) {
    const g = findGroup(gid);
    if (!g) return;
    openModal({
      title: '重命名分组',
      fields: [{ name: 'name', label: '分组名称', value: g.name }],
      onOk: (v) => {
        const name = v.name.trim();
        if (!name) { toast('分组名称不能为空', 'error'); return false; }
        commit(() => { g.name = name; });
      }
    });
  }

  function deleteGroup(gid) {
    const g = findGroup(gid);
    if (!g) return;
    openModal({
      title: '删除分组',
      desc: '将删除「' + g.name + '」及其下 ' + g.categories.length + ' 个分类、' +
        g.categories.reduce((s, c) => s + c.items.length, 0) + ' 个条目。此操作在推送前仅影响本地副本。',
      danger: true,
      okText: '确认删除',
      onOk: () => {
        commit(() => {
          state.data.groups = state.data.groups.filter((x) => x.id !== gid);
          forgetCollapsed('g', gid);
        });
      }
    });
  }

  /* ---------- 分类 ---------- */

  function addCategory(gid) {
    const g = findGroup(gid);
    if (!g) return;
    openModal({
      title: '新增分类',
      desc: '将添加到分组「' + g.name + '」',
      fields: [{ name: 'name', label: '分类名称', value: '', placeholder: '例如：常用工具' }],
      onOk: (v) => {
        const name = v.name.trim();
        if (!name) { toast('分类名称不能为空', 'error'); return false; }
        commit(() => {
          expandOne('g', gid); // 折叠状态下新增，结果要能看见
          g.categories.push({ id: newId('c', catIdExists), name: name, items: [] });
        });
      }
    });
  }

  /**
   * 编辑分类：只负责重命名。
   * 排序已独立到「排序」模式（拖动），这里不再混入排序选项。
   */
  function editCategory(gid, cid) {
    const g = findGroup(gid);
    const c = findCategory(gid, cid);
    if (!g || !c) return;

    const idx = g.categories.findIndex((x) => x.id === cid);

    openModal({
      title: '重命名分类',
      desc: '所在分组：' + g.name + '（第 ' + (idx + 1) + ' 个，共 ' + g.categories.length + ' 个）',
      fields: [{ name: 'name', label: '分类名称', value: c.name }],
      onOk: (v) => {
        const name = v.name.trim();
        if (!name) { toast('分类名称不能为空', 'error'); return false; }
        commit(() => { c.name = name; });
      }
    });
  }

  function deleteCategory(gid, cid) {
    const g = findGroup(gid);
    const c = findCategory(gid, cid);
    if (!g || !c) return;
    openModal({
      title: '删除分类',
      desc: '将删除「' + g.name + ' / ' + c.name + '」及其下 ' + c.items.length + ' 个条目。',
      danger: true,
      okText: '确认删除',
      onOk: () => {
        commit(() => {
          g.categories = g.categories.filter((x) => x.id !== cid);
          originPos.delete(cid);
          forgetCollapsed('c', cid);
        });
      }
    });
  }

  /**
   * 分类被移出时的原始位置。
   * 用途：用户把分类挪到别的分组、再挪回来时，自动插回原来的位置，
   * 这样「移走又移回」在差异比较里就是 0 处变更（符合直觉）。
   * 该表只存在于内存，不参与数据序列化。
   */
  const originPos = new Map(); // cid -> { gid, index }

  /**
   * 把分类移动到指定分组（标签栏的下拉选择器直接调用，无需二次确认）。
   * @returns {boolean} 是否发生了移动
   */
  function doMoveCategory(gid, cid, targetGid) {
    const g = findGroup(gid);
    const c = findCategory(gid, cid);
    const target = findGroup(targetGid);
    if (!g || !c || !target || target.id === g.id) return false;

    commit(() => {
      expandOne('g', target.id); // 移入的分组若折叠着，先展开，否则用户会以为分类丢了
      expandOne('c', cid);
      const fromIdx = g.categories.findIndex((x) => x.id === cid);
      if (!originPos.has(cid)) originPos.set(cid, { gid: gid, index: fromIdx });

      g.categories = g.categories.filter((x) => x.id !== cid);

      const home = originPos.get(cid);
      if (home && home.gid === target.id) {
        // 回到原分组：插回原索引，实现「移走又移回 = 无变更」
        target.categories.splice(Math.min(home.index, target.categories.length), 0, c);
        originPos.delete(cid);
      } else {
        target.categories.push(c);
      }
    });

    return true;
  }

  /* ---------- 条目 ---------- */

  function addItem(gid, cid) {
    const c = findCategory(gid, cid);
    if (!c) return;
    openModal({
      title: '新增条目',
      fields: [
        { name: 'name', label: '名称', value: '', placeholder: '显示名称' },
        { name: 'url', label: '链接', value: '', placeholder: 'https://' },
        { name: 'desc', label: '描述（可选）', value: '', placeholder: '一句话说明' }
      ],
      onOk: (v) => {
        const name = v.name.trim();
        const url = v.url.trim();
        if (!name) { toast('名称不能为空', 'error'); return false; }
        if (!safeUrl(url)) { toast('链接需以 http(s):// 开头', 'error'); return false; }
        commit(() => {
          expandOne('g', gid);  // 折叠状态下新增，结果要能看见
          expandOne('c', cid);
          c.items.push({ name: name, url: url, desc: v.desc.trim() });
        });
      }
    });
  }

  function editItem(gid, cid, idx) {
    const c = findCategory(gid, cid);
    if (!c || !c.items[idx]) return;
    const it = c.items[idx];
    const g = findGroup(gid);

    openModal({
      title: '编辑条目',
      desc: '所在位置：' + (g ? g.name : '') + ' / ' + c.name + '（第 ' + (idx + 1) + ' 个，共 ' + c.items.length + ' 个）',
      fields: [
        { name: 'name', label: '名称', value: it.name },
        { name: 'url', label: '链接', value: it.url },
        { name: 'desc', label: '描述（可选）', value: it.desc }
      ],
      onOk: (v) => {
        const name = v.name.trim();
        const url = v.url.trim();
        if (!name) { toast('名称不能为空', 'error'); return false; }
        if (!safeUrl(url)) { toast('链接需以 http(s):// 开头', 'error'); return false; }
        commit(() => {
          it.name = name;
          it.url = url;
          it.desc = v.desc.trim();
        });
      }
    });
  }

  function deleteItem(gid, cid, idx) {
    const c = findCategory(gid, cid);
    if (!c || !c.items[idx]) return;
    const it = c.items[idx];
    openModal({
      title: '删除条目',
      desc: '确认删除「' + it.name + '」？',
      danger: true,
      okText: '删除',
      onOk: () => {
        commit(() => { c.items.splice(idx, 1); });
      }
    });
  }

  /* ========================================================================
   * 8. 弹窗与轻提示
   * ====================================================================== */

  let modalEl = null;

  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    document.body.style.overflow = '';
  }

  const INPUT_CLS = 'w-full h-9 px-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-[13.5px] text-gray-800 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors';

  function fieldHTML(f, i) {
    const id = 'mf-' + i;
    const label = '<span class="block text-[11.5px] font-medium text-gray-500 dark:text-gray-400 mb-1">' + esc(f.label || f.name) + '</span>';

    if (f.type === 'select') {
      const opts = (f.options || []).map((o) =>
        '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>'
      ).join('');
      return '<label class="block mb-2.5">' + label + '<select id="' + id + '" class="' + INPUT_CLS + '">' + opts + '</select></label>';
    }
    if (f.type === 'textarea') {
      return '<label class="block mb-2.5">' + label + '<textarea id="' + id + '" rows="3" class="' + INPUT_CLS + ' h-auto py-1.5 resize-y">' + esc(f.value || '') + '</textarea></label>';
    }
    return '<label class="block mb-2.5">' + label +
      '<input id="' + id + '" type="text" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off" spellcheck="false" class="' + INPUT_CLS + '"></label>';
  }

  /**
   * 通用弹窗。
   * @param {object} opts {title, desc, fields, okText, danger, onOk(values)->false|void}
   */
  function openModal(opts) {
    closeModal();

    const fields = opts.fields || [];
    const okCls = opts.danger
      ? 'h-9 px-3.5 rounded-lg text-[13px] font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors'
      : 'h-9 px-3.5 rounded-lg text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors';

    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center';
    el.innerHTML =
      '<div class="absolute inset-0 bg-black/40 dark:bg-black/60" data-modal-close></div>' +
      '<div class="relative w-full sm:max-w-md bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 fade-in max-h-[88vh] flex flex-col">' +
        '<div class="px-5 pt-4 pb-1 shrink-0">' +
          '<h3 class="text-[15px] font-semibold text-gray-800 dark:text-gray-100">' + esc(opts.title || '') + '</h3>' +
          (opts.desc ? '<p class="mt-1 text-[12.5px] leading-5 text-gray-500 dark:text-gray-400 break-words">' + esc(opts.desc) + '</p>' : '') +
        '</div>' +
        '<div class="px-5 py-3 overflow-y-auto grow">' + fields.map(fieldHTML).join('') + '</div>' +
        '<div class="px-5 py-3 flex justify-end gap-2 shrink-0 border-t border-gray-100 dark:border-gray-800">' +
          '<button type="button" data-modal-cancel class="h-9 px-3.5 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">取消</button>' +
          '<button type="button" data-modal-ok class="' + okCls + '">' + esc(opts.okText || '确定') + '</button>' +
        '</div>' +
      '</div>';

    $('#modalRoot').appendChild(el);
    document.body.style.overflow = 'hidden';
    modalEl = el;

    const inputs = fields.map((f, i) => el.querySelector('#mf-' + i));

    function submit() {
      const values = {};
      fields.forEach((f, i) => {
        const node = inputs[i];
        values[f.name] = node ? node.value : '';
      });
      const ret = opts.onOk ? opts.onOk(values) : undefined;
      if (ret !== false) closeModal();
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-modal-close]') || e.target.closest('[data-modal-cancel]')) {
        closeModal();
      } else if (e.target.closest('[data-modal-ok]')) {
        submit();
      }
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    });

    if (inputs[0]) {
      inputs[0].focus();
      if (inputs[0].select) inputs[0].select();
    }
  }

  /** 轻提示 */
  function toast(msg, type) {
    const color = type === 'error' ? 'bg-red-500' : type === 'success' ? 'bg-emerald-600' : 'bg-gray-800';
    const el = document.createElement('div');
    el.className = 'fixed left-1/2 -translate-x-1/2 bottom-6 z-[60] px-4 py-2 rounded-xl text-[13px] text-white shadow-lg fade-in max-w-[88vw] text-center ' + color;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  /* ========================================================================
   * 9. 变更预览 / 导入 / 导出 / 恢复线上
   * ====================================================================== */

  const TYPE_STYLE = {
    add: { label: '新增', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
    remove: { label: '删除', cls: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' },
    rename: { label: '改名', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
    update: { label: '修改', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
    move: { label: '排序', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' }
  };

  const LEVEL_NAME = { group: '分组', category: '分类', item: '条目' };

  function openDiffPreview() {
    const list = state.diff.changes;

    if (!list.length) {
      openModal({
        title: '变更预览',
        desc: '当前内容与线上版本完全一致，没有需要提交的修改。\n\n（新增后又删除、移动后又移回等操作，因最终结果一致，不会被计为修改）',
        okText: '知道了',
        onOk: () => {}
      });
      return;
    }

    const rows = list.map((c) => {
      const st = TYPE_STYLE[c.type] || TYPE_STYLE.update;
      return '<div class="flex items-start gap-2 py-1.5 border-b border-gray-50 dark:border-gray-800/60 last:border-0">' +
        '<span class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10.5px] font-semibold leading-4 ' + st.cls + '">' + st.label + '</span>' +
        '<span class="text-[12.5px] leading-5 text-gray-600 dark:text-gray-300 break-words">' + esc(c.text) + '</span>' +
        '</div>';
    }).join('');

    // 按层级统计，让概览一眼可见
    const stat = { group: 0, category: 0, item: 0 };
    list.forEach((c) => { stat[c.level] = (stat[c.level] || 0) + 1; });
    const summary = ['group', 'category', 'item']
      .filter((k) => stat[k])
      .map((k) => LEVEL_NAME[k] + ' ' + stat[k])
      .join(' · ');

    closeModal();
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center';
    el.innerHTML =
      '<div class="absolute inset-0 bg-black/40 dark:bg-black/60" data-modal-close></div>' +
      '<div class="relative w-full sm:max-w-lg bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 fade-in max-h-[85vh] flex flex-col">' +
        '<div class="px-5 pt-4 pb-2 shrink-0">' +
          '<h3 class="text-[15px] font-semibold text-gray-800 dark:text-gray-100">变更预览（' + list.length + ' 处）</h3>' +
          '<p class="mt-0.5 text-[11.5px] text-gray-400 dark:text-gray-500">' + esc(summary) + '</p>' +
        '</div>' +
        '<div class="px-5 pb-3 overflow-y-auto grow">' + rows + '</div>' +
        '<div class="px-5 py-3 flex justify-end shrink-0 border-t border-gray-100 dark:border-gray-800">' +
          '<button type="button" data-modal-close class="h-9 px-3.5 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">关闭</button>' +
        '</div>' +
      '</div>';
    $('#modalRoot').appendChild(el);
    document.body.style.overflow = 'hidden';
    modalEl = el;
    el.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) closeModal(); });
  }

  /* ---------- 导出 ---------- */

  function exportJSON() {
    const text = serialize(state.data);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    a.href = url;
    a.download = 'nav-data-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出 ' + a.download, 'success');
  }

  /* ---------- 导入 ---------- */

  function importJSON() {
    const input = $('#fileInput');
    input.value = '';
    input.click();
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (e) {
        toast('JSON 解析失败，请检查文件格式', 'error');
        return;
      }
      const next = normalize(raw);
      if (!next.groups.length) {
        toast('文件里没有可用的分组数据', 'error');
        return;
      }
      const total = next.groups.reduce((s, g) => s + g.categories.reduce((t, c) => t + c.items.length, 0), 0);

      openModal({
        title: '导入数据',
        desc: '将用文件内容替换当前工作副本：' + next.groups.length + ' 个分组、' + total + ' 个条目。\n导入后需要点击「推送」才会写入线上。',
        okText: '导入',
        onOk: () => {
          state.data = next;
          state.active = {};
          originPos.clear();
          recompute();
          render();
          toast('导入完成，共 ' + state.diff.count + ' 处变化待提交', 'success');
        }
      });
    };
    reader.onerror = () => toast('文件读取失败', 'error');
    reader.readAsText(file, 'utf-8');
  }

  /* ---------- 恢复线上版本 ---------- */

  async function restoreRemote() {
    openModal({
      title: '恢复线上版本',
      desc: '将丢弃当前所有未提交的修改，重新从线上读取 data.json。此操作不可撤销。',
      danger: true,
      okText: '确认恢复',
      onOk: () => { doRestore(); }
    });
  }

  async function doRestore() {
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();

      const fresh = normalize(raw);
      state.baseline = clone(fresh);
      state.data = clone(fresh);
      state.active = {};
      originPos.clear();
      localStorage.setItem(LS.cache, JSON.stringify(raw));

      recompute();
      render();
      toast('已恢复为线上版本', 'success');
    } catch (e) {
      toast('恢复失败：' + e.message, 'error');
    }
  }

  /* ========================================================================
   * 10. GitHub 推送
   * ------------------------------------------------------------------------
   * 使用 GitHub Contents API 直接更新 data.json：
   *   GET  /repos/{owner}/{repo}/contents/{path}   取当前文件的 sha
   *   PUT  /repos/{owner}/{repo}/contents/{path}   提交新内容
   * 只需一枚具备 repo contents 写权限的 Personal Access Token，无需后端。
   * ====================================================================== */

  function loadGHConfig() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(LS.github) || '{}'); } catch (e) { cfg = {}; }
    return Object.assign({}, GH_DEFAULT, cfg);
  }

  function saveGHConfig(cfg) {
    localStorage.setItem(LS.github, JSON.stringify(cfg));
  }

  /** 支持直接粘贴仓库地址，自动拆成 owner/repo */
  function parseRepo(input) {
    const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
    const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
    if (m) return { owner: m[1], repo: m[2] };
    const parts = s.split('/').filter(Boolean);
    if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
    return null;
  }

  function openGHSettings(retry) {
    const cfg = loadGHConfig();
    openModal({
      title: 'GitHub 推送设置',
      desc: 'Token 仅保存在本机浏览器（localStorage），不会上传到任何服务器。\n需要具备该仓库 Contents 读写权限的 Personal Access Token。',
      fields: [
        { name: 'repo', label: '仓库（owner/repo 或完整地址）', value: cfg.owner + '/' + cfg.repo, placeholder: 'PasserJang/nav' },
        { name: 'branch', label: '分支', value: cfg.branch, placeholder: 'main' },
        { name: 'path', label: '数据文件路径', value: cfg.path, placeholder: 'data.json' },
        { name: 'token', label: 'Personal Access Token', value: cfg.token, placeholder: 'ghp_... 或 github_pat_...' }
      ],
      okText: '保存',
      onOk: (v) => {
        const repo = parseRepo(v.repo);
        if (!repo) { toast('仓库格式应为 owner/repo', 'error'); return false; }
        const token = v.token.trim();
        if (!token) { toast('请填写 Token', 'error'); return false; }

        saveGHConfig({
          owner: repo.owner,
          repo: repo.repo,
          branch: v.branch.trim() || 'main',
          path: (v.path.trim() || 'data.json').replace(/^\/+/, ''),
          token: token
        });
        toast('设置已保存', 'success');
        if (retry) setTimeout(retry, 200);
      }
    });
  }

  function ghHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /** UTF-8 → Base64，分块处理避免大文件爆栈 */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function ghPathURL(cfg) {
    const p = cfg.path.split('/').map(encodeURIComponent).join('/');
    return 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + p;
  }

  let pushing = false;

  async function pushToGitHub() {
    if (pushing) return;
    if (!state.diff.count) { toast('没有需要提交的修改', 'info'); return; }

    const cfg = loadGHConfig();
    if (!cfg.token) { openGHSettings(pushToGitHub); return; }

    pushing = true;
    const btn = $('[data-tb="push"]');
    const originText = btn.textContent;
    btn.textContent = '推送中…';
    btn.disabled = true;

    try {
      // 1) 取当前文件 sha（文件不存在时 sha 为空，走新建流程）
      let sha = null;
      const headRes = await fetch(ghPathURL(cfg) + '?ref=' + encodeURIComponent(cfg.branch), {
        headers: ghHeaders(cfg.token),
        cache: 'no-store'
      });

      if (headRes.ok) {
        const meta = await headRes.json();
        sha = meta.sha;
      } else if (headRes.status === 404) {
        sha = null;
      } else if (headRes.status === 401) {
        throw new Error('Token 无效或已过期（401）');
      } else if (headRes.status === 403) {
        throw new Error('Token 权限不足（403），需要 Contents 读写权限');
      } else {
        throw new Error('读取线上文件失败（HTTP ' + headRes.status + '）');
      }

      // 2) 提交新内容
      const body = {
        message: 'chore(nav): 更新导航数据（' + state.diff.count + ' 处变更）',
        content: b64encode(serialize(state.data)),
        branch: cfg.branch
      };
      if (sha) body.sha = sha;

      const putRes = await fetch(ghPathURL(cfg), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(cfg.token)),
        body: JSON.stringify(body)
      });

      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        if (putRes.status === 409) throw new Error('线上文件已被其它提交修改，请先「恢复线上」再重新编辑');
        if (putRes.status === 401) throw new Error('Token 无效或已过期（401）');
        if (putRes.status === 403) throw new Error('Token 权限不足（403）');
        throw new Error((err && err.message) || '推送失败（HTTP ' + putRes.status + '）');
      }

      // 3) 推送成功 → 当前副本成为新的基准，差异归零
      state.baseline = clone(state.data);
      originPos.clear();
      recompute();
      render();
      toast('已推送，GitHub Pages 约 1 分钟后生效', 'success');
    } catch (e) {
      toast('推送失败：' + e.message, 'error');
      console.error('[nav] push failed', e);
    } finally {
      pushing = false;
      btn.textContent = originText;
      renderToolbar();
    }
  }

  /* ========================================================================
   * 11. 鉴权与初始化
   * ====================================================================== */

  function enterEditMode() {
    state.editing = true;
    sessionStorage.setItem(LS.unlocked, '1');
    $('#adminBtn').textContent = '管理 ✓';
    render();
  }

  function exitEditMode() {
    const done = () => {
      state.editing = false;
      state.sorting = false;
      state.search = '';
      $('#searchInput').value = '';
      $('#adminBtn').textContent = '管理';
      document.body.classList.remove('sort-mode');
      render();
    };
    if (state.diff.count) {
      openModal({
        title: '退出管理模式',
        desc: '还有 ' + state.diff.count + ' 处修改未推送，退出后这些修改会保留在当前页面，刷新即丢失。',
        danger: true,
        okText: '仍然退出',
        onOk: done
      });
    } else {
      done();
    }
  }

  function requestAuth() {
    if (state.editing) { exitEditMode(); return; }

    if (sessionStorage.getItem(LS.unlocked) === '1') { enterEditMode(); return; }

    openModal({
      title: '进入管理模式',
      desc: '请输入管理密码',
      fields: [{ name: 'pwd', label: '密码', value: '', placeholder: '请输入密码' }],
      okText: '进入',
      onOk: (v) => {
        if (v.pwd !== ADMIN_PASSWORD) {
          toast('密码错误', 'error');
          return false;
        }
        enterEditMode();
        toast('已进入管理模式', 'success');
      }
    });
  }

  /* ---------- 事件委托 ---------- */

  function onListClick(e) {
    // 排序模式下所有点击都不响应，避免与拖动冲突
    if (state.sorting) return;

    const el = e.target.closest('[data-act]');
    if (!el) return;

    const act = el.dataset.act;
    const gid = el.dataset.gid;
    const cid = el.dataset.cid;
    const idx = Number(el.dataset.idx);

    // 搜索态下不响应编辑动作
    if (state.search && act !== 'tab') return;

    // 下拉选择器走 change 事件，不在这里处理
    if (act === 'cat-group') return;

    switch (act) {
      case 'tab': e.preventDefault(); switchTab(gid, idx); break;
      // 折叠只改显示，不走 commit，因此不会产生「N 处修改」
      case 'group-toggle': e.preventDefault(); toggleCollapse('g', gid, el); break;
      case 'cat-toggle': e.preventDefault(); toggleCollapse('c', cid, el); break;
      case 'group-add': addGroup(); break;
      case 'group-rename': renameGroup(gid); break;
      case 'group-del': deleteGroup(gid); break;
      case 'cat-add': addCategory(gid); break;
      case 'cat-edit': editCategory(gid, cid); break;
      case 'cat-del': deleteCategory(gid, cid); break;
      case 'item-add': addItem(gid, cid); break;
      case 'item-edit': editItem(gid, cid, idx); break;
      case 'item-del': e.preventDefault(); e.stopPropagation(); deleteItem(gid, cid, idx); break;
      default: break;
    }
  }

  /**
   * 标签栏的「分组」下拉：选中即把该分类移到目标分组。
   * 移动到原分组时，doMoveCategory 会自动插回原索引（移走又移回 = 无变更）。
   */
  function onListChange(e) {
    const sel = e.target.closest('[data-act="cat-group"]');
    if (!sel) return;

    const gid = sel.dataset.gid;
    const cid = sel.dataset.cid;
    const targetGid = sel.value;

    if (state.search || !state.editing) { sel.value = gid; return; }
    if (targetGid === gid) return;

    const moved = doMoveCategory(gid, cid, targetGid);
    if (moved) {
      const target = findGroup(targetGid);
      toast('已移动到「' + (target ? target.name : targetGid) + '」', 'success');
    } else {
      sel.value = gid; // 移动失败，回退选择器显示
    }
  }

  /** 切换分类：只改 class，不重建 DOM，避免整页重绘 */
  function switchTab(gid, idx) {
    const g = findGroup(gid);
    if (!g) return;
    const prev = state.active[gid];
    if (prev === idx) return;
    state.active[gid] = idx;

    $$('[data-pane]').forEach((el) => {
      if (el.dataset.gid !== gid) return;
      const on = Number(el.dataset.idx) === idx;
      el.classList.toggle('hidden', !on);
      el.classList.toggle('grid', on);
    });

    $$('[data-act="tab"]').forEach((b) => {
      if (b.dataset.gid !== gid) return;
      b.className = Number(b.dataset.idx) === idx ? TAB_ON : TAB_OFF;
    });
  }

  /* ---------- 搜索 ---------- */

  const searchInput = $('#searchInput');

  // 小屏放不下长提示，按断点切换 placeholder 文案
  (function syncPlaceholder() {
    if (!searchInput) return;
    const mq = window.matchMedia('(min-width: 640px)');
    const apply = () => {
      searchInput.placeholder = mq.matches ? '搜索（按 / 聚焦，Esc 取消）' : '搜索';
    };
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  })();

  const doSearch = debounce(function (val) {
    state.search = val;
    render();
  }, 180);

  function resetSearch() {
    searchInput.value = '';
    state.search = '';
    searchInput.blur();
    render();
  }

  /* ---------- 数据加载 ---------- */

  async function loadData() {
    // 先读缓存，让首屏尽快出内容；再用网络结果校正
    const cached = localStorage.getItem(LS.cache);
    if (cached) {
      try {
        const raw = JSON.parse(cached);
        const d = normalize(raw);
        state.baseline = clone(d);
        state.data = clone(d);
        recompute();
        render();
      } catch (e) { localStorage.removeItem(LS.cache); }
    }

    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();
      localStorage.setItem(LS.cache, JSON.stringify(raw));

      const fresh = normalize(raw);
      // 只有与当前基准不同才重建，避免打断用户正在进行的编辑
      if (!state.baseline || JSON.stringify(fresh) !== JSON.stringify(state.baseline)) {
        if (state.editing && state.diff.count) return; // 有未提交修改时不覆盖
        state.baseline = clone(fresh);
        state.data = clone(fresh);
        recompute();
        render();
      }
    } catch (e) {
      if (!state.data) {
        $('#listView').innerHTML = '<div class="text-center py-16 text-sm text-red-500 fade-in">数据加载失败，请检查网络或 data.json 是否存在</div>';
      }
    }
  }

  /* ---------- favicon 加载策略（供内联属性调用） ---------- */

  window.__navImgLoad = function (img) {
    // 部分 CDN 对失效域名返回 1x1 占位图
    if (img.naturalWidth <= 1 && img.naturalHeight <= 1) { window.__navImgError(img); return; }
    img.classList.add('loaded');
  };

  window.__navImgError = function (img) {
    if (img.dataset.state === 'failed') return;
    if (!img.dataset.triedDirect) {
      img.dataset.triedDirect = '1';
      try {
        img.src = new URL(img.dataset.url).origin + '/favicon.ico';
        return;
      } catch (e) { /* 链接不合法，直接走失败分支 */ }
    }
    img.dataset.state = 'failed';
    img.style.display = 'none'; // 隐藏后露出底下的首字母占位
  };

  /* ---------- 启动 ---------- */

  function bindEvents() {
    $('#listView').addEventListener('click', onListClick);
    $('#listView').addEventListener('change', onListChange);
    $('#listView').addEventListener('pointerdown', onDragDown);
    $('#searchView').addEventListener('click', onListClick);

    // 编辑态卡片支持键盘回车触发
    $('#listView').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.act === 'item-edit') {
        e.preventDefault();
        onListClick(e);
      }
    });

    $('#adminBtn').addEventListener('click', requestAuth);

    $('#toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tb]');
      if (!btn) return;
      switch (btn.dataset.tb) {
        case 'preview': openDiffPreview(); break;
        case 'sort': toggleSort(); break;
        case 'import': importJSON(); break;
        case 'export': exportJSON(); break;
        case 'restore': restoreRemote(); break;
        case 'push': pushToGitHub(); break;
        case 'exit': exitEditMode(); break;
        default: break;
      }
    });

    searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));

    $('#siteTitle').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (state.search) resetSearch();
    });

    $('#fileInput').addEventListener('change', (e) => handleFile(e.target.files && e.target.files[0]));

    // 快捷键：/ 聚焦搜索，Esc 取消
    document.addEventListener('keydown', (e) => {
      if (modalEl) return; // 弹窗打开时不干扰
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        searchInput.focus();
      } else if (e.key === 'Escape') {
        if (state.search) resetSearch();
      } else if (e.key === 'Enter' && document.activeElement === searchInput && searchInput.value.trim()) {
        window.open('https://www.google.com/search?q=' + encodeURIComponent(searchInput.value.trim()), '_blank', 'noopener');
      }
    });
  }

  function init() {
    state.collapsed = loadCollapsed();
    bindEvents();
    loadData();
  }

  // 供调试 / 单元测试使用
  window.__NAV__ = {
    normalize: normalize, diffData: diffData, align: align, lisIndices: lisIndices, state: state,
    isCollapsed: isCollapsed, saveCollapsed: saveCollapsed,
    dndInfo: () => (dnd ? {
      kind: dnd.kind, startIndex: dnd.startIndex, targetIndex: dnd.targetIndex,
      axis: dnd.axis, edges: dnd.edges, rows: dnd.rows, slots: dnd.slots,
      order: dnd.items.map((el) => el.textContent.trim().slice(0, 6))
    } : null)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
