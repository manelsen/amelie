// shell/anti_spam.gleam
// Ator OTP que gerencia o estado in-memory de rate limiting e proteção contra spam.
// Supervisonado sob arvore_supervisao.gleam com auto-recuperação.

import core/anti_spam
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{type Conteudo}
import gleam/bool
import gleam/dict
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import logging
import shell/ator_vivo
import shell/sistema

const max_chats_em_memoria = 500

const ttl_inatividade_ms = 3_600_000

const tempo_resposta_ms = 1000

pub type AntiSpam =
  Subject(MensagemAntiSpam)

pub type MensagemAntiSpam {
  Verificar(
    chat_id: IdChat,
    remetente: IdChat,
    peso: Float,
    conta_flood: Bool,
    agora_ms: Int,
    resposta: Subject(anti_spam.DecisaoAntiSpam),
  )
  VerificarAtrasada(
    chat_id: IdChat,
    remetente: IdChat,
    agora_ms: Int,
    resposta: Subject(anti_spam.DecisaoAntiSpam),
  )
  Desbloquear(alvo: String, resposta: Subject(Bool))
  ContarSilenciados(agora_ms: Int, resposta: Subject(Int))
  EmQuarentena(
    chat_id: IdChat,
    atrasada: Bool,
    agora_ms: Int,
    resposta: Subject(Bool),
  )
  LimpezaPeriodica(agora_ms: Int)
}

type Estado {
  Estado(dados: anti_spam.EstadoAntiSpam, admin_chat_id: Option(IdChat))
}

// ---------------------------------------------------------------------------
// Inicialização & Supervisão
// ---------------------------------------------------------------------------

pub fn iniciar(
  admin_chat_id: Option(IdChat),
) -> Result(AntiSpam, actor.StartError) {
  iniciar_actor(None, admin_chat_id)
  |> result.map(fn(started) { started.data })
}

pub fn iniciar_actor(
  name: Option(process.Name(MensagemAntiSpam)),
  admin_chat_id: Option(IdChat),
) -> Result(actor.Started(AntiSpam), actor.StartError) {
  let builder =
    actor.new(Estado(
      dados: anti_spam.novo_estado(),
      admin_chat_id: admin_chat_id,
    ))
    |> actor.on_message(tratar)

  let builder = case name {
    Some(n) -> actor.named(builder, n)
    None -> builder
  }

  actor.start(builder)
}

pub fn supervisionado(
  name: process.Name(MensagemAntiSpam),
  admin_chat_id: Option(IdChat),
) -> supervision.ChildSpecification(AntiSpam) {
  supervision.worker(fn() { iniciar_actor(Some(name), admin_chat_id) })
}

// ---------------------------------------------------------------------------
// Loop do Ator
// ---------------------------------------------------------------------------

fn tratar(
  estado: Estado,
  msg: MensagemAntiSpam,
) -> actor.Next(Estado, MensagemAntiSpam) {
  case msg {
    Verificar(chat_id, remetente, peso, conta_flood, agora_ms, resposta) -> {
      // Poda proativa se o dicionário exceder limite de capacidade
      let dados_atuais = case dict.size(estado.dados) >= max_chats_em_memoria {
        True ->
          anti_spam.limpar_inativos(estado.dados, agora_ms, ttl_inatividade_ms)
        False -> estado.dados
      }

      let #(novos_dados, decisao) =
        anti_spam.avaliar_carga(
          dados_atuais,
          chat_id,
          remetente,
          estado.admin_chat_id,
          peso,
          conta_flood,
          agora_ms,
        )
      process.send(resposta, decisao)
      actor.continue(Estado(..estado, dados: novos_dados))
    }

    VerificarAtrasada(chat_id, remetente, agora_ms, resposta) -> {
      let #(novos_dados, decisao) =
        anti_spam.avaliar_atrasada(
          estado.dados,
          chat_id,
          remetente,
          estado.admin_chat_id,
          agora_ms,
        )
      process.send(resposta, decisao)
      actor.continue(Estado(..estado, dados: novos_dados))
    }

    Desbloquear(alvo, resposta) -> {
      let #(novos_dados, ok) = anti_spam.desbloquear(estado.dados, alvo)
      process.send(resposta, ok)
      actor.continue(Estado(..estado, dados: novos_dados))
    }

    ContarSilenciados(agora_ms, resposta) -> {
      let count = anti_spam.contar_silenciados(estado.dados, agora_ms)
      process.send(resposta, count)
      actor.continue(estado)
    }

    EmQuarentena(chat_id, atrasada, agora_ms, resposta) -> {
      process.send(
        resposta,
        anti_spam.em_quarentena(estado.dados, chat_id, atrasada, agora_ms),
      )
      actor.continue(estado)
    }

    LimpezaPeriodica(agora_ms) -> {
      let novos_dados =
        anti_spam.limpar_inativos(estado.dados, agora_ms, ttl_inatividade_ms)
      actor.continue(Estado(..estado, dados: novos_dados))
    }
  }
}

