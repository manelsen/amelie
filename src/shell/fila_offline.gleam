import dominio/erro
import dominio/id_chat
import dominio/transacao as t
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import gleam/set
import gleam/string
import logging
import portas/mensageiro_porta.{type MensageiroPorta}
import portas/ponte_porta.{type PontePorta}
import portas/transacao_porta.{type TransacaoPorta}
import shell/ator_vivo
import shell/sistema

pub type FilaOffline =
  process.Subject(Mensagem)

pub type Mensagem {
  ProcessarPendentes
  Parar
}

pub type Estado {
  Estado(
    transacoes: TransacaoPorta,
    mensageiro: MensageiroPorta,
    ponte: PontePorta,
    tentativas_max: Int,
  )
}

/// Quanto tempo uma resposta para o WhatsApp espera a sessão voltar
/// (reconexão ou novo pareamento) antes de ser descartada.
pub const prazo_espera_sessao_s = 86_400

/// Códigos da ponte que indicam a sessão do WhatsApp fora do ar. A falha é
/// do canal, não da mensagem: ela volta a ser enviável quando a sessão voltar.
const codigos_sessao = [
  "whatsapp_logged_out", "whatsapp_session_missing", "whatsapp_disconnected",
  "whatsapp_unauthenticated", "whatsapp_client_unavailable",
  "whatsapp_stream_replaced", "whatsapp_connect_failure",
  "whatsapp_stream_error", "whatsapp_client_outdated",
  "whatsapp_cat_refresh_failed", "whatsapp_temporarily_banned",
  "whatsapp_pair_failed",
]

/// Identifica falhas causadas pela sessão do WhatsApp indisponível. Essas
/// falhas não consomem tentativas: a transação espera a sessão voltar.
pub fn e_erro_sessao(e: erro.Erro) -> Bool {
  case e {
    erro.ErroComunicacao(desc) -> {
      let desc_baixa = string.lowercase(desc)
      list.any(codigos_sessao, fn(codigo) {
        string.contains(desc_baixa, "[" <> codigo <> "]")
      })
    }
    _ -> False
  }
}

/// Identifica se um erro é permanente (não deve ser retentado).
pub fn e_erro_definitivo(e: erro.Erro) -> Bool {
  case e {
    erro.ErroValidacao(..) -> True
    erro.ErroNaoAutorizado -> True
    erro.ErroComandoDesconhecido(..) -> True
    erro.ErroComunicacao(desc) -> {
      let desc_baixa = string.lowercase(desc)
      string.contains(desc_baixa, "invalid_chat_id")
      || string.contains(desc_baixa, "invalid_json")
      || string.contains(desc_baixa, "chat not found")
      || string.contains(desc_baixa, "bot was blocked")
      || string.contains(desc_baixa, "user is deactivated")
      || string.contains(desc_baixa, "status 400")
      || string.contains(desc_baixa, "status 403")
      || string.contains(desc_baixa, "status 404")
      // Parte da resposta já chegou: reenviar tudo repetiria o começo.
      || string.contains(desc_baixa, "envio parcial")
    }
    _ -> False
  }
}

pub fn iniciar(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
  tentativas_max: Int,
) -> Result(FilaOffline, actor.StartError) {
  iniciar_actor(transacoes, mensageiro, ponte, tentativas_max, None)
  |> result.map(fn(started) { started.data })
}

pub fn iniciar_actor(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
  tentativas_max: Int,
  name: Option(process.Name(Mensagem)),
) -> Result(actor.Started(FilaOffline), actor.StartError) {
  let state =
    Estado(
      transacoes: transacoes,
      mensageiro: mensageiro,
      ponte: ponte,
      tentativas_max: tentativas_max,
    )

  let builder =
    actor.new(state)
    |> actor.on_message(tratar)

  let builder = case name {
    Some(n) -> actor.named(builder, n)
    None -> builder
  }

  actor.start(builder)
}

pub fn supervisionado(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
  tentativas_max: Int,
  name: process.Name(Mensagem),
) -> supervision.ChildSpecification(FilaOffline) {
  supervision.worker(fn() {
    iniciar_actor(transacoes, mensageiro, ponte, tentativas_max, Some(name))
  })
}

fn tratar(state: Estado, msg: Mensagem) -> actor.Next(Estado, Mensagem) {
  case msg {
    ProcessarPendentes -> {
      logging.log(logging.Debug, "FilaOffline: processando pendentes")
      processar_pendentes(state)
    }

    Parar -> {
      logging.log(logging.Info, "FilaOffline: parando")
      actor.stop()
    }
  }
}

fn processar_pendentes(state: Estado) -> actor.Next(Estado, Mensagem) {
  case state.transacoes.obter_pendentes() {
    Ok([]) -> {
      logging.log(logging.Debug, "FilaOffline: nenhuma transação pendente")
      actor.continue(state)
    }

    Ok(pendentes) -> {
      logging.log(
        logging.Info,
        "FilaOffline: encontradas "
          <> int.to_string(list.length(pendentes))
          <> " transações pendentes",
      )
      // A ponte só é consultada se houver pendente do WhatsApp, uma vez por ciclo.
      let tem_whatsapp =
        list.any(pendentes, fn(tx) {
          id_chat.canal(tx.chat_id) == id_chat.CanalWhatsapp
        })
      let whatsapp_disponivel = tem_whatsapp && whatsapp_disponivel(state)
      let agora = sistema.agora_s()
      // Um chat que falhou neste ciclo fica para o próximo: as partes de uma
      // resposta longa não podem chegar fora de ordem.
      let _ =
        list.fold(pendentes, set.new(), fn(travados, tx) {
          case set.contains(travados, tx.chat_id) {
            True -> travados
            False -> {
              let segue = case id_chat.canal(tx.chat_id), whatsapp_disponivel {
                // Sessão fora: nada sai deste chat, então não há ordem a
                // proteger, e o prazo de cada transação precisa ser visto.
                id_chat.CanalWhatsapp, False -> {
                  aguardar_sessao(state, tx, agora)
                  True
                }
                _, _ -> reenviar_transacao(state, tx)
              }
              case segue {
                True -> travados
                False -> set.insert(travados, tx.chat_id)
              }
            }
          }
        })
      actor.continue(state)
    }

    Error(e) -> {
      logging.log(
        logging.Warning,
        "FilaOffline: erro ao buscar pendentes: " <> erro.descricao(e),
      )
      actor.continue(state)
    }
  }
}

