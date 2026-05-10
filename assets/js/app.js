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

/* =========================================================
   COMPATIBILIDADE DE DOM ENTRE HTML NOVO E JS LEGADO
========================================================= */
const DOM_ALIASES = {
  screenHome: "homeScreen",
  screenClose: "closeScreen",
  screenHistory: "historyScreen",
  screenGoals: "goalsScreen",
  screenRanking: "rankingScreen",
  screenReports: "reportsScreen",
  screenAdmin: "adminScreen",

  closingDate: "closeDate",

  homeSaldoLiquido: "homeResultadoLiquido",
  homeTodayResult: "homeLucroDia",
  homeWeekResult: "homeLucroSemana",
  homeOperator: "homeLastOperator",
  homeLastClose: "homeReferenceDate",
  homeUpdatedAt: "homeReferenceDate",

  calcPendentes: "calcPendencias",
  closePendingCount: "pendingCounter",
  closeOutflowCount: "outflowCounter",
  closeProgressLabel: "closeFormStatus",
  closeActionHint: "closeFormStatus"
};

const $ = (id) => {
  if(!id) return null;
  return document.getElementById(id)
    || document.getElementById(DOM_ALIASES[id])
    || null;
};

const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

const appRefs = {
  app,
  auth,
  db
};

window.__BANK_APP_REFS__ = appRefs;

/* =========================================================
   ESTADO GLOBAL
========================================================= */
let currentUser = null;
let currentProfile = null;
let historyCache = [];
let historyUnsubscribe = null;
let systemUnsubscribe = null;
let currentRankRange = "day";
let historyRenderLimit = 12;
let editingHistoryId = null;

let calcRaf = 0;
let activeAsyncCount = 0;
const uiBusyMap = new WeakMap();

/* =========================================================
   UTILITÁRIOS BASE
========================================================= */
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

function syncBodyThemeState(){
  const shellVisible = !$("appShell")?.classList.contains("hidden");
  document.body.classList.toggle("is-authenticated", shellVisible);
  document.body.classList.toggle("is-guest", !shellVisible);
}

function safeSetText(id, value){
  const el = $(id);
  if(!el) return;
  el.textContent = value;
}

function safeSetHTML(id, value){
  const el = $(id);
  if(!el) return;
  el.innerHTML = value;
}

function safeToggle(id, shouldShow, hiddenClass = "hidden"){
  const el = $(id);
  if(!el) return;
  el.classList.toggle(hiddenClass, !shouldShow);
}

function screenEl(name){
  return $(name);
}

function setActiveScreen(screenId){
  const screens = [
    "homeScreen",
    "closeScreen",
    "historyScreen",
    "goalsScreen",
    "rankingScreen",
    "reportsScreen",
    "adminScreen"
  ];

  screens.forEach(id => {
    const el = screenEl(id);
    if(!el) return;
    const active = id === screenId;
    el.classList.toggle("hidden", !active);
    el.classList.toggle("active", active);
  });

  ["navHome", "navClose", "navHistory", "navMore"].forEach(id => {
    const btn = $(id);
    if(!btn) return;
    btn.classList.remove("active");
    btn.removeAttribute("aria-current");
  });

  if(screenId === "homeScreen" && $("navHome")){
    $("navHome").classList.add("active");
    $("navHome").setAttribute("aria-current", "page");
  }

  if(screenId === "closeScreen" && $("navClose")){
    $("navClose").classList.add("active");
    $("navClose").setAttribute("aria-current", "page");
  }

  if(screenId === "historyScreen" && $("navHistory")){
    $("navHistory").classList.add("active");
    $("navHistory").setAttribute("aria-current", "page");
  }

  if(
    ["goalsScreen", "rankingScreen", "reportsScreen", "adminScreen"].includes(screenId) &&
    $("navMore")
  ){
    $("navMore").classList.add("active");
    $("navMore").setAttribute("aria-current", "page");
  }
}

function closeMoreMenu(){
  safeToggle("moreMenu", false);
  safeToggle("moreMenuBackdrop", false);
  $("moreMenu")?.setAttribute("aria-hidden", "true");
}

function openMoreMenu(){
  safeToggle("moreMenu", true);
  safeToggle("moreMenuBackdrop", true);
  $("moreMenu")?.setAttribute("aria-hidden", "false");
}

/* =========================================================
   FEEDBACK / NOTICES / TOASTS
========================================================= */
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

function friendlyError(error){
  const code = error?.code || "";
  if(code.includes("permission-denied")) return "Permissão negada no Firestore. Ajuste as regras ou aprove este usuário como admin.";
  if(code.includes("auth/email-already-in-use")) return "Este email já está cadastrado. Use Entrar no sistema.";
  if(code.includes("auth/invalid-credential")) return "Email ou senha inválidos.";
  if(code.includes("auth/weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if(code.includes("auth/missing-password")) return "Digite sua senha para continuar.";
  if(code.includes("auth/invalid-email")) return "Digite um email válido.";
  return error?.message || String(error);
}

function handleUiError(error, targetId = ""){
  const message = friendlyError(error);
  if(targetId) showNotice(targetId, message, "error");
  showToast(message, "error");
  return message;
}

/* =========================================================
   LOADING GLOBAL / BOTÕES / SEÇÕES
========================================================= */
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

/* =========================================================
   FORMATAÇÃO / VALORES / MÁSCARAS
========================================================= */
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

function formatMoney(value){
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2
  }).format(Number(value) || 0);
}

