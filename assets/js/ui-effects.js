/* =========================================================
   UI EFFECTS - SEGURO E COMPATÍVEL COM O HTML ATUAL
========================================================= */

(function(){
  const moneyFormatter =
    typeof window.formatMoney === "function"
      ? window.formatMoney
      : (value) =>
          new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: "BRL",
            minimumFractionDigits: 2
          }).format(Number(value) || 0);

  function resolveHeroElement(){
    return (
      document.querySelector("[data-hero-balance]") ||
      document.querySelector(".hero-value") ||
      document.getElementById("homeSaldoReca") ||
      document.getElementById("homeSaldoGeral")
    );
  }

  function animateValue(el, start, end, duration = 800){
    if(!el) return;

    const safeStart = Number(start) || 0;
    const safeEnd = Number(end) || 0;
    const range = safeEnd - safeStart;
    const startTime = performance.now();

    function update(currentTime){
      const progress = Math.min((currentTime - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      const value = safeStart + (range * ease);

      el.textContent = moneyFormatter(value);

      if(progress < 1){
        requestAnimationFrame(update);
      }
    }

    requestAnimationFrame(update);
  }

  let lastBalance = 0;

  function updateHeroBalance(newValue){
    const el = resolveHeroElement();
    if(!el) return;

    const numericNewValue = Number(newValue) || 0;
    const oldValue = Number(lastBalance) || 0;

    animateValue(el, oldValue, numericNewValue);

    el.classList.remove("balance-positive", "balance-negative", "balance-pulse");

    if(numericNewValue > oldValue){
      el.classList.add("balance-positive");
    }else if(numericNewValue < oldValue){
      el.classList.add("balance-negative");
    }

    el.classList.add("balance-pulse");

    setTimeout(() => {
      el.classList.remove("balance-pulse");
    }, 600);

    lastBalance = numericNewValue;
  }

  window.animateValue = animateValue;
  window.updateHeroBalance = updateHeroBalance;
})();
