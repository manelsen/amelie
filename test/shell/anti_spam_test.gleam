// test/shell/anti_spam_test.gleam
// Testes unitários para o ator OTP de anti_spam.

import core/anti_spam as core_anti_spam
import dominio/mensagem.{Texto}
import gleam/erlang/process
import gleam/option.{None, Some}
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
