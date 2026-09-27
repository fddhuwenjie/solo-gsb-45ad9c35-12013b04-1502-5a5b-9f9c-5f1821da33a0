"""肥料母液分罐核心：不相容图连通分量二着色 + 分量翻转全局枚举。

业务背景
--------
每份肥料配方设有 A / B 两个母液罐（容量各自独立）。部分肥料两两不相容
（如钙盐与磷酸盐 / 硫酸盐混罐会沉淀），**不相容肥料必须分到不同罐**；
只对**用量（mL，正整数）大于 0** 的肥料求解，用量为 0 的肥料暂不参与。

求解步骤
--------
1. 以「用量 > 0」的肥料为顶点、不相容关系为边建无向图，按顶点 ID 升序
   BFS 拆分**连通分量**并二着色（相邻顶点颜色必须不同）。
2. 任一连通分量不可二着色即存在**奇环** → 返回图中的**最短奇环**
   （对每个顶点做 BFS，利用 ``dist[u] 与 dist[v] 同奇偶的非树边`` 求环，
   环长相同按顶点 ID 序列决胜），此时不存在任何合法分罐。
3. 每个连通分量二着色后只有两种整体翻转方向（哪一色进 A 罐）。
   枚举全部 ``2^k`` 种翻转组合（孤立肥料也是单顶点分量，可自由进 A / B）：
   - **可行组合**：A、B 两侧体积分别不超过罐容量；
   - 在可行组合中以**两罐体积差最小**为目标；
   - 体积差相同时，按 **A 罐肥料 ID 升序序列**字典序最小者决胜；
   - 若没有任何组合满足容量，则从全部组合中给出**总超额最小**的分罐结果
     （总超额 = max(0, A−容量A) + max(0, B−容量B)，再按体积差、A 罐 ID
     序列决胜），调用方必须展示该结果，不得只显示“无法分配”。

本模块无状态：用量 / 关系 / 容量每次修改后调用方应整体重算。
"""

from collections import deque

# 状态
OK = "ok"                # 存在满足双罐容量的分罐
OVERFLOW = "overflow"    # 无容量可行解，但给出最小总超额分罐
CONFLICT = "conflict"    # 不相容图含奇环，无法二着色
EMPTY = "empty"          # 没有用量 > 0 的肥料
ERROR = "error"          # 组合规模超过枚举上限等输入性错误
STATUS_LABEL = {
    OK: "可分罐",
    OVERFLOW: "容量超额（已给最小超额方案）",
    CONFLICT: "不相容奇环冲突",
    EMPTY: "无待分配肥料",
    ERROR: "未求解",
}

TANK_A = "A"
TANK_B = "B"

# 2^k 翻转组合枚举上限：配方规模为个位数~十几时瞬时完成；
# 取 2^16（最多 16 个互相独立的连通分量，即 16 种互不相关肥料）时
# 最坏耗时仍在 1 秒内，超过上限直接报错由接口返回 400，避免指数级耗时。
MAX_ENUM_COMBOS = 1 << 16

ML_MIN_AMOUNT = 0      # 用量允许为 0（不参与求解）
ML_MIN_CAPACITY = 1


# ---------------------------------------------------------------- 校验

def _int(raw, field, minimum):
    if raw in (None, ""):
        raise ValueError(f"缺少字段：{field}")
    if isinstance(raw, bool):
        raise ValueError(f"{field} 必须为整数（mL）")
    try:
        val = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须为整数（mL）")
    if float(raw) != val:
        raise ValueError(f"{field} 必须为整数（mL）")
    if val < minimum:
        if minimum == ML_MIN_AMOUNT:
            raise ValueError(f"{field} 必须为不小于 0 的整数")
        raise ValueError(f"{field} 必须为不小于 {minimum} 的整数")
    return val


def validate_amount(raw):
    """肥料所需母液量（mL）：非负整数；0 表示暂不参与求解。"""
    return _int(raw, "所需母液量", ML_MIN_AMOUNT)


