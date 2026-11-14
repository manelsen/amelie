//// Avisos ao admin quando um provedor de IA cai (o disjuntor abre) e quando
//// volta. Sem esses avisos, a Amélie fica no ar, com o healthcheck em "ok",
//// mas sem responder a quem usa o provedor caído.

import dominio/erro
import dominio/id_chat.{type IdChat}
import gleam/int
import gleam/option.{type Option, None, Some}
import logging
import portas/mensageiro_porta.{type MensageiroPorta}
import shell/disjuntor.{type Transicao, Abriu, Fechou}
import shell/sistema

pub fn texto(provedor: String, transicao: Transicao) -> String {
  case transicao {
    Abriu ->
      "🔴 *"
      <> provedor
      <> " fora do ar*\n\n"
      <> "Depois de "
      <> int.to_string(disjuntor.limite_falhas_padrao)
      <> " falhas seguidas, a Amélie parou de chamar o "
      <> provedor
      <> ". Quem usa esse provedor fica sem resposta da IA até ele voltar.\n\n"
      <> "Ela testa de novo a cada minuto e avisa aqui quando voltar."
    Fechou(fora_ms) ->
      "🟢 *"
      <> provedor
      <> " voltou*\n\n"
      <> "A IA está respondendo de novo. Ficou fora por "
      <> duracao(fora_ms)
      <> "."
  }
}

fn duracao(ms: Int) -> String {
  case ms / 60_000 {
    0 -> "menos de 1 min"
    minutos if minutos < 60 -> int.to_string(minutos) <> " min"
    minutos ->
      int.to_string(minutos / 60)
      <> " h "
      <> int.to_string(minutos % 60)
      <> " min"
  }
}

/// O gancho que o disjuntor chama nas transições. Envia em processo à parte,
/// para o ator do disjuntor nunca esperar o mensageiro. Sem admin, não faz nada.
pub fn notificador(
  provedor: String,
  mensageiro: MensageiroPorta,
  admin: Option(IdChat),
) -> fn(Transicao) -> Nil {
  case admin {
    None -> fn(_) { Nil }
    Some(admin) -> fn(transicao) {
      sistema.disparar(fn() { avisar(provedor, transicao, mensageiro, admin) })
    }
  }
}

/// Envia o aviso e registra no log se o envio falhar (não há nova tentativa:
/// o próximo aviso, ou o `/status`, mostram o estado).
pub fn avisar(
  provedor: String,
  transicao: Transicao,
  mensageiro: MensageiroPorta,
  admin: IdChat,
) -> Nil {
  case mensageiro.enviar(admin, texto(provedor, transicao)) {
    Ok(Nil) -> Nil
    Error(e) ->
      logging.log(
        logging.Warning,
        "[Avisos] Falha ao avisar o admin sobre o "
          <> provedor
          <> ": "
          <> erro.descricao(e),
      )
  }
}
