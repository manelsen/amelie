import core/comando/despachante
import core/processador
import dominio/acao.{EnviarResposta, SalvarConfig}
import dominio/config.{Config}
import gleeunit/should
import helpers/fixtures

fn cfg(legenda: Bool) {
  Config(..fixtures.config_padrao(), legenda_ativo: legenda)
}

pub fn legenda_on_liga_test() {
  let assert Ok([SalvarConfig(nova), EnviarResposta(_, texto)]) =
    despachante.executar("legenda", "on", cfg(False))
  nova.legenda_ativo |> should.be_true
  texto |> should.equal("Legenda ativada.")
}

pub fn legenda_off_com_legenda_desligada_continua_desligada_test() {
  let assert Ok([SalvarConfig(nova), EnviarResposta(_, texto)]) =
    despachante.executar("legenda", "off", cfg(False))
  nova.legenda_ativo |> should.be_false
  texto |> should.equal("Legenda desativada.")
}

pub fn legenda_sem_argumento_alterna_test() {
  let assert Ok([SalvarConfig(a), EnviarResposta(_, ta)]) =
    despachante.executar("legenda", "", cfg(False))
  a.legenda_ativo |> should.be_true
  ta |> should.equal("Legenda ativada.")
  let assert Ok([SalvarConfig(b), EnviarResposta(_, tb)]) =
    despachante.executar("legenda", "", cfg(True))
  b.legenda_ativo |> should.be_false
  tb |> should.equal("Legenda desativada.")
}

pub fn comando_com_acento_ja_parseado_test() {
  let assert Ok([SalvarConfig(a), EnviarResposta(_, _)]) =
    despachante.executar("áudio", "off", fixtures.config_padrao())
  a.audio_ativo |> should.be_false
}

pub fn processar_comando_video_acentuado_test() {
  let msg = fixtures.mensagem_comando("vídeo", "off")
  let assert Ok([SalvarConfig(a), EnviarResposta(_, _)]) =
    processador.processar(msg, fixtures.config_padrao(), [])
  a.video_ativo |> should.be_false
}