def validate_capacity(raw, field="罐容量"):
    """A / B 罐容量（mL）：正整数。"""
    return _int(raw, field, ML_MIN_CAPACITY)


# ---------------------------------------------------------------- 图

def _build_graph(active_ids, edges):
    """以有效肥料为顶点建邻接表；只保留两端均用量 > 0 的关系。"""
    active = set(active_ids)
    adj = {i: set() for i in active_ids}
    live_edges = []
    for e in edges:
        u, v = e["fert_a"], e["fert_b"]
        if u in active and v in active and u != v:
            a, b = (u, v) if u < v else (v, u)
            if (a, b) not in live_edges:
                live_edges.append((a, b))
            adj[a].add(b)
            adj[b].add(a)
    live_edges.sort()
    return adj, live_edges


def _split_components(active_ids, adj):
    """按 ID 升序 BFS：拆连通分量并二着色。

    返回 (components, color, conflict_edges)：
    components 为按分量最小顶点升序排列的顶点 ID 列表；
    conflict_edges 为着色冲突（两端同色）的无向边 (u,v), u<v。
    """
    color = {}
    components = []
    conflict = set()
    for start in active_ids:  # active_ids 已升序
        if start in color:
            continue
        color[start] = 0
        comp = []
        dq = deque([start])
        while dq:
            u = dq.popleft()
            comp.append(u)
            for v in sorted(adj[u]):
                if v not in color:
                    color[v] = color[u] ^ 1
                    dq.append(v)
                elif color[v] == color[u]:
                    conflict.add((u, v) if u < v else (v, u))
        components.append(sorted(comp))
    components.sort(key=lambda c: c[0])
    return components, color, sorted(conflict)


def _shortest_odd_cycle(nodes, adj, edge_list):
    """求一个连通分量内的最短奇环，返回规范化后的顶点环序列。

    对分量内每个顶点 s 做 BFS；对每条两端均可达且 BFS 距离同奇偶的边
    (u,v)，dist[u]+dist[v]+1 为奇数，对应一个奇环。取环长最小者，
    环长相同按「最小 ID 打头、正反两方向中字典序更小」的 ID 序列决胜。
    """
    node_set = set(nodes)
    best = None  # (length, canonical_tuple, ring)

    for s in nodes:
        dist = {s: 0}
        parent = {s: None}
        dq = deque([s])
        while dq:
            u = dq.popleft()
            for v in sorted(adj[u]):
                if v not in node_set or v in dist:
                    continue
                dist[v] = dist[u] + 1
                parent[v] = u
                dq.append(v)
        for (u, v) in edge_list:
            if u not in dist or v not in dist:
                continue
            if (dist[u] & 1) != (dist[v] & 1):
                continue  # 二分边，构成的是偶环
            # 由 BFS 父链求最近公共祖先，抽出简单环 u→…→lca→…→v -(v-u)
            anc_u = []
            x = u
            while x is not None:
                anc_u.append(x)
                x = parent[x]
            anc_v = []
            x = v
            while x is not None:
                anc_v.append(x)
                x = parent[x]
            anc_set = set(anc_u)
            lca = next(x for x in anc_v if x in anc_set)
            path_u = anc_u[:anc_u.index(lca) + 1]          # u, …, lca
            path_v = anc_v[:anc_v.index(lca) + 1]          # v, …, lca
            ring = path_u + path_v[-2::-1] \
                if len(path_v) > 1 else path_u             # u…lca…v，v-u 闭合
            canon = _canonical_ring(ring)
            key = (len(canon), tuple(canon))
            if best is None or key < (best[0], best[1]):
                best = (len(canon), tuple(canon), canon)
    return best[2] if best else None


def _canonical_ring(ring):
    """把环旋转到最小 ID 打头，并取正反两方向中字典序更小者。"""
    n = len(ring)
    i = min(range(n), key=lambda j: ring[j])
    rot = ring[i:] + ring[:i]
    rev = [rot[0]] + list(reversed(rot[1:]))
    return rot if tuple(rot) <= tuple(rev) else rev


