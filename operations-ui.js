(() => {
  const $ = id => document.getElementById(id);
  const collections = {
    teamMembers: {form:"opsMemberForm", status:"opsMemberStatus", rows:"opsMemberRows", tab:"team"},
    shifts: {form:"opsShiftForm", status:"opsShiftStatus", rows:"opsShiftRows", tab:"team"},
    stores: {form:"opsStoreForm", status:"opsStoreStatus", rows:"opsStoreRows", tab:"stores"},
    products: {form:"opsProductForm", status:"opsProductStatus", rows:"opsProductRows", tab:"stores"},
    brands: {form:"opsBrandForm", status:"opsBrandStatus", rows:"opsBrandRows", tab:"brands"},
    goals: {form:"opsGoalForm", status:"opsGoalStatus", rows:"opsCalendarRows", tab:"calendar"},
  };
  const labels = {
    role: {planned:"计划", live:"上播", completed:"已完成", invalid:"无效排班",
      active:"在售", inactive:"停售", douyin:"抖店", kuaishou:"快手小店", wechat:"微信小店"},
  };
  let data = {teamMembers:[], shifts:[], stores:[], products:[], brands:[], goals:[]};
  let loadPromise = null;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
  }
  function valueLabel(value) { return labels.role[value] || value || "未填写"; }
  function setStatus(id, message, error = false) {
    const element = $(id);
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("pending", error);
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {headers:{"Accept":"application/json", ...(options.body ? {"Content-Type":"application/json"} : {})}, ...options});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }
  function listMarkup(collection, record, title, detail, badge = "") {
    return `<article class="ops-record"><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div><div class="ops-record-actions">${badge ? `<span class="ops-state">${esc(badge)}</span>` : ""}<button class="btn small" type="button" data-ops-edit="${collection}" data-id="${esc(record.id)}" aria-label="编辑 ${esc(title)}">编辑</button></div></article>`;
  }
  function emptyMarkup(message) { return `<div class="ops-empty">${esc(message)}</div>`; }
  function memberName(id) { return data.teamMembers.find(item => item.id === id)?.name || "成员已移除"; }
  function storeName(id) { return data.stores.find(item => item.id === id)?.name || "店铺已移除"; }
  function renderRows() {
    const memberRows = [...data.teamMembers].sort((a,b) => a.name.localeCompare(b.name, "zh-CN"));
    $("opsMemberRows").innerHTML = memberRows.length ? memberRows.map(item => listMarkup("teamMembers", item, item.name,
      [item.role, item.platform, item.account].filter(Boolean).join(" · ") || "未填写岗位信息", item.active ? "在职" : "已停用")).join("") : emptyMarkup("尚未登记团队成员");

    const shifts = [...data.shifts].sort((a,b) => (b.date || "").localeCompare(a.date || "") || (a.start || "").localeCompare(b.start || ""));
    $("opsShiftRows").innerHTML = shifts.length ? shifts.map(item => listMarkup("shifts", item,
      `${item.date} · ${memberName(item.memberId)}`, [item.start && item.end ? `${item.start}–${item.end}` : item.start || item.end, item.role, item.liveAccount, item.notes].filter(Boolean).join(" · "), valueLabel(item.status))).join("") : emptyMarkup("尚未安排班次");

    const stores = [...data.stores].sort((a,b) => a.name.localeCompare(b.name, "zh-CN"));
    $("opsStoreRows").innerHTML = stores.length ? stores.map(item => listMarkup("stores", item, item.name,
      [valueLabel(item.platform), item.shopId].filter(Boolean).join(" · ") || "未填写店铺备注", item.active ? "经营中" : "已停用")).join("") : emptyMarkup("尚未登记店铺");

    const products = [...data.products].sort((a,b) => a.name.localeCompare(b.name, "zh-CN"));
    $("opsProductRows").innerHTML = products.length ? products.map(item => listMarkup("products", item, item.name,
      [storeName(item.storeId), item.sku && `SKU ${item.sku}`, item.price && `标价 ¥${item.price}`].filter(Boolean).join(" · "), valueLabel(item.status))).join("") : emptyMarkup("尚未登记商品");

    const brands = [...data.brands].sort((a,b) => a.name.localeCompare(b.name, "zh-CN"));
    $("opsBrandRows").innerHTML = brands.length ? brands.map(item => listMarkup("brands", item, item.name,
      [item.storeId && storeName(item.storeId), item.notes].filter(Boolean).join(" · ") || "未填写品牌备注", item.active ? "启用" : "停用")).join("") : emptyMarkup("尚未登记品牌");

    const calendar = [
      ...data.shifts.map(item => ({collection:"shifts", item, date:item.date, title:`${item.date} · ${memberName(item.memberId)}`, detail:[item.start && item.end ? `${item.start}–${item.end}` : item.start || item.end, item.role, item.liveAccount].filter(Boolean).join(" · "), badge:valueLabel(item.status)})),
      ...data.goals.map(item => ({collection:"goals", item, date:item.date, title:`${item.date} · ${item.account}`, detail:[item.targetGmv && `目标成交额 ¥${item.targetGmv}`, item.targetOrders && `目标订单 ${item.targetOrders}`].filter(Boolean).join(" · ") || "目标值未填写", badge:"目标"})),
    ].sort((a,b) => b.date.localeCompare(a.date));
    $("opsCalendarRows").innerHTML = calendar.length ? calendar.map(entry => listMarkup(entry.collection, entry.item,
      entry.title, entry.detail || "未填写排班信息", entry.badge)).join("") : emptyMarkup("尚无直播排班或目标");

    setSelectOptions($("opsShiftMember"), data.teamMembers.map(item => ({value:item.id, label:`${item.name}${item.active ? "" : " · 已停用"}`})), "请选择团队成员", true);
    setSelectOptions($("opsProductStore"), data.stores.map(item => ({value:item.id, label:`${item.name}${item.active ? "" : " · 已停用"}`})), "请先登记店铺", true);
    setSelectOptions($("opsBrandStore"), data.stores.map(item => ({value:item.id, label:item.name})), "不关联店铺", false);
  }
  function setSelectOptions(select, options, placeholder, required) {
    const markup = [`<option value="">${esc(placeholder)}</option>`, ...options.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`)].join("");
    if (select.innerHTML !== markup) select.innerHTML = markup;
    select.disabled = required && !options.length;
  }
  function showLoadError(error) {
    for (const config of Object.values(collections)) $(config.rows).innerHTML = emptyMarkup(`本机配置读取失败：${error.message}`);
    for (const config of Object.values(collections)) setStatus(config.status, "本机配置暂不可用", true);
  }
  async function refresh() {
    if (loadPromise) return loadPromise;
    loadPromise = request("/api/operations-workspace").then(result => {
      data = result;
      renderRows();
      for (const config of Object.values(collections)) setStatus(config.status, "");
      return true;
    }).catch(error => { showLoadError(error); return false; }).finally(() => { loadPromise = null; });
    return loadPromise;
  }
  function selectTab(name) {
    const button = document.querySelector(`[data-ops-tab="${name}"]`);
    if (!button) return;
    document.querySelectorAll("[data-ops-tab]").forEach(tab => {
      const selected = tab === button;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".ops-pane").forEach(pane => { pane.hidden = pane.id !== button.getAttribute("aria-controls"); });
  }
  function beginEdit(collection, id) {
    const config = collections[collection];
    const record = data[collection]?.find(item => item.id === id);
    if (!config || !record) return;
    selectTab(config.tab);
    const form = $(config.form);
    for (const [key, value] of Object.entries(record)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else field.value = value ?? "";
    }
    setStatus(config.status, "正在编辑本机记录");
    form.scrollIntoView({behavior:"smooth", block:"center"});
    form.querySelector("input:not([type=hidden]), select, textarea")?.focus({preventScroll:true});
  }
  function formRecord(form) {
    const record = Object.fromEntries(new FormData(form).entries());
    form.querySelectorAll('input[type="checkbox"]').forEach(field => { record[field.name] = field.checked; });
    return record;
  }
  function bindForm(collection, config) {
    const form = $(config.form);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      setStatus(config.status, "正在保存到本机…");
      try {
        await request(`/api/operations-workspace/${collection}`, {method:"POST", body:JSON.stringify(formRecord(form))});
        form.reset();
        form.elements.namedItem("id").value = "";
        const refreshed = await refresh();
        setStatus(config.status, refreshed ? "已保存到本机" : "已保存；列表刷新失败，请稍后重试", !refreshed);
      } catch (error) {
        setStatus(config.status, `保存失败：${error.message}`, true);
      } finally { submit.disabled = false; }
    });
    form.addEventListener("reset", () => {
      window.setTimeout(() => {
        form.elements.namedItem("id").value = "";
        setStatus(config.status, "");
      }, 0);
    });
  }
  document.querySelectorAll("[data-ops-tab]").forEach(tab => tab.addEventListener("click", () => selectTab(tab.dataset.opsTab)));
  document.querySelector(".ops-tabs")?.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll("[data-ops-tab]")];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next].focus();
    selectTab(tabs[next].dataset.opsTab);
  });
  document.querySelectorAll(".ops-record-list").forEach(list => list.addEventListener("click", event => {
    const button = event.target.closest("button[data-ops-edit]");
    if (button) beginEdit(button.dataset.opsEdit, button.dataset.id);
  }));
  for (const [collection, config] of Object.entries(collections)) bindForm(collection, config);
  window.LiveOperations = {refresh};
  refresh().catch(() => {});
})();
