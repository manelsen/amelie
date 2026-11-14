import dominio/erro
import dominio/id_chat
import gleam/erlang/process
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import helpers/portas_fake
import shell/avisos_ia
import shell/disjuntor

pub fn texto_de_queda_nomeia_o_provedor_test() {
  let texto = avisos_ia.texto("Gemini", disjuntor.Abriu)
  string.contains(texto, "Gemini fora do ar") |> should.be_true
}

pub fn texto_de_volta_traz_o_tempo_fora_test() {
  avisos_ia.texto("OpenRouter", disjuntor.Fechou(fora_ms: 30_000))
  |> string.contains("menos de 1 min")
  |> should.be_true
  avisos_ia.texto("OpenRouter", disjuntor.Fechou(fora_ms: 25 * 60_000))
  |> string.contains("25 min")
  |> should.be_true
  avisos_ia.texto("OpenRouter", disjuntor.Fechou(fora_ms: 130 * 60_000))
  |> string.contains("2 h 10 min")
  |> should.be_true
}

pub fn notificador_envia_ao_admin_test() {
  let caixa = process.new_subject()
  let admin = id_chat.telegram(42)
  let avisar =
    avisos_ia.notificador(
      "Gemini",
      portas_fake.mensageiro_capturar(caixa),
      Some(admin),
    )
  avisar(disjuntor.Abriu)
  let assert Ok(#(destino, texto)) = process.receive(caixa, 500)
  destino |> should.equal(admin)
  string.contains(texto, "Gemini") |> should.be_true
}

pub fn notificador_sem_admin_nao_envia_test() {
  let caixa = process.new_subject()
  let avisar =
    avisos_ia.notificador(
      "Gemini",
      portas_fake.mensageiro_capturar(caixa),
      None,
    )
  avisar(disjuntor.Abriu)
  process.receive(caixa, 100) |> should.be_error
}

pub fn falha_no_envio_nao_derruba_quem_avisa_test() {
  avisos_ia.avisar(
    "Gemini",
    disjuntor.Abriu,
    portas_fake.mensageiro_erro(erro.ErroComunicacao("fora")),
    id_chat.telegram(42),
  )
  |> should.equal(Nil)
}