# ---------------------------------------------------------------- 枚举

def _greedy_incumbent(sides, amount, cap_a, cap_b):
    """按分量顺序贪心选翻转方向，给总超额一个上界以便 DFS 剪枝。"""
    va = vb = 0
    for s0, s1 in sides:
        w0a, w0b = sum(amount[n] for n in s0), sum(amount[n] for n in s1)
        # 不翻转：s0 进 A；翻转：s1 进 A
        w1a, w1b = w0b, w0a
        ov0 = max(0, va + w0a - cap_a) + max(0, vb + w0b - cap_b)
        ov1 = max(0, va + w1a - cap_a) + max(0, vb + w1b - cap_b)
        if ov1 < ov0:
            va, vb = va + w1a, vb + w1b
        else:
            va, vb = va + w0a, vb + w0b
    return max(0, va - cap_a) + max(0, vb - cap_b)


def _enumerate(components, color, amount, cap_a, cap_b):
    """在每个连通分量的两种翻转方向中枚举全局最优组合。

    返回 dict：可行最优（status=ok）或最小总超额（status=overflow）。
    """
    import bisect

    sides = []
    for comp in components:
        s0 = sorted(n for n in comp if color[n] == 0)
        s1 = sorted(n for n in comp if color[n] == 1)
        sides.append((s0, s1))
    k = len(sides)
    total_combos = 1 << k
    if total_combos > MAX_ENUM_COMBOS:
        raise ValueError(
            f"不相容图存在 {k} 个互相独立的连通分量，翻转组合达 "
            f"{total_combos} 种、超过上限 {MAX_ENUM_COMBOS}，"
            "请减少参与求解（用量>0）的肥料数量后重试")

    best_feasible = None    # (体积差, A 罐 ID 序列, va, vb, flips)
    best_overflow = None    # (总超额, 体积差, A 罐 ID 序列, va, vb, flips)
    feasible_count = 0
    incumbent_ov = _greedy_incumbent(sides, amount, cap_a, cap_b)

    # 分量按顺序处理；node_sums 预先求好，DFS 只做加减与有序列表插入
    sums = [
        (sum(amount[n] for n in s0), sum(amount[n] for n in s1))
        for s0, s1 in sides
    ]

    def dfs(idx, va, vb, a_ids, flips):
        nonlocal best_feasible, best_overflow, feasible_count, incumbent_ov
        if idx == k:
            diff = abs(va - vb)
            key_ids = tuple(a_ids)
            if va <= cap_a and vb <= cap_b:
                feasible_count += 1
                key = (diff, key_ids)
                if best_feasible is None or key < best_feasible[:2]:
                    best_feasible = (diff, key_ids, va, vb, tuple(flips))
            else:
                ov = max(0, va - cap_a) + max(0, vb - cap_b)
                key = (ov, diff, key_ids)
                if best_overflow is None or key < best_overflow[:3]:
                    best_overflow = (ov, diff, key_ids, va, vb, tuple(flips))
                    incumbent_ov = min(incumbent_ov, ov)
            return
        # 部分超额沿路径单调不减：已严格差于已知最优叶节点则其子树必不更优
        part_ov = max(0, va - cap_a) + max(0, vb - cap_b)
        if part_ov > incumbent_ov:
            return
        s0, s1 = sides[idx]
        w0a, w0b = sums[idx]
        for flip in (0, 1):
            add_a = s1 if flip else s0
            na, nb = (va + w0b, vb + w0a) if flip else (va + w0a, vb + w0b)
            # 体积只增不减，超额剪枝统一在子 dfs 入口判定（part_ov=0 的
            # 可行分支永远不会被剪掉）
            inserted = []
            for n in add_a:
                bisect.insort(a_ids, n)
                inserted.append(n)
            flips.append(flip)
            dfs(idx + 1, na, nb, a_ids, flips)
            flips.pop()
            for n in inserted:
                a_ids.remove(n)

    dfs(0, 0, 0, [], [])

    if best_feasible is not None:
        diff, _ids, va, vb, flips = best_feasible
        status = OK
    else:
        ov, diff, _ids, va, vb, flips = best_overflow
        status = OVERFLOW
    return {
        "status": status,
        "status_label": STATUS_LABEL[status],
        "flips": flips,
        "sides": sides,
        "vol_a": va,
        "vol_b": vb,
        "diff": diff,
        "overflow_a": max(0, va - cap_a),
        "overflow_b": max(0, vb - cap_b),
        "total_overflow": max(0, va - cap_a) + max(0, vb - cap_b),
        "combination_total": total_combos,
        "feasible_count": feasible_count,
        "component_count": k,
    }