// ---------------------------------------------------------------------------
// Funções de Conveniência (Client API)
// ---------------------------------------------------------------------------

/// Verificação de uma mensagem nova. Se o ator não responder (nome sem dono
/// durante o restart, morte ou mais de 1 s), devolve `Permitido` e registra
/// Warning: perder a mensagem do usuário é pior do que deixar passar uma
/// mensagem sem rate limit na janela de restart (o estado em memória do
/// anti-spam se perde no restart de qualquer jeito).
pub fn verificar(
  actor: AntiSpam,
  chat_id: IdChat,
  remetente: IdChat,
  corpo: Conteudo,
) -> anti_spam.DecisaoAntiSpam {
  let peso = anti_spam.peso_mensagem(corpo)
  let conta_flood = anti_spam.conta_para_flood(corpo)
  let agora = sistema.agora_ms()
  chamar(actor, fn(resposta) {
    Verificar(chat_id, remetente, peso, conta_flood, agora, resposta)
  })
  |> decisao_ou_permitir("verificar")
}

/// Verificação de mensagem atrasada (ver `anti_spam.avaliar_atrasada`).
/// Mesmo fallback de `verificar`: sem resposta do ator, `Permitido` + Warning.
pub fn verificar_atrasada(
  actor: AntiSpam,
  chat_id: IdChat,
  remetente: IdChat,
) -> anti_spam.DecisaoAntiSpam {
  let agora = sistema.agora_ms()
  chamar(actor, fn(resposta) {
    VerificarAtrasada(chat_id, remetente, agora, resposta)
  })
  |> decisao_ou_permitir("verificar_atrasada")
}

/// `Ok(True)` se o alvo estava bloqueado e foi liberado, `Ok(False)` se não
/// estava. `Error(Nil)` se o ator não respondeu: o chamador não pode afirmar
/// que o alvo "não estava em quarentena".
pub fn desbloquear(actor: AntiSpam, alvo: String) -> Result(Bool, Nil) {
  chamar(actor, fn(resposta) { Desbloquear(alvo, resposta) })
  |> registrar_sem_resposta("desbloquear")
}

/// Ver `anti_spam.em_quarentena`. Não muda o estado.
/// É só uma economia de download: se o ator não responder (reiniciando,
/// ocupado), devolve False e o download segue; o anti-spam do tratador
/// decide como sempre. Um process.call aqui geraria panic e a mensagem se
/// perderia sem aviso.
pub fn em_quarentena(actor: AntiSpam, chat_id: IdChat, atrasada: Bool) -> Bool {
  chamar(actor, fn(resposta) {
    EmQuarentena(chat_id, atrasada, sistema.agora_ms(), resposta)
  })
  |> result.unwrap(False)
}

/// Quantos chats estão silenciados agora. `Error(Nil)` se o ator não
/// respondeu: o `/status` mostra "indisponível" em vez de um 0 enganoso.
pub fn contar_silenciados(actor: AntiSpam) -> Result(Int, Nil) {
  let agora = sistema.agora_ms()
  chamar(actor, fn(resposta) { ContarSilenciados(agora, resposta) })
  |> registrar_sem_resposta("contar_silenciados")
}

/// Pedido com resposta sem risco de panic: ao contrário de `process.call`,
/// não falha com nome sem dono, ator morto ou tempo esgotado; devolve
/// `Error(Nil)`. Uma resposta tardia fica na caixa do chamador e é ignorada.
fn chamar(
  actor: AntiSpam,
  montar: fn(Subject(r)) -> MensagemAntiSpam,
) -> Result(r, Nil) {
  let resposta = process.new_subject()
  let enviado = ator_vivo.enviar(actor, montar(resposta))
  use <- bool.guard(!enviado, Error(Nil))
  process.receive(resposta, tempo_resposta_ms)
}

fn registrar_sem_resposta(
  resultado: Result(r, Nil),
  operacao: String,
) -> Result(r, Nil) {
  case resultado {
    Ok(_) -> Nil
    Error(Nil) ->
      logging.log(
        logging.Warning,
        "AntiSpam: ator sem resposta em " <> operacao,
      )
  }
  resultado
}

fn decisao_ou_permitir(
  resultado: Result(anti_spam.DecisaoAntiSpam, Nil),
  operacao: String,
) -> anti_spam.DecisaoAntiSpam {
  registrar_sem_resposta(resultado, operacao <> "; mensagem permitida")
  |> result.unwrap(anti_spam.Permitido)
}
