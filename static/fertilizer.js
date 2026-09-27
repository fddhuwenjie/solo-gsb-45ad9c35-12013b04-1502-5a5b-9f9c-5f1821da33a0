/* 肥料母液分罐 —— 原生 JS */
(() => {
  "use strict";

  let state = null;
  const filter = { recipe_id: null, zone_id: null };
  let activeOnly = false;

  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------ 工具

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = "toast"), 3200);
  }

  async function api(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STATUS_TEXT = {
    ok: "可分罐", overflow: "容量超额", conflict: "奇环冲突",
    empty: "无待分配", error: "未求解",
  };

  // ------------------------------------------------------------ 加载

  function stateUrl(extra = {}) {
    const p = new URLSearchParams();
    const rid = extra.recipe_id ?? filter.recipe_id;
    const zid = extra.zone_id ?? filter.zone_id;
    if (rid) p.set("recipe_id", rid);
    if (zid) p.set("zone_id", zid);
    const qs = p.toString();
    return "/api/fertilizer/state" + (qs ? "?" + qs : "");
  }

  async function load(extra) {
    state = await api(stateUrl(extra));
    if (state.selected_id) filter.recipe_id = state.selected_id;
    renderAll();
  }

  const sel = () => state.selected;

  function renderAll() {
    renderSelectors();
    renderRecipeList();
    renderRecipeForm();
    renderOverview();
    renderConflict();
    renderOverflow();
    renderTanks();
    renderComponents();
    renderDetail();
  }

  // ------------------------------------------------------------ 选择器

  function renderSelectors() {
    const rz = $("#recipe-zone"), fz = $("#filter-zone"), fr = $("#filter-recipe");
    rz.innerHTML = state.zones.length
      ? state.zones.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join("")
      : `<option value="">（请先建立温室分区）</option>`;

    if (fz.options.length === 0) {
      fz.innerHTML = `<option value="">全部分区</option>` +
        state.zones.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join("");
    } else {
      const keep = new Set(["", ...state.zones.map((z) => String(z.id))]);
      [...fz.options].forEach((o) => { if (!keep.has(o.value)) o.remove(); });
      state.zones.forEach((z) => {
        if (![...fz.options].some((o) => o.value === String(z.id))) {
          fz.insertAdjacentHTML("beforeend",
            `<option value="${z.id}">${escapeHtml(z.name)}</option>`);
        }
      });
    }
    fz.value = state.filter_zone_id || "";

    fr.innerHTML = state.recipes.length
      ? state.recipes.map((r) =>
          `<option value="${r.id}"${r.id === state.selected_id ? " selected" : ""}>` +
          `${escapeHtml(r.name)}（${escapeHtml(r.zone_name || "—")}）</option>`).join("")
      : `<option value="">（无配方）</option>`;

    const disabled = !state.selected_id;
    $("#fert-card").style.opacity = disabled ? ".55" : "1";
    $("#edge-card").style.opacity = disabled ? ".55" : "1";
  }

  // ------------------------------------------------------------ 配方列表

  function renderRecipeList() {
    const ul = $("#recipe-list");
    ul.innerHTML = "";
    if (!state.recipes.length) {
      ul.innerHTML = `<li class="entity-row" style="color:var(--ink-soft)">` +
        (state.zones.length ? "暂无配方，请在下方新建"
                           : "请先在轮灌编排台建立温室分区") + `</li>`;
      return;
    }
    state.recipes.forEach((r) => {
      const li = document.createElement("li");
      li.className = "entity-row recipe-item" + (r.id === state.selected_id ? " selected" : "");
      li.innerHTML =
        `<span class="line1">
           <span class="grow name">${escapeHtml(r.name)}</span>
           <span class="zone-chip">${escapeHtml(r.zone_name || "（分区已删除）")}</span>
         </span>
         <span class="meta">
           <span><i class="status-dot ${r.status}"></i>${escapeHtml(r.status_label || STATUS_TEXT[r.status] || "—")}</span>
           <span>${r.vol_a === null || r.vol_a === undefined ? "求解超限" :
                  `💧 A ${r.vol_a} / B ${r.vol_b} mL`}</span>
         </span>
         <span class="meta">容量 A/B：${r.cap_a_ml}/${r.cap_b_ml} mL · 参与求解 ${r.active_count}/${r.fert_count}</span>`;
      li.addEventListener("click", () => selectRecipe(r.id));
      ul.appendChild(li);
    });
  }

  async function selectRecipe(id) {
    filter.recipe_id = id;
    filter.zone_id = null;
    try {
      await load({ zone_id: undefined });
    } catch (e) {
      // 选中配方求解失败（如翻转组合超上限）：后端对该配方返回 400，
      // 回退到列表态，仍可删除该配方、减量或在表单中改容量。
      toast(e.message, true);
      filter.recipe_id = null;
      try { await load({ recipe_id: undefined, zone_id: undefined }); }
      catch (e2) { toast(e2.message, true); }
    }
  }

  // ------------------------------------------------------------ 配方表单

  function renderRecipeForm() {
    const f = $("#recipe-form");
    const s = sel();
    $("#btn-recipe-delete").disabled = !s;
    if (!s) {
      f.elements.id.value = "";
      f.elements.name.value = "";
      f.elements.note.value = "";
      f.elements.cap_a_ml.value = "1000";
      f.elements.cap_b_ml.value = "1000";
      $("#recipe-submit").textContent = "新建配方";
      $("#recipe-cancel").classList.add("hidden");
      return;
    }
    f.elements.id.value = s.id;
    f.elements.name.value = s.name;
    f.elements.zone_id.value = s.zone_id || "";
    f.elements.cap_a_ml.value = s.cap_a_ml;
    f.elements.cap_b_ml.value = s.cap_b_ml;
    f.elements.note.value = s.note || "";
    $("#recipe-submit").textContent = "保存容量 / 分区并重算";
    $("#recipe-cancel").classList.remove("hidden");
  }

  // ------------------------------------------------------------ 总览

  function renderOverview() {
    const s = sel();
    const title = $("#fs-title"), badge = $("#fs-badge");
    const meta = $("#fs-meta"), stats = $("#fs-stats"), rule = $("#fs-rule");
    stats.innerHTML = ""; rule.innerHTML = ""; badge.className = "case-badge";
    if (!s) {
      title.textContent = "未选择配方";
      badge.textContent = "";
      meta.textContent = "在左侧新建配方或从列表中选择。";
      return;
    }
    const r = s.result;
    title.textContent = `${s.name}（${s.zone_name || "（分区已删除）"}）`;
    badge.classList.add(r.status);
    badge.textContent = r.status_label || STATUS_TEXT[r.status];
    meta.innerHTML =
      `容量 <b>A ${s.cap_a_ml} / B ${s.cap_b_ml} mL</b>` +
      ` · 参与求解肥料 <b>${r.active_count}</b> 种` +
      ` · 母液总量 <b>${r.total_volume} mL</b>` +
      ` · 连通分量 <b>${r.component_count}</b> 个` +
      (s.note ? ` · ${escapeHtml(s.note)}` : "");

    if (r.status === "conflict") {
      const stats_items = [
        ["连通分量", r.component_count, "个"],
        ["最短冲突环长度", r.conflict_cycle.length, "个肥料"],
        ["参与求解", r.active_count, "种"],
      ];
      fillStats(stats, stats_items);
      rule.className = "forecast-box conflict";
    } else if (r.status === "empty") {
      fillStats(stats, [["参与求解", 0, "种"], ["连通分量", 0, "个"]]);
      rule.className = "forecast-box empty";
    } else if (r.status === "error") {
      rule.className = "forecast-box error";
    } else {
      const items = [
        ["A 罐占用", r.vol_a, `mL / ${r.cap_a_ml}`],
        ["B 罐占用", r.vol_b, `mL / ${r.cap_b_ml}`],
        ["两罐体积差", r.diff, "mL"],
        ["可行翻转组合", r.feasible_count, `/${r.combination_total}`],
      ];
      if (r.status === "overflow") {
        items.splice(2, 1, ["最小总超额", r.total_overflow, "mL"]);
      }
      fillStats(stats, items);
      rule.className = "forecast-box " + r.status;
    }
    rule.innerHTML = (r.reasons || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  }

  function fillStats(ul, items) {
    items.forEach(([label, val, unit]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="stat-label">${label}</span>` +
        `<span class="stat-val">${escapeHtml(String(val))} <span class="stat-unit">${unit}</span></span>`;
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------ 冲突环 / 超额

  function renderConflict() {
    const card = $("#conflict-card"), body = $("#conflict-body");
    const s = sel();
    if (!s || s.result.status !== "conflict") {
      card.classList.add("hidden");
      return;
    }
    const cy = s.result.conflict_cycle;
    card.classList.remove("hidden");
    body.innerHTML =
      `<div class="cycle-chain">` +
      cy.fertilizers.map((f, i) =>
        `<span class="cycle-node">#${f.id} ${escapeHtml(f.name)}（${f.amount_ml} mL）</span>` +
        (i < cy.fertilizers.length - 1 ? `<span class="cycle-arrow">→</span>` : "")).join("") +
      `<span class="cycle-arrow">→</span>` +
      `<span class="cycle-node">#${cy.fertilizers[0].id} ${escapeHtml(cy.fertilizers[0].name)}</span>` +
      `</div>
       <p class="cycle-meta">最短奇环长度 <b>${cy.length}</b>（奇数条不相容边）：` +
      cy.edge_names.map(([a, b]) => `${escapeHtml(a)} ⚡ ${escapeHtml(b)}`).join("；") +
      `。请删除环上某条不相容关系，或把环中某肥料用量改为 0 使其退出求解。</p>`;
  }

  function renderOverflow() {
    const card = $("#overflow-card"), body = $("#overflow-body");
    const s = sel();
    if (!s || s.result.status !== "overflow") {
      card.classList.add("hidden");
      return;
    }
    const r = s.result;
    card.classList.remove("hidden");
    body.innerHTML =
      `<div class="overflow-grid">
         <div class="ov-tank ${r.overflow_a > 0 ? "over" : ""}">
           <div class="ov-line"><b>A 罐</b><span class="ov-extra">${r.overflow_a > 0 ? `超 ${r.overflow_a} mL` : "不超额"}</span></div>
           <div class="ov-line"><span>占用 / 容量</span><span class="ov-vol">${r.vol_a} / ${r.cap_a_ml} mL</span></div>
         </div>
         <div class="ov-tank ${r.overflow_b > 0 ? "over" : ""}">
           <div class="ov-line"><b>B 罐</b><span class="ov-extra">${r.overflow_b > 0 ? `超 ${r.overflow_b} mL` : "不超额"}</span></div>
           <div class="ov-line"><span>占用 / 容量</span><span class="ov-vol">${r.vol_b} / ${r.cap_b_ml} mL</span></div>
         </div>
       </div>
       <p class="overflow-note">全部 ${r.combination_total} 种分量翻转组合均超容量；这是其中<b>总超额最小</b>（${r.total_overflow} mL）的分罐结果（同超额按体积差 ${r.diff} mL、A 罐肥料 ID 序列决胜）。扩大罐容量、削减用量或调整不相容关系后会自动重算。</p>`;
  }

  // ------------------------------------------------------------ 分罐清单

  function tankOf(fid, r) {
    if (r.tank_a?.some((f) => f.id === fid)) return "A";
    if (r.tank_b?.some((f) => f.id === fid)) return "B";
    return null;
  }

  function compIndexOf(fid, r) {
    const c = (r.components || []).find((c) => c.nodes.some((n) => n.id === fid));
    return c ? c.index : null;
  }

  function renderTanks() {
    const wrap = $("#tank-panels");
    const s = sel();
    if (!s) {
      wrap.innerHTML = "";
      return;
    }
    const r = s.result;
    const showable = r.status === "ok" || r.status === "overflow";
    if (!showable) {
      wrap.innerHTML = `<div class="tank-empty" style="grid-column:1/-1">` +
        (r.status === "conflict"
          ? "存在不相容奇环，任何分罐都会让一对不相容肥料同罐，请先按上方冲突链处理。"
          : "暂无可分配肥料（所有肥料用量均为 0）。") + `</div>`;
      return;
    }
    const renderTank = (key, items, vol, cap, overflow) => {
      const pct = Math.min(100, Math.round(vol / cap * 100));
      const rows = items.length
        ? `<ul class="tank-list">` + items.map((f) =>
            `<li><span class="t-fid">#${f.id}</span>` +
            `<span class="t-name">${escapeHtml(f.name)}</span>` +
            `<span class="t-cid">分量 ${compIndexOf(f.id, r)}</span>` +
            `<span class="t-ml">${f.amount_ml} mL</span></li>`).join("") +
          `</ul>`
        : `<div class="tank-empty">该罐无肥料</div>`;
      return `<div class="tank-box tank-${key.toLowerCase()} ${overflow > 0 ? "over" : ""}">
        <div class="tank-head">
          <span class="tank-name">${key} 罐</span>
          <span class="tank-vol ${overflow > 0 ? "over" : ""}"><b>${vol}</b> / ${cap} mL` +
          (overflow > 0 ? `（超 ${overflow}）` : "") + `</span>
        </div>
        <div class="tank-bar"><i class="${overflow > 0 ? "over" : ""}" style="width:${pct}%"></i></div>
        ${rows}
      </div>`;
    };
    wrap.innerHTML =
      renderTank("A", r.tank_a, r.vol_a, r.cap_a, r.overflow_a) +
      renderTank("B", r.tank_b, r.vol_b, r.cap_b, r.overflow_b);
  }

  // ------------------------------------------------------------ 连通分量

  function renderComponents() {
    const wrap = $("#component-list");
    const s = sel();
    wrap.innerHTML = "";
    if (!s) return;
    const r = s.result;
    const comps = r.components || [];
    if (!comps) { wrap.innerHTML = `<div class="tank-empty">—</div>`; return; }
    if (!comps.length) {
      wrap.innerHTML = `<div class="tank-empty">暂无用量 &gt; 0 的肥料，不相容图为空。</div>`;
      return;
    }
    const nameById = Object.fromEntries(r.fertilizers.map((f) => [f.id, f.name]));
    comps.forEach((c) => {
      const box = document.createElement("div");
      const bip = c.bipartite !== false;
      box.className = "comp-box" + (bip ? "" : " bad");
      const flipText = c.flipped === null ? ""
        : c.flipped ? "本分量已翻转：色 1 → A 罐"
                    : "本分量未翻转：色 0 → A 罐";
      box.innerHTML =
        `<div class="comp-title">分量 ${c.index}
           <span class="comp-tag">${c.nodes.length} 个肥料${bip ? " · 可二着色" : " · 不可二着色（奇环）"}</span>
         </div>
         <div class="comp-sides">
           <span class="comp-side c0">色 0：${(c.side0 || []).map((id) =>
             `#${id} ${escapeHtml(nameById[id] || "")}`).join("、") || "—"}</span>
           <span class="comp-side c1">色 1：${(c.side1 || []).map((id) =>
             `#${id} ${escapeHtml(nameById[id] || "")}`).join("、") || "—"}</span>
           ${flipText ? `<span class="comp-side flip-note">${flipText}</span>` : ""}
         </div>`;
      wrap.appendChild(box);
    });
  }

  // ------------------------------------------------------------ 明细表

  function renderDetail() {
    const tbody = $("#fert-rows"), chips = $("#edge-chips");
    tbody.innerHTML = ""; chips.innerHTML = "";
    const s = sel();
    // 关系表单下拉
    const fa = $("#edge-form").elements.fert_a;
    const fb = $("#edge-form").elements.fert_b;
    if (!s) {
      fa.innerHTML = fb.innerHTML = `<option value="">（先选择配方）</option>`;
      $("#edge-count").textContent = "0";
      return;
    }
    const r = s.result;
    const opts = r.fertilizers.map((f) =>
      `<option value="${f.id}">#${f.id} ${escapeHtml(f.name)}（${f.amount_ml} mL）</option>`).join("");
    fa.innerHTML = opts;
    fb.innerHTML = opts;

    const nameById = Object.fromEntries(r.fertilizers.map((f) => [f.id, f.name]));
    const incompByFert = new Map();
    r.incompat.forEach((e) => {
      if (!incompByFert.has(e.fert_a)) incompByFert.set(e.fert_a, []);
      if (!incompByFert.has(e.fert_b)) incompByFert.set(e.fert_b, []);
      incompByFert.get(e.fert_a).push(e.fert_b);
      incompByFert.get(e.fert_b).push(e.fert_a);
    });

    let rows = r.fertilizers;
    if (activeOnly) rows = rows.filter((f) => f.amount_ml > 0);
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">暂无肥料，请在左上方录入</td></tr>`;
    }
    rows.forEach((f) => {
      const tank = tankOf(f.id, r);
      const active = f.amount_ml > 0;
      const tankCell = !active
        ? `<td class="inactive-cell">不参与（用量 0）</td>`
        : tank === "A"
          ? `<td class="tank-a-cell">A 罐</td>`
          : tank === "B"
            ? `<td class="tank-b-cell">B 罐</td>`
            : `<td class="inactive-cell">—（奇环未解）</td>`;
      const others = incompByFert.get(f.id) || [];
      const tr = document.createElement("tr");
      if (!active) tr.classList.add("inactive-row");
      tr.innerHTML =
        `<td>${f.id}</td>` +
        `<td><span class="inline-edit">
             <input type="text" value="${escapeHtml(f.name)}" data-edit-name="${f.id}">
           </span></td>` +
        `<td><span class="inline-edit">
             <input type="number" min="0" step="1" value="${f.amount_ml}" data-edit-amount="${f.id}">
           </span></td>` +
        tankCell +
        `<td class="incomp-cell">` +
        (others.length
          ? others.map((oid) => `#${oid} ${escapeHtml(nameById[oid] || "")}`).join("；")
          : '<span class="tank-empty" style="padding:0">—</span>') +
        `</td>` +
        `<td class="row-ops">
           <button class="btn small ghost" data-save-item="${f.id}">保存</button>
           <button class="del-btn" data-del-item="${f.id}" title="删除肥料（其不相容关系一并删除）">🗑</button>
         </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-save-item]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.saveItem);
        const name = tbody.querySelector(`[data-edit-name="${id}"]`).value.trim();
        const amount = tbody.querySelector(`[data-edit-amount="${id}"]`).value;
        void saveItem(id, name, amount);
      });
    });
    tbody.querySelectorAll("[data-del-item]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.delItem);
        const f = r.fertilizers.find((x) => x.id === id);
        if (!confirm(`删除肥料「${f.name}」？与其相关的不相容关系一并删除，删除后立即重算。`)) return;
        void deleteItem(id);
      });
    });

    // 关系芯片
    $("#edge-count").textContent = String(r.incompat.length);
    if (!r.incompat.length) {
      chips.innerHTML = `<span class="edge-empty">尚未登记不相容关系；所有用量 &gt; 0 的肥料可自由分罐。</span>`;
    } else {
      r.incompat.forEach((e) => {
        const na = nameById[e.fert_a], nb = nameById[e.fert_b];
        const fa_ = r.fertilizers.find((x) => x.id === e.fert_a);
        const fb_ = r.fertilizers.find((x) => x.id === e.fert_b);
        const live = fa_ && fb_ && fa_.amount_ml > 0 && fb_.amount_ml > 0;
        const chip = document.createElement("span");
        chip.className = "edge-chip" + (live ? "" : " inactive");
        chip.title = live ? "参与求解的不相容关系" : "至少一端用量为 0，暂不参与求解";
        chip.innerHTML =
          `#${e.fert_a} ${escapeHtml(na)} ⚡ #${e.fert_b} ${escapeHtml(nb)}` +
          `<button class="edge-del" data-del-edge="${e.id}" title="删除该不相容关系">✕</button>`;
        chips.appendChild(chip);
      });
      chips.querySelectorAll("[data-del-edge]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.delEdge);
          void deleteEdge(id);
        });
      });
    }
  }

  // ------------------------------------------------------------ 变更操作

  async function saveItem(id, name, amount) {
    if (!name) { toast("请填写肥料名称", true); return; }
    try {
      await api(`/api/fertilizer/items/${id}`, {
        method: "PUT", body: { name, amount_ml: amount },
      });
      await load();
      toast("肥料已保存，分罐结果已重算");
    } catch (e) { toast(e.message, true); }
  }

  async function deleteItem(id) {
    try {
      await api(`/api/fertilizer/items/${id}`, { method: "DELETE" });
      await load();
      toast("肥料已删除，分罐结果已重算");
    } catch (e) { toast(e.message, true); }
  }

  async function deleteEdge(id) {
    try {
      await api(`/api/fertilizer/incompat/${id}`, { method: "DELETE" });
      await load();
      toast("不相容关系已删除，分罐结果已重算");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 表单绑定

  function bindForms() {
    $("#recipe-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name: f.elements.name.value.trim(),
        zone_id: Number(f.elements.zone_id.value),
        cap_a_ml: f.elements.cap_a_ml.value,
        cap_b_ml: f.elements.cap_b_ml.value,
        note: f.elements.note.value.trim(),
      };
      const id = f.elements.id.value;
      try {
        if (id) {
          await api(`/api/fertilizer/recipes/${id}`, { method: "PUT", body });
          toast("配方已保存，分罐结果已重算");
        } else {
          const r = await api("/api/fertilizer/recipes", { method: "POST", body });
          filter.recipe_id = r.selected_id;
          toast("配方已创建");
        }
        await load();
      } catch (err) { toast(err.message, true); }
    });

    $("#recipe-cancel").addEventListener("click", () => {
      filter.recipe_id = null;
      void load({ recipe_id: undefined }).then(() => {
        $("#recipe-form").elements.id.value = "";
        $("#recipe-submit").textContent = "新建配方";
        $("#recipe-cancel").classList.add("hidden");
      }).catch((e) => toast(e.message, true));
    });

    $("#btn-recipe-delete").addEventListener("click", async () => {
      const s = sel();
      if (!s) return;
      if (!confirm(`删除配方「${s.name}」？其全部肥料与不相容关系将一并删除。`)) return;
      try {
        await api(`/api/fertilizer/recipes/${s.id}`, { method: "DELETE" });
        filter.recipe_id = null;
        await load({ recipe_id: undefined });
        toast("配方已删除");
      } catch (err) { toast(err.message, true); }
    });

    $("#fert-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selected_id) { toast("请先选择 / 新建配方", true); return; }
      const f = e.target;
      const body = {
        name: f.elements.name.value.trim(),
        amount_ml: f.elements.amount_ml.value,
      };
      if (!body.name) { toast("请填写肥料名称", true); return; }
      try {
        await api(`/api/fertilizer/recipes/${state.selected_id}/items`,
                  { method: "POST", body });
        f.elements.name.value = "";
        f.elements.amount_ml.value = "0";
        await load();
        toast("肥料已录入，分罐结果已重算");
      } catch (err) { toast(err.message, true); }
    });

    $("#edge-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selected_id) { toast("请先选择 / 新建配方", true); return; }
      const f = e.target;
      const a = Number(f.elements.fert_a.value);
      const b = Number(f.elements.fert_b.value);
      if (a === b) { toast("请选择两种不同的肥料", true); return; }
      try {
        await api(`/api/fertilizer/recipes/${state.selected_id}/incompat`,
                  { method: "POST", body: { fert_a: a, fert_b: b } });
        await load();
        toast("不相容关系已登记，分罐结果已重算");
      } catch (err) { toast(err.message, true); }
    });
  }

  function bindFilters() {
    $("#filter-zone").addEventListener("change", async () => {
      filter.zone_id = Number($("#filter-zone").value) || null;
      filter.recipe_id = null;
      try { await load({ recipe_id: undefined }); }
      catch (e) { toast(e.message, true); }
    });
    $("#filter-recipe").addEventListener("change", async () => {
      const id = Number($("#filter-recipe").value) || null;
      if (!id) return;
      await selectRecipe(id);
    });
    $("#detail-active-only").addEventListener("change", () => {
      activeOnly = $("#detail-active-only").checked;
      renderDetail();
    });
    $("#btn-export").addEventListener("click", () => {
      if (!state.selected_id) { toast("没有可导出的配方", true); return; }
      window.location.href = `/api/fertilizer/export?recipe_id=${state.selected_id}`;
    });
  }

  bindForms();
  bindFilters();
  load().catch((e) => toast(e.message, true));
})();