# ---------------------------------------------------------------- 主入口

def solve(fertilizers, edges, cap_a, cap_b):
    """对一份配方整体重算分罐。

    fertilizers: [{id, name, amount_ml}]（amount_ml 为非负整数）
    edges:       [{id?, fert_a, fert_b}]
    cap_a/cap_b: A/B 罐容量（正整数，mL）
    返回结构化结果 dict（含状态、分罐清单、占用量、连通分量 / 组合统计、
    奇环冲突链或最小超额方案及人话依据）。
    """
    cap_a = validate_capacity(cap_a, "A 罐容量")
    cap_b = validate_capacity(cap_b, "B 罐容量")
    by_id = {}
    for f in fertilizers:
        fid = int(f["id"])
        amt = validate_amount(f.get("amount_ml"))
        by_id[fid] = {"id": fid, "name": f["name"], "amount_ml": amt}
    active_ids = sorted(fid for fid, f in by_id.items() if f["amount_ml"] > 0)
    active_set = set(active_ids)
    amount = {fid: by_id[fid]["amount_ml"] for fid in by_id}
    adj, live_edges = _build_graph(active_ids, edges)

    inactive = [by_id[i] for i in sorted(by_id) if i not in active_set]
    ignored_edges = [
        [e["fert_a"], e["fert_b"]] for e in edges
        if e["fert_a"] in by_id and e["fert_b"] in by_id
        and (e["fert_a"] not in active_set or e["fert_b"] not in active_set)
    ]

    base = {
        "cap_a": cap_a,
        "cap_b": cap_b,
        "total_volume": sum(amount.values()),
        "active_count": len(active_ids),
        "inactive": inactive,
        "ignored_edges": ignored_edges,
    }
    if not active_ids:
        base.update(_empty_result())
        return base

    components, color, conflict_edges = _split_components(active_ids, adj)
    if conflict_edges:
        # 各冲突分量分别求最短奇环，取全局最短（环长相同按 ID 序列决胜）
        rings = []
        for comp in components:
            comp_set = set(comp)
            comp_edges = [e for e in live_edges if e[0] in comp_set]
            if any(color[e[0]] == color[e[1]] for e in comp_edges):
                ring = _shortest_odd_cycle(comp, adj, comp_edges)
                if ring:
                    rings.append(ring)
        rings.sort(key=lambda r: (len(r), tuple(_canonical_ring(r))))
        ring = rings[0]
        base.update(_conflict_result(ring, by_id, components, color, conflict_edges))
        return base

    enum = _enumerate(components, color, amount, cap_a, cap_b)
    flips = enum.pop("flips")
    sides = enum.pop("sides")
    base.update(enum)

    tank_a, tank_b, comp_views = [], [], []
    for idx, comp in enumerate(components):
        s0, s1 = sides[idx]
        side_a = s1 if flips[idx] else s0
        side_b = s0 if flips[idx] else s1
        for n in side_a:
            tank_a.append(by_id[n])
        for n in side_b:
            tank_b.append(by_id[n])
        comp_views.append({
            "index": idx + 1,
            "nodes": [by_id[n] for n in comp],
            "side0": s0,
            "side1": s1,
            "flipped": bool(flips[idx]),
        })
    tank_a.sort(key=lambda f: f["id"])
    tank_b.sort(key=lambda f: f["id"])
    base.update({
        "tank_a": tank_a,
        "tank_b": tank_b,
        "components": comp_views,
        "reasons": _reasons(base, comp_views),
    })
    return base


