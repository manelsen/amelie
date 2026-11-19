// Testes do processamento assíncrono da fila de mídia: descrição pela IA,
// entrega, histórico e contexto de vídeo para follow-up.

import dominio/acao.{MidiaAudio, MidiaImagem, MidiaVideo}
import dominio/erro
import dominio/mensagem.{type Turno, Mensagem, TurnoAssistente, TurnoUsuario}
import dominio/video_contexto.{VideoContexto}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import helpers/fixtures
import helpers/portas_fake.{VideoRemovido, VideoSalvo}
import portas/historico_porta.{type HistoricoPorta, HistoricoPorta}
import portas/ia_porta.{type IAPorta, IAPorta}
import portas/mensageiro_porta.{type MensageiroPorta}
import portas/video_contexto_porta.{type VideoContextoPorta}
import shell/fila_midia
import shell/metricas
import simplifile

const espera_ms = 2000

fn historico_capturar(ref: Subject(Turno)) -> HistoricoPorta {
  HistoricoPorta(
    obter: fn(_) { Ok([]) },
    adicionar: fn(_, turnos) {
      list.each(turnos, process.send(ref, _))
      Ok(Nil)
    },
    limpar: fn(_) { Ok(Nil) },
  )
}

fn contexto(
  ia: IAPorta,
  mensageiro: MensageiroPorta,
  historico: HistoricoPorta,
  video_contexto: VideoContextoPorta,
) -> fila_midia.Contexto {
  fila_midia.Contexto(
    cfg: fixtures.config_padrao(),
    ia:,
    mensageiro:,
    transacoes: portas_fake.transacao_noop(),
    historico:,
    video_contexto:,
    metricas: process.new_subject(),
  )
}

