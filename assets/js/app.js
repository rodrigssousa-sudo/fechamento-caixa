import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

import { firebaseConfig, BOOTSTRAP_ADMIN_EMAILS } from "./config/firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let historyCache = [];
let historyUnsubscribe = null;
let systemUnsubscribe = null;
let currentRankRange = "day";
let historyRenderLimit = 12;

let calcRaf = 0;
let activeAsyncCount = 0;
const uiBusyMap = new WeakMap();

function nextFrame(){
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function debounce(fn, wait = 180){
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function ensureSpinStyle(){
  if(document.getElementById("appInlineSpinStyle")) return;

  const style = document.createElement("style");
  style.id = "appInlineSpinStyle";
  style.textContent = `
    @keyframes appSpin { to { transform: rotate(360deg); } }
    .section-loading{
      position: relative;
      pointer-events: none;
      opacity: .72;
      transition: opacity .2s ease;
    }
    .section-loading::after{
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.18) 50%, rgba(255,255,255,0) 100%);
      animation: appShimmer 1.05s linear infinite;
    }
    @keyframes appShimmer{
      from { transform: translateX(-100%); }
      to { transform: translateX(100%); }
    }
  `;
  document.head.appendChild(style);
}

function ensureToastRoot(){
  let root = document.getElementById("appToastRoot");
  if(root) return root;

  root = document.createElement("div");
  root.id = "appToastRoot";
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "true");
  root.style.position = "fixed";
  root.style.right = "16px";
  root.style.bottom = "92px";
  root.style.zIndex = "9999";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "10px";
  root.style.maxWidth = "min(92vw, 380px)";
  document.body.appendChild(root);
  return root;
}

function showToast(message, type = "info", timeout = 3200){
  const root = ensureToastRoot();
  const toast = document.createElement("div");

  const palette = {
    info:    { bg:"#0f172a", border:"#334155", color:"#f8fafc", title:"Informação" },
    success: { bg:"#052e16", border:"#16a34a", color:"#f0fdf4", title:"Concluído" },
    warning: { bg:"#3b2300", border:"#f59e0b", color:"#fff7ed", title:"Aviso" },
    error:   { bg:"#450a0a", border:"#ef4444", color:"#fef2f2", title:"Atenção" }
  };

  const tone = palette[type] || palette.info;

  toast.style.background = tone.bg;
  toast.style.color = tone.color;
  toast.style.border = `1px solid ${tone.border}`;
  toast.style.borderRadius = "16px";
  toast.style.padding = "12px 14px";
  toast.style.boxShadow = "0 14px 32px rgba(2,6,23,.22)";
  toast.style.fontSize = "14px";
  toast.style.lineHeight = "1.4";
  toast.style.transform = "translateY(10px)";
  toast.style.opacity = "0";
  toast.style.transition = "all .22s ease";
  toast.innerHTML = `
    <div style="font-weight:700; margin-bottom:2px;">${tone.title}</div>
    <div>${escapeHtml(message)}</div>
  `;

  root.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.transform = "translateY(0)";
    toast.style.opacity = "1";
  });

  const remove = () => {
    toast.style.transform = "translateY(10px)";
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 220);
  };

  setTimeout(remove, timeout);
  return toast;
}

function showSoftFeedback(message, type = "info", targetId = ""){
  if(targetId && $(targetId)){
    const noticeType =
      type === "error" ? "error" :
      type === "success" ? "ok" :
      "info";

    showNotice(targetId, message, noticeType);
  }

  showToast(message, type);
}

function handleUiError(error, targetId = ""){
  const message = friendlyError(error);
  if(targetId) showNotice(targetId, message, "error");
  showToast(message, "error");
  return message;
}

function setGlobalBusy(isBusy, message = "Carregando..."){
  const overlay = $("globalLoading");
  if(!overlay) return;

  activeAsyncCount += isBusy ? 1 : -1;
  if(activeAsyncCount < 0) activeAsyncCount = 0;

  overlay.classList.toggle("hidden", activeAsyncCount === 0);

  const msgEl =
    $("globalLoadingText") ||
    overlay.querySelector("[data-loading-text]");

  if(msgEl) msgEl.textContent = message;
}

async function withGlobalBusy(task, message = "Processando..."){
  try{
    setGlobalBusy(true, message);
    await nextFrame();
    return await task();
  }finally{
    setGlobalBusy(false);
  }
}

