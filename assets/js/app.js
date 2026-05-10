import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
    import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
    import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

    import { firebaseConfig, BOOTSTRAP_ADMIN_EMAILS } from "./config/firebase-config.js";


    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const $ = (id) => document.getElementById(id);

    let currentUser = null, currentProfile = null, historyCache = [], historyUnsubscribe = null, systemUnsubscribe = null, currentRankRange = "day";
    let historyRenderLimit = 30;

    function syncBodyThemeState(){
      const shellVisible = !$("appShell")?.classList.contains("hidden");
      document.body.classList.toggle("is-authenticated", shellVisible);
      document.body.classList.toggle("is-guest", !shellVisible);
    }

    function showNotice(targetId, message, type="error"){
      const el = $(targetId); if(!el) return;
      el.className = `notice ${type}`; el.textContent = message; el.classList.remove("hidden");
    }
    function hideNotice(targetId){ $(targetId)?.classList.add("hidden"); }
    function friendlyError(error){
      const code = error?.code || "";
      if(code.includes("permission-denied")) return "Permissão negada no Firestore. Ajuste as regras ou aprove este usuário como admin.";
      if(code.includes("auth/email-already-in-use")) return "Este email já está cadastrado. Use Entrar no sistema.";
      if(code.includes("auth/invalid-credential")) return "Email ou senha inválidos.";
      if(code.includes("auth/weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
      return error?.message || String(error);
    }

    function moneyToNumber(value){
      if(value === null || value === undefined) return 0; if(typeof value === "number") return value;
      let s = String(value).trim().replace(/[^0-9,.-]/g, ""); if(!s) return 0;
      const hasComma = s.includes(","), hasDot = s.includes(".");
      if(hasComma && hasDot){ const lastComma=s.lastIndexOf(","), lastDot=s.lastIndexOf("."); s = lastComma > lastDot ? s.split(".").join("").replace(",",".") : s.split(",").join(""); }
      else if(hasComma){ s = s.split(".").join("").replace(",","."); }
      const n = Number(s); return Number.isFinite(n) ? n : 0;
    }

    function formatInputMoney(value){
      const n = moneyToNumber(value);
      if(!n) return "";
      return n.toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 });
    }

    function applyBankMoneyMask(input){
      if(!input) return;
      input.classList.add("money-input");
      input.setAttribute("autocomplete","off");
      input.setAttribute("inputmode","decimal");

      if(!input.nextElementSibling || !input.nextElementSibling.classList?.contains("input-helper")){
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
          input.dispatchEvent(new Event("bankmoney", { bubbles:true }));
          return;
        }
        const number = Number(digits) / 100;
        input.value = number.toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 });
        updateVisual();
        input.dispatchEvent(new Event("bankmoney", { bubbles:true }));
      });

      input.addEventListener("focus", () => {
        input.select?.();
        updateVisual();
      });

      input.addEventListener("blur", () => {
        if(input.value) input.value = formatInputMoney(input.value);
        updateVisual();
      });

      updateVisual();
    }

    function applyBankMoneyMaskAll(scope=document){
      scope.querySelectorAll(".money-input").forEach(input => {
        if(input.dataset.bankMask === "1") return;
        input.dataset.bankMask = "1";
        applyBankMoneyMask(input);
      });
    }

    function formatMoney(value){ return new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",minimumFractionDigits:2}).format(Number(value)||0); }
    function dateLabel(value){ if(!value) return "-"; const d = value?.toDate ? value.toDate() : new Date(value); if(isNaN(d)) return "-"; return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"}); }
    function toDateInputValue(value){ const d = value?.toDate ? value.toDate() : new Date(value || Date.now()); if(isNaN(d)) return ""; d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }

    function isBootstrapEmail(email){ return BOOTSTRAP_ADMIN_EMAILS.map(x=>x.toLowerCase()).includes(String(email||"").toLowerCase()); }
    function isAdmin(){ return currentProfile?.role === "admin" || currentProfile?.admin === true; }
    function isSupervisor(){ return currentProfile?.role === "supervisor"; }
    function profileName(){ return currentProfile?.name || currentUser?.email?.split("@")[0] || ""; }
    async function requireAdmin(){ if(isAdmin()) return true; alert("Ação permitida somente para admin."); return false; }

    function canAccessHistoryItem(item){
      // Histórico liberado para todos os usuários aprovados.
      // Admin pode gerenciar tudo. Operador só edita o próprio último fechamento real.
      return true;
    }

    function visibleHistory(){ return historyCache.filter(canAccessHistoryItem); }

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

      // Admin sempre edita.
      if(isAdmin()) return true;

      // Ajustes/carga rápida ficam somente para admin.
      if(isAdjustmentItem(item)) return false;

      // Operador só edita o próprio último fechamento real.
      const lastOwn = lastOwnRealClosing();
      return !!lastOwn && lastOwn.id === item.id && isOwnHistoryItem(item);
    }

    function canDeleteHistoryItem(item){
      // Exclusão fica somente para admin.
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
        retiradaCaixa = t.outflows.reduce((s,x)=>s + moneyToNumber(x.value),0);
      }else{
        retiradaCaixa = moneyToNumber(t.saidasTotal ?? 0);
      }

      return { cargaPoker, cargaCasino, retiradaCaixa };
    }

    function adjustmentImpact(item){
      if(!isAdjustmentItem(item)) return 0;

      const { cargaPoker, cargaCasino, retiradaCaixa } = getAdjustmentParts(item);
      const impacto = cargaPoker + cargaCasino - retiradaCaixa;

      // Se tiver campos de ajuste, essa é a fonte da verdade.
      if(cargaPoker || cargaCasino || retiradaCaixa) return impacto;

      // Fallback para ajuste antigo sem estrutura.
      const t = item?.turno || {};
      return moneyToNumber(t.saldoLiquido ?? item?.diff ?? 0);
    }

    function baseForNextClosing(){
      // BASE OPERACIONAL FINAL:
      // 1) Fechamento real passa para o próximo turno como: saldoLiquido - retiradas.
      // 2) Ajuste interno altera essa base.
      // 3) Diff do próximo fechamento compara saldoLiquido atual contra essa base.
      const view = visibleHistory();
      const lastRealIndex = view.findIndex(item => !isAdjustmentItem(item));
      const lastReal = lastRealIndex >= 0 ? view[lastRealIndex] : null;
      if(!lastReal) return null;

      const lastRealBase = moneyToNumber(lastReal.turno?.baseOperacional ?? lastReal.operationalBase ?? calcularBaseOperacional(lastReal.turno || {}));
      const adjustmentsAfterLastReal = view
        .slice(0, lastRealIndex)
        .filter(isAdjustmentItem)
        .reduce((s,item)=>s + adjustmentImpact(item), 0);

      return lastRealBase + adjustmentsAfterLastReal;
    }

    function latestInternalAdjustment(){
      return visibleHistory().find(isAdjustmentItem) || null;
    }

    function adjustmentDescription(item){
      if(!item) return "Sem ajuste";
      const t = item.turno || {};
      const value = adjustmentImpact(item);
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

        // Ajustes internos entre o fechamento anterior e o fechamento atual
        // entram na base, mas não entram como lucro/diferença operacional.
        const internalAdjustments = view
          .slice(currentIndex + 1, prevRealIndex)
          .filter(isAdjustmentItem)
          .reduce((s,x)=>s + adjustmentImpact(x), 0);

        const baseComparacao = prevBase + internalAdjustments;
        return currentSaldo - baseComparacao;
      }catch(e){
        console.warn("Erro displayCashDiff:", e);
        return 0;
      }
    }

    function getDynamicRows(containerId){ const el=$(containerId); if(!el) return []; return [...el.querySelectorAll(".row-item")].map(row=>({name:row.querySelector(".row-name")?.value||"",category:row.querySelector(".row-category")?.value||"",value:moneyToNumber(row.querySelector(".row-value")?.value||0)})).filter(x=>x.name||x.value); }
    function setDynamicRows(containerId, rows=[]){ const el=$(containerId); if(!el) return; el.innerHTML=""; (rows.length?rows:[{}]).forEach(r=>createDynamicRow(containerId,"Nome / motivo",r)); }
    function createDynamicRow(containerId,label="Descrição",data={}){ const list=$(containerId); if(!list) return; const row=document.createElement("div"); const isOutflow=containerId.toLowerCase().includes("outflow"); row.className="row-item"+(isOutflow?" outflow-row":""); const safeName=String(data.name||"").replace(/"/g,'&quot;'); const value=data.value ? formatInputMoney(data.value) : ""; const category=data.category||data.type||"lucro"; row.innerHTML=isOutflow?`<input class="row-name" placeholder="${label}" value="${safeName}" /><select class="row-category"><option value="lucro">Lucro</option><option value="custo_operacional">Custo operacional</option></select><input class="row-value money-input" inputmode="decimal" placeholder="0,00" value="${value}" /><button type="button" class="remove-row">×</button>`:`<input class="row-name" placeholder="${label}" value="${safeName}" /><input class="row-value money-input" inputmode="decimal" placeholder="0,00" value="${value}" /><button type="button" class="remove-row">×</button>`; if(isOutflow) row.querySelector(".row-category").value=category; row.querySelectorAll("input,select").forEach(i=>i.addEventListener("input",renderCalculations)); row.querySelectorAll("select").forEach(i=>i.addEventListener("change",renderCalculations)); row.querySelector(".remove-row").onclick=()=>{row.remove();renderCalculations();}; list.appendChild(row); applyBankMoneyMaskAll(row); enableClearOnFocus(); }

    function getTurnFromForm(){
      const webReca=moneyToNumber($("webReca")?.value), suprema=moneyToNumber($("suprema")?.value), pppoker=moneyToNumber($("pppoker")?.value), buffalo=moneyToNumber($("buffalo")?.value), ganamos=moneyToNumber($("ganamos")?.value), cargasPoker=moneyToNumber($("cargasPoker")?.value), cargasCasino=moneyToNumber($("cargasCasino")?.value);
      const pendings=getDynamicRows("pendingList"), outflows=getDynamicRows("outflowList");
      const pendentesTotal=pendings.reduce((s,x)=>s+x.value,0), saidasTotal=outflows.reduce((s,x)=>s+x.value,0), retiradaLucroTotal=outflows.filter(x=>x.category==="lucro").reduce((s,x)=>s+x.value,0), custoOperacionalTotal=outflows.filter(x=>x.category==="custo_operacional").reduce((s,x)=>s+x.value,0);
      const turno={operatorName:$("operatorName")?.value.trim()||"", closingDate:$("closingDate")?.value||new Date().toISOString(), webReca,suprema,pppoker,buffalo,ganamos,cargasPoker,cargasCasino,pendings,outflows,pendentesTotal,saidasTotal,retiradaLucroTotal,custoOperacionalTotal};
      turno.saldoLiquido=calcularSaldoLiquido(turno);
      return turno;
    }
    function calcularSaldoLiquido(turno={}){
      const webReca=moneyToNumber(turno.webReca??turno.reca??turno.banco??0),
        suprema=moneyToNumber(turno.suprema??0)*400,
        pppoker=moneyToNumber(turno.pppoker??0)*400,
        buffalo=moneyToNumber(turno.buffalo??0),
        ganamos=moneyToNumber(turno.ganamos??0),
        cargasPoker=moneyToNumber(turno.cargasPoker??0)*400,
        cargasCasino=moneyToNumber(turno.cargasCasino??turno.cargas??0),
        pendentes=moneyToNumber(turno.pendentesTotal??(turno.pendings||[]).reduce((s,x)=>s+moneyToNumber(x.value),0)),
        saidas=moneyToNumber(turno.saidasTotal??(turno.outflows||[]).reduce((s,x)=>s+moneyToNumber(x.value),0));

      // Saldo líquido de conferência: soma retiradas porque elas saíram do caixa,
      // mas precisam ser reconhecidas no resultado daquele fechamento.
      return webReca+suprema+pppoker+buffalo+ganamos+cargasPoker+cargasCasino-pendentes+saidas;
    }

    function calcularBaseOperacional(turno={}){
      // Base operacional é o caixa real que passa para o próximo turno.
      // Por isso retiradas NÃO podem inflar a base do turno seguinte.
      const saldoLiquido = moneyToNumber(turno.saldoLiquido ?? calcularSaldoLiquido(turno));
      const saidas = moneyToNumber(turno.saidasTotal ?? (turno.outflows||[]).reduce((s,x)=>s+moneyToNumber(x.value),0));
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
      ["webReca","suprema","pppoker","buffalo","ganamos","cargasPoker","cargasCasino"].forEach(id=>{
        if($(id)) $(id).value = "";
      });

      if($("pendingList")) $("pendingList").innerHTML = "";
      if($("outflowList")) $("outflowList").innerHTML = "";
      initDate();
      fillOperatorFromProfile();
      renderCalculations();
    }

    function enableClearOnFocus(){
      // Desativado: os campos não devem zerar ao clicar/focar,
      // para permitir sair do app e voltar sem perder os números digitados.
    }

    function renderCalculations(){
      const turno = getTurnFromForm();

      if($("calcSaldoLiquido")) $("calcSaldoLiquido").textContent = formatMoney(turno.saldoLiquido);
      if($("calcPendentes")) $("calcPendentes").textContent = formatMoney(turno.pendentesTotal);
      if($("calcSaidas")) $("calcSaidas").textContent = formatMoney(turno.saidasTotal);
      if($("calcLucroSaida")) $("calcLucroSaida").textContent = formatMoney(turno.retiradaLucroTotal || 0);
      if($("calcCustoSaida")) $("calcCustoSaida").textContent = formatMoney(turno.custoOperacionalTotal || 0);
      if($("calcCargaPoker")) $("calcCargaPoker").textContent = formatMoney((turno.cargasPoker || 0) * 400);
      if($("calcCargaCasino")) $("calcCargaCasino").textContent = formatMoney(turno.cargasCasino || 0);
      

      const saldoEl = $("calcSaldoLiquido");
      if(saldoEl){
        saldoEl.style.color = turno.saldoLiquido < 0 ? "#ef4444" : "#06152e";
      }

      if($("homeOperator")) $("homeOperator").textContent = profileName() || "-";
    }

 function renderMonthlyGoal(view){
  const card = $("monthlyGoalCard");
  if(!card) return;

  // ✅ Deixa a meta aparecer para qualquer usuário logado
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
        .reduce((s,o) => s + moneyToNumber(o.value || 0), 0);
    }

    return 0;
  };

  const done = monthItems.reduce((s,item) => s + lucroDoItem(item), 0);

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

  console.log("META MENSAL DEBUG:", {
    target,
    done,
    percent,
    monthItems
  });
}

    function renderHome(){
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
      todayStart.setHours(0,0,0,0);
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);

      const profitItems = visibleHistory();
      const lucroFromItem = (x) => moneyToNumber(x.turno?.retiradaLucroTotal ?? 0);
      const itemDate = (x) => x.submittedAt?.toDate ? x.submittedAt.toDate() : new Date(x.turno?.closingDate || x.createdAt || 0);

      const todayResult = profitItems.filter(x=>{
        const d = itemDate(x);
        return !isNaN(d) && d >= todayStart;
      }).reduce((s,x)=>s + lucroFromItem(x), 0);

      const weekResult = profitItems.filter(x=>{
        const d = itemDate(x);
        return !isNaN(d) && d >= weekStart;
      }).reduce((s,x)=>s + lucroFromItem(x), 0);

      if($("homeSaldoReca")) $("homeSaldoReca").textContent = formatMoney(saldoReca);
      if($("homeSaldoLiquido")) $("homeSaldoLiquido").textContent = formatMoney(saldoLiquido);
      if($("homePendentes")) $("homePendentes").textContent = formatMoney(pendentes);
      const pendCard = document.querySelector('[data-home-detail="pendentes"]');
      if(pendCard){
        pendCard.classList.remove("pending-blue","pending-yellow","pending-red");
        if(moneyToNumber(pendentes) < 500000) pendCard.classList.add("pending-blue");
        else if(moneyToNumber(pendentes) < 1000000) pendCard.classList.add("pending-yellow");
        else pendCard.classList.add("pending-red");
      }

      const latestAdjustment = latestInternalAdjustment();
      const adjustmentValue = latestAdjustment ? adjustmentImpact(latestAdjustment) : 0;
      if($("homeInternalAdjustment")){
        $("homeInternalAdjustment").textContent = adjustmentDescription(latestAdjustment);
        $("homeInternalAdjustment").style.color = adjustmentValue < 0 ? "#FF3B30" : "#16C784";
      }
      const canSeeProfitCards = isAdmin() || isSupervisor();
      if($("todayResultCard")) $("todayResultCard").classList.toggle("hidden", !canSeeProfitCards);
      if($("weekResultCard")) $("weekResultCard").classList.toggle("hidden", !canSeeProfitCards);

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
      renderMonthlyGoal(view);
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
        { label:"Suprema", key:"suprema", type:"chips" },
        { label:"PPPoker", key:"pppoker", type:"chips" },
        { label:"Buffalo", key:"buffalo", type:"money" },
        { label:"Ganamos", key:"ganamos", type:"money" }
      ];

      const fmtChips = (value) => `${moneyToNumber(value).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})} fichas`;
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
    
    function renderHistory(){
      const search = $("historySearch")?.value.trim().toLowerCase() || "";
      const date = $("historyDate")?.value || "";
      let list = visibleHistory();

      if(search){
        list = list.filter(x => (x.operatorName || x.turno?.operatorName || "").toLowerCase().includes(search));
      }

      if(date){
        list = list.filter(x => {
          const d = x.submittedAt?.toDate ? x.submittedAt.toDate() : new Date(x.turno?.closingDate || x.createdAt || 0);
          return !isNaN(d) && d.toISOString().slice(0,10) === date;
        });
      }

      const totalList = list.length;
      list = list.slice(0, Math.min(historyRenderLimit, 100));

      if($("historyCount")) $("historyCount").textContent = `${list.length} de ${Math.min(totalList,100)} registros`;

      const html = list.map(item => {
        const t = item.turno || {};
        const operator = item.operatorName || t.operatorName || "Sem operador";
        const ajuste = isAdjustmentItem(item);
        const saldo = ajuste ? adjustmentImpact(item) : (t.saldoLiquido ?? item.currentSaldoTotal ?? 0);
        const diff = displayCashDiff(item);
        const canEdit = canEditHistoryItem(item);
        const canDelete = canDeleteHistoryItem(item);
        const lastEditableBadge = canEdit && !isAdmin() ? `<span class="badge ok history-last-editable">Último editável</span>` : "";
        const adminActions = `
          ${canEdit ? `<button class="small-btn" data-edit="${item.id}">Editar</button>` : ""}
          ${canDelete ? `<button class="small-btn danger" data-delete="${item.id}">Excluir</button>` : ""}
        `;

        const typeBadge = ajuste ? '<span class="history-pill history-pill-adjust">Ajuste</span>' : '<span class="history-pill">Fechamento</span>';
        const diffClass = diff < 0 ? "is-negative" : "is-positive";

        return `<div class="history-item ${ajuste ? "history-item-adjustment" : ""}" data-receipt="${item.id}" style="cursor:pointer;">
          <div class="history-item-accent"></div>
          <div class="history-top">
            <div class="history-main">
              <strong>${operator}</strong>
              <div class="history-meta-row">${typeBadge}${lastEditableBadge}</div>
            </div>
            <span class="history-date">${dateLabel(item.submittedAt || t.closingDate)}</span>
          </div>
          <div class="history-values">
            <div><span class="muted">Saldo líquido</span><b>${formatMoney(saldo)}</b></div>
            <div><span class="muted">Diferença</span><b class="${diffClass}">${formatMoney(diff)}</b></div>
          </div>
          <div class="history-actions">${adminActions}</div>
        </div>`;
      }).join("") || `<div class="history-item">Nenhum fechamento encontrado.</div>`;

      if($("historyList")) $("historyList").innerHTML = html;

      document.querySelectorAll("[data-delete]").forEach(btn => btn.onclick = (ev) => {
        ev.stopPropagation();
        deleteHistory(btn.dataset.delete);
      });

      document.querySelectorAll("[data-edit]").forEach(btn => btn.onclick = (ev) => {
        ev.stopPropagation();
        openEditHistory(btn.dataset.edit);
      });

      document.querySelectorAll("[data-receipt]").forEach(card => card.onclick = () => openHistoryReceipt(card.dataset.receipt));

      const totalAvailable = Math.min(visibleHistory().filter(x => {
        const searchNow = $("historySearch")?.value.trim().toLowerCase() || "";
        const dateNow = $("historyDate")?.value || "";
        if(searchNow && !(x.operatorName || x.turno?.operatorName || "").toLowerCase().includes(searchNow)) return false;
        if(dateNow){
          const d = x.submittedAt?.toDate ? x.submittedAt.toDate() : new Date(x.turno?.closingDate || x.createdAt || 0);
          if(isNaN(d) || d.toISOString().slice(0,10) !== dateNow) return false;
        }
        return true;
      }).length, 100);

      if(historyRenderLimit < totalAvailable && $("historyList")){
        $("historyList").insertAdjacentHTML("beforeend", `<button id="loadMoreHistoryBtn" class="btn secondary full" style="margin-top:6px;">Carregar mais</button>`);
        $("loadMoreHistoryBtn").onclick = () => {
          historyRenderLimit = Math.min(100, historyRenderLimit + 20);
          renderHistory();
        };
      }
    }

    function periodStart(range){ const now=new Date(), d=new Date(now); if(range==="day") d.setHours(0,0,0,0); if(range==="week") d.setDate(now.getDate()-7); if(range==="month") d.setMonth(now.getMonth()-1); if(range==="all") return null; return d; }
    function renderRanking(){
      const start = periodStart(currentRankRange);
      let list = operationalHistory();

      if(start){
        list = list.filter(x=>{
          const d = x.submittedAt?.toDate ? x.submittedAt.toDate() : new Date(x.turno?.closingDate || x.createdAt || 0);
          return d >= start;
        });
      }

      const map = new Map();
      list.forEach(x=>{
        const name = x.operatorName || x.turno?.operatorName || "Sem operador";
        const diff = moneyToNumber(x.diff ?? 0);
        const prev = map.get(name) || { name, total:0, count:0 };
        prev.total += diff;
        prev.count += 1;
        map.set(name, prev);
      });

      const ranking = [...map.values()].sort((a,b)=>b.total-a.total);
      const maxAbs = Math.max(...ranking.map(r=>Math.abs(r.total)), 1);

      $("rankingList").innerHTML = ranking.map((r,i)=>{
        const percent = Math.min(100, (Math.abs(r.total) / maxAbs) * 100);
        const positive = r.total >= 0;
        const status = positive ? "Caixa positivo" : "Caixa negativo";

        return `<div class="rank-item">
          <div class="rank-head">
            <div class="rank-left">
              <div class="rank-pos">${i+1}</div>
              <div>
                <div class="rank-name">${r.name}</div>
                <div class="rank-meta">${r.count} fechamentos</div>
              </div>
            </div>
            <div class="rank-value" style="color:${positive ? '#10b981' : '#ef4444'}">${formatMoney(r.total)}</div>
          </div>

          <div class="rank-bar">
            <div class="rank-fill ${positive ? 'good' : 'bad'}" style="width:${percent}%"></div>
          </div>

          <div class="rank-footer">
            <span>${status}</span>
            <span>${percent.toFixed(1)}% do maior movimento</span>
          </div>
        </div>`;
      }).join("") || `<div class="rank-item">Sem dados para ranking.</div>`;
    }

    function safeRender(name, fn){
      try{
        if(typeof fn === "function") fn();
      }catch(e){
        console.warn(`Render ignorou erro em ${name}:`, e);
      }
    }

    function renderAll(){
      safeRender("calculations", renderCalculations);
      safeRender("home", renderHome);
      safeRender("history", renderHistory);
      safeRender("ranking", renderRanking);
      safeRender("report", previewReport);
    }

    function validateTurnBeforeSave(turno){
      const hasMainValue = [turno.webReca, turno.suprema, turno.pppoker, turno.buffalo, turno.ganamos, turno.cargasPoker, turno.cargasCasino, turno.pendentesTotal, turno.saidasTotal].some(v=>moneyToNumber(v)>0);
      if(!turno.operatorName) return "Informe o operador.";
      if(!hasMainValue) return "Informe pelo menos um valor antes de salvar.";
      
      return "";
    }

    let savingClosing = false;
    let savingQuickCharge = false;

    function setGlobalLoading(active, title="Processando", text="Aguarde, salvando com segurança..."){
      const overlay = $("globalLoading");
      if(!overlay) return;
      if($("globalLoadingTitle")) $("globalLoadingTitle").textContent = title;
      if($("globalLoadingText")) $("globalLoadingText").textContent = text;
      overlay.classList.toggle("active", !!active);
    }

    function setButtonLoading(btn, active, text="Salvando..."){
      if(!btn) return;
      if(active){
        btn.dataset.oldText = btn.textContent;
        btn.textContent = text;
        btn.disabled = true;
        btn.classList.add("is-loading");
      }else{
        btn.textContent = btn.dataset.oldText || btn.textContent;
        btn.disabled = false;
        btn.classList.remove("is-loading");
      }
    }

    async function saveClosing(){
      if(savingClosing) return;
      savingClosing = true;
      setButtonLoading($("saveClosingBtn"), true, "Salvando...");
      setGlobalLoading(true, "Salvando fechamento", "Não feche nem toque duas vezes. Estamos gravando o turno.");
      try{
        const turno = getTurnFromForm();
        const validationError = validateTurnBeforeSave(turno);
        if(validationError) return alert(validationError);

        turno.supervisorUid = currentProfile?.supervisorUid || (isSupervisor()?currentUser?.uid:null) || null;
        turno.supervisorEmail = currentProfile?.supervisorEmail || (isSupervisor()?currentUser?.email:null) || null;
        turno.supervisorName = currentProfile?.supervisorName || (isSupervisor()?profileName():null) || null;

        // MODELO FINAL:
        // Ajuste interno altera a base operacional do próximo fechamento,
        // mas não aparece como lucro operacional próprio.
        const baseSaldo = baseForNextClosing();
        const diff = baseSaldo === null ? 0 : turno.saldoLiquido - baseSaldo;
        turno.baseOperacional = calcularBaseOperacional(turno);

        await addDoc(collection(db,"history"),{
          type:"closing",
          adjustment:false,
          turno:{
            ...turno,
            operatorEmail:currentUser?.email || null,
            createdByEmail:currentUser?.email || null
          },
          operatorName:turno.operatorName,
          operatorEmail:currentUser?.email || null,
          supervisorUid:turno.supervisorUid,
          supervisorEmail:turno.supervisorEmail,
          supervisorName:turno.supervisorName,
          currentSaldoTotal:turno.saldoLiquido,
          operationalBase:turno.baseOperacional,
          diff,
          submittedAt:serverTimestamp(),
          createdBy:currentUser?.uid||null,
          createdByEmail:currentUser?.email||null
        });

        await addAudit("save_closing",`Fechamento salvo por ${turno.operatorName}`);
        clearClosingForm();
        alert("Fechamento salvo com sucesso.");
      }catch(e){
        alert(friendlyError(e));
      }finally{
        savingClosing = false;
        setButtonLoading($("saveClosingBtn"), false);
        setGlobalLoading(false);
      }
    }

    async function addQuickCapitalInjection(){
      if(savingQuickCharge) return;
      if(!await requireAdmin()) return;
      savingQuickCharge = true;
      setButtonLoading($("quickChargeBtn"), true, "Salvando ajuste...");
      setGlobalLoading(true, "Salvando ajuste", "A carga rápida está sendo registrada com segurança.");

      const cargasPoker = moneyToNumber($("quickCargaPoker")?.value || 0);
      const cargasCasino = moneyToNumber($("quickCargaCasino")?.value || 0);
      const retiradaCaixa = moneyToNumber($("quickRetiradaCaixa")?.value || 0);
      const retiradaTipo = $("quickRetiradaTipo")?.value || "lucro";
      const motivo = $("quickCargaMotivo")?.value.trim() || "Carga rápida de caixa";
      const operador = $("quickCargaOperador")?.value.trim() || profileName() || "Admin";
      const totalAjuste = (cargasPoker * 400) + cargasCasino - retiradaCaixa;
      const turno = {
        operatorName: operador,
        closingDate: new Date().toISOString(),
        webReca: 0,
        suprema: 0,
        pppoker: 0,
        buffalo: 0,
        ganamos: 0,
        cargasPoker,
        cargasCasino,
        pendings: [],
        outflows: retiradaCaixa > 0 ? [{
          name: motivo,
          category: retiradaTipo,
          value: retiradaCaixa
        }] : [],
        pendentesTotal: 0,
        saidasTotal: retiradaCaixa,
        retiradaLucroTotal: retiradaTipo === "lucro" ? retiradaCaixa : 0,
        custoOperacionalTotal: retiradaTipo === "custo_operacional" ? retiradaCaixa : 0,
        ajusteTipo: "carga_rapida",
        ajusteMotivo: motivo,
        retiradaCaixa,
        retiradaTipo,
        saldoLiquido: totalAjuste
      };

      if((cargasPoker <= 0 && cargasCasino <= 0 && retiradaCaixa <= 0)){
        alert("Informe uma carga ou uma retirada de caixa maior que zero.");
        return;
      }

      const baseSaldo = baseForNextClosing();
      const currentSaldoTotal = (baseSaldo ?? 0) + totalAjuste;
      const diff = totalAjuste;

      try{
        await addDoc(collection(db,"history"), {
          type:"capital_injection",
          adjustment:true,
          adjustmentType:"carga_rapida",
          adjustmentReason:motivo,
          turno,
          operatorName:operador,
          currentSaldoTotal,
          diff,
          submittedAt:serverTimestamp(),
          createdBy:currentUser?.uid || null,
          createdByEmail:currentUser?.email || null
        });

        await addAudit("quick_capital_injection", `Carga rápida adicionada: ${formatMoney(totalAjuste)} • ${motivo}`);

        ["quickCargaPoker","quickCargaCasino","quickRetiradaCaixa","quickCargaMotivo","quickCargaOperador"].forEach(id=>{ if($(id)) $(id).value=""; });
        if($("quickRetiradaTipo")) $("quickRetiradaTipo").value="lucro";

        if(isAdmin()){
  await recalculateAllHistory();
}

renderAll();
renderMonthlyGoal(visibleHistory());

alert("Carga adicionada ao sistema como ajuste auditável.");
      }catch(e){
        alert(friendlyError(e));
      }finally{
        savingQuickCharge = false;
        setButtonLoading($("quickChargeBtn"), false);
        setGlobalLoading(false);
      }
    }

    async function deleteHistory(id){ if(!await requireAdmin()) return; if(!confirm("Excluir este fechamento?")) return; try{await deleteDoc(doc(db,"history",id)); await addAudit("delete_history",`Fechamento excluído: ${id}`);}catch(e){alert(friendlyError(e));} }

    function receiptLine(label, value){
      return `<div class="receipt-line"><span>${label}</span><b>${value}</b></div>`;
    }

    function renderReceiptRows(title, rows, emptyText){
      const list = (rows || []).filter(x=>x.name || x.value);
      return `<div class="receipt-section"><h3>${title}</h3><div class="receipt-list">${list.length ? list.map(x=>receiptLine(`${x.name || "Sem descrição"}${x.category ? " • " + (x.category === "custo_operacional" ? "Custo operacional" : "Lucro") : ""}`, formatMoney(x.value || 0))).join("") : `<div class="receipt-line"><span>${emptyText}</span><b>-</b></div>`}</div></div>`;
    }

    function openHistoryReceipt(id){
      const item = historyCache.find(x=>x.id===id);
      if(!item) return alert("Fechamento não encontrado.");

      if(isAdjustmentItem(item)){
        openQuickAdjustmentReceipt(item);
        return;
      }

      openFullClosingReceipt(item);
    }

    function openFullClosingReceipt(item){
      const t = item.turno || {};
      const id = item.id || "";
      const saldo = t.saldoLiquido ?? item.currentSaldoTotal ?? 0;
      const diff = displayCashDiff(item);
      const cargaPokerMoney = moneyToNumber(t.cargasPoker || 0) * 400;
      const cargaCasino = moneyToNumber(t.cargasCasino ?? t.cargas ?? 0);

      $("receiptSaldoLiquido").textContent = formatMoney(saldo);
      $("receiptSubtitle").textContent = `Fechamento completo • ${dateLabel(item.submittedAt || t.closingDate)}`;
      $("receiptCode").textContent = `ID: ${String(id).slice(0,8)} • fechamento`;

      $("receiptContent").innerHTML = `
        <div class="receipt-grid">
          <div class="receipt-row"><span>Operador</span><b>${item.operatorName || t.operatorName || "-"}</b></div>
          <div class="receipt-row"><span>Supervisor</span><b>${item.supervisorName || t.supervisorName || item.supervisorEmail || "-"}</b></div>
          <div class="receipt-row"><span>Data</span><b>${dateLabel(item.submittedAt || t.closingDate)}</b></div>
          <div class="receipt-row"><span>Diferença de caixa</span><b style="color:${diff<0?'#ef4444':'#10b981'}">${formatMoney(diff)}</b></div>
        </div>

        <div class="receipt-section">
          <h3>Resumo financeiro</h3>
          <div class="receipt-list">
            ${receiptLine("Saldo Reca", formatMoney(t.webReca ?? t.reca ?? 0))}
            ${receiptLine("Suprema ×400", formatMoney(moneyToNumber(t.suprema || 0) * 400))}
            ${receiptLine("PPPoker ×400", formatMoney(moneyToNumber(t.pppoker || 0) * 400))}
            ${receiptLine("Buffalo", formatMoney(t.buffalo || 0))}
            ${receiptLine("Ganamos", formatMoney(t.ganamos || 0))}
            ${receiptLine("Carga poker ×400", formatMoney(cargaPokerMoney))}
            ${receiptLine("Carga casino", formatMoney(cargaCasino))}
            ${receiptLine("Pagos pendentes", formatMoney(t.pendentesTotal || 0))}
          </div>
        </div>

        ${renderReceiptRows("Pagos pendentes detalhados", t.pendings, "Sem pagos pendentes")}
        ${renderReceiptRows("Retiradas detalhadas", t.outflows, "Sem retiradas")}
      `;

      const adminActions = $("receiptAdminActions");
      adminActions?.classList.toggle("hidden", !(canEditHistoryItem(item) || canDeleteHistoryItem(item)));

      const editBtn = $("receiptEditBtn");
      const deleteBtn = $("receiptDeleteBtn");
      if(editBtn){
        editBtn.style.display = canEditHistoryItem(item) ? "" : "none";
        editBtn.onclick = () => { closeHistoryReceipt(); openEditHistory(item.id); };
      }
      if(deleteBtn){
        deleteBtn.style.display = canDeleteHistoryItem(item) ? "" : "none";
        deleteBtn.onclick = () => { closeHistoryReceipt(); deleteHistory(item.id); };
      }

      $("receiptModal").classList.add("active");
    }

    function openQuickAdjustmentReceipt(item){
      const t = item.turno || {};
      const id = item.id || "";
      const impacto = adjustmentImpact(item);
      const parts = getAdjustmentParts(item);
      const motivo = t.ajusteMotivo || item.adjustmentReason || "Ajuste interno";
      const operador = item.operatorName || t.operatorName || "-";
      const data = dateLabel(item.submittedAt || t.closingDate || item.createdAt);
      const tipoRetirada = t.retiradaTipo === "custo_operacional" ? "Custo operacional" : (t.retiradaTipo === "lucro" ? "Lucro" : "-");

      $("receiptSaldoLiquido").textContent = formatMoney(impacto);
      $("receiptSubtitle").textContent = `Carga rápida / ajuste • ${data}`;
      $("receiptCode").textContent = `ID: ${String(id).slice(0,8)} • ajuste rápido`;

      $("receiptContent").innerHTML = `
        <div class="receipt-grid">
          <div class="receipt-row"><span>Operador</span><b>${operador}</b></div>
          <div class="receipt-row"><span>Data</span><b>${data}</b></div>
          <div class="receipt-row"><span>Motivo</span><b>${motivo}</b></div>
          <div class="receipt-row"><span>Impacto no caixa</span><b style="color:${impacto<0?'#ef4444':'#10b981'}">${formatMoney(impacto)}</b></div>
        </div>

        <div class="receipt-section">
          <h3>Dados do ajuste</h3>
          <div class="receipt-list">
            ${receiptLine("Carga poker ×400", formatMoney(parts.cargaPoker))}
            ${receiptLine("Carga casino / dinheiro", formatMoney(parts.cargaCasino))}
            ${receiptLine("Retirada do caixa", formatMoney(parts.retiradaCaixa))}
            ${receiptLine("Tipo da retirada", tipoRetirada)}
          </div>
        </div>
      `;

      const adminActions = $("receiptAdminActions");
      adminActions?.classList.toggle("hidden", !(canEditHistoryItem(item) || canDeleteHistoryItem(item)));

      const editBtn = $("receiptEditBtn");
      const deleteBtn = $("receiptDeleteBtn");
      if(editBtn){
        editBtn.style.display = canEditHistoryItem(item) ? "" : "none";
        editBtn.onclick = () => { closeHistoryReceipt(); openEditHistory(item.id); };
      }
      if(deleteBtn){
        deleteBtn.style.display = canDeleteHistoryItem(item) ? "" : "none";
        deleteBtn.onclick = () => { closeHistoryReceipt(); deleteHistory(item.id); };
      }

      $("receiptModal").classList.add("active");
    }

    function closeHistoryReceipt(){
      $("receiptModal")?.classList.remove("active");
    }

    function exportReceiptAsPng(){
      const panel = document.querySelector(".receipt-panel");
      if(!panel){
        alert("Resumo não encontrado.");
        return;
      }

      const btn = $("receiptExportPngBtn");
      const originalBtnText = btn ? btn.textContent : "";

      function resetButton(){
        if(btn){
          btn.disabled = false;
          btn.textContent = originalBtnText || "Exportar resumo PNG";
        }
      }

      function restorePanel(originalMaxHeight, originalOverflow, hiddenEls){
        panel.style.maxHeight = originalMaxHeight;
        panel.style.overflow = originalOverflow;
        hiddenEls.forEach(function(el){
          el.style.display = el.getAttribute("data-old-display") || "";
          el.removeAttribute("data-old-display");
        });
      }

      if(btn){
        btn.disabled = true;
        btn.textContent = "Gerando PNG...";
      }

      function startExport(){
        const originalMaxHeight = panel.style.maxHeight;
        const originalOverflow = panel.style.overflow;
        const hiddenEls = Array.from(panel.querySelectorAll("button, .receipt-actions, #receiptAdminActions"));

        hiddenEls.forEach(function(el){
          el.setAttribute("data-old-display", el.style.display || "");
          el.style.display = "none";
        });

        panel.style.maxHeight = "none";
        panel.style.overflow = "visible";

        setTimeout(function(){
          window.html2canvas(panel, {
            backgroundColor: "#ffffff",
            scale: Math.min(3, window.devicePixelRatio || 2),
            useCORS: true,
            logging: false
          }).then(function(canvas){
            restorePanel(originalMaxHeight, originalOverflow, hiddenEls);

            const fileName = "bank-king-resumo-" + Date.now() + ".png";

            if(canvas.toBlob){
              canvas.toBlob(function(blob){
                if(blob){
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = fileName;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
                }else{
                  const a = document.createElement("a");
                  a.href = canvas.toDataURL("image/png");
                  a.download = fileName;
                  a.click();
                }
                resetButton();
              }, "image/png", 1);
            }else{
              const a = document.createElement("a");
              a.href = canvas.toDataURL("image/png");
              a.download = fileName;
              a.click();
              resetButton();
            }
          }).catch(function(error){
            console.error("Erro PNG:", error);
            restorePanel(originalMaxHeight, originalOverflow, hiddenEls);
            resetButton();
            alert("Não consegui gerar o PNG neste navegador.");
          });
        }, 150);
      }

      if(window.html2canvas){
        startExport();
        return;
      }

      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      script.onload = startExport;
      script.onerror = function(){
        resetButton();
        alert("Não foi possível carregar o exportador PNG. Verifique a internet e tente novamente.");
      };
      document.head.appendChild(script);
    }

    function openHomeMetricDetail(type){
      const view = visibleHistory();
      const last = lastRealClosing() || view[0];
      const t = last?.turno || {};
      let title = "Detalhamento";
      let total = 0;
      let content = "";

      const now = new Date();
      const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
      const weekStart = new Date(now); weekStart.setDate(weekStart.getDate()-7);

      const makeLines = (rows, emptyText="Sem detalhes") => {
        const clean = (rows || []).filter(x=>x.label || x.value);
        return clean.length
          ? clean.map(x=>receiptLine(x.label, formatMoney(x.value || 0))).join("")
          : `<div class="receipt-line"><span>${emptyText}</span><b>-</b></div>`;
      };

      if(type === "saldo"){
        title = "Saldo líquido atual";
        total = moneyToNumber(t.saldoLiquido ?? last?.currentSaldoTotal ?? 0);
        content = `
          <div class="receipt-section"><h3>Composição do saldo</h3><div class="receipt-list">
            ${receiptLine("Saldo Reca", formatMoney(t.webReca ?? t.reca ?? 0))}
            ${receiptLine("Suprema ×400", formatMoney(moneyToNumber(t.suprema || 0) * 400))}
            ${receiptLine("PPPoker ×400", formatMoney(moneyToNumber(t.pppoker || 0) * 400))}
            ${receiptLine("Buffalo", formatMoney(t.buffalo || 0))}
            ${receiptLine("Ganamos", formatMoney(t.ganamos || 0))}
            ${receiptLine("Pagos pendentes", "- " + formatMoney(t.pendentesTotal || 0))}
            ${receiptLine("Retiradas", "+ " + formatMoney(t.saidasTotal || 0))}
            ${receiptLine("Data do fechamento", last ? dateLabel(last.submittedAt || last.createdAt || t.closingDate) : "-")}
          </div></div>`;
      }

      if(type === "pendentes"){
        title = "Pagos pendentes";
        total = moneyToNumber(t.pendentesTotal || 0);
        content = `<div class="receipt-section"><h3>Lista de pendentes do último fechamento</h3><div class="receipt-list">${makeLines((t.pendings || []).map(p=>({label:p.name || "Sem descrição", value:p.value || 0})), "Sem pagos pendentes")}</div></div>`;
      }

      if(type === "lucroHoje" || type === "lucroSemana"){
        const start = type === "lucroHoje" ? todayStart : weekStart;
        title = type === "lucroHoje" ? "Lucro de hoje" : "Lucro da semana";
        const rows = [];

        view.forEach(item=>{
          const d = item.submittedAt?.toDate ? item.submittedAt.toDate() : new Date(item.turno?.closingDate || item.createdAt || 0);
          if(isNaN(d) || d < start) return;
          const tt = item.turno || {};
          (tt.outflows || []).forEach(o=>{
            if(o.category === "lucro"){
              rows.push({
                label: `${item.operatorName || tt.operatorName || "Sem operador"} • ${o.name || "Retirada lucro"}`,
                value: moneyToNumber(o.value || 0)
              });
            }
          });
        });

        total = rows.reduce((s,x)=>s + moneyToNumber(x.value),0);
        content = `<div class="receipt-section"><h3>Retiradas tipo lucro</h3><div class="receipt-list">${makeLines(rows, "Sem retiradas de lucro no período")}</div></div>`;
      }

      $("receiptSaldoLiquido").textContent = formatMoney(total);
      $("receiptSubtitle").textContent = title;
      $("receiptCode").textContent = "Detalhamento da tela inicial";
      $("receiptContent").innerHTML = content;
      $("receiptAdminActions")?.classList.add("hidden");
      $("receiptModal").classList.add("active");
    }

    async function openEditHistory(id){ const item=historyCache.find(x=>x.id===id); if(!item) return alert("Fechamento não encontrado no cache."); if(!canEditHistoryItem(item)) return alert("Você só pode editar o seu último fechamento de turno."); const t=item.turno||{}; $("editHistoryId").value=id; $("editOperatorName").value=item.operatorName||t.operatorName||""; $("editClosingDate").value=toDateInputValue(t.closingDate||item.submittedAt); $("editWebReca").value=t.webReca??t.reca??0; $("editSuprema").value=t.suprema??0; $("editPppoker").value=t.pppoker??0; $("editBuffalo").value=t.buffalo??0; $("editGanamos").value=t.ganamos??0; $("editCargasPoker").value=t.cargasPoker??0; $("editCargasCasino").value=t.cargasCasino??t.cargas??0; setDynamicRows("editPendingList",t.pendings||[]); setDynamicRows("editOutflowList",t.outflows||[]); $("editHistoryModal").classList.add("active"); }
    function closeEdit(){ $("editHistoryModal").classList.remove("active"); }
    async function saveEdit(){ const id=$("editHistoryId").value; const ref=doc(db,"history",id); const original=historyCache.find(x=>x.id===id)||{}; if(!canEditHistoryItem(original)) return alert("Você só pode editar o seu último fechamento de turno."); const t={...(original.turno||{}),operatorName:$("editOperatorName").value.trim(),closingDate:$("editClosingDate").value||new Date().toISOString(),webReca:moneyToNumber($("editWebReca").value),suprema:moneyToNumber($("editSuprema").value),pppoker:moneyToNumber($("editPppoker").value),buffalo:moneyToNumber($("editBuffalo").value),ganamos:moneyToNumber($("editGanamos").value),cargasPoker:moneyToNumber($("editCargasPoker").value),cargasCasino:moneyToNumber($("editCargasCasino").value),pendings:getDynamicRows("editPendingList"),outflows:getDynamicRows("editOutflowList")}; t.pendentesTotal=t.pendings.reduce((s,x)=>s+x.value,0); t.saidasTotal=t.outflows.reduce((s,x)=>s+x.value,0); t.retiradaLucroTotal=t.outflows.filter(x=>x.category==="lucro").reduce((s,x)=>s+x.value,0); t.custoOperacionalTotal=t.outflows.filter(x=>x.category==="custo_operacional").reduce((s,x)=>s+x.value,0); t.saldoLiquido=calcularSaldoLiquido(t); t.baseOperacional=calcularBaseOperacional(t); try{await updateDoc(ref,{turno:t,operatorName:t.operatorName,currentSaldoTotal:t.saldoLiquido,operationalBase:t.baseOperacional,editedAt:serverTimestamp(),editedBy:currentUser?.uid||null,editedByEmail:currentUser?.email||null}); await addAudit("edit_history",`Fechamento editado: ${id}`); closeEdit(); if(isAdmin()) await recalculateAllHistory(); else renderAll(); alert("Fechamento editado com sucesso.");}catch(e){alert(friendlyError(e));} }

    async function recalculateAllHistory(){
      if(!await requireAdmin()) return false;
      const loader=$("appReloadLoader");
      loader?.classList.add("active");

      try{
        const qh=query(collection(db,"history"),orderBy("submittedAt","asc"));
        const snap=await getDocs(qh);
        let operationalBaseSaldo=null;

        for(const item of snap.docs){
          try{
            const data=item.data();
            const turno=data.turno||{};
            const isAdjustment = data.adjustment === true || data.type === "capital_injection" || turno.ajusteTipo === "carga_rapida";
            const adjustmentParts = isAdjustment ? getAdjustmentParts({ ...data, turno }) : null;
            const saldoLiquido = isAdjustment ? adjustmentImpact({ ...data, turno }) : calcularSaldoLiquido(turno);
            let currentSaldoTotal, diff;

            if(isAdjustment){
              // Ajuste interno altera apenas a base operacional.
              diff = saldoLiquido;
              currentSaldoTotal = saldoLiquido;
              operationalBaseSaldo = (operationalBaseSaldo ?? 0) + diff;
            }else{
              currentSaldoTotal = saldoLiquido;
              diff = operationalBaseSaldo===null ? 0 : currentSaldoTotal - operationalBaseSaldo;
              operationalBaseSaldo = calcularBaseOperacional({ ...turno, saldoLiquido });
            }

            const updatePayload = {
              "turno.saldoLiquido": saldoLiquido,
              "turno.baseOperacional": isAdjustment ? operationalBaseSaldo : calcularBaseOperacional({ ...turno, saldoLiquido }),
              currentSaldoTotal,
              operationalBase: isAdjustment ? operationalBaseSaldo : calcularBaseOperacional({ ...turno, saldoLiquido }),
              diff,
              recalculatedAt: serverTimestamp()
            };

            if(isAdjustment && adjustmentParts){
              updatePayload["turno.retiradaCaixa"] = adjustmentParts.retiradaCaixa;
              updatePayload["turno.saidasTotal"] = adjustmentParts.retiradaCaixa;
              updatePayload["turno.ajusteImpacto"] = saldoLiquido;
            }

            await updateDoc(doc(db,"history",item.id), updatePayload);
          }catch(e){
            console.warn("Histórico ignorado no recálculo:",item.id,e);
          }
        }

        await addAudit("recalculate_history","Histórico recalculado: ajustes internos alteram base operacional sem virar resultado operacional");
        renderAll();
        return true;
      }catch(e){
        alert(friendlyError(e));
        return false;
      }finally{
        setTimeout(()=>loader?.classList.remove("active"),500);
      }
    }
    async function refreshInternal(){ const loader=$("appReloadLoader"); loader?.classList.add("active"); renderAll(); setTimeout(()=>loader?.classList.remove("active"),650); }

    function getReportFiltersSummary(){
      const start = $("reportStart")?.value || "";
      const end = $("reportEnd")?.value || "";
      const operator = ($("reportOperator")?.value || "").trim();
      const supervisor = ($("reportSupervisor")?.value || "").trim();
      const parts = [];
      if(start || end) parts.push(`Período: ${start || "início"} → ${end || "hoje"}`);
      if(operator) parts.push(`Operador: ${operator}`);
      if(supervisor) parts.push(`Supervisor: ${supervisor}`);
      return {
        start,
        end,
        operator,
        supervisor,
        text: parts.join(" • ") || "Todos os registros disponíveis"
      };
    }
    function getReportItems(){
      const filters = getReportFiltersSummary();
      let items = visibleHistory();
      if(filters.start) items = items.filter(x=>{const d=x.submittedAt?.toDate?x.submittedAt.toDate():new Date(x.turno?.closingDate||x.createdAt||0); return !isNaN(d) && d.toISOString().slice(0,10) >= filters.start;});
      if(filters.end) items = items.filter(x=>{const d=x.submittedAt?.toDate?x.submittedAt.toDate():new Date(x.turno?.closingDate||x.createdAt||0); return !isNaN(d) && d.toISOString().slice(0,10) <= filters.end;});
      if(filters.operator) items = items.filter(x=>String(x.operatorName||x.turno?.operatorName||"").toLowerCase().includes(filters.operator.toLowerCase()));
      if(filters.supervisor) items = items.filter(x=>String(x.supervisorName||x.turno?.supervisorName||x.supervisorEmail||x.turno?.supervisorEmail||"").toLowerCase().includes(filters.supervisor.toLowerCase()));
      return items;
    }
    function previewReport(){
      if(!$("reportPreviewCount")) return;
      const items = getReportItems();
      const filters = getReportFiltersSummary();
      const totalSaldo = items.reduce((s,x)=>s + moneyToNumber(x.turno?.saldoLiquido ?? x.currentSaldoTotal), 0);
      const totalDiff = items.reduce((s,x)=>s + moneyToNumber(x.diff), 0);
      const totalLucro = items.reduce((s,x)=>s + moneyToNumber(x.turno?.retiradaLucroTotal), 0);
      const totalAjustes = items.filter(isAdjustmentItem).reduce((s,x)=>s + adjustmentImpact(x), 0);
      const avgTicket = items.length ? totalSaldo / items.length : 0;
      $("reportPreviewCount").textContent = items.length;
      $("reportPreviewSaldo").textContent = formatMoney(totalSaldo);
      $("reportPreviewDiff").textContent = formatMoney(totalDiff);
      if($("reportPreviewLucro")) $("reportPreviewLucro").textContent = formatMoney(totalLucro);
      if($("reportPreviewAjustes")) $("reportPreviewAjustes").textContent = formatMoney(totalAjustes);
      if($("reportPreviewAvg")) $("reportPreviewAvg").textContent = formatMoney(avgTicket);
      if($("reportPreviewRange")) $("reportPreviewRange").textContent = filters.text;

      const list = $("reportPreviewList");
      if(!list) return;
      if(!items.length){
        list.innerHTML = `<div class="report-preview-empty">Nenhum fechamento encontrado com os filtros atuais.</div>`;
        return;
      }

      list.innerHTML = items.slice(0, 6).map((item, index) => {
        const t = item.turno || {};
        const ajuste = isAdjustmentItem(item);
        const saldo = moneyToNumber(t.saldoLiquido ?? item.currentSaldoTotal ?? 0);
        const diff = ajuste ? adjustmentImpact(item) : displayCashDiff(item);
        const positive = diff >= 0;
        const operator = item.operatorName || t.operatorName || "Sem operador";
        const subtitle = ajuste ? "Ajuste interno" : (item.supervisorName || t.supervisorName || item.supervisorEmail || "Fechamento");
        return `<div class="report-preview-item">
          <div>
            <div class="report-preview-title">#${index + 1} • ${operator}</div>
            <div class="report-preview-meta">${subtitle} • ${dateLabel(item.submittedAt || t.closingDate || item.createdAt)}</div>
          </div>
          <div class="report-preview-balance">${formatMoney(saldo)}</div>
          <div class="report-preview-diff ${positive ? "is-positive" : "is-negative"}">${positive ? "+" : ""}${formatMoney(diff)}</div>
        </div>`;
      }).join("");
    }
    function buildBankPdfHtml(items){
      const filters = getReportFiltersSummary();
      const generatedAt = new Date().toLocaleString("pt-BR");
      const reportCode = "BK-" + Date.now().toString().slice(-8);
      const totalSaldo = items.reduce((s,x)=>s + moneyToNumber(x.turno?.saldoLiquido ?? x.currentSaldoTotal), 0);
      const totalDiff = items.filter(x=>!isAdjustmentItem(x)).reduce((s,x)=>s + displayCashDiff(x), 0);
      const totalAjustes = items.filter(isAdjustmentItem).reduce((s,x)=>s + adjustmentImpact(x), 0);
      const totalLucro = items.reduce((s,x)=>s + moneyToNumber(x.turno?.retiradaLucroTotal), 0);
      const avgSaldo = items.length ? totalSaldo / items.length : 0;

      const blocks = items.map((item, index)=>{
        const t = item.turno || {};
        const ajuste = isAdjustmentItem(item);
        const diff = ajuste ? adjustmentImpact(item) : displayCashDiff(item);
        const saldo = moneyToNumber(t.saldoLiquido ?? item.currentSaldoTotal ?? 0);
        const base = ajuste ? moneyToNumber(item.operationalBase ?? item.currentSaldoTotal ?? 0) : calcularBaseOperacional({ ...t, saldoLiquido: saldo });
        const positive = diff >= 0;
        const titulo = ajuste ? "Ajuste interno" : "Fechamento de turno";
        const operador = item.operatorName || t.operatorName || "Sem operador";
        const supervisor = item.supervisorName || t.supervisorName || item.supervisorEmail || "-";
        const data = dateLabel(item.submittedAt || t.closingDate);
        const motivo = t.ajusteMotivo || item.adjustmentReason || "-";
        const cargaPoker = moneyToNumber(t.cargasPoker || 0) * 400;
        const cargaCasino = moneyToNumber(t.cargasCasino ?? t.cargas ?? 0);

        const pendentes = (t.pendings || []).filter(x=>x.name || x.value).map(p=>`<div class="line"><span>${p.name || "Pendente"}</span><b>${formatMoney(p.value || 0)}</b></div>`).join("") || `<div class="line muted-line"><span>Sem pendentes</span><b>-</b></div>`;
        const retiradas = (t.outflows || []).filter(x=>x.name || x.value).map(o=>`<div class="line"><span>${o.name || "Retirada"} • ${o.category === "custo_operacional" ? "Custo" : "Lucro"}</span><b>${formatMoney(o.value || 0)}</b></div>`).join("") || `<div class="line muted-line"><span>Sem retiradas</span><b>-</b></div>`;

        return `<section class="close-block">
          <div class="close-head">
            <div>
              <span class="kicker">${titulo} #${index + 1}</span>
              <h2>${operador}</h2>
              <p>${data} • Supervisor: ${supervisor}</p>
            </div>
            <div class="diff ${positive ? "pos" : "neg"}">${positive ? "+" : ""}${formatMoney(diff)}</div>
          </div>

          <div class="main-card">
            <div><span>Saldo líquido</span><strong>${formatMoney(saldo)}</strong></div>
            <div><span>Diferença de caixa</span><strong class="${positive ? "txt-pos" : "txt-neg"}">${positive ? "+" : ""}${formatMoney(diff)}</strong></div>
            <div><span>Base operacional</span><strong>${formatMoney(base)}</strong></div>
            <div><span>Lucro retirado</span><strong>${formatMoney(t.retiradaLucroTotal || 0)}</strong></div>
          </div>

          <div class="detail-grid">
            <div class="detail-card"><h3>Composição do saldo</h3>
              <div class="line"><span>Saldo Reca</span><b>${formatMoney(t.webReca ?? t.reca ?? 0)}</b></div>
              <div class="line"><span>Suprema ×400</span><b>${formatMoney(moneyToNumber(t.suprema || 0) * 400)}</b></div>
              <div class="line"><span>PPPoker ×400</span><b>${formatMoney(moneyToNumber(t.pppoker || 0) * 400)}</b></div>
              <div class="line"><span>Buffalo</span><b>${formatMoney(t.buffalo || 0)}</b></div>
              <div class="line"><span>Ganamos</span><b>${formatMoney(t.ganamos || 0)}</b></div>
            </div>
            <div class="detail-card"><h3>Movimentos operacionais</h3>
              <div class="line"><span>Carga poker</span><b>${formatMoney(cargaPoker)}</b></div>
              <div class="line"><span>Carga casino</span><b>${formatMoney(cargaCasino)}</b></div>
              <div class="line"><span>Pendentes</span><b>${formatMoney(t.pendentesTotal || 0)}</b></div>
              <div class="line"><span>Retiradas</span><b>${formatMoney(t.saidasTotal || 0)}</b></div>
              <div class="line"><span>Lucro / Custo</span><b>${formatMoney(t.retiradaLucroTotal || 0)} / ${formatMoney(t.custoOperacionalTotal || 0)}</b></div>
            </div>
          </div>

          <div class="detail-card full"><h3>${ajuste ? "Detalhe do ajuste" : "Detalhamento"}</h3>
            ${ajuste ? `<div class="line"><span>Motivo</span><b>${motivo}</b></div>` : ""}
            ${pendentes}
            ${retiradas}
          </div>
        </section>`;
      }).join("");

      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Relatório Bank King</title><style>
        *{box-sizing:border-box}body{margin:0;background:#eef4fb;color:#07152f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:20px}.toolbar{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.92);backdrop-filter:blur(18px);border:1px solid #dbe5f2;border-radius:18px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px}.toolbar strong{font-size:14px}.toolbar-actions{display:flex;gap:8px}.tool-btn{height:38px;border:0;border-radius:12px;padding:0 14px;font-weight:900;cursor:pointer}.primary{background:#005BFF;color:#fff}.secondary{background:#eef4ff;color:#07328E}.cover{background:radial-gradient(circle at top right,rgba(96,165,250,.22),transparent 26%),linear-gradient(135deg,#071225 0%,#0a1f4f 42%,#0d3b97 100%);color:#fff;border-radius:28px;padding:26px;margin-bottom:16px;box-shadow:0 24px 70px rgba(0,91,255,.20)}.cover-top{display:flex;justify-content:space-between;gap:20px}.logo{width:54px;height:54px;border-radius:17px;background:#fff;color:#005BFF;display:flex;align-items:center;justify-content:center;font-weight:950;font-size:20px}.brand{display:flex;gap:12px;align-items:center}.brand h1{margin:0;font-size:30px}.brand p,.meta{margin:4px 0 0;color:rgba(255,255,255,.78);font-weight:800;font-size:12px}.meta{text-align:right;line-height:1.55}.filter-line{margin-top:16px;padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);font-size:12px;font-weight:800;color:rgba(255,255,255,.82)}.totals{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:18px}.total{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:16px;padding:12px}.total span{display:block;font-size:10px;text-transform:uppercase;opacity:.75;font-weight:900}.total b{display:block;margin-top:5px;font-size:15px}.close-block{background:#fff;border:1px solid #dbe5f2;border-radius:24px;padding:18px;margin-bottom:14px;box-shadow:0 16px 44px rgba(11,31,77,.09);break-inside:avoid;page-break-inside:avoid}.close-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}.kicker{font-size:10px;color:#005BFF;font-weight:950;text-transform:uppercase;letter-spacing:.5px}.close-head h2{margin:3px 0;font-size:20px}.close-head p{margin:0;color:#64748b;font-size:12px;font-weight:800}.diff{border-radius:999px;padding:9px 12px;font-size:13px;font-weight:950;white-space:nowrap}.pos{background:#dcfce7;color:#047857}.neg{background:#fee2e2;color:#b91c1c}.main-card{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;border-radius:20px;background:linear-gradient(135deg,#07152f,#07328E);color:#fff;padding:14px;margin-bottom:12px}.main-card span{display:block;font-size:10px;opacity:.76;font-weight:900;text-transform:uppercase}.main-card strong{display:block;margin-top:5px;font-size:17px}.txt-pos{color:#6EE7B7!important}.txt-neg{color:#FCA5A5!important}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.detail-card{border:1px solid #e8eef8;border-radius:18px;background:#fbfdff;padding:12px}.detail-card.full{margin-top:10px}.detail-card h3{margin:0 0 8px;font-size:13px;color:#07328E}.line{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #edf2f7;font-size:12px}.line:first-of-type{border-top:0}.line span{color:#64748b;font-weight:800}.line b{font-weight:950;text-align:right}.muted-line{opacity:.75}@media(max-width:760px){body{padding:10px}.cover-top{flex-direction:column}.meta{text-align:left}.totals,.main-card,.detail-grid{grid-template-columns:1fr}.toolbar{align-items:flex-start;flex-direction:column}.toolbar-actions{width:100%;display:grid;grid-template-columns:1fr 1fr 1fr}.tool-btn{width:100%}}@media print{@page{size:A4 portrait;margin:10mm}body{background:#fff;padding:0}.toolbar{display:none}.cover{border-radius:0;margin:0 0 8mm;box-shadow:none}.close-block{box-shadow:none;border-radius:18px;margin-bottom:8mm}.close-block{page-break-inside:avoid}.totals{grid-template-columns:repeat(5,1fr)}.main-card{grid-template-columns:repeat(4,1fr)}.detail-grid{grid-template-columns:1fr 1fr}}
      </style></head><body><div class="toolbar"><strong>Relatório Bank King • ${reportCode}</strong><div class="toolbar-actions"><button class="tool-btn secondary" onclick="window.close()">Voltar</button><button class="tool-btn secondary" onclick="window.print()">Imprimir</button><button class="tool-btn primary" onclick="window.print()">Salvar PDF</button></div></div><header class="cover"><div class="cover-top"><div class="brand"><div class="logo">BK</div><div><h1>Bank King Pro</h1><p>Relatório financeiro interno</p></div></div><div class="meta">Código: ${reportCode}<br>Gerado em: ${generatedAt}<br>Usuário: ${currentProfile?.name || currentUser?.email || "-"}</div></div><div class="filter-line">${filters.text}</div><div class="totals"><div class="total"><span>Registros</span><b>${items.length}</b></div><div class="total"><span>Saldo somado</span><b>${formatMoney(totalSaldo)}</b></div><div class="total"><span>Diferença caixa</span><b>${formatMoney(totalDiff)}</b></div><div class="total"><span>Ajustes</span><b>${formatMoney(totalAjustes)}</b></div><div class="total"><span>Média por fechamento</span><b>${formatMoney(avgSaldo)}</b></div></div></header><main>${blocks || `<section class="close-block">Nenhum fechamento encontrado.</section>`}</main></body></html>`;
    }

    function generateBankPdfReport(){
      const items = $("reportStart") ? getReportItems() : visibleHistory();
      const win = window.open("", "_blank");
      if(!win) return alert("Permita pop-ups para gerar o PDF.");
      win.document.open();
      win.document.write(buildBankPdfHtml(items));
      win.document.close();
      setTimeout(()=>{ win.focus(); win.print(); }, 500);
    }

    function startHistoryRealtimeListener(){ if(historyUnsubscribe) historyUnsubscribe(); const qh=query(collection(db,"history"),orderBy("submittedAt","desc"),limit(300)); historyUnsubscribe=onSnapshot(qh,snap=>{historyCache=snap.docs.map(d=>({id:d.id,...d.data()})); hideNotice("appNotice"); renderAll();},error=>{console.warn("History permission/listener:",error); showNotice("appNotice",friendlyError(error),"error"); historyCache=[]; renderAll();}); }
    function startSystemRealtime(){ if(systemUnsubscribe) systemUnsubscribe(); systemUnsubscribe=onSnapshot(doc(db,"system","saldoReca"),snap=>{ if(!snap.exists()) return; const data=snap.data(); if(data.valor!==undefined){$("homeSaldoReca").textContent=formatMoney(data.valor); $("homeUpdatedAt").textContent="Saldo realtime: "+dateLabel(data.updatedAt);}},error=>console.warn("Saldo Reca realtime não configurado:",error)); }

    async function safeSetUserProfile(user, profile){ try{ await setDoc(doc(db,"users",user.uid), profile, { merge:true }); return true; }catch(e){ console.warn("Não conseguiu gravar perfil:",e); showNotice("appNotice",friendlyError(e),"error"); return false; } }
    async function loadProfile(user){ const ref=doc(db,"users",user.uid); try{ const snap=await getDoc(ref); if(snap.exists()) return snap.data(); const bootstrap=isBootstrapEmail(user.email); const profile={email:user.email,name:user.email.split("@")[0],role:bootstrap?"admin":"operator",approved:bootstrap?true:false,blocked:false,createdAt:serverTimestamp()}; await safeSetUserProfile(user,profile); return profile; }catch(e){ console.warn("Erro ao ler perfil:",e); if(isBootstrapEmail(user.email)){ return {email:user.email,name:user.email.split("@")[0],role:"admin",approved:true,blocked:false,localOnly:true}; } showNotice("appNotice",friendlyError(e),"error"); return {email:user.email,name:user.email.split("@")[0],role:"operator",approved:false,blocked:false,permissionError:true}; } }
    async function addAudit(action,description){ try{ await addDoc(collection(db,"audit_logs"),{action,description,uid:currentUser?.uid||null,email:currentUser?.email||null,createdAt:serverTimestamp()}); }catch(e){ console.warn("Audit não gravado:",e); } }

    async function loadUsers(){
      if(!await requireAdmin()) return;
      try{
        const snap = await getDocs(collection(db,"users"));

        $("usersList").innerHTML = snap.docs.map(d=>{
          const u = d.data();
          const role = u.role || "operator";
          const status = u.blocked ? "Bloqueado" : (u.approved ? "Aprovado" : "Pendente");

          return `<div class="user-item">
            <div>
              <strong>${u.name || u.email || "Usuário"}</strong>
              <div class="muted">${u.email || ""}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;">
                <span class="badge ${u.approved?'ok':'off'}">${u.approved?'Aprovado':'Pendente'}</span>
                <span class="badge ${u.blocked?'off':'ok'}">${u.blocked?'Bloqueado':'Ativo'}</span>
                <span class="badge">${role}</span>
              </div>
            </div>

            <div class="user-actions">
              <select data-role-select="${d.id}">
                <option value="operator" ${role === "operator" ? "selected" : ""}>Operador</option>
                <option value="supervisor" ${role === "supervisor" ? "selected" : ""}>Supervisor</option>
                <option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>
              </select>

              <select data-action-select="${d.id}">
                <option value="approve">Aprovar com cargo</option>
                <option value="save_role">Salvar cargo</option>
                <option value="block">${u.blocked ? "Desbloquear" : "Bloquear"}</option>
              </select>

              <button class="small-btn" data-run-user-action="${d.id}">Executar</button>
            </div>
          </div>`;
        }).join("") || `<div class="user-item">Nenhum usuário encontrado.</div>`;

        document.querySelectorAll("[data-run-user-action]").forEach(btn=>btn.onclick=async()=>{
          const id = btn.dataset.runUserAction;
          const role = document.querySelector(`[data-role-select="${id}"]`)?.value || "operator";
          const action = document.querySelector(`[data-action-select="${id}"]`)?.value || "approve";

          if(action === "approve"){
            await updateDoc(doc(db,"users",id), { approved:true, role });
            await addAudit("approve_user", `Usuário aprovado como ${role}`);
          }

          if(action === "save_role"){
            await updateDoc(doc(db,"users",id), { role });
            await addAudit("update_user_role", `Cargo alterado para ${role}`);
          }

          if(action === "block"){
            const s = await getDoc(doc(db,"users",id));
            await updateDoc(doc(db,"users",id), { blocked:!s.data()?.blocked });
            await addAudit("toggle_user_block", `Status de bloqueio alterado`);
          }

          loadUsers();
        });
      }catch(e){
        $("usersList").innerHTML=`<div class="notice error">${friendlyError(e)}</div>`;
      }
    }

    async function loadAudit(){ if(!isAdmin()) return; try{ const qh=query(collection(db,"audit_logs"),orderBy("createdAt","desc"),limit(20)); const snap=await getDocs(qh); $("auditList").innerHTML=snap.docs.map(d=>{const a=d.data(); return `<div class="history-item"><div class="history-top"><strong>${a.action}</strong><span>${dateLabel(a.createdAt)}</span></div><div class="muted">${a.description||""}<br>${a.email||""}</div></div>`;}).join("")||`<div class="history-item">Sem auditoria.</div>`; }catch(e){ $("auditList").innerHTML=`<div class="notice error">${friendlyError(e)}</div>`; } }

    async function createInternalUser(){ if(!await requireAdmin()) return; const email=$("newUserEmail").value.trim(), password=$("newUserPassword").value, name=$("newUserName").value.trim(), role=$("newUserRole").value, supervisorRaw=$("newUserSupervisor")?.value.trim()||""; if(!email||!password) return alert("Informe email e senha."); if(password.length<6) return alert("A senha precisa ter pelo menos 6 caracteres."); const secondaryApp=initializeApp(firebaseConfig,"SecondaryUserCreator"+Date.now()), secondaryAuth=getAuth(secondaryApp); try{ const cred=await createUserWithEmailAndPassword(secondaryAuth,email,password); await setDoc(doc(db,"users",cred.user.uid),{email,name:name||email.split("@")[0],role,supervisorUid:role==="operator"&&!supervisorRaw.includes("@")?(supervisorRaw||null):null,supervisorEmail:role==="operator"&&supervisorRaw.includes("@")?supervisorRaw:null,approved:true,blocked:false,createdAt:serverTimestamp(),createdBy:currentUser?.uid||null}); await signOut(secondaryAuth); await deleteApp(secondaryApp); await addAudit("create_user",`Usuário criado: ${email}`); ["newUserEmail","newUserPassword","newUserName","newUserSupervisor"].forEach(id=>{if($(id)) $(id).value="";}); await loadUsers(); alert("Usuário criado com sucesso."); }catch(e){ try{await signOut(secondaryAuth);await deleteApp(secondaryApp);}catch(_ignored){} alert(friendlyError(e)); } }
    async function registerAccess(){ const email=$("loginEmail").value.trim(), password=$("loginPassword").value; if(!email||!password) return showNotice("loginNotice","Informe email e senha para criar acesso.","error"); if(password.length<6) return showNotice("loginNotice","A senha precisa ter pelo menos 6 caracteres.","error"); try{ const bootstrap=isBootstrapEmail(email); const cred=await createUserWithEmailAndPassword(auth,email,password); const profile={email,name:email.split("@")[0],role:bootstrap?"admin":"operator",approved:bootstrap?true:false,blocked:false,createdAt:serverTimestamp()}; await safeSetUserProfile(cred.user,profile); showNotice("loginNotice",bootstrap?"Conta admin criada. Entrando...":"Conta criada. Aguarde aprovação do admin.",bootstrap?"ok":"error"); }catch(e){ showNotice("loginNotice",friendlyError(e),"error"); } }

    function showScreen(name){
      if(name === "Admin" && !isAdmin()){
        alert("Painel Admin liberado somente para admin.");
        return;
      }

      document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
      $("screen"+name)?.classList.add("active");
      document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.screen===name));
      $("moreMenuBtn")?.classList.toggle("active", ["Ranking","Reports","Admin"].includes(name));
      $("moreMenu")?.classList.remove("active");

      if(name==="Admin"){loadUsers();loadAudit();}
      if(name==="Ranking") renderRanking();
      if(name==="Reports") previewReport();
      if(name==="Goals") renderMonthlyGoal(visibleHistory());
    }
    function updateRoleVisibility(){
      const adminOnlyIds = [
        "cargasPoker",
        "cargasCasino",
        "editCargasPoker",
        "editCargasCasino",
        "quickChargeCard"
      ];

      adminOnlyIds.forEach(id => {
        const el = $(id);
        const wrapper = el?.closest(".field") || el;
        if(wrapper) wrapper.style.display = isAdmin() ? "" : "none";
      });
    }

    function bindEvents(){
      if(bindEvents._bound) return;
      bindEvents._bound = true;
      // logo volta para início
      if($("logoRefreshBtn")){
        $("logoRefreshBtn").onclick = () => {
          showScreen("Home");
          refreshInternal();
        };
      } applyBankMoneyMaskAll(document); enableClearOnFocus(); ["webReca","suprema","pppoker","buffalo","ganamos","cargasPoker","cargasCasino","quickCargaCasino","quickRetiradaCaixa","operatorName","closingDate","editWebReca","editSuprema","editPppoker","editBuffalo","editGanamos","editCargasPoker","editCargasCasino"].forEach(id=>$(id)?.addEventListener("input",renderCalculations)); document.addEventListener("bankmoney", renderCalculations); $("togglePendingBtn") && ($("togglePendingBtn").onclick=()=>{ const panel=$("pendingPanel"); panel?.classList.toggle("active"); $("togglePendingBtn").textContent = panel?.classList.contains("active") ? "Ocultar" : "Abrir"; });
      $("toggleOutflowBtn") && ($("toggleOutflowBtn").onclick=()=>{ const panel=$("outflowPanel"); panel?.classList.toggle("active"); $("toggleOutflowBtn").textContent = panel?.classList.contains("active") ? "Ocultar" : "Abrir"; });
      $("addPendingBtn") && ($("addPendingBtn").onclick=()=>createDynamicRow("pendingList","Nome / motivo"));
      $("addOutflowBtn") && ($("addOutflowBtn").onclick=()=>createDynamicRow("outflowList","Descrição"));
      $("quickChargeBtn") && ($("quickChargeBtn").onclick=addQuickCapitalInjection);
      $("toggleQuickChargeBtn") && ($("toggleQuickChargeBtn").onclick=()=>{
        const panel = $("quickChargePanel");
        panel?.classList.toggle("active");
        $("toggleQuickChargeBtn").textContent = panel?.classList.contains("active") ? "Ocultar carga rápida" : "Mostrar carga rápida";
      }); $("clearClosingBtn") && ($("clearClosingBtn").onclick=clearClosingForm);
      $("saveClosingBtn") && ($("saveClosingBtn").onclick=saveClosing);
      $("refreshBtn") && ($("refreshBtn").onclick=refreshInternal);
      // BK já volta para Início e atualiza no começo do bindEvents()
      $("recalculateBtn") && ($("recalculateBtn").onclick=recalculateAllHistory);
      $("pdfReportBtn") && ($("pdfReportBtn").onclick=generateBankPdfReport);
      $("previewReportBtn") && ($("previewReportBtn").onclick=previewReport);
      $("generateReportBtn") && ($("generateReportBtn").onclick=generateBankPdfReport);
      ["reportStart","reportEnd","reportOperator","reportSupervisor"].forEach(id=>$(id)?.addEventListener("input",previewReport));
      $("loadUsersBtn") && ($("loadUsersBtn").onclick=loadUsers);
      $("toggleCreateUserBtn") && ($("toggleCreateUserBtn").onclick=()=>{
        const panel = $("createUserPanel");
        panel?.classList.toggle("active");
        $("toggleCreateUserBtn").textContent = panel?.classList.contains("active") ? "Ocultar criar usuário" : "Mostrar criar usuário";
      });
      $("createUserBtn") && ($("createUserBtn").onclick=createInternalUser);
      $("historySearch")?.addEventListener("input",()=>{ historyRenderLimit=30; renderHistory(); });
      $("historyDate")?.addEventListener("input",()=>{ historyRenderLimit=30; renderHistory(); }); document.querySelectorAll(".nav-btn[data-screen]").forEach(btn=>btn.onclick=()=>showScreen(btn.dataset.screen));
      document.querySelectorAll("[data-home-detail]").forEach(card=>{
        card.onclick = () => openHomeMetricDetail(card.dataset.homeDetail);
      });
      $("toggleComparativoBtn") && ($("toggleComparativoBtn").onclick=()=>{
        const section = $("comparativoSection");
        const btn = $("toggleComparativoBtn");
        if(!section || !btn) return;

        const shouldOpen = section.classList.contains("hidden");
        section.classList.toggle("hidden", !shouldOpen);
        btn.textContent = shouldOpen ? "Ocultar comparativo" : "Ver comparativo";

        const last = lastRealClosing() || visibleHistory()[0] || null;
        const prev = last ? previousRealClosingAfter(last) : (visibleHistory()[1] || null);
        renderChipsComparison(last, prev);
      });
      $("moreMenuBtn") && ($("moreMenuBtn").onclick=(ev)=>{
        ev.stopPropagation();
        $("moreMenu")?.classList.toggle("active");
      });
      document.addEventListener("click", (ev)=>{
        const menu = $("moreMenu");
        if(!menu?.classList.contains("active")) return;
        if(menu.contains(ev.target) || $("moreMenuBtn")?.contains(ev.target)) return;
        menu.classList.remove("active");
      });
      document.querySelectorAll("[data-more-screen]").forEach(btn=>btn.onclick=(ev)=>{ ev.stopPropagation(); showScreen(btn.dataset.moreScreen); }); document.querySelectorAll("[data-rank]").forEach(btn=>btn.onclick=()=>{document.querySelectorAll("[data-rank]").forEach(b=>b.classList.remove("active")); btn.classList.add("active"); currentRankRange=btn.dataset.rank; renderRanking();}); $("logoutBtn").onclick=async()=>{if(historyUnsubscribe)historyUnsubscribe();if(systemUnsubscribe)systemUnsubscribe();await signOut(auth);}; $("loginBtn").onclick=async()=>{try{hideNotice("loginNotice");await signInWithEmailAndPassword(auth,$("loginEmail").value.trim(),$("loginPassword").value);}catch(e){showNotice("loginNotice",friendlyError(e),"error");}}; $("registerBtn").onclick=registerAccess; $("resetPasswordBtn").onclick=async()=>{try{const email=$("loginEmail").value.trim(); if(!email) return showNotice("loginNotice","Informe o email.","error"); await sendPasswordResetEmail(auth,email); showNotice("loginNotice","Email de recuperação enviado.","ok");}catch(e){showNotice("loginNotice",friendlyError(e),"error");}}; $("receiptCloseBtn") && ($("receiptCloseBtn").onclick=closeHistoryReceipt);
      $("receiptExportPngBtn") && ($("receiptExportPngBtn").onclick=exportReceiptAsPng);
      $("editCloseBtn").onclick=closeEdit; $("cancelEditBtn").onclick=closeEdit; $("saveEditBtn").onclick=saveEdit; $("editAddPendingBtn").onclick=()=>createDynamicRow("editPendingList","Nome / motivo"); $("editAddOutflowBtn").onclick=()=>createDynamicRow("editOutflowList","Descrição"); }
    function initDate(){ const now=new Date(); now.setMinutes(now.getMinutes()-now.getTimezoneOffset()); $("closingDate").value=now.toISOString().slice(0,16); }

    onAuthStateChanged(auth,async(user)=>{ currentUser=user; if(!user){$("loginScreen").classList.remove("hidden");$("appShell").classList.add("hidden");$("bottomNav").classList.add("hidden"); syncBodyThemeState(); return;} currentProfile=await loadProfile(user); if(currentProfile.blocked){await signOut(auth);return alert("Usuário bloqueado.");} if(currentProfile.approved===false){$("loginScreen").classList.remove("hidden");$("appShell").classList.add("hidden");$("bottomNav").classList.add("hidden");syncBodyThemeState();showNotice("loginNotice","Usuário aguardando aprovação do admin.","error");return;} $("loginScreen").classList.add("hidden");$("appShell").classList.remove("hidden");$("bottomNav").classList.remove("hidden");syncBodyThemeState();$("topUserLabel").textContent=`${currentProfile.name||user.email} • ${isAdmin()?"Admin":isSupervisor()?"Supervisor":"Operador"}`; $("adminStatus").textContent=isAdmin()?"Admin ativo":"Somente admin";
      if($("moreAdminBtn")) $("moreAdminBtn").style.display = isAdmin() ? "flex" : "none";

      updateRoleVisibility(); if(currentProfile.permissionError) showNotice("appNotice","Seu login entrou, mas o Firestore negou acesso ao perfil. Ajuste as regras ou coloque seu email em BOOTSTRAP_ADMIN_EMAILS.","error"); startHistoryRealtimeListener(); startSystemRealtime(); fillOperatorFromProfile(); renderAll(); });

    function runSelfTests(){
      const savedUser = currentUser;
      const savedProfile = currentProfile;
      const tests=[];
      const assert=(name,cond)=>tests.push({name,pass:!!cond});

      assert("money BR",moneyToNumber("1.234,56")===1234.56);
      assert("money US",moneyToNumber("1,234.56")===1234.56);
      assert("calc multipliers",calcularSaldoLiquido({webReca:100,suprema:1,pppoker:2,buffalo:10,ganamos:20,cargasPoker:1,cargasCasino:5,pendentesTotal:15,saidasTotal:7})===1327);
      assert("history access approved",canAccessHistoryItem({createdBy:"u1",turno:{}})===true);

      currentUser = savedUser;
      currentProfile = savedProfile;
      console.table(tests);
      return tests;
    }
    window.BankKingTests={runSelfTests,moneyToNumber,calcularSaldoLiquido};

    function bindHeroLiveGlow(){
      // Removido: sem efeito de luz acompanhando o dedo.
    }

    document.addEventListener("DOMContentLoaded",()=>{
      bindEvents();
      initDate();
      document.body.classList.add("app-ready");
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
          navigator.serviceWorker.register("./service-worker.js").catch((error) => {
            console.warn("Service worker não registrado:", error);
          });
        }, { once: true });
      }
      setTimeout(()=>{const splash=$("appSplash"); splash?.classList.add("hide"); setTimeout(()=>splash?.remove(),800);},1600);
      runSelfTests();
    });
