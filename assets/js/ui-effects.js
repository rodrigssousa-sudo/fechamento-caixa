/* =========================================================
   💸 CONTADOR ANIMADO (TIPO BANCO)
========================================================= */
function animateValue(el, start, end, duration = 800){
  if(!el) return;

  const range = end - start;
  const startTime = performance.now();

  function update(currentTime){
    const progress = Math.min((currentTime - startTime) / duration, 1);

    const ease = 1 - Math.pow(1 - progress, 3); // easeOut
    const value = start + (range * ease);

    el.textContent = formatMoney(value);

    if(progress < 1){
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

/* =========================================================
   🔄 ATUALIZAÇÃO AO VIVO DO CARD
========================================================= */
let lastBalance = 0;

function updateHeroBalance(newValue){
  const el = document.querySelector(".hero-value");
  if(!el) return;

  const oldValue = lastBalance || 0;

  animateValue(el, oldValue, newValue);

  el.classList.remove("balance-positive","balance-negative","balance-pulse");

  if(newValue > oldValue){
    el.classList.add("balance-positive");
  }else if(newValue < oldValue){
    el.classList.add("balance-negative");
  }

  el.classList.add("balance-pulse");

  setTimeout(()=>{
    el.classList.remove("balance-pulse");
  },600);

  lastBalance = newValue;
}

/* =========================================================
   📡 SIMULAÇÃO (REMOVER EM PRODUÇÃO)
========================================================= */
// setInterval(()=>{
//   const random = lastBalance + (Math.random() * 50000 - 25000);
//   updateHeroBalance(Math.max(0, random));
// },3000);