function setButtonLoading(buttonOrId, isLoading, loadingText = "Processando..."){
  const btn = typeof buttonOrId === "string" ? $(buttonOrId) : buttonOrId;
  if(!btn) return;

  ensureSpinStyle();

  if(isLoading){
    if(!uiBusyMap.has(btn)){
      uiBusyMap.set(btn, {
        html: btn.innerHTML,
        width: Math.max(btn.offsetWidth, 96),
        disabled: btn.disabled
      });
    }

    const prev = uiBusyMap.get(btn);
    btn.disabled = true;
    btn.style.width = `${prev.width}px`;
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span aria-hidden="true" style="display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:999px;animation:appSpin .6s linear infinite;vertical-align:-2px;margin-right:8px;"></span>${escapeHtml(loadingText)}`;
    return;
  }

  const prev = uiBusyMap.get(btn);
  btn.classList.remove("is-loading");
  btn.removeAttribute("aria-busy");

  if(prev){
    btn.innerHTML = prev.html;
    btn.disabled = prev.disabled;
    btn.style.width = "";
    uiBusyMap.delete(btn);
  }else{
    btn.disabled = false;
    btn.style.width = "";
  }
}

function setSectionLoading(sectionOrId, isLoading){
  const el = typeof sectionOrId === "string" ? $(sectionOrId) : sectionOrId;
  if(!el) return;

  ensureSpinStyle();
  el.classList.toggle("section-loading", !!isLoading);
  el.setAttribute("aria-busy", isLoading ? "true" : "false");
}

async function withButtonLoading(buttonOrId, task, loadingText = "Salvando..."){
  setButtonLoading(buttonOrId, true, loadingText);
  try{
    await nextFrame();
    return await task();
  }finally{
    setButtonLoading(buttonOrId, false);
  }
}

function scheduleRenderCalculations(){
  if(calcRaf) cancelAnimationFrame(calcRaf);
  calcRaf = requestAnimationFrame(() => {
    calcRaf = 0;
    renderCalculations();
  });
}

const debouncedRenderCalculations = debounce(() => {
  scheduleRenderCalculations();
}, 120);

function syncBodyThemeState(){
  const shellVisible = !$("appShell")?.classList.contains("hidden");
  document.body.classList.toggle("is-authenticated", shellVisible);
  document.body.classList.toggle("is-guest", !shellVisible);
}

function showNotice(targetId, message, type = "error"){
  const el = $(targetId);
  if(!el) return;

  el.className = `notice ${type}`;
  el.textContent = message;
  el.classList.remove("hidden");
  el.style.opacity = "0";
  el.style.transform = "translateY(6px)";
  el.style.transition = "all .18s ease";

  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });
}

function hideNotice(targetId){
  $(targetId)?.classList.add("hidden");
}

function friendlyError(error){
  const code = error?.code || "";
  if(code.includes("permission-denied")) return "Permissão negada no Firestore. Ajuste as regras ou aprove este usuário como admin.";
  if(code.includes("auth/email-already-in-use")) return "Este email já está cadastrado. Use Entrar no sistema.";
  if(code.includes("auth/invalid-credential")) return "Email ou senha inválidos.";
  if(code.includes("auth/weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  return error?.message || String(error);
}

function moneyToNumber(value){
  if(value === null || value === undefined) return 0;
  if(typeof value === "number") return value;

  let s = String(value).trim().replace(/[^0-9,.-]/g, "");
  if(!s) return 0;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if(hasComma && hasDot){
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    s = lastComma > lastDot
      ? s.split(".").join("").replace(",", ".")
      : s.split(",").join("");
  }else if(hasComma){
    s = s.split(".").join("").replace(",", ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function formatInputMoney(value){
  const n = moneyToNumber(value);
  if(!n) return "";
  return n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function applyBankMoneyMask(input){
  if(!input) return;

  input.classList.add("money-input");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("inputmode", "decimal");

  if(
    input.dataset.noHelper !== "1" &&
    (!input.nextElementSibling || !input.nextElementSibling.classList?.contains("input-helper"))
  ){
    const helper = document.createElement("div");
    helper.className = "input-helper";
    helper.innerHTML = `<span>Digite só números</span><b>0,00</b>`;
    input.insertAdjacentElement("afterend", helper);
  }

  const updateVisual = () => {
    const value = moneyToNumber(input.value || 0);
    input.classList.toggle("input-filled", value > 0);
    input.classList.toggle("input-error", String(input.value || "").includes("-") || !Number.isFinite(value));
    const b = input.nextElementSibling?.querySelector?.("b");
    if(b) b.textContent = value > 0 ? formatMoney(value) : "0,00";
  };

  input.addEventListener("input", () => {
    const digits = String(input.value || "").replace(/[^0-9]/g, "");

    if(!digits){
      input.value = "";
      updateVisual();
      input.dispatchEvent(new Event("bankmoney", { bubbles: true }));
      debouncedRenderCalculations();
      return;
    }

    const number = Number(digits) / 100;
    input.value = number.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    updateVisual();
    input.dispatchEvent(new Event("bankmoney", { bubbles: true }));
    debouncedRenderCalculations();
  });

  input.addEventListener("focus", () => {
    input.select?.();
    updateVisual();
  });

  input.addEventListener("blur", () => {
    if(input.value) input.value = formatInputMoney(input.value);
    updateVisual();
    scheduleRenderCalculations();
  });

  updateVisual();
}

function applyBankMoneyMaskAll(scope = document){
  scope.querySelectorAll(".money-input").forEach(input => {
    if(input.dataset.bankMask === "1") return;
    input.dataset.bankMask = "1";
    applyBankMoneyMask(input);
  });
}

function formatMoney(value){
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2
  }).format(Number(value) || 0);
}

function dateLabel(value){
  if(!value) return "-";
  const d = value?.toDate ? value.toDate() : new Date(value);
  if(isNaN(d)) return "-";

  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toDateInputValue(value){
  const d = value?.toDate ? value.toDate() : new Date(value || Date.now());
  if(isNaN(d)) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function isBootstrapEmail(email){
  return BOOTSTRAP_ADMIN_EMAILS
    .map(x => x.toLowerCase())
    .includes(String(email || "").toLowerCase());
}

function isAdmin(){
  return currentProfile?.role === "admin" || currentProfile?.admin === true;
}

function isSupervisor(){
  return currentProfile?.role === "supervisor";
}

function isOperator(){
  return !!currentUser && !isAdmin() && !isSupervisor();
}

function canCloseTurn(){
  return !!currentUser;
}

function canSeeAllHistory(){
  return !!currentUser;
}

function canSeeInternalAdjustments(){
  return isAdmin() || isSupervisor();
}

function canUseAdminClosingFields(){
  return isAdmin() || isSupervisor();
}

function canPrintIndividualHistory(){
  return !!currentUser;
}

function canGenerateMonthlyPdf(){
  return isAdmin() || isSupervisor();
}

function canSeeTodayProfitCard(){
  return !!currentUser;
}

function canSeeWeeklyProfitCard(){
  return isAdmin() || isSupervisor();
}

function allowedCloseFieldIds(){
  const ids = ["webReca", "suprema", "pppoker", "buffalo", "ganamos"];
  if(canUseAdminClosingFields()) ids.push("cargasPoker", "cargasCasino");
  return ids;
}

function normalizeOutflowCategory(value){
  const normalized = String(value || "lucro").toLowerCase();
  if(normalized === "custo_operacional") return "custo_operacional";
  if(normalized === "taxas_reba") return "taxas_reba";
  return "lucro";
}

function sanitizeTurnForPersistence(turno = {}, originalTurno = null){
  const original = originalTurno || {};
  const fallbackOperator = profileName() || currentUser?.email?.split("@")[0] || "";

  const sanitized = {
    ...turno,
    operatorName: String(turno.operatorName || fallbackOperator).trim(),
    closingDate: turno.closingDate || new Date().toISOString(),
    webReca: moneyToNumber(turno.webReca ?? turno.reca ?? 0),
    suprema: moneyToNumber(turno.suprema ?? 0),
    pppoker: moneyToNumber(turno.pppoker ?? 0),
    buffalo: moneyToNumber(turno.buffalo ?? 0),
    ganamos: moneyToNumber(turno.ganamos ?? 0)
  };

  sanitized.cargasPoker = canUseAdminClosingFields()
    ? moneyToNumber(turno.cargasPoker ?? 0)
    : moneyToNumber(original.cargasPoker ?? 0);

  sanitized.cargasCasino = canUseAdminClosingFields()
    ? moneyToNumber(turno.cargasCasino ?? turno.cargas ?? 0)
    : moneyToNumber(original.cargasCasino ?? original.cargas ?? 0);

  sanitized.pendings = Array.isArray(turno.pendings)
    ? turno.pendings
        .map(x => ({
          name: String(x?.name || "").trim(),
          value: moneyToNumber(x?.value || 0)
        }))
        .filter(x => x.name || x.value)
    : [];

  sanitized.outflows = Array.isArray(turno.outflows)
    ? turno.outflows
        .map(x => ({
          name: String(x?.name || "").trim(),
          category: normalizeOutflowCategory(x?.category ?? x?.type),
          value: moneyToNumber(x?.value || 0)
        }))
        .filter(x => x.name || x.value)
    : [];

  sanitized.pendentesTotal = sanitized.pendings.reduce((s, x) => s + moneyToNumber(x.value), 0);
  sanitized.saidasTotal = sanitized.outflows.reduce((s, x) => s + moneyToNumber(x.value), 0);
  sanitized.retiradaLucroTotal = sanitized.outflows
    .filter(x => x.category === "lucro")
    .reduce((s, x) => s + moneyToNumber(x.value), 0);
  sanitized.custoOperacionalTotal = sanitized.outflows
    .filter(x => x.category === "custo_operacional")
    .reduce((s, x) => s + moneyToNumber(x.value), 0);
  sanitized.saldoLiquido = calcularSaldoLiquido(sanitized);
  sanitized.baseOperacional = calcularBaseOperacional(sanitized);

  return sanitized;
}

function outflowCategoryLabel(category){
  const value = String(category || "lucro").toLowerCase();
  if(value === "custo_operacional") return "Custo operacional";
  if(value === "taxas_reba") return "Taxas Reba";
  return "Lucro";
}

function todayDateInputValue(){
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function ensureDefaultHistoryDate(){
  const input = $("historyDate");
  if(input && !input.value) input.value = todayDateInputValue();
}

function profileName(){
  return currentProfile?.name || currentUser?.email?.split("@")[0] || "";
}

async function requireAdmin(){
  if(isAdmin()) return true;
  showSoftFeedback("Ação permitida somente para admin.", "warning");
  return false;
}

async function requireSupervisorOrAdmin(message = "Ação permitida somente para supervisor ou admin."){
  if(isAdmin() || isSupervisor()) return true;
  showSoftFeedback(message, "warning");
  return false;
}

function canAccessHistoryItem(item){
  return canSeeAllHistory();
}

function visibleHistory(){
  return historyCache.filter(canAccessHistoryItem);
}

function historyItemOwnerEmail(item){
  const t = item?.turno || {};
  return String(
    item?.operatorEmail ||
    item?.createdByEmail ||
    item?.email ||
    t.operatorEmail ||
    t.createdByEmail ||
    ""
  ).toLowerCase();
}

function isOwnHistoryItem(item){
  const currentEmail = String(currentUser?.email || "").toLowerCase();
  const ownerEmail = historyItemOwnerEmail(item);
  return !!currentEmail && !!ownerEmail && currentEmail === ownerEmail;
}

function lastOwnRealClosing(){
  const currentEmail = String(currentUser?.email || "").toLowerCase();
  if(!currentEmail) return null;

  return visibleHistory().find(item => {
    if(isAdjustmentItem(item)) return false;
    return historyItemOwnerEmail(item) === currentEmail;
  }) || null;
}

function canEditHistoryItem(item){
  if(!item) return false;
  if(isAdmin()) return true;
  if(isSupervisor()) return false;
  if(isAdjustmentItem(item)) return false;

  const lastOwn = lastOwnRealClosing();
  return !!lastOwn && lastOwn.id === item.id && isOwnHistoryItem(item);
}

function canDeleteHistoryItem(item){
  return isAdmin();
}

function isAdjustmentItem(item){
  const t = item?.turno || {};
  return item?.adjustment === true || item?.type === "capital_injection" || t.ajusteTipo === "carga_rapida";
}

function operationalHistory(){
  return visibleHistory().filter(item => !isAdjustmentItem(item));
}

function lastRealClosing(){
  return visibleHistory().find(item => !isAdjustmentItem(item)) || null;
}

function getAdjustmentParts(item){
  const t = item?.turno || {};

  const cargaPoker = moneyToNumber(t.cargasPoker || 0) * 400;
  const cargaCasino = moneyToNumber(t.cargasCasino ?? t.cargas ?? 0);

  let retiradaCaixa = 0;
  if(t.retiradaCaixa !== undefined){
    retiradaCaixa = moneyToNumber(t.retiradaCaixa);
  }else if(Array.isArray(t.outflows) && t.outflows.length){
    retiradaCaixa = t.outflows.reduce((s, x) => s + moneyToNumber(x.value), 0);
  }else{
    retiradaCaixa = moneyToNumber(t.saidasTotal ?? 0);
  }

  return { cargaPoker, cargaCasino, retiradaCaixa };
}

function adjustmentImpact(item){
  if(!isAdjustmentItem(item)) return 0;

  const { cargaPoker, cargaCasino, retiradaCaixa } = getAdjustmentParts(item);
  const impacto = cargaPoker + cargaCasino - retiradaCaixa;

  if(cargaPoker || cargaCasino || retiradaCaixa) return impacto;

  const t = item?.turno || {};
  return moneyToNumber(t.saldoLiquido ?? item?.diff ?? 0);
}

function baseForNextClosing(){
  const view = visibleHistory();
  const lastRealIndex = view.findIndex(item => !isAdjustmentItem(item));
  const lastReal = lastRealIndex >= 0 ? view[lastRealIndex] : null;
  if(!lastReal) return null;

  const lastRealBase = moneyToNumber(
    lastReal.turno?.baseOperacional ??
    lastReal.operationalBase ??
    calcularBaseOperacional(lastReal.turno || {})
  );

  const adjustmentsAfterLastReal = view
    .slice(0, lastRealIndex)
    .filter(isAdjustmentItem)
    .reduce((s, item) => s + adjustmentImpact(item), 0);

  return lastRealBase + adjustmentsAfterLastReal;
}

function latestInternalAdjustment(){
  return visibleHistory().find(isAdjustmentItem) || null;
}

function adjustmentDescription(item){
  if(!item) return "Sem ajuste";
  const value = adjustmentImpact(item);
  const t = item.turno || {};
  const reason = t.ajusteMotivo || item.adjustmentReason || "Ajuste interno";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMoney(value)} • ${reason}`;
}

function previousRealClosingAfter(currentItem){
  const view = visibleHistory();
  const idx = view.findIndex(x => x.id === currentItem?.id);
  const start = idx >= 0 ? idx + 1 : 0;
  return view.slice(start).find(item => !isAdjustmentItem(item)) || null;
}

function displayCashDiff(item){
  try{
    if(!item) return 0;

    if(isAdjustmentItem(item)){
      return adjustmentImpact(item);
    }

    const view = visibleHistory();
    const currentIndex = view.findIndex(x => x.id === item.id);
    const currentSaldo = moneyToNumber(item.turno?.saldoLiquido ?? item.currentSaldoTotal ?? 0);

    if(currentIndex < 0) return moneyToNumber(item.diff ?? 0);

    const prevRealIndex = view.findIndex((x, idx) => idx > currentIndex && !isAdjustmentItem(x));
    if(prevRealIndex < 0) return 0;

    const prevReal = view[prevRealIndex];
    const prevBase = moneyToNumber(
      prevReal.turno?.baseOperacional ??
      prevReal.operationalBase ??
      calcularBaseOperacional(prevReal.turno || {})
    );

    const internalAdjustments = view
      .slice(currentIndex + 1, prevRealIndex)
      .filter(isAdjustmentItem)
      .reduce((s, x) => s + adjustmentImpact(x), 0);

    const baseComparacao = prevBase + internalAdjustments;
    return currentSaldo - baseComparacao;
  }catch(error){
    console.warn("Erro displayCashDiff:", error);
    return 0;
  }
}

function getDynamicRows(containerId){
  const el = $(containerId);
  if(!el) return [];

  return [...el.querySelectorAll(".row-item")]
    .map(row => ({
      name: row.querySelector(".row-name")?.value || "",
      category: row.querySelector(".row-category")?.value || "",
      value: moneyToNumber(row.querySelector(".row-value")?.value || 0)
    }))
    .filter(x => x.name || x.value);
}

function setDynamicRows(containerId, rows = []){
  const el = $(containerId);
  if(!el) return;

  el.innerHTML = "";
  const defaultLabel = containerId.toLowerCase().includes("outflow") ? "Descrição" : "Nome / motivo";
  (rows.length ? rows : [{}]).forEach(r => createDynamicRow(containerId, defaultLabel, r));
}

function createDynamicRow(containerId, label = "Descrição", data = {}){
  const list = $(containerId);
  if(!list) return;

  const row = document.createElement("div");
  const isOutflow = containerId.toLowerCase().includes("outflow");
  row.className = "row-item" + (isOutflow ? " outflow-row" : "");

  const safeName = escapeHtml(String(data.name || ""));
  const value = data.value ? formatInputMoney(data.value) : "";
  const category = data.category || data.type || "lucro";

  row.innerHTML = isOutflow
    ? `<div class="row-field row-field-name"><input class="row-name" placeholder="${label}" value="${safeName}" /></div><div class="row-field row-field-category"><select class="row-category"><option value="lucro">Lucro</option><option value="custo_operacional">Custo operacional</option><option value="taxas_reba">Taxas Reba</option></select></div><div class="row-field row-field-value"><input class="row-value money-input" data-no-helper="1" inputmode="decimal" placeholder="0,00" value="${value}" /></div><button type="button" class="remove-row" aria-label="Remover linha">×</button>`
    : `<div class="row-field row-field-name"><input class="row-name" placeholder="${label}" value="${safeName}" /></div><div class="row-field row-field-value"><input class="row-value money-input" data-no-helper="1" inputmode="decimal" placeholder="0,00" value="${value}" /></div><button type="button" class="remove-row" aria-label="Remover linha">×</button>`;

  if(isOutflow) row.querySelector(".row-category").value = category;

  row.querySelectorAll("input,select").forEach(i => i.addEventListener("input", debouncedRenderCalculations));
  row.querySelectorAll("select").forEach(i => i.addEventListener("change", scheduleRenderCalculations));
  row.querySelector(".remove-row").onclick = () => {
    row.remove();
    scheduleRenderCalculations();
  };

  list.appendChild(row);
  applyBankMoneyMaskAll(row);
  enableClearOnFocus();
  scheduleRenderCalculations();
}

function getTurnFromForm(){
  const webReca = moneyToNumber($("webReca")?.value);
  const suprema = moneyToNumber($("suprema")?.value);
  const pppoker = moneyToNumber($("pppoker")?.value);
  const buffalo = moneyToNumber($("buffalo")?.value);
  const ganamos = moneyToNumber($("ganamos")?.value);

  const rawCargasPoker = moneyToNumber($("cargasPoker")?.value);
  const rawCargasCasino = moneyToNumber($("cargasCasino")?.value);

  const cargasPoker = canUseAdminClosingFields() ? rawCargasPoker : 0;
  const cargasCasino = canUseAdminClosingFields() ? rawCargasCasino : 0;

  const pendings = getDynamicRows("pendingList");
  const outflows = getDynamicRows("outflowList");

  const turno = {
    operatorName: $("operatorName")?.value.trim() || "",
    closingDate: $("closingDate")?.value || new Date().toISOString(),
    webReca,
    suprema,
    pppoker,
    buffalo,
    ganamos,
    cargasPoker,
    cargasCasino,
    pendings,
    outflows
  };

  return sanitizeTurnForPersistence(turno);
}

function calcularSaldoLiquido(turno = {}){
  const webReca = moneyToNumber(turno.webReca ?? turno.reca ?? turno.banco ?? 0);
  const suprema = moneyToNumber(turno.suprema ?? 0) * 400;
  const pppoker = moneyToNumber(turno.pppoker ?? 0) * 400;
  const buffalo = moneyToNumber(turno.buffalo ?? 0);
  const ganamos = moneyToNumber(turno.ganamos ?? 0);
  const cargasPoker = moneyToNumber(turno.cargasPoker ?? 0) * 400;
  const cargasCasino = moneyToNumber(turno.cargasCasino ?? turno.cargas ?? 0);
  const pendentes = moneyToNumber(turno.pendentesTotal ?? (turno.pendings || []).reduce((s, x) => s + moneyToNumber(x.value), 0));
  const saidas = moneyToNumber(turno.saidasTotal ?? (turno.outflows || []).reduce((s, x) => s + moneyToNumber(x.value), 0));

  return webReca + suprema + pppoker + buffalo + ganamos + cargasPoker + cargasCasino - pendentes + saidas;
}

function calcularBaseOperacional(turno = {}){
  const saldoLiquido = moneyToNumber(turno.saldoLiquido ?? calcularSaldoLiquido(turno));
  const saidas = moneyToNumber(turno.saidasTotal ?? (turno.outflows || []).reduce((s, x) => s + moneyToNumber(x.value), 0));
  return saldoLiquido - saidas;
}

function fillOperatorFromProfile(){
  const name = profileName() || currentUser?.email?.split("@")[0] || "";

  if($("operatorName")){
    $("operatorName").value = name;
    $("operatorName").readOnly = true;
  }

  if($("operatorEmailLabel")){
    $("operatorEmailLabel").textContent = currentUser?.email || "";
  }
}

function clearClosingForm(){
  ["webReca", "suprema", "pppoker", "buffalo", "ganamos", "cargasPoker", "cargasCasino"].forEach(id => {
    if($(id)) $(id).value = "";
  });

  if($("pendingList")) $("pendingList").innerHTML = "";
  if($("outflowList")) $("outflowList").innerHTML = "";

  initDate();
  fillOperatorFromProfile();
  scheduleRenderCalculations();
  showSoftFeedback("Formulário limpo para um novo fechamento.", "info");
}

function enableClearOnFocus(){
}

function setClosePanelState(panelId, buttonId, cardId, closedText = "Abrir", openText = "Ocultar"){
  const panel = $(panelId);
  const button = $(buttonId);
  const card = $(cardId);
  const open = !!panel?.classList.contains("active");

  card?.classList.toggle("is-open", open);
  if(button) button.textContent = open ? openText : closedText;
}

function updateCloseVisualState(turno = getTurnFromForm()){
  const monitoredIds = allowedCloseFieldIds();
  const filledCount = monitoredIds.filter(id => moneyToNumber($(id)?.value || 0) > 0).length;
  const pendingCount = (turno.pendings || []).length;
  const outflowCount = (turno.outflows || []).length;
  const visualSteps = monitoredIds.length + 2;
  const doneSteps = filledCount + (pendingCount > 0 ? 1 : 0) + (outflowCount > 0 ? 1 : 0);
  const progress = Math.max(0, Math.min(100, Math.round((doneSteps / visualSteps) * 100)));
  const hasBaseValues = monitoredIds.some(id => moneyToNumber($(id)?.value || 0) > 0);

  const statusEl = $("closeStatusBadge");
  if(statusEl){
    statusEl.classList.remove("is-idle", "is-ready", "is-alert");

    if(!hasBaseValues){
      statusEl.textContent = "Aguardando dados";
      statusEl.classList.add("is-idle");
    }else if(turno.saldoLiquido < 0){
      statusEl.textContent = "Conferir saldo";
      statusEl.classList.add("is-alert");
    }else{
      statusEl.textContent = "Pronto para revisar";
      statusEl.classList.add("is-ready");
    }
  }

  if($("closeFilledCount")) $("closeFilledCount").textContent = `${filledCount} / ${monitoredIds.length}`;
  if($("closePendingCount")) $("closePendingCount").textContent = `${pendingCount} ${pendingCount === 1 ? "item" : "itens"}`;
  if($("closeOutflowCount")) $("closeOutflowCount").textContent = `${outflowCount} ${outflowCount === 1 ? "item" : "itens"}`;
  if($("pendingCounter")) $("pendingCounter").textContent = pendingCount ? `${pendingCount} ${pendingCount === 1 ? "item aguardando baixa" : "itens aguardando baixa"}` : "0 itens aguardando baixa";
  if($("outflowCounter")) $("outflowCounter").textContent = outflowCount ? `${outflowCount} ${outflowCount === 1 ? "item lançado" : "itens lançados"}` : "0 itens lançados";
  if($("closeProgressLabel")) $("closeProgressLabel").textContent = `${progress}%`;
  if($("closeProgressFill")) $("closeProgressFill").style.width = `${progress}%`;

  if($("closeActionHint")){
    $("closeActionHint").textContent = !hasBaseValues
      ? "Preencha os valores do turno para revisar o fechamento."
      : (turno.pendentesTotal || turno.saidasTotal)
        ? "Revise pendentes e retiradas antes de salvar para conferir o resumo final."
        : "Resumo pronto para conferência final e salvamento.";
  }

  setClosePanelState("pendingPanel", "togglePendingBtn", "pendingCard", "Abrir", "Ocultar");
  setClosePanelState("outflowPanel", "toggleOutflowBtn", "outflowCard", "Abrir", "Ocultar");
  setClosePanelState("quickChargePanel", "toggleQuickChargeBtn", "quickChargeCard", "Mostrar", "Ocultar carga rápida");
}

function renderCalculations(){
  const turno = getTurnFromForm();

  const bindings = [
    ["calcSaldoLiquido", formatMoney(turno.saldoLiquido)],
    ["calcPendentes", formatMoney(turno.pendentesTotal)],
    ["calcSaidas", formatMoney(turno.saidasTotal)],
    ["calcLucroSaida", formatMoney(turno.retiradaLucroTotal || 0)],
    ["calcCustoSaida", formatMoney(turno.custoOperacionalTotal || 0)],
    ["calcCargaPoker", formatMoney((turno.cargasPoker || 0) * 400)],
    ["calcCargaCasino", formatMoney(turno.cargasCasino || 0)]
  ];

  bindings.forEach(([id, value]) => {
    const el = $(id);
    if(el && el.textContent !== value) el.textContent = value;
  });

  const saldoEl = $("calcSaldoLiquido");
  if(saldoEl){
    saldoEl.style.color = turno.saldoLiquido < 0 ? "#ef4444" : "#06152e";
  }

  if($("homeOperator")) $("homeOperator").textContent = profileName() || "-";
  updateCloseVisualState(turno);
}

function renderMonthlyGoal(){
  const card = $("monthlyGoalCard");
  if(!card) return;

  card.classList.remove("hidden");

  const target = moneyToNumber(
    currentProfile?.monthlyGoal ||
    currentProfile?.metaMensal ||
    45000000
  );

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthItems = visibleHistory().filter(item => {
    const d = item?.submittedAt?.toDate
      ? item.submittedAt.toDate()
      : new Date(item?.turno?.closingDate || item?.createdAt || 0);

    return !isNaN(d) && d >= monthStart;
  });

  const lucroDoItem = (item) => {
    const t = item?.turno || {};

    const direto = moneyToNumber(t.retiradaLucroTotal ?? 0);
    if(direto > 0) return direto;

    if(Array.isArray(t.outflows)){
      return t.outflows
        .filter(o => String(o.category || o.type || "").toLowerCase() === "lucro")
        .reduce((s, o) => s + moneyToNumber(o.value || 0), 0);
    }

    return 0;
  };

  const done = monthItems.reduce((s, item) => s + lucroDoItem(item), 0);

  const percent = target > 0
    ? Math.max(0, Math.min(100, (done / target) * 100))
    : 0;

  const remaining = Math.max(0, target - done);

  if($("monthlyGoalDone")) $("monthlyGoalDone").textContent = formatMoney(done);
  if($("monthlyGoalTarget")) $("monthlyGoalTarget").textContent = formatMoney(target);
  if($("monthlyGoalPercent")) $("monthlyGoalPercent").textContent = `${percent.toFixed(1)}%`;
  if($("monthlyGoalFill")) $("monthlyGoalFill").style.width = `${percent}%`;
  if($("monthlyGoalRemaining")) $("monthlyGoalRemaining").textContent = remaining > 0 ? `Faltam ${formatMoney(remaining)}` : "Meta alcançada";
  if($("monthlyGoalStatus")) $("monthlyGoalStatus").textContent = remaining > 0 ? "Em andamento" : "Meta batida";
}

function renderHome(){
  const homeScreen = $("screenHome");
  if(homeScreen) homeScreen.setAttribute("aria-busy", "true");

  try{
    const view = visibleHistory();
    const last = lastRealClosing() || view[0];
    const prev = last ? previousRealClosingAfter(last) : null;
    const saldoReca = last?.turno?.webReca ?? last?.turno?.reca ?? last?.webReca ?? 0;
    const saldoLiquido = last?.turno?.saldoLiquido ?? last?.currentSaldoTotal ?? 0;
    const pendentes = last?.turno?.pendentesTotal ?? 0;
    const diff = last ? displayCashDiff(last) : 0;

    if($("homeDiff")){
      $("homeDiff").textContent = formatMoney(diff);
      $("homeDiff").style.color = diff < 0 ? "#FF3B30" : "#16C784";
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const profitItems = visibleHistory();
    const lucroFromItem = (x) => moneyToNumber(x.turno?.retiradaLucroTotal ?? 0);
    const itemDate = (x) => x.submittedAt?.toDate ? x.submittedAt.toDate() : new Date(x.turno?.closingDate || x.createdAt || 0);

    const todayResult = profitItems
      .filter(x => {
        const d = itemDate(x);
        return !isNaN(d) && d >= todayStart;
      })
      .reduce((s, x) => s + lucroFromItem(x), 0);

    const weekResult = profitItems
      .filter(x => {
        const d = itemDate(x);
        return !isNaN(d) && d >= weekStart;
      })
      .reduce((s, x) => s + lucroFromItem(x), 0);

    if($("homeSaldoReca")) $("homeSaldoReca").textContent = formatMoney(saldoReca);
    if($("homeSaldoLiquido")) $("homeSaldoLiquido").textContent = formatMoney(saldoLiquido);
    if($("homePendentes")) $("homePendentes").textContent = formatMoney(pendentes);

    const pendCard = document.querySelector('[data-home-detail="pendentes"]');
    if(pendCard){
      pendCard.classList.remove("pending-blue", "pending-yellow", "pending-red");
      if(moneyToNumber(pendentes) < 500000) pendCard.classList.add("pending-blue");
      else if(moneyToNumber(pendentes) < 1000000) pendCard.classList.add("pending-yellow");
      else pendCard.classList.add("pending-red");
    }

    const latestAdjustment = latestInternalAdjustment();
    const adjustmentValue = latestAdjustment ? adjustmentImpact(latestAdjustment) : 0;

    if($("homeAdjustmentCard")) $("homeAdjustmentCard").classList.toggle("hidden", !canSeeInternalAdjustments());

    if($("homeInternalAdjustment")){
      $("homeInternalAdjustment").textContent = adjustmentDescription(latestAdjustment);
      $("homeInternalAdjustment").style.color = adjustmentValue < 0 ? "#FF3B30" : "#16C784";
    }

    const canSeeTodayProfit = canSeeTodayProfitCard();
    const canSeeWeeklyProfit = canSeeWeeklyProfitCard();

    if($("todayResultCard")) $("todayResultCard").classList.toggle("hidden", !canSeeTodayProfit);
    if($("weekResultCard")) $("weekResultCard").classList.toggle("hidden", !canSeeWeeklyProfit);

    if($("homeTodayResult")){
      $("homeTodayResult").textContent = formatMoney(todayResult);
      $("homeTodayResult").style.color = todayResult < 0 ? "#dc2626" : "#059669";
    }

    if($("homeWeekResult")){
      $("homeWeekResult").textContent = formatMoney(weekResult);
      $("homeWeekResult").style.color = weekResult < 0 ? "#dc2626" : "#059669";
    }

    if($("homeOperator")) $("homeOperator").textContent = last ? (last.operatorName || last.turno?.operatorName || "-") : "-";
    if($("homeLastClose")) $("homeLastClose").textContent = last ? dateLabel(last.submittedAt || last.createdAt || last.turno?.closingDate) : "-";
    if($("homeUpdatedAt")) $("homeUpdatedAt").textContent = last ? "Última atualização: " + dateLabel(last.submittedAt || last.createdAt) : "Aguardando fechamento";

    renderMonthlyGoal();
    renderChipsComparison(last, prev);
  }finally{
    if(homeScreen) homeScreen.setAttribute("aria-busy", "false");
  }
}

function renderChipsComparison(last, prev){
  const box = $("chipsComparison");
  if(!box) return;

  if(!last){
    box.innerHTML = `<div class="chips-empty">Nenhum fechamento para comparar.</div>`;
    return;
  }

  const lt = last.turno || {};
  const pt = prev?.turno || {};

  const items = [
    { label: "Suprema", key: "suprema", type: "chips" },
    { label: "PPPoker", key: "pppoker", type: "chips" },
    { label: "Buffalo", key: "buffalo", type: "money" },
    { label: "Ganamos", key: "ganamos", type: "money" }
  ];

  const fmtChips = (value) =>
    `${moneyToNumber(value).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} fichas`;

  const signText = (value) => value > 0 ? "+" : "";

  box.innerHTML = items.map(item => {
    const atual = moneyToNumber(lt[item.key] ?? 0);
    const anterior = moneyToNumber(pt[item.key] ?? 0);
    const diff = atual - anterior;
    const positive = diff >= 0;

    if(item.type === "chips"){
      return `<div class="chips-item ${positive ? "chips-positive" : "chips-negative"}">
        <div class="chips-simple-head"><strong>${item.label}</strong></div>
        <div class="chips-stack">
          <div class="chips-row"><span>Atual</span><strong>${fmtChips(atual)}</strong></div>
          <div class="chips-row"><span>Anterior</span><strong>${fmtChips(anterior)}</strong></div>
          <div class="chips-row chips-diff-row"><span>Fichas Diferença</span><strong class="${positive ? "chips-good" : "chips-bad"}">${signText(diff)}${fmtChips(diff)}</strong></div>
        </div>
      </div>`;
    }

    return `<div class="chips-item ${positive ? "chips-positive" : "chips-negative"}">
      <div class="chips-simple-head"><strong>${item.label}</strong></div>
      <div class="chips-stack">
        <div class="chips-row"><span>Atual</span><strong>${formatMoney(atual)}</strong></div>
        <div class="chips-row"><span>Anterior</span><strong>${formatMoney(anterior)}</strong></div>
        <div class="chips-row chips-diff-row"><span>Diferença</span><strong class="${positive ? "chips-good" : "chips-bad"}">${signText(diff)}${formatMoney(diff)}</strong></div>
      </div>
    </div>`;
  }).join("");
}
