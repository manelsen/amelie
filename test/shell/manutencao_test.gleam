import dominio/erro
import gleam/erlang/process
import gleam/erlang/reference
import gleam/option.{Some}
import gleeunit/should
import helpers/portas_fake
import portas/transacao_porta.{TransacaoPorta}
import shell/manutencao

pub fn manutencao_executar_chama_limpeza_transacoes_test() {
  let ref = process.new_subject()
  let porta_base = portas_fake.transacao_noop()
  let porta =
    TransacaoPorta(..porta_base, limpar_antigas: fn() {
      process.send(ref, "limpeza_chamada")
      Ok(Nil)
    })

  manutencao.executar(porta)

  process.receive(ref, 1000)
  |> should.equal(Ok("limpeza_chamada"))
}

pub fn manutencao_executar_com_erro_banco_nao_entra_em_panico_test() {
  let porta_base = portas_fake.transacao_noop()
  let porta =
    TransacaoPorta(..porta_base, limpar_antigas: fn() {
      Error(erro.ErroBancoDados("falha de teste"))
    })

  // Deve concluir sem lançar exceção / pânico
  manutencao.executar(porta)
  |> should.equal(Nil)
}

pub fn manutencao_actor_executar_agora_test() {
  let ref = process.new_subject()
  let porta_base = portas_fake.transacao_noop()
  let porta =
    TransacaoPorta(..porta_base, limpar_antigas: fn() {
      process.send(ref, "chamou_limpeza")
      Ok(Nil)
    })

  let name = process.new_name("teste_manutencao_actor")
  let assert Ok(started) =
    manutencao.iniciar_actor(porta, 3_600_000, Some(name))

  manutencao.executar_agora(started.data)

  process.receive(ref, 1000)
  |> should.equal(Ok("chamou_limpeza"))
}

// Um Tick de um timer anterior (agendado antes de um restart) não executa
// a manutenção nem abre outra cadeia de ticks.
pub fn manutencao_ignora_tick_obsoleto_test() {
  let ref = process.new_subject()
  let porta_base = portas_fake.transacao_noop()
  let porta =
    TransacaoPorta(..porta_base, limpar_antigas: fn() {
      process.send(ref, "chamou_limpeza")
      Ok(Nil)
    })

  let name = process.new_name("teste_manutencao_tick_obsoleto")
  let assert Ok(started) =
    manutencao.iniciar_actor(porta, 3_600_000, Some(name))

  process.send(started.data, manutencao.Tick(reference.new()))
  process.receive(ref, 100) |> should.equal(Error(Nil))

  // O ator segue vivo e atendendo.
  manutencao.executar_agora(started.data)
  process.receive(ref, 1000) |> should.equal(Ok("chamou_limpeza"))
}