def _empty_result():
    return {
        "status": EMPTY,
        "status_label": STATUS_LABEL[EMPTY],
        "vol_a": 0, "vol_b": 0, "diff": 0,
        "overflow_a": 0, "overflow_b": 0, "total_overflow": 0,
        "combination_total": 0, "feasible_count": 0, "component_count": 0,
        "tank_a": [], "tank_b": [], "components": [],
        "reasons": ["所有肥料用量均为 0，暂无母液需要分罐；录入正整数用量后自动重算。"],
    }


def _conflict_result(ring, by_id, components, color, conflict_edges):
    edge_pairs = [(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))]
    cycle = {
        "length": len(ring),
        "nodes": ring,
        "names": [by_id[n]["name"] for n in ring],
        "fertilizers": [by_id[n] for n in ring],
        "edges": [[a, b] for a, b in edge_pairs],
        "edge_names": [[by_id[a]["name"], by_id[b]["name"]] for a, b in edge_pairs],
    }
    comp_index = next(
        i + 1 for i, c in enumerate(components)
        if ring[0] in set(c))
    reason = (
        f"不相容图第 {comp_index} 个连通分量无法二着色：存在长度为 "
        f"{len(ring)} 的奇环 "
        f"{' → '.join(cycle['names'])} → {cycle['names'][0]}"
        "，环上相邻肥料两两不相容却只有 A/B 两个罐，必有一对不相容肥料同罐。"
        "请删除该环上的某条不相容关系，或把环中某肥料用量改为 0 后重试。"
    )
    return {
        "status": CONFLICT,
        "status_label": STATUS_LABEL[CONFLICT],
        "conflict_cycle": cycle,
        "conflict_edges": [list(e) for e in conflict_edges],
        "component_count": len(components),
        "components": [
            {"index": i + 1, "nodes": [by_id[n] for n in c],
             "side0": [n for n in c if color[n] == 0],
             "side1": [n for n in c if color[n] == 1],
             "flipped": None,
             "bipartite": not any(color[e[0]] == color[e[1]]
                                  for e in conflict_edges if e[0] in set(c))}
            for i, c in enumerate(components)
        ],
        "reasons": [reason],
    }


def _reasons(result, components):
    """生成面向台账的求解依据（人话）。"""
    k = result["component_count"]
    reasons = []
    if result["status"] == OK:
        reasons.append(
            f"不相容图拆为 {k} 个连通分量并二着色成功；枚举 2^{k}="
            f"{result['combination_total']} 种分量翻转组合，其中 "
            f"{result['feasible_count']} 种同时满足 A≤{result['cap_a']}、"
            f"B≤{result['cap_b']} mL。")
        reasons.append(
            f"在可行组合中取两罐体积差最小：A {result['vol_a']} / "
            f"B {result['vol_b']} mL，体积差 {result['diff']} mL；"
            "体积差并列时按 A 罐肥料 ID 升序序列字典序最小者决胜。")
    else:
        reasons.append(
            f"不相容图拆为 {k} 个连通分量并二着色成功；枚举 "
            f"{result['combination_total']} 种翻转组合，"
            f"无一能同时满足 A≤{result['cap_a']}、B≤{result['cap_b']} mL。")
        reasons.append(
            f"已从全部组合中取总超额最小者：A {result['vol_a']}/"
            f"{result['cap_a']}（超 {result['overflow_a']} mL）、"
            f"B {result['vol_b']}/{result['cap_b']}（超 "
            f"{result['overflow_b']} mL），最小总超额 "
            f"{result['total_overflow']} mL、体积差 {result['diff']} mL；"
            "请扩大罐容量、削减用量或调整不相容关系，而非简单判定无法分配。")
    if result["inactive"]:
        reasons.append(
            "用量为 0、未参与求解的肥料："
            + "、".join(f["name"] for f in result["inactive"]) + "。")
    return reasons
