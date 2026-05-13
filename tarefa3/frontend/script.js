const API_BASE = "";

  // Histórico local (persistente)
  const STORAGE_KEY = "corecraft_tx_history_v2";
  let history = loadHistory();

  function nowIso(){ return new Date().toISOString(); }
  function fmtTime(iso){
    const d = new Date(iso);
    return d.toLocaleString();
  }

  function loadHistory(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }catch(e){ return []; }
  }
  function saveHistory(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }

  function statusClass(status, confirmed){
    if(status === "error" || status === "unknown") return "b-error";
    if(confirmed || status === "confirmed") return "b-confirmed";
    if(status === "mempool") return "b-mempool";
    return "b-broadcast";
  }
  function statusLabel(status, confirmed){
    if(status === "error" || status === "unknown") return "erro";
    if(confirmed || status === "confirmed") return "confirmada";
    if(status === "mempool") return "mempool";
    return "broadcast";
  }

  function showToast(title, body, status="broadcast", confirmed=false){
    const toast = document.getElementById("toast");
    const badge = document.getElementById("toastBadge");
    const badgeText = document.getElementById("toastBadgeText");

    document.getElementById("toastTitle").innerText = title;
    document.getElementById("toastBody").innerText = body;

    badge.className = "badge " + statusClass(status, confirmed);
    badgeText.innerText = statusLabel(status, confirmed);

    toast.style.display = "flex";
  }
  function hideToast(){
    document.getElementById("toast").style.display = "none";
  }

  function setBackendIndicator(ok, text){
    const dot = document.getElementById("apiDot");
    const label = document.getElementById("apiText");
    label.innerText = text;

    if(ok){
      dot.style.background = "var(--ok)";
      dot.style.boxShadow = "0 0 0 4px rgba(43,228,167,.12)";
    }else{
      dot.style.background = "var(--bad)";
      dot.style.boxShadow = "0 0 0 4px rgba(255,92,122,.12)";
    }
  }

  async function sendTx(){
    const btn = document.getElementById("btnSend");
    const address = document.getElementById("address").value.trim();
    const amount = document.getElementById("amount").value.trim();

    if(!address || !amount){
      showToast("Campos obrigatórios", "Preencha endereço e valor antes de enviar.", "error", false);
      return;
    }

    btn.disabled = true;

    try{
      const res = await fetch(`${API_BASE}/send`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ address, amount })
      });

      const data = await res.json().catch(()=> ({}));

      if(!res.ok){
        const msg = data?.error || data?.message || `HTTP ${res.status}`;
        showToast("Falha ao enviar", msg, "error", false);
        btn.disabled = false;
        return;
      }

      const txid = data.txid;
      history.unshift({
        txid,
        address,
        amount,
        createdAt: nowIso(),
        status: "broadcast",
        confirmed: false,
        block_hash: null
      });
      saveHistory();
      render();

      showToast("Transação enviada", `txid: ${txid}`, "broadcast", false);
      setTimeout(hideToast, 4000);
      document.getElementById("amount").value = "";

    }catch(e){
      showToast("Erro de rede", String(e), "error", false);
    }finally{
      btn.disabled = false;
    }
  }

  function clearHistory(){
    history = [];
    saveHistory();
    render();
    showToast("Histórico limpo", "Lista de transações removida do navegador.", "broadcast", false);
  }

  function copy(text){
    navigator.clipboard?.writeText(text).then(()=>{
      showToast("Copiado", text, "mempool", false);
    }).catch(()=>{
      showToast("Não foi possível copiar", "Seu navegador bloqueou clipboard.", "error", false);
    });
  }

  function render(){
    const list = document.getElementById("list");
    const empty = document.getElementById("empty");
    const countTag = document.getElementById("countTag");

    countTag.innerText = `${history.length} item${history.length === 1 ? "" : "s"}`;

    list.innerHTML = "";

    if(history.length === 0){
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    for(const item of history){
      const confirmed = !!item.confirmed;
      const sClass = statusClass(item.status, confirmed);
      const sLabel = statusLabel(item.status, confirmed);

      const blockInfo = item.block_hash
        ? `<span class="mono txid">bloco: ${item.block_hash}</span>`
        : `<span class="mono">bloco: —</span>`;
        
      const aviso = item.warning;

      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `
        <div>
          <div class="itemTop">
            <span class="badge ${sClass}">
              <span class="bDot"></span>
              <span>${sLabel}</span>
            </span>
            <span class="mono">${fmtTime(item.createdAt)}</span>
          </div>

          <div class="meta">
            <span class="mono">destino: ${item.address}</span>
            <span class="mono">valor: ${item.amount} BTC</span>
          </div>

          <div class="meta" style="margin-top:8px;">
            <span class="mono txid">txid: ${item.txid}</span>
            ${blockInfo}
          </div>

          <div class="meta">
          	${aviso}
          </div>
        </div>

        <div class="actions">
          <button class="ghost" onclick="copy('${item.txid}')">Copiar txid</button>
          ${item.block_hash ? `<button class="ghost" onclick="copy('${item.block_hash}')">Copiar bloco</button>` : ``}
        </div>
      `;
      list.appendChild(el);
    }
  }

  // Atualiza o item ativo com base no /status (estado global do backend)
  function applyBackendState(st){
    const tag = document.getElementById("lastStatusTag");
    tag.innerText = `status: ${st?.status || "—"}`;

    const current = st?.current_txid;
    if(!current) return;

    const idx = history.findIndex(x => x.txid === current);
    if(idx === -1) return;
    
    if(st.confirmed)
    {
		history[idx].message = "";
    	history[idx].warning = "";
	}

    history[idx].status = st.status || history[idx].status;
    history[idx].confirmed = !!st.confirmed;
    history[idx].block_hash = st.block_hash || history[idx].block_hash || null;
    history[idx].message = history[idx].message || "";
    history[idx].warning = history[idx].warning || "";

    saveHistory();
    render();
  }

  async function refreshOneTx(txid){
    try{
      const res = await fetch(`${API_BASE}/tx/${txid}`);
      if(!res.ok) return null;
      return await res.json();
    }catch(e){
      return null;
    }
  }

  // Atualiza TODAS as transações pendentes consultando /tx/<txid>
async function refreshPendingTxs(){
  const pending = history.filter(x => !x.confirmed);

  let changed = false;

  for(const item of pending){
    try{
      const res = await fetch(`/tx/${item.txid}?t=${Date.now()}`);

      if(!res.ok){
        continue;
      }

      const st = await res.json();

      if(st.status && st.status !== "unknown"){
        item.status = st.status;
      }

      if(typeof st.confirmed === "boolean"){
        item.confirmed = st.confirmed;
      }

      if(st.block_hash){
        item.block_hash = st.block_hash;
      }

      if(st.message){
        item.message = st.message;
      }

      if(st.warning){
        item.warning = st.warning;
      }
      
      if(item.confirmed)
      {
		item.message = "";
		item.warning = "";
	  }

      changed = true;

    }catch(e){
      console.log("Erro ao atualizar tx:", item.txid, e);
    }
  }

  if(changed){
    saveHistory();
    render();
  }
}

  async function poll(){
    try{
      const res = await fetch(`${API_BASE}/status`);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const st = await res.json();

      setBackendIndicator(true, "Backend online");
      applyBackendState(st);
      loadWalletStatus();

      // ✅ novo: também atualiza transações antigas
      await refreshPendingTxs();

    }catch(e){
      setBackendIndicator(false, "Backend offline");
    }
  }
  
  async function listWallets()
  {
	try
	{
      const res = await fetch(`${API_BASE}/wallets`);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      
      let select = document.getElementById("carteiras");

      json.available_wallets.wallets.forEach(wallet => 
      {
		const opt = new Option(wallet.name, wallet.name);
		
		select.add(opt);
	  });
    }
    catch(e)
    {
      setBackendIndicator(false, "Backend offline");
    }
  }
  
  async function selectWallet(carteira)
  {
	const res = await fetch(`${API_BASE}/wallet/select`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
			"wallet": carteira
	  	})
  	});

    const data = await res.json()
    
    console.log(data);
  }
  
  async function loadWalletStatus()
  {
	try
	{
      const res = await fetch(`${API_BASE}/wallets/status`);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      
      document.getElementById("nome-carteira").innerText = json.wallet;
      document.getElementById("saldo-carteira").innerText = json.balance;
      document.getElementById("utxos-disponiveis").innerText = json.utxos;
    }
    catch(e)
    {
      setBackendIndicator(false, "Backend offline");
    }
  }

  render();
  poll();
  setInterval(poll, 2000);
  listWallets();