pub fn imagem_com_legenda_entrega_e_grava_historico_test() {
  let envios = process.new_subject()
  let turnos = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = Mensagem(..fixtures.mensagem_imagem(), legenda: Some("meu gato"))
  let ctx =
    contexto(
      portas_fake.ia_ok("Um gato laranja no sofá."),
      portas_fake.mensageiro_capturar(envios),
      historico_capturar(turnos),
      portas_fake.video_contexto_noop(),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, ctx)
  |> should.be_ok

  let assert Ok(#(para, texto)) = process.receive(envios, espera_ms)
  para |> should.equal(msg.chat_id)
  texto |> should.equal("Um gato laranja no sofá.")
  process.receive(turnos, espera_ms)
  |> should.equal(Ok(TurnoUsuario("[imagem] meu gato")))
  process.receive(turnos, espera_ms)
  |> should.equal(Ok(TurnoAssistente("Um gato laranja no sofá.")))
}

pub fn audio_remove_timestamps_da_transcricao_test() {
  let envios = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_audio()
  let ctx =
    contexto(
      portas_fake.ia_ok("00:01 Olá, tudo bem?\n\n\n\n00:05 Até logo."),
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_noop(),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaAudio, ctx)
  |> should.be_ok

  let assert Ok(#(_, texto)) = process.receive(envios, espera_ms)
  string.contains(texto, "00:0") |> should.be_false
  string.contains(texto, "\n\n\n") |> should.be_false
  string.contains(texto, "Olá, tudo bem?") |> should.be_true
}

pub fn tipo_diferente_do_corpo_e_ignorado_test() {
  let envios = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_imagem()
  let ctx =
    contexto(
      portas_fake.ia_ok("não deveria ser entregue"),
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_noop(),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaAudio, ctx)
  |> should.be_ok

  process.receive(envios, 300) |> should.equal(Error(Nil))
}

pub fn video_apaga_arquivo_local_e_guarda_contexto_test() {
  let caminho = "/tmp/amelie_fila_midia_test_video.mp4"
  let assert Ok(_) = simplifile.write(caminho, "não é um vídeo de verdade")
  let envios = process.new_subject()
  let eventos = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg =
    Mensagem(
      ..fixtures.mensagem_video(),
      corpo: mensagem.Video(caminho_temp: caminho, mime: "video/mp4"),
    )
  let ctx =
    contexto(
      portas_fake.ia_ok("Uma pessoa caminhando na praia."),
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_capturar(None, eventos),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaVideo, ctx)
  |> should.be_ok

  let assert Ok(#(_, texto)) = process.receive(envios, espera_ms)
  texto |> should.equal("Uma pessoa caminhando na praia.")
  process.receive(eventos, espera_ms)
  |> should.equal(Ok(VideoRemovido(msg.chat_id)))
  let assert Ok(VideoSalvo(VideoContexto(
    chat_id: chat,
    uri: uri,
    perguntas_restantes: perguntas,
    ..,
  ))) = process.receive(eventos, espera_ms)
  chat |> should.equal(msg.chat_id)
  uri |> should.equal("https://files.google.com/fake-uri")
  perguntas |> should.equal(2)
  simplifile.is_file(caminho) |> should.equal(Ok(False))
}

pub fn video_com_falha_na_ia_apaga_upload_e_so_avisa_test() {
  let envios = process.new_subject()
  let apagados = process.new_subject()
  let eventos = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_video()
  let ia =
    IAPorta(
      ..portas_fake.ia_ok("não deveria ser entregue"),
      processar_video: fn(_, _, _) { Error(erro.ErroIA("modelo indisponível")) },
      deletar_arquivo: fn(uri) {
        process.send(apagados, uri)
        Ok(Nil)
      },
    )
  let ctx =
    contexto(
      ia,
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_capturar(None, eventos),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaVideo, ctx)
  |> should.be_ok

  process.receive(apagados, espera_ms)
  |> should.equal(Ok("https://files.google.com/fake-uri"))
  // Só o aviso de falha chega; a descrição nunca é entregue.
  process.receive(envios, espera_ms)
  |> should.equal(Ok(#(msg.chat_id, fila_midia.aviso_falha_midia)))
  process.receive(envios, 300) |> should.equal(Error(Nil))
  process.receive(eventos, 100) |> should.equal(Error(Nil))
}

pub fn aviso_de_falha_fica_auditado_para_reenvio_test() {
  // Com a sessão fora, o aviso fica na fila offline em vez de se perder.
  let eventos = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_imagem()
  let ctx =
    fila_midia.Contexto(
      ..contexto(
        portas_fake.ia_erro(erro.ErroIA("bloqueado")),
        portas_fake.mensageiro_erro(erro.ErroComunicacao("offline")),
        portas_fake.historico_vazio(),
        portas_fake.video_contexto_noop(),
      ),
      transacoes: portas_fake.transacao_capturar(eventos),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, ctx)
  |> should.be_ok

  let assert Ok(portas_fake.Registrada(tx)) =
    process.receive(eventos, espera_ms)
  tx.conteudo |> should.equal(fila_midia.aviso_falha_midia)
  let assert Ok(portas_fake.ErroAtualizado(1, _, 1)) =
    process.receive(eventos, espera_ms)
}

pub fn falha_da_ia_avisa_usuario_e_nao_grava_historico_test() {
  let envios = process.new_subject()
  let turnos = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_imagem()
  let ctx =
    contexto(
      portas_fake.ia_erro(erro.ErroIA("bloqueado")),
      portas_fake.mensageiro_capturar(envios),
      historico_capturar(turnos),
      portas_fake.video_contexto_noop(),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, ctx)
  |> should.be_ok

  process.receive(envios, espera_ms)
  |> should.equal(Ok(#(msg.chat_id, fila_midia.aviso_falha_midia)))
  process.receive(turnos, 100) |> should.be_error
}

pub fn midia_concluida_conta_na_metrica_test() {
  // O /status mostrava "Mídias processadas: 0" com mídias atendidas.
  let contador = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_audio()
  let ctx =
    fila_midia.Contexto(
      ..contexto(
        portas_fake.ia_ok("Olá."),
        portas_fake.mensageiro_ok(),
        portas_fake.historico_vazio(),
        portas_fake.video_contexto_noop(),
      ),
      metricas: contador,
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaAudio, ctx)
  |> should.be_ok

  process.receive(contador, espera_ms)
  |> should.equal(Ok(metricas.Incrementar(metricas.MidiaPorTipo(MidiaAudio))))
}

pub fn midia_com_falha_nao_conta_na_metrica_test() {
  let contador = process.new_subject()
  let envios = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_imagem()
  let ctx =
    fila_midia.Contexto(
      ..contexto(
        portas_fake.ia_erro(erro.ErroIA("bloqueado")),
        portas_fake.mensageiro_capturar(envios),
        portas_fake.historico_vazio(),
        portas_fake.video_contexto_noop(),
      ),
      metricas: contador,
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, ctx)
  |> should.be_ok

  // O aviso de falha só sai depois que a IA falhou: a partir daí o
  // incremento, se houvesse, já teria sido enviado.
  let assert Ok(#(_, aviso)) = process.receive(envios, espera_ms)
  aviso |> should.equal(fila_midia.aviso_falha_midia)
  process.receive(contador, 100) |> should.be_error
}

pub fn job_que_quebra_avisa_e_nao_derruba_a_fila_test() {
  // Antes, o panic matava o ator do tipo e os jobs de trás se perdiam.
  let envios = process.new_subject()
  let assert Ok(filas) = fila_midia.iniciar_todas()
  let msg = fixtures.mensagem_imagem()
  let quebra =
    contexto(
      IAPorta(..portas_fake.ia_ok("x"), processar_imagem: fn(_, _, _, _) {
        panic as "falha simulada"
      }),
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_noop(),
    )
  let funciona =
    contexto(
      portas_fake.ia_ok("Um gato."),
      portas_fake.mensageiro_capturar(envios),
      portas_fake.historico_vazio(),
      portas_fake.video_contexto_noop(),
    )

  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, quebra)
  |> should.be_ok
  fila_midia.enfileirar(filas, msg.chat_id, msg, MidiaImagem, funciona)
  |> should.be_ok

  let assert Ok(#(_, aviso)) = process.receive(envios, espera_ms)
  aviso |> should.equal(fila_midia.aviso_falha_midia)
  let assert Ok(#(_, descricao)) = process.receive(envios, espera_ms)
  descricao |> should.equal("Um gato.")
}
