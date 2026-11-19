// Actor de manutenção periódica como OTP Actor supervisionado.
// Executa tarefas de limpeza de arquivos órfãos e manutenção do banco de dados.

import dominio/erro
import gleam/erlang/process.{type Subject}
import gleam/erlang/reference.{type Reference}
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import logging
import portas/transacao_porta.{type TransacaoPorta}
import shell/arquivos_temporarios

// 1 hora em ms
pub const intervalo_padrao_ms = 3_600_000

// Idade máxima para mídias temporárias em segundos (1 hora)
const max_idade_midia_segundos = 3600

pub type MensagemManutencao {
  /// Disparo periódico. `marca` identifica o timer: o ator só aceita o Tick
  /// cuja marca é a do timer que ele mesmo agendou por último. `send_after`
  /// para um nome resolve o destino só na entrega, então um timer agendado
  /// antes de um restart chega ao ator novo; sem a marca, ele somaria uma
  /// segunda cadeia de manutenção à cadeia do Tick inicial, para sempre.
  Tick(marca: Reference)
  ExecutarManutencao(resposta: Subject(Nil))
}

pub type EstadoManutencao {
  EstadoManutencao(
    transacoes: TransacaoPorta,
    intervalo_ms: Int,
    nome_proprio: process.Name(MensagemManutencao),
    tick_esperado: Reference,
  )
}

pub fn iniciar_actor(
  transacoes: TransacaoPorta,
  intervalo_ms: Int,
  name: Option(process.Name(MensagemManutencao)),
) -> Result(actor.Started(Subject(MensagemManutencao)), actor.StartError) {
  let name_val = case name {
    Some(n) -> n
    None -> process.new_name("amelie_manutencao")
  }

  let marca = reference.new()
  let builder =
    actor.new(EstadoManutencao(
      transacoes: transacoes,
      intervalo_ms: intervalo_ms,
      nome_proprio: name_val,
      tick_esperado: marca,
    ))
    |> actor.on_message(tratar)
    |> actor.named(name_val)

  case actor.start(builder) {
    Ok(started) -> {
      let subj = process.named_subject(name_val)
      process.send_after(subj, 10_000, Tick(marca))
      Ok(started)
    }
    Error(err) -> Error(err)
  }
}

pub fn supervisionado(
  transacoes: TransacaoPorta,
  intervalo_ms: Int,
  name: process.Name(MensagemManutencao),
) -> supervision.ChildSpecification(Subject(MensagemManutencao)) {
  supervision.worker(fn() {
    iniciar_actor(transacoes, intervalo_ms, Some(name))
  })
}

fn tratar(
  estado: EstadoManutencao,
  msg: MensagemManutencao,
) -> actor.Next(EstadoManutencao, MensagemManutencao) {
  case msg {
    Tick(marca) if marca == estado.tick_esperado -> {
      executar(estado.transacoes)
      let proxima = reference.new()
      let subj = process.named_subject(estado.nome_proprio)
      process.send_after(subj, estado.intervalo_ms, Tick(proxima))
      actor.continue(EstadoManutencao(..estado, tick_esperado: proxima))
    }
    // Timer de uma encarnação anterior do ator: ignora, sem reagendar.
    Tick(_) -> {
      logging.log(logging.Debug, "Manutenção: Tick obsoleto ignorado")
      actor.continue(estado)
    }
    ExecutarManutencao(resposta) -> {
      executar(estado.transacoes)
      process.send(resposta, Nil)
      actor.continue(estado)
    }
  }
}

/// Dispara execução imediata de manutenção via ator.
pub fn executar_agora(manutencao: Subject(MensagemManutencao)) -> Nil {
  let resposta = process.new_subject()
  process.send(manutencao, ExecutarManutencao(resposta))
  case process.receive(resposta, 10_000) {
    Ok(Nil) -> Nil
    Error(_) -> Nil
  }
}

/// Agenda execução periódica das rotinas de manutenção.
pub fn agendar(transacoes: TransacaoPorta, intervalo_ms: Int) -> Nil {
  let _ = iniciar_actor(transacoes, intervalo_ms, None)
  Nil
}

pub fn agendar_padrao(transacoes: TransacaoPorta) -> Nil {
  agendar(transacoes, intervalo_padrao_ms)
}

/// Executa ciclo completo de manutenção: varredura de mídias órfãs e limpeza de banco.
pub fn executar(transacoes: TransacaoPorta) -> Nil {
  logging.log(logging.Info, "Manutenção: varrendo mídias temporárias órfãs")
  case arquivos_temporarios.limpar_antigos(max_idade_midia_segundos) {
    Ok(qtd) ->
      logging.log(
        logging.Info,
        "Manutenção: limpeza de mídias concluída ("
          <> int.to_string(qtd)
          <> " arquivos removidos)",
      )
    Error(e) ->
      logging.log(
        logging.Warning,
        "Manutenção: falha na limpeza de mídias temporárias: " <> e,
      )
  }

  logging.log(
    logging.Info,
    "Manutenção: limpando transações antigas e otimizando banco",
  )
  case transacoes.limpar_antigas() {
    Ok(_) ->
      logging.log(
        logging.Info,
        "Manutenção: limpeza de transações e otimização do banco concluída",
      )
    Error(e) ->
      logging.log(
        logging.Warning,
        "Manutenção: falha na limpeza de transações: " <> erro.descricao(e),
      )
  }
}