window.formatMoney = formatMoney;

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
    helper.innerHTML = `<span>Digite só números</span><b>R$ 0,00</b>`;
    input.insertAdjacentElement("afterend", helper);
  }

  const updateVisual = () => {
    const value = moneyToNumber(input.value || 0);
    input.classList.toggle("input-filled", value > 0);
    input.classList.toggle("input-error", String(input.value || "").includes("-") || !Number.isFinite(value));
    const b = input.nextElementSibling?.querySelector?.("b");
    if(b) b.textContent = value > 0 ? formatMoney(value) : "R$ 0,00";
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
  return d.toISOString().slice(0, 10);
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

/* =========================================================
   AGENDA DE CÁLCULO (SEGURA PARA OS PRÓXIMOS BLOCOS)
========================================================= */
function scheduleRenderCalculations(){
  if(typeof renderCalculations !== "function") return;
  if(calcRaf) cancelAnimationFrame(calcRaf);
  calcRaf = requestAnimationFrame(() => {
    calcRaf = 0;
    renderCalculations();
  });
}

const debouncedRenderCalculations = debounce(() => {
  scheduleRenderCalculations();
}, 120);

/* =========================================================
   BLOCO 2 CONTINUA A PARTIR DAQUI
========================================================= */
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

/* =========================================================
   COMPATIBILIDADE DE DOM ENTRE HTML NOVO E JS LEGADO
========================================================= */
const DOM_ALIASES = {
  screenHome: "homeScreen",
  screenClose: "closeScreen",
  screenHistory: "historyScreen",
  screenGoals: "goalsScreen",
  screenRanking: "rankingScreen",
  screenReports: "reportsScreen",
  screenAdmin: "adminScreen",

  closingDate: "closeDate",

  homeSaldoLiquido: "homeResultadoLiquido",
  homeTodayResult: "homeLucroDia",
  homeWeekResult: "homeLucroSemana",
  homeOperator: "homeLastOperator",
  homeLastClose: "homeReferenceDate",
  homeUpdatedAt: "homeReferenceDate",

  calcPendentes: "calcPendencias",
  closePendingCount: "pendingCounter",
  closeOutflowCount: "outflowCounter",
  closeProgressLabel: "closeFormStatus",
  closeActionHint: "closeFormStatus"
};

const $ = (id) => {
  if(!id) return null;
  return document.getElementById(id)
    || document.getElementById(DOM_ALIASES[id])
    || null;
};

const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

window.__BANK_APP_REFS__ = { app, auth, db };

/* =========================================================
   ESTADO GLOBAL
========================================================= */
let currentUser = null;
let currentProfile = null;
let historyCache = [];
let historyUnsubscribe = null;
let systemUnsubscribe = null;
let currentRankRange = "day";
let historyRenderLimit = 12;
let editingHistoryId = null;

let calcRaf = 0;
let activeAsyncCount = 0;
const uiBusyMap = new WeakMap();

/* =========================================================
   UTILITÁRIOS BASE
========================================================= */
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

function syncBodyThemeState(){
  const shellVisible = !$("appShell")?.classList.contains("hidden");
  document.body.classList.toggle("is-authenticated", shellVisible);
  document.body.classList.toggle("is-guest", !shellVisible);
}

function safeSetText(id, value){
  const el = $(id);
  if(!el) return;
  el.textContent = value;
}

function safeSetHTML(id, value){
  const el = $(id);
  if(!el) return;
  el.innerHTML = value;
}

function safeToggle(id, shouldShow, hiddenClass = "hidden"){
  const el = $(id);
  if(!el) return;
  el.classList.toggle(hiddenClass, !shouldShow);
}

function screenEl(name){
  return $(name);
}

function setActiveScreen(screenId){
  const screens = [
    "homeScreen",
    "closeScreen",
    "historyScreen",
    "goalsScreen",
    "rankingScreen",
    "reportsScreen",
    "adminScreen"
  ];

  screens.forEach(id => {
    const el = screenEl(id);
    if(!el) return;
    const active = id === screenId;
    el.classList.toggle("hidden", !active);
    el.classList.toggle("active", active);
  });

  ["navHome", "navClose", "navHistory", "navMore"].forEach(id => {
    const btn = $(id);
    if(!btn) return;
    btn.classList.remove("active");
    btn.removeAttribute("aria-current");
  });

  if(screenId === "homeScreen" && $("navHome")){
    $("navHome").classList.add("active");
    $("navHome").setAttribute("aria-current", "page");
  }

  if(screenId === "closeScreen" && $("navClose")){
    $("navClose").classList.add("active");
    $("navClose").setAttribute("aria-current", "page");
  }

  if(screenId === "historyScreen" && $("navHistory")){
    $("navHistory").classList.add("active");
    $("navHistory").setAttribute("aria-current", "page");
  }

  if(["goalsScreen", "rankingScreen", "reportsScreen", "adminScreen"].includes(screenId) && $("navMore")){
    $("navMore").classList.add("active");
    $("navMore").setAttribute("aria-current", "page");
  }
}

function closeMoreMenu(){
  safeToggle("moreMenu", false);
  safeToggle("moreMenuBackdrop", false);
  $("moreMenu")?.setAttribute("aria-hidden", "true");
}

function openMoreMenu(){
  safeToggle("moreMenu", true);
  safeToggle("moreMenuBackdrop", true);
  $("moreMenu")?.setAttribute("aria-hidden", "false");
}

/* =========================================================
   FEEDBACK / NOTICES / TOASTS
========================================================= */
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

function friendlyError(error){
  const code = error?.code || "";
  if(code.includes("permission-denied")) return "Permissão negada no Firestore. Ajuste as regras ou aprove este usuário como admin.";
  if(code.includes("auth/email-already-in-use")) return "Este email já está cadastrado. Use Entrar no sistema.";
  if(code.includes("auth/invalid-credential")) return "Email ou senha inválidos.";
  if(code.includes("auth/weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if(code.includes("auth/missing-password")) return "Digite sua senha para continuar.";
  if(code.includes("auth/invalid-email")) return "Digite um email válido.";
  return error?.message || String(error);
}

function handleUiError(error, targetId = ""){
  const message = friendlyError(error);
  if(targetId) showNotice(targetId, message, "error");
  showToast(message, "error");
  return message;
}

/* =========================================================
   LOADING GLOBAL / BOTÕES / SEÇÕES
========================================================= */
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

/* =========================================================
   FORMATAÇÃO / VALORES / MÁSCARAS
========================================================= */
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

function formatMoney(value){
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2
  }).format(Number(value) || 0);
}

window.formatMoney = formatMoney;

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
    helper.innerHTML = `<span>Digite só números</span><b>R$ 0,00</b>`;
    input.insertAdjacentElement("afterend", helper);
  }

  const updateVisual = () => {
    const value = moneyToNumber(input.value || 0);
    input.classList.toggle("input-filled", value > 0);
    input.classList.toggle("input-error", String(input.value || "").includes("-") || !Number.isFinite(value));
    const b = input.nextElementSibling?.querySelector?.("b");
    if(b) b.textContent = value > 0 ? formatMoney(value) : "R$ 0,00";
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
  return d.toISOString().slice(0, 10);
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

function scheduleRenderCalculations(){
  if(typeof renderCalculations !== "function") return;
  if(calcRaf) cancelAnimationFrame(calcRaf);
  calcRaf = requestAnimationFrame(() => {
    calcRaf = 0;
    renderCalculations();
  });
}

const debouncedRenderCalculations = debounce(() => {
  scheduleRenderCalculations();
}, 120);

/* =========================================================
   PERFIL / PERMISSÕES
========================================================= */
function isBootstrapEmail(email){
  return BOOTSTRAP_ADMIN_EMAILS
    .map(x => x.toLowerCase())
    .includes(String(email || "").toLowerCase());
}

function profileName(){
  return currentProfile?.name || currentUser?.email?.split("@")[0] || "";
}

function isAdmin(){
  return currentProfile?.role === "admin" || currentProfile?.admin === true || isBootstrapEmail(currentUser?.email);
}

function isSupervisor(){
  return currentProfile?.role === "supervisor";
}

function isOperator(){
  return !!currentUser && !isAdmin() && !isSupervisor();
}

function canCloseTurn(){
  return !!currentUser || true;
}

function canSeeAllHistory(){
  return !!currentUser || true;
}

function canSeeInternalAdjustments(){
  return isAdmin() || isSupervisor();
}

function canUseAdminClosingFields(){
  return isAdmin() || isSupervisor();
}

function canPrintIndividualHistory(){
  return !!currentUser || true;
}

function canGenerateMonthlyPdf(){
  return isAdmin() || isSupervisor() || true;
}

function canSeeTodayProfitCard(){
  return !!currentUser || true;
}

function canSeeWeeklyProfitCard(){
  return isAdmin() || isSupervisor() || true;
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

/* =========================================================
   HISTÓRICO / ACESSO
========================================================= */
function canAccessHistoryItem(item){
  return canSeeAllHistory(item);
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

function isAdjustmentItem(item){
  const t = item?.turno || {};
  return item?.adjustment === true || item?.type === "capital_injection" || t?.ajusteTipo === "carga_rapida";
}

function operationalHistory(){
  return visibleHistory().filter(item => !isAdjustmentItem(item));
}

function lastRealClosing(){
  return operationalHistory()[0] || null;
}

function lastOwnRealClosing(){
  const currentEmail = String(currentUser?.email || "").toLowerCase();
  if(!currentEmail) return null;

  return operationalHistory().find(item => historyItemOwnerEmail(item) === currentEmail) || null;
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
  return cargaPoker + cargaCasino - retiradaCaixa;
}

function latestInternalAdjustment(){
  const found = visibleHistory().find(item => {
    const t = item?.turno || {};
    return moneyToNumber(t.internalAdjustment || 0) !== 0 || moneyToNumber(t.adminAdjustment || 0) !== 0;
  });

  if(!found) return 0;

  const t = found.turno || {};
  return moneyToNumber(t.internalAdjustment || 0) + moneyToNumber(t.adminAdjustment || 0);
}

/* =========================================================
   CÁLCULOS DE NEGÓCIO
========================================================= */
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

function outflowCategoryLabel(category){
  const value = String(category || "lucro").toLowerCase();
  if(value === "custo_operacional") return "Custo operacional";
  if(value === "taxas_reba") return "Taxas Reba";
  return "Lucro";
}

function calcularEntradas(turno = {}){
  const webReca = moneyToNumber(turno.webReca ?? turno.reca ?? 0);
  const suprema = moneyToNumber(turno.suprema ?? 0) * 400;
  const pppoker = moneyToNumber(turno.pppoker ?? 0) * 400;
  const buffalo = moneyToNumber(turno.buffalo ?? 0);
  const ganamos = moneyToNumber(turno.ganamos ?? 0);
  return webReca + suprema + pppoker + buffalo + ganamos;
}

function calcularAjustes(turno = {}){
  return moneyToNumber(turno.adminAdjustment ?? 0) + moneyToNumber(turno.internalAdjustment ?? 0);
}

function calcularSaldoLiquido(turno = {}){
  const entradas = calcularEntradas(turno);
  const pendentes = moneyToNumber(turno.pendentesTotal ?? turno.pendingAmount ?? 0);
  const saidas = moneyToNumber(turno.saidasTotal ?? turno.outflowAmount ?? 0);
  const ajustes = calcularAjustes(turno);
  return entradas - pendentes - saidas + ajustes;
}

function calcularBaseOperacional(turno = {}){
  const saldoLiquido = calcularSaldoLiquido(turno);
  const cargasPoker = moneyToNumber(turno.cargasPoker ?? 0) * 400;
  const cargasCasino = moneyToNumber(turno.cargasCasino ?? turno.cargas ?? 0);
  return saldoLiquido + cargasPoker + cargasCasino;
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
    ganamos: moneyToNumber(turno.ganamos ?? 0),
    adminAdjustment: moneyToNumber(turno.adminAdjustment ?? 0),
    internalAdjustment: moneyToNumber(turno.internalAdjustment ?? 0),
    notes: String(turno.notes ?? turno.closeNotes ?? "").trim()
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
  sanitized.entradasTotal = calcularEntradas(sanitized);
  sanitized.ajustesTotal = calcularAjustes(sanitized);
  sanitized.saldoReca = sanitized.entradasTotal;
  sanitized.saldoLiquido = calcularSaldoLiquido(sanitized);
  sanitized.baseOperacional = calcularBaseOperacional(sanitized);
  sanitized.resultadoFinal = sanitized.baseOperacional;

  return sanitized;
}

/* =========================================================
   LINHAS DINÂMICAS
========================================================= */
function getDynamicRows(containerId){
  const el = $(containerId);
  if(!el) return [];

  return [...el.querySelectorAll(".row-item")]
    .map(row => {
      const nameInput =
        row.querySelector('[data-field="name"]') ||
        row.querySelector(".row-name") ||
        row.querySelector('input[type="text"]');

      const valueInput =
        row.querySelector('[data-field="value"]') ||
        row.querySelector(".row-value") ||
        row.querySelector(".money-input") ||
        row.querySelector('input[type="number"]');

      const categoryInput =
        row.querySelector('[data-field="category"]') ||
        row.querySelector(".row-category") ||
        row.querySelector("select");

      return {
        name: String(nameInput?.value || "").trim(),
        value: moneyToNumber(valueInput?.value || 0),
        category: normalizeOutflowCategory(categoryInput?.value || "lucro")
      };
    })
    .filter(row => row.name || row.value);
}

function setDynamicRows(containerId, rows = []){
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = "";
  rows.forEach(row => el.appendChild(createDynamicRow(containerId, row)));
}

function createDynamicRow(containerId, row = {}){
  const isOutflow = String(containerId).toLowerCase().includes("outflow");
  const item = document.createElement("div");
  item.className = "row-item";
  item.style.display = "grid";
  item.style.gridTemplateColumns = isOutflow ? "1.1fr .9fr .8fr auto" : "1.2fr .8fr auto";
  item.style.gap = "10px";
  item.style.alignItems = "center";
  item.style.padding = "12px";
  item.style.borderRadius = "16px";
  item.style.background = "linear-gradient(180deg, #ffffff, #f8fbff)";
  item.style.border = "1px solid rgba(13, 27, 47, 0.08)";
  item.style.marginBottom = "10px";

  item.innerHTML = `
    <input data-field="name" class="row-name" type="text" placeholder="${isOutflow ? "Descrição da saída" : "Descrição da pendência"}" value="${escapeHtml(row.name || "")}" />
    ${isOutflow ? `
      <select data-field="category" class="row-category">
        <option value="lucro" ${normalizeOutflowCategory(row.category) === "lucro" ? "selected" : ""}>Lucro</option>
        <option value="custo_operacional" ${normalizeOutflowCategory(row.category) === "custo_operacional" ? "selected" : ""}>Custo operacional</option>
        <option value="taxas_reba" ${normalizeOutflowCategory(row.category) === "taxas_reba" ? "selected" : ""}>Taxas Reba</option>
      </select>
    ` : ""}
    <input data-field="value" class="money-input row-value" type="text" placeholder="0,00" value="${row.value ? formatInputMoney(row.value) : ""}" />
    <button type="button" class="remove-row" aria-label="Remover linha">×</button>
  `;

  const removeBtn = item.querySelector(".remove-row");
  removeBtn?.addEventListener("click", () => {
    item.remove();
    updateCloseVisualState();
    scheduleRenderCalculations();
  });

  applyBankMoneyMaskAll(item);

  item.querySelectorAll("input, select").forEach(el => {
    el.addEventListener("input", debouncedRenderCalculations);
    el.addEventListener("change", debouncedRenderCalculations);
  });

  return item;
}

/* =========================================================
   FORMULÁRIO DE FECHAMENTO
========================================================= */
function fillOperatorFromProfile(){
  const input = $("operatorName");
  if(!input) return;
  if(!input.value.trim()){
    input.value = profileName();
  }
}

function clearClosingForm(){
  const form = $("closeForm");
  if(form) form.reset();

  if($("closeDate")) $("closeDate").value = todayDateInputValue();
  if($("historyDate")) $("historyDate").value = todayDateInputValue();
  if($("operatorName")) $("operatorName").value = profileName();

  safeSetHTML("pendingList", "");
  safeSetHTML("outflowList", "");

  applyBankMoneyMaskAll();
  scheduleRenderCalculations();
  updateCloseVisualState();
}

function enableClearOnFocus(scope = document){
  scope.querySelectorAll(".money-input").forEach(input => {
    if(input.dataset.clearOnFocus === "1") return;
    input.dataset.clearOnFocus = "1";

    input.addEventListener("focus", () => {
      if(String(input.value).trim() === "0,00"){
        input.value = "";
      }
    });
  });
}

function getTurnFromForm(){
  const pendingRows = getDynamicRows("pendingList");
  const outflowRows = getDynamicRows("outflowList");

  const pendingAmount = moneyToNumber($("pendingAmount")?.value || 0);
  const outflowAmount = moneyToNumber($("outflowAmount")?.value || 0);

  if(pendingAmount > 0){
    pendingRows.unshift({
      name: "Pendência principal",
      value: pendingAmount
    });
  }

  if(outflowAmount > 0){
    outflowRows.unshift({
      name: "Saída principal",
      value: outflowAmount,
      category: "lucro"
    });
  }

  const turno = {
    operatorName: $("operatorName")?.value || "",
    closingDate: $("closeDate")?.value || $("closingDate")?.value || todayDateInputValue(),

    webReca: $("webReca")?.value || 0,
    suprema: $("suprema")?.value || 0,
    pppoker: $("pppoker")?.value || 0,
    buffalo: $("buffalo")?.value || 0,
    ganamos: $("ganamos")?.value || 0,

    cargasPoker: $("cargasPoker")?.value || 0,
    cargasCasino: $("cargasCasino")?.value || 0,

    adminAdjustment: $("adminAdjustment")?.value || 0,
    internalAdjustment: $("internalAdjustment")?.value || 0,

    closeNotes: $("closeNotes")?.value || "",
    notes: $("closeNotes")?.value || "",

    pendings: pendingRows,
    outflows: outflowRows
  };

  return sanitizeTurnForPersistence(turno);
}

/* =========================================================
   ESTADO VISUAL DO FECHAMENTO
========================================================= */
function updateCloseVisualState(){
  const monitoredIds = [
    "webReca",
    "suprema",
    "pppoker",
    "buffalo",
    "ganamos",
    "pendingAmount",
    "outflowAmount",
    "adminAdjustment",
    "internalAdjustment",
    "closeNotes"
  ];

  const filled = monitoredIds.reduce((count, id) => {
    const el = $(id);
    if(!el) return count;

    if(el.tagName === "TEXTAREA"){
      return count + (String(el.value || "").trim() ? 1 : 0);
    }

    return count + (moneyToNumber(el.value || 0) > 0 || String(el.value || "").trim() ? 1 : 0);
  }, 0);

  const pendingCount = getDynamicRows("pendingList").length + (moneyToNumber($("pendingAmount")?.value || 0) > 0 ? 1 : 0);
  const outflowCount = getDynamicRows("outflowList").length + (moneyToNumber($("outflowAmount")?.value || 0) > 0 ? 1 : 0);

  safeSetText("closeFilledCount", String(filled));
  safeSetText("pendingCounter", String(pendingCount));
  safeSetText("outflowCounter", String(outflowCount));

  let status = "Aguardando";
  if(filled >= 1) status = "Em andamento";
  if(filled >= 5) status = "Quase pronto";
  if(filled >= 8) status = "Pronto para salvar";

  safeSetText("closeFormStatus", status);
  safeSetText("closeStatusBadge", status);

  const badge = $("closeStatusBadge");
  if(badge){
    badge.classList.remove("status-ok", "status-warning", "status-neutral");
    if(status === "Pronto para salvar") badge.classList.add("status-ok");
    else if(status === "Em andamento" || status === "Quase pronto") badge.classList.add("status-warning");
    else badge.classList.add("status-neutral");
  }
}

function renderCalculations(){
  const turno = getTurnFromForm();

  const bindings = [
    ["calcSaldoReca", formatMoney(turno.saldoReca)],
    ["calcSaldoLiquido", formatMoney(turno.saldoLiquido)],
    ["calcBaseOperacional", formatMoney(turno.baseOperacional)],
    ["calcResultadoFinal", formatMoney(turno.resultadoFinal)],
    ["calcEntradas", formatMoney(turno.entradasTotal)],
    ["calcSaidas", formatMoney(turno.saidasTotal)],
    ["calcPendencias", formatMoney(turno.pendentesTotal)],
    ["calcAjustes", formatMoney(turno.ajustesTotal)],

    ["homeSaldoReca", formatMoney(turno.saldoReca)],
    ["homeSaldoGeral", formatMoney(turno.baseOperacional)],
    ["homeSaldoBanco", formatMoney(turno.saldoReca)],
    ["homeCapitalTotal", formatMoney(turno.baseOperacional)],
    ["homeResultadoLiquido", formatMoney(turno.saldoLiquido)],
    ["homeBaseOperacional", formatMoney(turno.baseOperacional)],
    ["homeDiff", formatMoney(turno.resultadoFinal)]
  ];

  bindings.forEach(([id, value]) => {
    const el = $(id);
    if(el && el.textContent !== value) el.textContent = value;
  });

  if(typeof window.updateHeroBalance === "function"){
    window.updateHeroBalance(turno.saldoReca);
  }

  updateCloseVisualState();
}

/* =========================================================
   HOME / METAS / COMPARAÇÃO
========================================================= */
function getTurnDate(item){
  const raw = item?.turno?.closingDate || item?.createdAt || item?.date || null;
  const d = raw?.toDate ? raw.toDate() : new Date(raw);
  return isNaN(d) ? null : d;
}

function isSameDay(a, b){
  return !!a && !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function isSameMonth(a, b){
  return !!a && !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth();
}

function isSameWeek(a, b){
  if(!a || !b) return false;
  const start = new Date(a);
  start.setHours(0,0,0,0);
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  return b >= start && b < end;
}

function renderMonthlyGoal(){
  const now = new Date();
  const items = operationalHistory();
  const monthItems = items.filter(item => isSameMonth(now, getTurnDate(item)));

  const done = monthItems.reduce((sum, item) => {
    const t = item?.turno || {};
    return sum + moneyToNumber(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0);
  }, 0);

  const target = moneyToNumber(currentProfile?.monthlyGoal || 0);
  const percent = target > 0 ? Math.min((done / target) * 100, 100) : 0;
  const remaining = Math.max(target - done, 0);

  safeSetText("monthlyGoalDone", formatMoney(done));
  safeSetText("monthlyGoalTarget", formatMoney(target));
  safeSetText("monthlyGoalPercent", `${percent.toFixed(1)}%`);
  safeSetText("monthlyGoalRemaining", formatMoney(remaining));
  safeSetText("monthlyGoalProgressValue", `${percent.toFixed(1)}%`);

  const progressBar = $("monthlyGoalProgressBar");
  if(progressBar) progressBar.style.width = `${percent}%`;

  const compatFill = $("monthlyGoalFill");
  if(compatFill) compatFill.style.width = `${percent}%`;

  const label =
    target <= 0
      ? "Meta ainda não definida."
      : percent >= 100
        ? "Meta atingida."
        : `Faltam ${formatMoney(remaining)} para bater a meta.`;

  safeSetText("monthlyGoalProgressLabel", label);
}

function renderHome(){
  const items = operationalHistory();
  const last = items[0] || null;
  const prev = items[1] || null;

  const now = new Date();

  const todayProfit = items
    .filter(item => isSameDay(now, getTurnDate(item)))
    .reduce((sum, item) => sum + moneyToNumber(item?.turno?.resultadoFinal ?? item?.turno?.baseOperacional ?? item?.turno?.saldoLiquido ?? 0), 0);

  const weekProfit = items
    .filter(item => isSameWeek(now, getTurnDate(item)))
    .reduce((sum, item) => sum + moneyToNumber(item?.turno?.resultadoFinal ?? item?.turno?.baseOperacional ?? item?.turno?.saldoLiquido ?? 0), 0);

  const bestResult = items.reduce((best, item) => {
    const v = moneyToNumber(item?.turno?.resultadoFinal ?? item?.turno?.baseOperacional ?? item?.turno?.saldoLiquido ?? 0);
    return Math.max(best, v);
  }, 0);

  const average = items.length
    ? items.reduce((sum, item) => sum + moneyToNumber(item?.turno?.resultadoFinal ?? item?.turno?.baseOperacional ?? item?.turno?.saldoLiquido ?? 0), 0) / items.length
    : 0;

  const adjustment = latestInternalAdjustment();

  const t = last?.turno || {};

  safeSetText("homeSaldoReca", formatMoney(t.saldoReca ?? 0));
  safeSetText("homeSaldoGeral", formatMoney(t.baseOperacional ?? t.resultadoFinal ?? t.saldoLiquido ?? 0));
  safeSetText("homeSaldoBanco", formatMoney(t.saldoReca ?? 0));
  safeSetText("homeCapitalTotal", formatMoney(t.baseOperacional ?? 0));
  safeSetText("homeResultadoLiquido", formatMoney(t.saldoLiquido ?? 0));
  safeSetText("homeBaseOperacional", formatMoney(t.baseOperacional ?? 0));

  safeSetText("homeLucroDia", formatMoney(todayProfit));
  safeSetText("homeLucroSemana", formatMoney(weekProfit));

  safeSetText("homeTotalClosings", String(items.length));
  safeSetText("homeDailyAverage", formatMoney(average));
  safeSetText("homeBestResult", formatMoney(bestResult));
  safeSetText("homeLastOperator", t.operatorName || "--");

  const reference = getTurnDate(last);
  safeSetText("homeReferenceDate", reference ? reference.toLocaleDateString("pt-BR") : "--/--/----");
  safeSetText("homeOperationalStatus", last ? "Último fechamento carregado" : "Sem dados");
  safeSetText("homePainelStatus", last ? "Estável" : "Aguardando dados");

  safeSetText("homeDiff", formatMoney(adjustment));
  safeSetText("homeInternalAdjustment", formatMoney(adjustment));

  const adjCard = $("homeAdjustmentCard");
  if(adjCard){
    adjCard.classList.toggle("hidden", adjustment === 0);
  }

  if($("todayResultCard")){
    $("todayResultCard").classList.toggle("hidden", !canSeeTodayProfitCard());
  }

  if($("weekResultCard")){
    $("weekResultCard").classList.toggle("hidden", !canSeeWeeklyProfitCard());
  }

  if(typeof window.updateHeroBalance === "function"){
    window.updateHeroBalance(moneyToNumber(t.saldoReca ?? 0));
  }

  renderMonthlyGoal();
  renderChipsComparison(last, prev);
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
    const current = moneyToNumber(lt[item.key] || 0);
    const previous = moneyToNumber(pt[item.key] || 0);
    const diff = current - previous;

    const currentLabel = item.type === "chips" ? fmtChips(current) : formatMoney(current);
    const previousLabel = item.type === "chips" ? fmtChips(previous) : formatMoney(previous);
    const diffLabel = item.type === "chips"
      ? `${signText(diff)}${fmtChips(diff)}`
      : `${signText(diff)}${formatMoney(diff)}`;

    const tone = diff > 0 ? "var(--success, #0f9f6e)" : diff < 0 ? "var(--danger, #c63f2f)" : "var(--text-soft, #64758b)";

    return `
      <div class="chips-item">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <strong style="font-size:14px;color:var(--text-strong,#0d1b2f);">${escapeHtml(item.label)}</strong>
          <span style="font-size:12px;font-weight:800;color:${tone};">${escapeHtml(diffLabel)}</span>
        </div>
        <div style="display:grid;gap:6px;margin-top:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <span style="font-size:12px;color:var(--text-soft,#64758b);">Atual</span>
            <strong style="font-size:13px;color:var(--text-strong,#0d1b2f);">${escapeHtml(currentLabel)}</strong>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <span style="font-size:12px;color:var(--text-soft,#64758b);">Anterior</span>
            <strong style="font-size:13px;color:var(--text-strong,#0d1b2f);">${escapeHtml(previousLabel)}</strong>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================================================
   NAVEGAÇÃO / SCAFFOLD LOCAL
========================================================= */
function bindScaffoldNavigation(){
  $("navHome")?.addEventListener("click", () => {
    closeMoreMenu();
    setActiveScreen("homeScreen");
  });

  $("navClose")?.addEventListener("click", () => {
    closeMoreMenu();
    setActiveScreen("closeScreen");
    scheduleRenderCalculations();
  });

  $("navHistory")?.addEventListener("click", () => {
    closeMoreMenu();
    setActiveScreen("historyScreen");
  });

  $("navMore")?.addEventListener("click", () => {
    const menu = $("moreMenu");
    const isHidden = menu?.classList.contains("hidden");
    if(isHidden) openMoreMenu();
    else closeMoreMenu();
  });

  $("moreMenuBtn")?.addEventListener("click", openMoreMenu);
  $("closeMoreMenuBtn")?.addEventListener("click", closeMoreMenu);
  $("moreMenuBackdrop")?.addEventListener("click", closeMoreMenu);

  $("goToCloseBtn")?.addEventListener("click", () => {
    setActiveScreen("closeScreen");
    closeMoreMenu();
    scheduleRenderCalculations();
  });

  $("goToHistoryBtn")?.addEventListener("click", () => {
    setActiveScreen("historyScreen");
    closeMoreMenu();
  });

  $("goToGoalsBtn")?.addEventListener("click", () => {
    setActiveScreen("goalsScreen");
    closeMoreMenu();
  });

  $("goToReportsBtn")?.addEventListener("click", () => {
    setActiveScreen("reportsScreen");
    closeMoreMenu();
  });

  $("menuGoalsBtn")?.addEventListener("click", () => {
    setActiveScreen("goalsScreen");
    closeMoreMenu();
  });

  $("menuRankingBtn")?.addEventListener("click", () => {
    setActiveScreen("rankingScreen");
    closeMoreMenu();
  });

  $("menuReportsBtn")?.addEventListener("click", () => {
    setActiveScreen("reportsScreen");
    closeMoreMenu();
  });

  $("menuAdminBtn")?.addEventListener("click", () => {
    setActiveScreen("adminScreen");
    closeMoreMenu();
  });
}

function bindCloseFormScaffold(){
  [
    "webReca",
    "suprema",
    "pppoker",
    "buffalo",
    "ganamos",
    "pendingAmount",
    "outflowAmount",
    "adminAdjustment",
    "internalAdjustment",
    "closeNotes",
    "operatorName",
    "closeDate"
  ].forEach(id => {
    const el = $(id);
    if(!el) return;
    el.addEventListener("input", debouncedRenderCalculations);
    el.addEventListener("change", debouncedRenderCalculations);
  });

  $("clearCloseFormBtn")?.addEventListener("click", clearClosingForm);
  $("clearClosingBtn")?.addEventListener("click", clearClosingForm);
  $("refreshHomeBtn")?.addEventListener("click", () => renderHome());
  $("refreshGoalsBtn")?.addEventListener("click", () => renderMonthlyGoal());
}

function initScaffold(){
  applyBankMoneyMaskAll();
  enableClearOnFocus();
  ensureDefaultHistoryDate();

  if($("closeDate") && !$("closeDate").value){
    $("closeDate").value = todayDateInputValue();
  }

  fillOperatorFromProfile();
  closeMoreMenu();
  syncBodyThemeState();
  setActiveScreen("homeScreen");
  bindScaffoldNavigation();
  bindCloseFormScaffold();
  scheduleRenderCalculations();
  renderHome();
}

document.addEventListener("DOMContentLoaded", initScaffold);

/* =========================================================
   BLOCO 3 VEM A PARTIR DAQUI:
   - auth real
   - login/logout
   - onAuthStateChanged
   - firestore CRUD
   - histórico render
   - modais
   - admin
   - relatórios
========================================================= */
const COLLECTION_CANDIDATES = {
  profiles: ["users", "profiles"],
  closings: ["closings", "fechamentos", "history", "turnos"],
  audit: ["audit_log", "auditLogs", "logs"]
};

const resolvedCollections = {
  profiles: null,
  closings: null,
  audit: null
};

let adminUsersCache = [];
let auditCache = [];
let auditUnsubscribe = null;
let reportPreviewCache = [];

function normalizeDateOnly(value){
  if(!value) return "";
  const d = value?.toDate ? value.toDate() : new Date(value);
  if(isNaN(d)) return "";
  const local = new Date(d);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function showLoginScreen(){
  safeToggle("loginScreen", true);
  safeToggle("appSplash", false);
  safeToggle("appShell", false);
  syncBodyThemeState();
}

function showSplash(message = "Carregando ambiente..."){
  safeToggle("loginScreen", false);
  safeToggle("appSplash", true);
  safeToggle("appShell", false);
  const text = $("appSplash")?.querySelector(".app-splash-text");
  if(text) text.textContent = message;
  syncBodyThemeState();
}

function showAppShell(){
  safeToggle("loginScreen", false);
  safeToggle("appSplash", false);
  safeToggle("appShell", true);
  syncBodyThemeState();
}

function getInitials(value){
  const name = String(value || "").trim();
  if(!name) return "BK";
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(x => x[0]?.toUpperCase() || "").join("") || "BK";
}

function updateTopbarUser(){
  const name = currentProfile?.name || currentUser?.displayName || currentUser?.email || "Usuário";
  safeSetText("topbarUserName", name);
  safeSetText("appStatusText", currentUser ? "Ambiente operacional ativo" : "Sessão encerrada");

  const avatar = $("topbarUserAvatar");
  if(avatar) avatar.textContent = getInitials(name);
}

async function resolveCollectionName(type){
  if(resolvedCollections[type]) return resolvedCollections[type];

  const candidates = COLLECTION_CANDIDATES[type] || [];
  for(const name of candidates){
    try{
      await getDocs(query(collection(db, name), limit(1)));
      resolvedCollections[type] = name;
      return name;
    }catch(_error){
      // tenta a próxima
    }
  }

  resolvedCollections[type] = candidates[0] || type;
  return resolvedCollections[type];
}

function sortByNewest(items = []){
  return [...items].sort((a, b) => {
    const da = getTurnDate(a)?.getTime?.() || 0;
    const dbb = getTurnDate(b)?.getTime?.() || 0;
    return dbb - da;
  });
}

async function getProfileDocForUser(user){
  const uid = user?.uid;
  if(!uid) return null;

  for(const name of COLLECTION_CANDIDATES.profiles){
    try{
      const snap = await getDoc(doc(db, name, uid));
      if(snap.exists()){
        resolvedCollections.profiles = name;
        return {
          id: snap.id,
          refCollection: name,
          data: snap.data()
        };
      }
    }catch(_error){
      // tenta próxima coleção
    }
  }

  return null;
}

async function ensureUserProfile(user){
  if(!user?.uid) return null;

  const existing = await getProfileDocForUser(user);
  if(existing){
    const profile = {
      uid: user.uid,
      email: user.email || "",
      ...existing.data
    };

    if(isBootstrapEmail(user.email) && !profile.admin){
      try{
        await setDoc(
          doc(db, existing.refCollection, user.uid),
          {
            ...profile,
            role: "admin",
            admin: true,
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
        profile.role = "admin";
        profile.admin = true;
      }catch(_error){
        // segue com o que tiver
      }
    }

    return profile;
  }

  const targetCollection = await resolveCollectionName("profiles");
  const fallbackName = user.displayName || user.email?.split("@")[0] || "Usuário";
  const profile = {
    uid: user.uid,
    email: user.email || "",
    name: fallbackName,
    role: isBootstrapEmail(user.email) ? "admin" : "operator",
    admin: isBootstrapEmail(user.email),
    monthlyGoal: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  try{
    await setDoc(doc(db, targetCollection, user.uid), profile, { merge: true });
  }catch(_error){
    // se falhar, ainda devolve um perfil local mínimo
  }

  return {
    uid: user.uid,
    email: user.email || "",
    name: fallbackName,
    role: isBootstrapEmail(user.email) ? "admin" : "operator",
    admin: isBootstrapEmail(user.email),
    monthlyGoal: 0
  };
}

async function logAudit(action, details = {}){
  try{
    const auditCollection = await resolveCollectionName("audit");
    await addDoc(collection(db, auditCollection), {
      action,
      details,
      userUid: currentUser?.uid || null,
      userEmail: currentUser?.email || null,
      userName: currentProfile?.name || null,
      createdAt: serverTimestamp()
    });
  }catch(_error){
    // log silencioso
  }
}

function getFilteredHistory(){
  let items = sortByNewest(visibleHistory());

  const search = String($("historySearch")?.value || "").trim().toLowerCase();
  const from = $("historyDateFrom")?.value || $("historyDate")?.value || "";
  const to = $("historyDateTo")?.value || "";

  if(search){
    items = items.filter(item => {
      const t = item?.turno || {};
      const haystack = [
        item.id,
        t.operatorName,
        item.operatorEmail,
        item.createdByEmail,
        t.notes,
        t.closeNotes,
        normalizeDateOnly(t.closingDate)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });
  }

  if(from){
    items = items.filter(item => {
      const d = normalizeDateOnly(getTurnDate(item));
      return d && d >= from;
    });
  }

  if(to){
    items = items.filter(item => {
      const d = normalizeDateOnly(getTurnDate(item));
      return d && d <= to;
    });
  }

  return items;
}

function buildHistoryCard(item){
  const t = item?.turno || {};
  const dateText = dateLabel(t.closingDate || item?.createdAt);
  const result = moneyToNumber(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0);
  const canEdit = canEditHistoryItem(item);
  const canDelete = canDeleteHistoryItem(item);

  return `
    <article class="history-item" data-history-id="${escapeHtml(item.id)}">
      <div style="display:grid;gap:12px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="min-width:0;">
            <strong style="display:block;font-size:16px;color:var(--text-strong,#0d1b2f);">
              ${escapeHtml(t.operatorName || "Sem operador")}
            </strong>
            <span style="display:block;margin-top:4px;font-size:12px;color:var(--text-soft,#64758b);">
              ${escapeHtml(dateText)}
            </span>
          </div>
          <div style="text-align:right;min-width:120px;">
            <span style="display:block;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--text-soft,#64758b);">
              Resultado
            </span>
            <strong style="display:block;margin-top:4px;font-size:16px;color:${result >= 0 ? "var(--success,#0f9f6e)" : "var(--danger,#c63f2f)"};">
              ${escapeHtml(formatMoney(result))}
            </strong>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">
          <div style="padding:12px;border-radius:14px;background:#f8fbff;border:1px solid rgba(13,27,47,.06);">
            <span style="display:block;font-size:11px;color:var(--text-soft,#64758b);font-weight:800;">Saldo reca</span>
            <strong style="display:block;margin-top:4px;color:var(--text-strong,#0d1b2f);">${escapeHtml(formatMoney(t.saldoReca ?? 0))}</strong>
          </div>
          <div style="padding:12px;border-radius:14px;background:#f8fbff;border:1px solid rgba(13,27,47,.06);">
            <span style="display:block;font-size:11px;color:var(--text-soft,#64758b);font-weight:800;">Base operacional</span>
            <strong style="display:block;margin-top:4px;color:var(--text-strong,#0d1b2f);">${escapeHtml(formatMoney(t.baseOperacional ?? 0))}</strong>
          </div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="small-btn history-receipt-btn" data-history-action="receipt" data-history-id="${escapeHtml(item.id)}">
            Recibo
          </button>
          ${canEdit ? `
            <button type="button" class="small-btn history-edit-btn" data-history-action="edit" data-history-id="${escapeHtml(item.id)}">
              Editar
            </button>
          ` : ""}
          ${canDelete ? `
            <button type="button" class="small-btn danger history-delete-btn" data-history-action="delete" data-history-id="${escapeHtml(item.id)}">
              Excluir
            </button>
          ` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderHistory(){
  const items = getFilteredHistory();
  const list = $("historyList");
  if(!list) return;

  safeSetText("historyVisibleCount", String(items.length));

  const last = items[0] || null;
  safeSetText("historyLastDate", last ? dateLabel(last?.turno?.closingDate || last?.createdAt) : "--");
  safeSetText("historyLastOperator", last?.turno?.operatorName || "--");
  safeSetText("historyStatusText", items.length ? "Pronto" : "Sem dados");
  safeSetText("historyPrintStatus", canPrintIndividualHistory() ? "Disponível" : "Indisponível");
  safeSetText("historyPdfStatus", canGenerateMonthlyPdf() ? "Disponível" : "Restrito");
  safeSetText("historyEditStatus", isAdmin() ? "Admin total" : isSupervisor() ? "Supervisor" : "Limitada");
  safeSetText("historyDeleteStatus", isAdmin() ? "Permitida" : "Restrita");

  if(!items.length){
    list.innerHTML = `<div class="history-empty-state">Nenhum fechamento encontrado com os filtros atuais.</div>`;
    return;
  }

  list.innerHTML = items
    .slice(0, historyRenderLimit)
    .map(buildHistoryCard)
    .join("");

  list.querySelectorAll("[data-history-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-history-action");
      const id = btn.getAttribute("data-history-id");
      const item = historyCache.find(x => x.id === id);
      if(!item) return;

      if(action === "receipt"){
        openReceiptModal(item);
      }

      if(action === "edit"){
        openEditModal(item);
      }

      if(action === "delete"){
        await handleDeleteHistoryItem(item);
      }
    });
  });
}

function getReceiptHtml(item){
  const t = item?.turno || {};
  const pendentes = Array.isArray(t.pendings) ? t.pendings : [];
  const saidas = Array.isArray(t.outflows) ? t.outflows : [];

  return `
    <div style="display:grid;gap:18px;">
      <div style="padding:16px;border-radius:18px;background:#f8fbff;border:1px solid rgba(13,27,47,.06);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <span style="display:block;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#64758b;">Operador</span>
            <strong style="display:block;margin-top:6px;font-size:18px;color:#0d1b2f;">${escapeHtml(t.operatorName || "--")}</strong>
          </div>
          <div style="text-align:right;">
            <span style="display:block;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#64758b;">Data</span>
            <strong style="display:block;margin-top:6px;font-size:15px;color:#0d1b2f;">${escapeHtml(dateLabel(t.closingDate || item?.createdAt))}</strong>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
        <div style="padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(13,27,47,.08);">
          <span style="display:block;font-size:11px;color:#64758b;font-weight:800;">Saldo reca</span>
          <strong style="display:block;margin-top:6px;color:#0d1b2f;">${escapeHtml(formatMoney(t.saldoReca ?? 0))}</strong>
        </div>
        <div style="padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(13,27,47,.08);">
          <span style="display:block;font-size:11px;color:#64758b;font-weight:800;">Saldo líquido</span>
          <strong style="display:block;margin-top:6px;color:#0d1b2f;">${escapeHtml(formatMoney(t.saldoLiquido ?? 0))}</strong>
        </div>
        <div style="padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(13,27,47,.08);">
          <span style="display:block;font-size:11px;color:#64758b;font-weight:800;">Base operacional</span>
          <strong style="display:block;margin-top:6px;color:#0d1b2f;">${escapeHtml(formatMoney(t.baseOperacional ?? 0))}</strong>
        </div>
        <div style="padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(13,27,47,.08);">
          <span style="display:block;font-size:11px;color:#64758b;font-weight:800;">Resultado final</span>
          <strong style="display:block;margin-top:6px;color:#0d1b2f;">${escapeHtml(formatMoney(t.resultadoFinal ?? 0))}</strong>
        </div>
      </div>

      <div style="display:grid;gap:12px;">
        <div>
          <span style="display:block;margin-bottom:8px;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#64758b;">Pendências</span>
          ${
            pendentes.length
              ? pendentes.map(row => `
                  <div style="display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:#fff;border:1px solid rgba(13,27,47,.06);margin-bottom:8px;">
                    <span>${escapeHtml(row.name || "Pendência")}</span>
                    <strong>${escapeHtml(formatMoney(row.value || 0))}</strong>
                  </div>
                `).join("")
              : `<div style="padding:12px;border-radius:12px;background:#f8fbff;border:1px dashed rgba(23,71,158,.18);color:#64758b;">Sem pendências registradas.</div>`
          }
        </div>

        <div>
          <span style="display:block;margin-bottom:8px;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#64758b;">Saídas</span>
          ${
            saidas.length
              ? saidas.map(row => `
                  <div style="display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:#fff;border:1px solid rgba(13,27,47,.06);margin-bottom:8px;">
                    <span>${escapeHtml(row.name || outflowCategoryLabel(row.category))}</span>
                    <strong>${escapeHtml(formatMoney(row.value || 0))}</strong>
                  </div>
                `).join("")
              : `<div style="padding:12px;border-radius:12px;background:#f8fbff;border:1px dashed rgba(23,71,158,.18);color:#64758b;">Sem saídas registradas.</div>`
          }
        </div>
      </div>

      ${
        t.notes || t.closeNotes
          ? `
            <div style="padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(13,27,47,.08);">
              <span style="display:block;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#64758b;">Observações</span>
              <p style="margin:8px 0 0;color:#24364d;line-height:1.6;">${escapeHtml(t.notes || t.closeNotes)}</p>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function openReceiptModal(item){
  const content = $("receiptContent");
  if(content){
    content.innerHTML = getReceiptHtml(item);
  }
  safeToggle("receiptModal", true);
  $("receiptModal")?.setAttribute("aria-hidden", "false");
}

function closeReceiptModal(){
  safeToggle("receiptModal", false);
  $("receiptModal")?.setAttribute("aria-hidden", "true");
}

function printHtmlContent(title, html){
  const popup = window.open("", "_blank", "width=900,height=700");
  if(!popup){
    showSoftFeedback("Não foi possível abrir a janela de impressão.", "warning");
    return;
  }

  popup.document.write(`
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <meta charset="utf-8" />
        <style>
          body{font-family:Inter,Arial,sans-serif;padding:24px;color:#0d1b2f;}
          *{box-sizing:border-box;}
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  popup.document.close();
  popup.focus();
  popup.print();
}

function fillEditFormFromItem(item){
  const t = item?.turno || {};
  if($("editOperatorName")) $("editOperatorName").value = t.operatorName || "";
  if($("editCloseDate")) $("editCloseDate").value = normalizeDateOnly(t.closingDate || item?.createdAt);
  if($("editSuprema")) $("editSuprema").value = t.suprema ? formatInputMoney(t.suprema) : "";
  if($("editPppoker")) $("editPppoker").value = t.pppoker ? formatInputMoney(t.pppoker) : "";
  if($("editBuffalo")) $("editBuffalo").value = t.buffalo ? formatInputMoney(t.buffalo) : "";
  if($("editGanamos")) $("editGanamos").value = t.ganamos ? formatInputMoney(t.ganamos) : "";
  if($("editPendingAmount")) $("editPendingAmount").value = t.pendentesTotal ? formatInputMoney(t.pendentesTotal) : "";
  if($("editOutflowAmount")) $("editOutflowAmount").value = t.saidasTotal ? formatInputMoney(t.saidasTotal) : "";
  if($("editCloseNotes")) $("editCloseNotes").value = t.notes || t.closeNotes || "";

  applyBankMoneyMaskAll($("editHistoryModal"));
}

function openEditModal(item){
  editingHistoryId = item?.id || null;
  if(!editingHistoryId) return;
  fillEditFormFromItem(item);
  safeToggle("editHistoryModal", true);
  $("editHistoryModal")?.setAttribute("aria-hidden", "false");
}

function closeEditModal(){
  editingHistoryId = null;
  safeToggle("editHistoryModal", false);
  $("editHistoryModal")?.setAttribute("aria-hidden", "true");
}

function getTurnFromEditForm(originalItem){
  const originalTurn = originalItem?.turno || {};

  const pendingAmount = moneyToNumber($("editPendingAmount")?.value || 0);
  const outflowAmount = moneyToNumber($("editOutflowAmount")?.value || 0);

  const turno = {
    ...originalTurn,
    operatorName: $("editOperatorName")?.value || originalTurn.operatorName || "",
    closingDate: $("editCloseDate")?.value || normalizeDateOnly(originalTurn.closingDate) || todayDateInputValue(),
    webReca: originalTurn.webReca ?? 0,
    suprema: $("editSuprema")?.value || 0,
    pppoker: $("editPppoker")?.value || 0,
    buffalo: $("editBuffalo")?.value || 0,
    ganamos: $("editGanamos")?.value || 0,
    cargasPoker: originalTurn.cargasPoker ?? 0,
    cargasCasino: originalTurn.cargasCasino ?? 0,
    adminAdjustment: originalTurn.adminAdjustment ?? 0,
    internalAdjustment: originalTurn.internalAdjustment ?? 0,
    closeNotes: $("editCloseNotes")?.value || "",
    notes: $("editCloseNotes")?.value || "",
    pendings: pendingAmount > 0 ? [{ name: "Pendência principal", value: pendingAmount }] : [],
    outflows: outflowAmount > 0 ? [{ name: "Saída principal", value: outflowAmount, category: "lucro" }] : []
  };

  return sanitizeTurnForPersistence(turno, originalTurn);
}

async function handleDeleteHistoryItem(item){
  if(!item?.id) return;
  if(!canDeleteHistoryItem(item)){
    showSoftFeedback("Você não tem permissão para excluir este item.", "warning");
    return;
  }

  const confirmed = window.confirm("Deseja excluir este fechamento?");
  if(!confirmed) return;

  try{
    const closingsCollection = await resolveCollectionName("closings");
    await deleteDoc(doc(db, closingsCollection, item.id));
    await logAudit("delete_closing", { closingId: item.id });
    showSoftFeedback("Fechamento excluído com sucesso.", "success");
  }catch(error){
    handleUiError(error);
  }
}

function buildUserCard(profile){
  const role = profile?.role || (profile?.admin ? "admin" : "operator");
  return `
    <article class="user-item">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
        <div style="min-width:0;">
          <strong style="display:block;color:#0d1b2f;font-size:15px;">${escapeHtml(profile?.name || "Sem nome")}</strong>
          <span style="display:block;margin-top:4px;color:#64758b;font-size:12px;">${escapeHtml(profile?.email || "--")}</span>
        </div>
        <span style="display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;border-radius:999px;background:#edf4ff;border:1px solid rgba(23,71,158,.1);font-size:11px;font-weight:900;color:#17479e;text-transform:uppercase;">
          ${escapeHtml(role)}
        </span>
      </div>
    </article>
  `;
}

function renderAdminUsers(){
  const list = $("adminUsersList");
  if(!list) return;

  if(!adminUsersCache.length){
    list.innerHTML = `<div class="history-empty-state">Nenhum usuário carregado.</div>`;
    return;
  }

  list.innerHTML = adminUsersCache
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"))
    .map(buildUserCard)
    .join("");
}

function renderAuditLog(){
  const list = $("auditLogList");
  if(!list) return;

  if(!auditCache.length){
    list.innerHTML = `<div class="history-empty-state">Nenhum log de auditoria disponível.</div>`;
    return;
  }

  list.innerHTML = auditCache.map(item => {
    const createdAt = item?.createdAt?.toDate ? item.createdAt.toDate() : new Date(item?.createdAt || 0);
    return `
      <article class="history-item">
        <div style="display:grid;gap:6px;">
          <strong style="color:#0d1b2f;">${escapeHtml(item.action || "evento")}</strong>
          <span style="font-size:12px;color:#64758b;">
            ${escapeHtml(item.userName || item.userEmail || "sistema")} • ${isNaN(createdAt) ? "--" : createdAt.toLocaleString("pt-BR")}
          </span>
        </div>
      </article>
    `;
  }).join("");
}

function getRankingBase(range = "day"){
  const now = new Date();
  let items = operationalHistory();

  if(range === "day"){
    items = items.filter(item => isSameDay(now, getTurnDate(item)));
  }else if(range === "week"){
    items = items.filter(item => isSameWeek(now, getTurnDate(item)));
  }else if(range === "month"){
    items = items.filter(item => isSameMonth(now, getTurnDate(item)));
  }

  const grouped = new Map();

  items.forEach(item => {
    const t = item?.turno || {};
    const key = t.operatorName || item?.operatorEmail || "Sem operador";
    const value = moneyToNumber(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0);

    grouped.set(key, (grouped.get(key) || 0) + value);
  });

  return [...grouped.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}

function buildRankingList(items){
  if(!items.length){
    return `<div class="history-empty-state">Sem dados para este período.</div>`;
  }

  return items.map((item, index) => `
    <article class="rank-item">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="display:flex;align-items:center;gap:12px;min-width:0;">
          <strong style="width:28px;height:28px;border-radius:10px;display:grid;place-items:center;background:#edf4ff;color:#17479e;font-size:12px;">${index + 1}</strong>
          <span style="font-weight:800;color:#0d1b2f;">${escapeHtml(item.name)}</span>
        </div>
        <strong style="color:#0f9f6e;">${escapeHtml(formatMoney(item.total))}</strong>
      </div>
    </article>
  `).join("");
}

function renderRanking(){
  const day = getRankingBase("day");
  const week = getRankingBase("week");
  const month = getRankingBase("month");
  const total = getRankingBase("total");

  safeSetText("rankingDailyLeader", day[0]?.name || "--");
  safeSetText("rankingWeeklyLeader", week[0]?.name || "--");
  safeSetText("rankingMonthlyLeader", month[0]?.name || "--");
  safeSetText("rankingTotalLeader", total[0]?.name || "--");

  safeSetHTML("rankingDailyList", buildRankingList(day));
  safeSetHTML("rankingWeeklyList", buildRankingList(week));
  safeSetHTML("rankingMonthlyList", buildRankingList(month));
  safeSetHTML("rankingTotalList", buildRankingList(total));
}

function getReportFilteredHistory(){
  let items = operationalHistory();

  const from = $("reportDateFrom")?.value || "";
  const to = $("reportDateTo")?.value || "";
  const operatorFilter = String($("reportOperatorFilter")?.value || "").trim().toLowerCase();

  if(from){
    items = items.filter(item => {
      const d = normalizeDateOnly(getTurnDate(item));
      return d && d >= from;
    });
  }

  if(to){
    items = items.filter(item => {
      const d = normalizeDateOnly(getTurnDate(item));
      return d && d <= to;
    });
  }

  if(operatorFilter){
    items = items.filter(item => {
      const name = String(item?.turno?.operatorName || "").toLowerCase();
      return name.includes(operatorFilter);
    });
  }

  return sortByNewest(items);
}

function renderReportPreview(){
  const items = getReportFilteredHistory();
  reportPreviewCache = items;

  const total = items.reduce((sum, item) => {
    const t = item?.turno || {};
    return sum + moneyToNumber(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0);
  }, 0);

  const average = items.length ? total / items.length : 0;

  safeSetText("reportPreviewCount", String(items.length));
  safeSetText("reportPreviewResult", formatMoney(total));
  safeSetText("reportPreviewAverage", formatMoney(average));

  const box = $("reportPreviewStats");
  if(!box) return;

  if(!items.length){
    box.innerHTML = `<div class="history-empty-state">Nenhum resultado para os filtros de relatório.</div>`;
    return;
  }

  box.innerHTML = items.slice(0, 20).map(item => {
    const t = item?.turno || {};
    const result = moneyToNumber(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0);
    return `
      <article class="report-preview-item">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="min-width:0;">
            <strong style="display:block;color:#0d1b2f;">${escapeHtml(t.operatorName || "Sem operador")}</strong>
            <span style="display:block;margin-top:4px;font-size:12px;color:#64758b;">${escapeHtml(dateLabel(t.closingDate || item?.createdAt))}</span>
          </div>
          <strong style="color:${result >= 0 ? "#0f9f6e" : "#c63f2f"};">${escapeHtml(formatMoney(result))}</strong>
        </div>
      </article>
    `;
  }).join("");
}

function exportTextFile(filename, content, mime = "text/plain;charset=utf-8"){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderAllDataViews(){
  renderCalculations();
  renderHome();
  renderHistory();
  renderRanking();
  renderReportPreview();
  renderAdminUsers();
  renderAuditLog();
}

async function subscribeHistoryRealtime(){
  const closingsCollection = await resolveCollectionName("closings");

  if(historyUnsubscribe){
    historyUnsubscribe();
    historyUnsubscribe = null;
  }

  historyUnsubscribe = onSnapshot(
    collection(db, closingsCollection),
    (snapshot) => {
      historyCache = sortByNewest(
        snapshot.docs.map(docSnap => ({
          id: docSnap.id,
          ...docSnap.data()
        }))
      );
      renderAllDataViews();
    },
    (error) => {
      handleUiError(error);
    }
  );
}

async function subscribeAuditRealtime(){
  const auditCollection = await resolveCollectionName("audit");

  if(auditUnsubscribe){
    auditUnsubscribe();
    auditUnsubscribe = null;
  }

  auditUnsubscribe = onSnapshot(
    collection(db, auditCollection),
    (snapshot) => {
      auditCache = snapshot.docs
        .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => {
          const da = a?.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
          const dbb = b?.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
          return dbb - da;
        })
        .slice(0, 30);

      renderAuditLog();
    },
    (_error) => {
      auditCache = [];
      renderAuditLog();
    }
  );
}

async function loadAdminUsers(){
  const collectionName = await resolveCollectionName("profiles");

  try{
    const snap = await getDocs(collection(db, collectionName));
    adminUsersCache = snap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
  }catch(_error){
    adminUsersCache = [];
  }

  renderAdminUsers();
}

async function handleLogin(){
  const email = String($("email")?.value || "").trim();
  const password = String($("password")?.value || "");

  hideNotice("loginNotice");

  if(!email){
    showNotice("loginNotice", "Digite seu email.", "error");
    return;
  }

  if(!password){
    showNotice("loginNotice", "Digite sua senha.", "error");
    return;
  }

  try{
    await withButtonLoading("loginBtn", async () => {
      await signInWithEmailAndPassword(auth, email, password);
    }, "Entrando...");
  }catch(error){
    handleUiError(error, "loginNotice");
  }
}

async function handleCreateAccount(){
  const email = String($("email")?.value || "").trim();
  const password = String($("password")?.value || "");

  hideNotice("loginNotice");

  if(!email){
    showNotice("loginNotice", "Digite um email válido para criar a conta.", "error");
    return;
  }

  if(password.length < 6){
    showNotice("loginNotice", "A senha precisa ter pelo menos 6 caracteres.", "error");
    return;
  }

  try{
    await withButtonLoading("createAccountBtn", async () => {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await ensureUserProfile(cred.user);
      await logAudit("create_self_account", { email });
    }, "Criando...");
    showSoftFeedback("Conta criada com sucesso. Faça o login para continuar.", "success", "loginNotice");
  }catch(error){
    handleUiError(error, "loginNotice");
  }
}

async function handleForgotPassword(){
  const email = String($("email")?.value || "").trim();

  hideNotice("loginNotice");

  if(!email){
    showNotice("loginNotice", "Digite seu email para recuperar a senha.", "error");
    return;
  }

  try{
    await withButtonLoading("forgotPasswordBtn", async () => {
      await sendPasswordResetEmail(auth, email);
    }, "Enviando...");
    showSoftFeedback("Email de recuperação enviado.", "success", "loginNotice");
  }catch(error){
    handleUiError(error, "loginNotice");
  }
}

async function handleLogout(){
  try{
    await withButtonLoading("logoutBtn", async () => {
      await logAudit("logout", {});
      await signOut(auth);
    }, "Saindo...");
  }catch(error){
    handleUiError(error);
  }
}

function bindAuthActions(){
  const loginBtn = $("loginBtn");
  if(loginBtn && loginBtn.dataset.bound !== "1"){
    loginBtn.dataset.bound = "1";
    loginBtn.addEventListener("click", handleLogin);
  }

  const createBtn = $("createAccountBtn");
  if(createBtn && createBtn.dataset.bound !== "1"){
    createBtn.dataset.bound = "1";
    createBtn.addEventListener("click", handleCreateAccount);
  }

  const forgotBtn = $("forgotPasswordBtn");
  if(forgotBtn && forgotBtn.dataset.bound !== "1"){
    forgotBtn.dataset.bound = "1";
    forgotBtn.addEventListener("click", handleForgotPassword);
  }

  const logoutBtn = $("logoutBtn");
  if(logoutBtn && logoutBtn.dataset.bound !== "1"){
    logoutBtn.dataset.bound = "1";
    logoutBtn.addEventListener("click", handleLogout);
  }

  $("password")?.addEventListener("keydown", (event) => {
    if(event.key === "Enter"){
      event.preventDefault();
      handleLogin();
    }
  });
}

async function getSecondaryAuth(){
  if(!window.__BANK_SECONDARY_APP__){
    window.__BANK_SECONDARY_APP__ = initializeApp(firebaseConfig, "bank-king-secondary");
    window.__BANK_SECONDARY_AUTH__ = getAuth(window.__BANK_SECONDARY_APP__);
  }
  return window.__BANK_SECONDARY_AUTH__;
}

async function handleAdminCreateUser(){
  if(!(await requireAdmin())) return;

  const name = String($("adminUserName")?.value || "").trim();
  const email = String($("adminUserEmail")?.value || "").trim();
  const password = String($("adminUserPassword")?.value || "");
  const role = String($("adminUserRole")?.value || "operator");

  if(!name || !email || password.length < 6){
    showSoftFeedback("Preencha nome, email e uma senha com pelo menos 6 caracteres.", "warning");
    return;
  }

  try{
    await withButtonLoading("createUserBtn", async () => {
      const secondaryAuth = await getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);

      const profilesCollection = await resolveCollectionName("profiles");
      await setDoc(doc(db, profilesCollection, cred.user.uid), {
        uid: cred.user.uid,
        email,
        name,
        role,
        admin: role === "admin",
        monthlyGoal: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });

      await signOut(secondaryAuth);

      if($("adminUserName")) $("adminUserName").value = "";
      if($("adminUserEmail")) $("adminUserEmail").value = "";
      if($("adminUserPassword")) $("adminUserPassword").value = "";
      if($("adminUserRole")) $("adminUserRole").value = "operator";

      await loadAdminUsers();
      await logAudit("admin_create_user", { email, role });
    }, "Criando...");

    showSoftFeedback("Usuário criado com sucesso.", "success");
  }catch(error){
    handleUiError(error);
  }
}

async function saveClosingRecord(){
  if(!canCloseTurn()){
    showSoftFeedback("Você não tem permissão para registrar fechamento.", "warning");
    return;
  }

  const turno = getTurnFromForm();

  if(!turno.operatorName){
    showSoftFeedback("Informe o operador antes de salvar.", "warning");
    return;
  }

  const closingsCollection = await resolveCollectionName("closings");

  const payload = {
    turno,
    operatorEmail: currentUser?.email || null,
    createdByEmail: currentUser?.email || null,
    createdByUid: currentUser?.uid || null,
    role: currentProfile?.role || "operator",
    adjustment: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  try{
    let createdId = null;

    await withButtonLoading("saveClosingBtn", async () => {
      const ref = await addDoc(collection(db, closingsCollection), payload);
      createdId = ref.id;
    }, "Salvando...");

    if($("saveClosingBtnTop")){
      await withButtonLoading("saveClosingBtnTop", async () => Promise.resolve(), "Salvando...");
    }

    const receiptItem = {
      id: createdId,
      ...payload,
      turno
    };

    openReceiptModal(receiptItem);
    await logAudit("save_closing", { closingId: createdId, operatorName: turno.operatorName });
    showSoftFeedback("Fechamento salvo com sucesso.", "success");
    clearClosingForm();
  }catch(error){
    handleUiError(error);
  }
}

async function saveEditedHistoryItem(){
  if(!editingHistoryId){
    showSoftFeedback("Nenhum registro selecionado para edição.", "warning");
    return;
  }

  const item = historyCache.find(x => x.id === editingHistoryId);
  if(!item){
    showSoftFeedback("Registro não encontrado para edição.", "warning");
    return;
  }

  if(!canEditHistoryItem(item) && !isAdmin()){
    showSoftFeedback("Você não tem permissão para editar este registro.", "warning");
    return;
  }

  try{
    const closingsCollection = await resolveCollectionName("closings");
    const turno = getTurnFromEditForm(item);

    await withButtonLoading("saveEditBtn", async () => {
      await updateDoc(doc(db, closingsCollection, editingHistoryId), {
        turno,
        updatedAt: serverTimestamp()
      });
    }, "Salvando...");

    await logAudit("edit_closing", { closingId: editingHistoryId });
    closeEditModal();
    showSoftFeedback("Registro atualizado com sucesso.", "success");
  }catch(error){
    handleUiError(error);
  }
}

function bindHistoryControls(){
  [
    "historySearch",
    "historyDateFrom",
    "historyDateTo"
  ].forEach(id => {
    const el = $(id);
    if(!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("input", debounce(renderHistory, 180));
    el.addEventListener("change", renderHistory);
  });

  $("applyHistoryFilterBtn")?.addEventListener("click", renderHistory);
  $("clearHistoryFilterBtn")?.addEventListener("click", () => {
    if($("historySearch")) $("historySearch").value = "";
    if($("historyDateFrom")) $("historyDateFrom").value = "";
    if($("historyDateTo")) $("historyDateTo").value = "";
    renderHistory();
  });

  $("printHistoryBtn")?.addEventListener("click", () => {
    const html = $("historyList")?.innerHTML || "<p>Sem dados.</p>";
    printHtmlContent("Histórico de fechamentos", html);
  });

  $("historyPdfBtn")?.addEventListener("click", () => {
    const items = getFilteredHistory();
    const content = items.map(item => {
      const t = item?.turno || {};
      return [
        `Operador: ${t.operatorName || "--"}`,
        `Data: ${dateLabel(t.closingDate || item?.createdAt)}`,
        `Resultado: ${formatMoney(t.resultadoFinal ?? t.baseOperacional ?? t.saldoLiquido ?? 0)}`,
        `Saldo reca: ${formatMoney(t.saldoReca ?? 0)}`,
        ""
      ].join("\n");
    }).join("\n");

    exportTextFile("historico-fechamentos.txt", content || "Sem dados.");
    showSoftFeedback("Exportação do histórico gerada em TXT.", "success");
  });
}

function bindReceiptControls(){
  $("closeReceiptModalBtn")?.addEventListener("click", closeReceiptModal);

  $("printReceiptBtn")?.addEventListener("click", () => {
    const html = $("receiptContent")?.innerHTML || "<p>Sem conteúdo.</p>";
    printHtmlContent("Comprovante de fechamento", html);
  });

  $("exportReceiptBtn")?.addEventListener("click", () => {
    const text = ($("receiptContent")?.textContent || "Sem conteúdo.").trim();
    exportTextFile("comprovante-fechamento.txt", text);
    showSoftFeedback("Comprovante exportado em TXT.", "success");
  });

  $("receiptModal")?.addEventListener("click", (event) => {
    if(event.target?.id === "receiptModal"){
      closeReceiptModal();
    }
  });
}

function bindEditControls(){
  $("closeEditModalBtn")?.addEventListener("click", closeEditModal);
  $("saveEditBtn")?.addEventListener("click", saveEditedHistoryItem);

  $("deleteHistoryBtn")?.addEventListener("click", async () => {
    if(!editingHistoryId) return;
    const item = historyCache.find(x => x.id === editingHistoryId);
    if(!item) return;
    await handleDeleteHistoryItem(item);
    closeEditModal();
  });

  $("editHistoryModal")?.addEventListener("click", (event) => {
    if(event.target?.id === "editHistoryModal"){
      closeEditModal();
    }
  });
}

function bindReportControls(){
  ["reportDateFrom", "reportDateTo", "reportOperatorFilter"].forEach(id => {
    const el = $(id);
    if(!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("input", debounce(renderReportPreview, 180));
    el.addEventListener("change", renderReportPreview);
  });

  $("previewReportBtn")?.addEventListener("click", renderReportPreview);

  $("generateReportBtn")?.addEventListener("click", () => {
    const lines = reportPreviewCache.map(item => {
      const t = item?.turno || {};
      return [
        `Operador: ${t.operatorName || "--"}`,
        `Data: ${dateLabel(t.closingDate || item?.createdAt)}`,
        `Saldo reca: ${formatMoney(t.saldoReca ?? 0)}`,
        `Saldo líquido: ${formatMoney(t.saldoLiquido ?? 0)}`,
        `Base operacional: ${formatMoney(t.baseOperacional ?? 0)}`,
        `Resultado final: ${formatMoney(t.resultadoFinal ?? 0)}`,
        "-----------------------------"
      ].join("\n");
    }).join("\n");

    exportTextFile("relatorio-fechamentos.txt", lines || "Sem dados.");
    showSoftFeedback("Relatório exportado em TXT.", "success");
  });

  $("generatePdfReportBtn")?.addEventListener("click", () => {
    const html = $("reportPreviewStats")?.innerHTML || "<p>Sem dados.</p>";
    printHtmlContent("Prévia de relatório", html);
  });
}

function bindAdminControls(){
  $("createUserBtn")?.addEventListener("click", handleAdminCreateUser);
}

function bindClosingSaveControls(){
  $("saveClosingBtn")?.addEventListener("click", saveClosingRecord);
  $("saveClosingBtnTop")?.addEventListener("click", saveClosingRecord);
}

function registerServiceWorkerIfAvailable(){
  if(!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // segue sem SW
    });
  });
}

async function handleAuthenticatedUser(user){
  currentUser = user;
  showSplash("Carregando perfil e dados...");
  currentProfile = await ensureUserProfile(user);
  updateTopbarUser();
  fillOperatorFromProfile();
  showAppShell();

  await Promise.allSettled([
    subscribeHistoryRealtime(),
    subscribeAuditRealtime(),
    loadAdminUsers()
  ]);

  renderAllDataViews();
}

function handleSignedOutUser(){
  currentUser = null;
  currentProfile = null;
  historyCache = [];
  adminUsersCache = [];
  auditCache = [];

  if(historyUnsubscribe){
    historyUnsubscribe();
    historyUnsubscribe = null;
  }

  if(auditUnsubscribe){
    auditUnsubscribe();
    auditUnsubscribe = null;
  }

  closeMoreMenu();
  closeEditModal();
  closeReceiptModal();

  showLoginScreen();
  renderAllDataViews();
  updateTopbarUser();
}

function bootstrapAuthState(){
  onAuthStateChanged(auth, async (user) => {
    try{
      if(user){
        await handleAuthenticatedUser(user);
      }else{
        handleSignedOutUser();
      }
    }catch(error){
      handleUiError(error, "loginNotice");
      handleSignedOutUser();
    }
  });
}

function bootstrapFinalLayer(){
  bindAuthActions();
  bindHistoryControls();
  bindReceiptControls();
  bindEditControls();
  bindReportControls();
  bindAdminControls();
  bindClosingSaveControls();
  registerServiceWorkerIfAvailable();
  bootstrapAuthState();
}

document.addEventListener("DOMContentLoaded", bootstrapFinalLayer);
