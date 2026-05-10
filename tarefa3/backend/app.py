'''
Created on 7 de mai. de 2026

@author: sergio
'''
# backend.py

from flask import Flask, request, jsonify, send_from_directory

from tx_builder import build_transaction
from zmq_listener import start_zmq_listeners
from state import state
from rpc import BitcoinRPC

import threading
from builtins import list, len
from distutils.log import info

app = Flask(__name__, static_folder="../frontend", static_url_path="")

rpc = BitcoinRPC(
    "http://127.0.0.1:58443",
    "teste",
    "teste"
)

class InMemoryState:
    def __init__(self):
        self.lock = threading.Lock()

MEMORIA = InMemoryState()


@app.route("/", methods=["GET"])
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.get("/style.css")
def styles():
    return send_from_directory(app.static_folder, "style.css")

@app.get("/script.js")
def js():
    return send_from_directory(app.static_folder, "script.js")


@app.route("/send", methods=["POST"])
def send_tx():
    try:
        print("\n>>> ENTROU NO /send (POST)")
        print("Content-Type:", request.headers.get("Content-Type"))
        print("Raw body:", request.data)

        data = request.get_json(silent=True)
        print("JSON parseado:", data)

        if not data:
            return jsonify({"error": "JSON inválido ou ausente"}), 400

        to_address = data.get("address")
        amount = data.get("amount")

        if not to_address or amount is None:
            return jsonify({"error": "Campos obrigatórios: address, amount"}), 400

        amount = float(amount)

        print(f"Construindo TX -> address={to_address} amount={amount}")

        # 1) Build raw tx sem bitcoin-lib.
        # O tx_builder monta inputs/outputs e usa createrawtransaction via RPC.
        raw_tx = build_transaction(to_address, amount)
        print("Raw TX gerada (hex, início):", raw_tx[:80] + "...")

        # 2) Sign via Bitcoin Core wallet (RPC)
        signed = rpc.call("signrawtransactionwithwallet", [raw_tx])
        if not signed.get("complete"):
            raise Exception(f"Falha ao assinar TX: {signed}")

        signed_tx = signed["hex"]
        print("Signed TX (hex, início):", signed_tx[:80] + "...")

        # 3) Broadcast via RPC
        txid = rpc.call("sendrawtransaction", [signed_tx])
        print("✅ TX enviada! txid =", txid)

        # Atualiza estado imediatamente
        state["current_txid"] = txid
        state["status"] = "broadcast"
        state["seen_in_mempool"] = False
        state["confirmed"] = False
        state["block_hash"] = None

        # se já entrou na mempool, marca agora via RPC
        try:
            rpc.call("getmempoolentry", [txid])
            state["seen_in_mempool"] = True
            state["status"] = "mempool"
            print("[RPC mempool] ✅ tx já está na mempool, marcando state=mempool")
        except Exception:
            print("[RPC mempool] tx ainda não está na mempool (ou já confirmou)")

        return jsonify({"txid": txid})

    except Exception as e:
        print("❌ ERRO no /send:", e)
        return jsonify({"error": str(e)}), 500


@app.route("/tx/<txid>", methods=["GET"])
def tx_status(txid):
    """
    Retorna o status de um txid específico sem depender de txindex,
    usando gettransaction da wallet.
    """
    try:
        info = rpc.call("gettransaction", [txid])
        conf = int(info.get("confirmations", 0) or 0)
        bh = info.get("blockhash")

        if conf > 0 and bh:
            return jsonify({
                "txid": txid,
                "status": "confirmed",
                "confirmed": True,
                "confirmations": conf,
                "block_hash": bh
            })

        return jsonify({
            "txid": txid,
            "status": "mempool",
            "confirmed": False,
            "confirmations": conf,
            "block_hash": None
        })

    except Exception as e:
        return jsonify({
            "txid": txid,
            "status": "unknown",
            "confirmed": False,
            "error": str(e)
        }), 404


@app.route("/status", methods=["GET"])
def status():
    """
    Estado global da última transação acompanhada pelo backend.
    Usa gettransaction, não getrawtransaction, para não depender de txindex.
    """
    try:
        cur = state.get("current_txid")

        if state.get("seen_in_mempool") and cur and not state.get("confirmed"):
            tx = rpc.call("gettransaction", [cur])
            bh = tx.get("blockhash")
            conf = int(tx.get("confirmations", 0) or 0)

            if bh and conf > 0:
                state["confirmed"] = True
                state["block_hash"] = bh
                state["status"] = "confirmed"

    except Exception as e:
        print("[/status confirm-check] erro:", e)

    return jsonify(state)


@app.route("/wallets", methods=["GET"])
def wallets():
    try:
        wallets_disponiveis = rpc.call("listwalletdir")
        wallets_carregadas = rpc.call("listwallets")
    except Exception as e:
        print("[/wallets confirm-check] erro:", e)
         
    return jsonify({
        "available_wallets": wallets_disponiveis,
        "loaded_wallets": wallets_carregadas,
        "selected_wallet":"wallet1"
    })
    
def desativar_carteiras():
    for carteira in rpc.call("listwallets"):
        rpc.call("unloadwallet", [carteira])
            
def ativar_carteira(carteira):
    if carteira: rpc.call("loadwallet", [carteira])
    
def get_carteira_ativa():
    wallet_carregada = ""
    
    try:
        wallets_carregadas = rpc.call("listwallets")
    except Exception as e:
        print("[get_carteira_ativa() erro:", e)
        
    if wallets_carregadas:
        wallet_carregada = wallets_carregadas[0]
        
    return wallet_carregada
        
    
@app.route("/wallet/select", methods=["POST"])
def wallet_select():
    data = request.get_json(silent=True)
    print("JSON parseado:", data)
    
    wallet_selecionada = data.get("wallet")
    wallet_info = {}
    
    try:
        desativar_carteiras();
        ativar_carteira(wallet_selecionada)
        if wallet_selecionada: wallet_info = rpc.call("getwalletinfo")
    except Exception as e:
        print("[/wallet/select confirm-check] erro:", e)
        
    return jsonify({
        "selected_wallet": wallet_selecionada,
        "wallet_info": wallet_info
    })


@app.route("/wallets/status", methods=["GET"])
def wallets_status():
    wallet_ativa = get_carteira_ativa()
    balance = 0
    utxos = 0
    
    if wallet_ativa:
        try:
            info = rpc.call("getwalletinfo")
            balance = info.get("balance")
        except Exception as e:
            print("[/wallets/status confirm-check] erro:", e)
        
    return jsonify({
        "wallet": wallet_ativa,
        "balance": balance,
        "utxos": utxos
    })

if __name__ == "__main__":
    start_zmq_listeners()
    app.run(host="127.0.0.1", port=5000, debug=True)
    
