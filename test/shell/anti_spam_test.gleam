// test/shell/anti_spam_test.gleam
// Testes unitários para o ator OTP de anti_spam.

import core/anti_spam as core_anti_spam
import dominio/mensagem.{Texto}
import gleam/erlang/process
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import helpers/fixtures
import shell/anti_spam

pub fn anti_spam_actor_inicializacao_e_verificacao_test() {
  let assert Ok(actor) = anti_spam.iniciar(Some(fixtures.id("tg:123")))

  // Chat comum tem permissão inicial
  let dec =
    anti_spam.verificar(
      actor,
      fixtures.id("user_456@c.us"),
      fixtures.id("user_456@c.us"),
      Texto("Olá"),
    )
  dec |> should.equal(core_anti_spam.Permitido)

  // Admin sempre permitido
  let dec_admin =
    anti_spam.verificar(
      actor,
      fixtures.id("tg:123"),
      fixtures.id("tg:123"),
      Texto("Status"),
    )
  dec_admin |> should.equal(core_anti_spam.Permitido)
}

pub fn anti_spam_actor_desbloquear_e_contar_test() {
  let assert Ok(actor) = anti_spam.iniciar(None)

  // Inicialmente 0 silenciados
  anti_spam.contar_silenciados(actor) |> should.equal(Ok(0))

  // Desbloquear chat inexistente retorna falso
  anti_spam.desbloquear(actor, "inexistente") |> should.equal(Ok(False))
}

// Nome sem dono (ator reiniciando): nenhuma função dá panic.
// verificar/verificar_atrasada deixam a mensagem seguir; as de admin
// informam que não houve resposta.
pub fn anti_spam_nome_sem_dono_nao_da_panic_test() {
  let sem_dono = process.named_subject(process.new_name("anti_spam_ausente"))
  let chat = fixtures.id("5531999990000@s.whatsapp.net")

  anti_spam.verificar(sem_dono, chat, chat, Texto("oi"))
  |> should.equal(core_anti_spam.Permitido)
  anti_spam.verificar_atrasada(sem_dono, chat, chat)
  |> should.equal(core_anti_spam.Permitido)
  anti_spam.desbloquear(sem_dono, "5531999990000") |> should.equal(Error(Nil))
  anti_spam.contar_silenciados(sem_dono) |> should.equal(Error(Nil))
  anti_spam.em_quarentena(sem_dono, chat, False) |> should.be_false
}

pub fn anti_spam_actor_limpeza_periodica_test() {
  let assert Ok(actor) = anti_spam.iniciar(None)

  process.send(actor, anti_spam.LimpezaPeriodica(1_000_000))
  // Ator continua respondendo normalmente
  anti_spam.contar_silenciados(actor) |> should.equal(Ok(0))
}

// Processo que assume o nome e recebe os pedidos, sem responder: o ator está
// vivo, mas travado. Avisa `pronto` quando o nome já tem dono.
fn ator_mudo(nome: process.Name(anti_spam.MensagemAntiSpam), pronto) -> Nil {
  process.spawn_unlinked(fn() {
    let assert Ok(_) = process.register(process.self(), nome)
    process.send(pronto, Nil)
    process.sleep_forever()
  })
  let assert Ok(Nil) = process.receive(pronto, 1000)
  Nil
}

// Ator vivo que não responde dentro do prazo: mesmo desfecho do nome sem
// dono. Cada chamada espera o prazo inteiro, então rodam em paralelo.
pub fn anti_spam_ator_mudo_cai_no_fallback_test() {
  let nome = process.new_name("anti_spam_mudo")
  ator_mudo(nome, process.new_subject())
  let mudo = process.named_subject(nome)
  let chat = fixtures.id("5531999990000@s.whatsapp.net")
  let resultados = process.new_subject()

  process.spawn_unlinked(fn() {
    let r = anti_spam.verificar(mudo, chat, chat, Texto("oi"))
    process.send(resultados, #("verificar", r == core_anti_spam.Permitido))
  })
  process.spawn_unlinked(fn() {
    let r = anti_spam.verificar_atrasada(mudo, chat, chat)
    process.send(resultados, #("atrasada", r == core_anti_spam.Permitido))
  })
  process.spawn_unlinked(fn() {
    let r = anti_spam.desbloquear(mudo, "5531999990000")
    process.send(resultados, #("desbloquear", r == Error(Nil)))
  })
  process.spawn_unlinked(fn() {
    let r = anti_spam.contar_silenciados(mudo)
    process.send(resultados, #("contar", r == Error(Nil)))
  })

  [1, 2, 3, 4]
  |> list.map(fn(_) {
    let assert Ok(#(operacao, ok)) = process.receive(resultados, 3000)
    #(operacao, ok)
  })
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  |> should.equal([
    #("atrasada", True),
    #("contar", True),
    #("desbloquear", True),
    #("verificar", True),
  ])
}

// A resposta atrasada de uma chamada que já desistiu não vale para a
// seguinte: cada chamada espera no seu próprio subject.
pub fn anti_spam_resposta_atrasada_nao_vaza_test() {
  let nome = process.new_name("anti_spam_lento")
  let pronto = process.new_subject()
  process.spawn_unlinked(fn() {
    let assert Ok(_) = process.register(process.self(), nome)
    let caixa = process.named_subject(nome)
    process.send(pronto, Nil)
    // Primeiro pedido: responde 99 depois do prazo de quem chamou.
    let assert Ok(anti_spam.ContarSilenciados(_, resposta1)) =
      process.receive(caixa, 5000)
    process.sleep(1200)
    process.send(resposta1, 99)
    // Segundo pedido: responde 7 na hora.
    let assert Ok(anti_spam.ContarSilenciados(_, resposta2)) =
      process.receive(caixa, 5000)
    process.send(resposta2, 7)
    process.sleep_forever()
  })
  let assert Ok(Nil) = process.receive(pronto, 1000)
  let lento = process.named_subject(nome)

  anti_spam.contar_silenciados(lento) |> should.equal(Error(Nil))
  anti_spam.contar_silenciados(lento) |> should.equal(Ok(7))
}