fn whatsapp_disponivel(state: Estado) -> Bool {
  case state.ponte.checar_status() {
    Ok(status) -> status.conectado && status.logado
    Error(_) -> False
  }
}

/// Mantém a transação pendente enquanto a sessão está fora do ar, sem gastar
/// tentativas, e descarta só depois do prazo de espera.
fn aguardar_sessao(state: Estado, tx: t.Transacao, agora: Int) -> Nil {
  case tx.id {
    None -> Nil
    Some(id) ->
      case agora - tx.criado_em > prazo_espera_sessao_s {
        True -> {
          let _ =
            state.transacoes.atualizar_erro(
              id,
              "sessão do WhatsApp indisponível além do prazo de espera",
              tx.tentativas,
            )
          let _ = state.transacoes.atualizar_status(id, t.Descartada)
          logging.log(
            logging.Warning,
            "FilaOffline: transação "
              <> int.to_string(id)
              <> " descartada: sessão do WhatsApp indisponível além do prazo",
          )
        }
        False ->
          logging.log(
            logging.Debug,
            "FilaOffline: transação "
              <> int.to_string(id)
              <> " aguardando a sessão do WhatsApp",
          )
      }
  }
}

/// Devolve True se a transação foi entregue agora.
fn reenviar_transacao(state: Estado, tx: t.Transacao) -> Bool {
  case tx.id {
    None -> False
    Some(id) -> {
      case tx.tentativas < state.tentativas_max {
        True -> {
          logging.log(
            logging.Info,
            "FilaOffline: retry transação "
              <> int.to_string(id)
              <> " (tentativa "
              <> int.to_string(tx.tentativas + 1)
              <> ")",
          )

          case state.mensageiro.enviar(tx.chat_id, tx.conteudo) {
            Ok(_) -> {
              let _ = state.transacoes.marcar_entregue(id)
              logging.log(
                logging.Info,
                "FilaOffline: transação "
                  <> int.to_string(id)
                  <> " enviada com sucesso",
              )
              True
            }
            Error(e) -> {
              case e_erro_sessao(e), e_erro_definitivo(e) {
                True, _ -> {
                  let _ =
                    state.transacoes.atualizar_erro(
                      id,
                      erro.descricao(e),
                      tx.tentativas,
                    )
                  logging.log(
                    logging.Info,
                    "FilaOffline: transação "
                      <> int.to_string(id)
                      <> " aguardando a sessão do WhatsApp: "
                      <> erro.descricao(e),
                  )
                }
                _, True -> {
                  let _ =
                    state.transacoes.atualizar_erro(
                      id,
                      erro.descricao(e) <> " (descarte definitivo)",
                      tx.tentativas + 1,
                    )
                  let _ = state.transacoes.atualizar_status(id, t.Descartada)
                  logging.log(
                    logging.Warning,
                    "FilaOffline: transação "
                      <> int.to_string(id)
                      <> " descartada imediatamente por erro definitivo: "
                      <> erro.descricao(e),
                  )
                }
                _, False -> {
                  let _ =
                    state.transacoes.atualizar_erro(
                      id,
                      erro.descricao(e),
                      tx.tentativas + 1,
                    )
                  logging.log(
                    logging.Warning,
                    "FilaOffline: falha ao enviar transação "
                      <> int.to_string(id)
                      <> ": "
                      <> erro.descricao(e),
                  )
                }
              }
              False
            }
          }
        }
        False -> {
          logging.log(
            logging.Warning,
            "FilaOffline: transação "
              <> int.to_string(id)
              <> " atingiu máximo de tentativas",
          )
          let _ = state.transacoes.atualizar_status(id, t.Descartada)
          False
        }
      }
    }
  }
}

/// Dispara o laço que pede à fila, a cada `intervalo_ms`, que reprocesse as
/// pendentes. O laço não fica ligado a quem chama: se a fila (ator nomeado)
/// estiver reiniciando, o envio só é pulado e o laço tenta de novo no próximo
/// intervalo, em vez de dar panic e derrubar o processo principal pelo link.
/// Devolve o pid do laço (útil para encerrá-lo em testes).
pub fn agendar_processamento(
  fila: FilaOffline,
  intervalo_ms: Int,
) -> process.Pid {
  process.spawn_unlinked(fn() { loop_processamento(fila, intervalo_ms) })
}

fn loop_processamento(fila: FilaOffline, intervalo_ms: Int) -> Nil {
  case ator_vivo.enviar(fila, ProcessarPendentes) {
    True -> Nil
    False ->
      logging.log(
        logging.Warning,
        "FilaOffline: ator indisponível; nova tentativa no próximo intervalo",
      )
  }
  process.sleep(intervalo_ms)
  loop_processamento(fila, intervalo_ms)
}
