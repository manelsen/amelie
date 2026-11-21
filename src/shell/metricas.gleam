// Métricas simples via OTP actor.
// Conta mensagens processadas, erros, e mídia por tipo.

import dominio/acao.{
  type TipoMidia, MidiaAudio, MidiaDocumento, MidiaImagem, MidiaSticker,
  MidiaVideo,
}
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import shell/ator_vivo

pub type Metricas =
  Subject(MensagemMetrica)

pub type MensagemMetrica {
  Incrementar(tipo: TipoContador)
  Consultar(resposta: Subject(Estado))
}

pub type TipoContador {
  MensagensProcessadas
  Erros
  MidiaPorTipo(TipoMidia)
}

pub type Estado {
  Estado(
    mensagens: Int,
    erros: Int,
    imagens: Int,
    audios: Int,
    videos: Int,
    documentos: Int,
    stickers: Int,
  )
}

fn estado_inicial() -> Estado {
  Estado(
    mensagens: 0,
    erros: 0,
    imagens: 0,
    audios: 0,
    videos: 0,
    documentos: 0,
    stickers: 0,
  )
}

pub fn iniciar() -> Result(Metricas, actor.StartError) {
  iniciar_actor(None)
  |> result.map(fn(started) { started.data })
}

pub fn iniciar_actor(
  name: Option(process.Name(MensagemMetrica)),
) -> Result(actor.Started(Metricas), actor.StartError) {
  let builder =
    actor.new(estado_inicial())
    |> actor.on_message(fn(state, msg) {
      case msg {
        Incrementar(tipo) -> actor.continue(incrementar(state, tipo))
        Consultar(resposta) -> {
          process.send(resposta, state)
          actor.continue(state)
        }
      }
    })

  let builder = case name {
    Some(n) -> actor.named(builder, n)
    None -> builder
  }

  actor.start(builder)
}

pub fn supervisionado(
  name: process.Name(MensagemMetrica),
) -> supervision.ChildSpecification(Metricas) {
  supervision.worker(fn() { iniciar_actor(Some(name)) })
}

/// Contar é acessório: com o ator reiniciando, o nome fica sem dono por um
/// instante, e `process.send` a um nome sem dono gera panic, que derrubaria
/// quem conta (a fila de mídia, o tratador). O nome é resolvido uma vez só e
/// a mensagem vai ao processo encontrado: se ele morrer nesse meio-tempo, o
/// envio a um processo morto não falha. Sem dono, a contagem se perde.
pub fn registrar(metricas: Metricas, tipo: TipoContador) -> Nil {
  let _ = ator_vivo.enviar(metricas, Incrementar(tipo))
  Nil
}

pub fn consultar(metricas: Metricas) -> Estado {
  let resposta = process.new_subject()
  process.send(metricas, Consultar(resposta))
  case process.receive(resposta, 5000) {
    Ok(estado) -> estado
    Error(_) -> estado_inicial()
  }
}

pub fn formatar(estado: Estado) -> String {
  "*Métricas*\n\n"
  <> "Mensagens processadas: `"
  <> int.to_string(estado.mensagens)
  <> "`\n"
  <> "Erros: `"
  <> int.to_string(estado.erros)
  <> "`\n\n"
  <> "*Mídia processada:*\n"
  <> "- Imagens: `"
  <> int.to_string(estado.imagens)
  <> "`\n"
  <> "- Áudios: `"
  <> int.to_string(estado.audios)
  <> "`\n"
  <> "- Vídeos: `"
  <> int.to_string(estado.videos)
  <> "`\n"
  <> "- Documentos: `"
  <> int.to_string(estado.documentos)
  <> "`\n"
  <> "- Stickers: `"
  <> int.to_string(estado.stickers)
  <> "`\n\n"
  <> "*BEAM:*\n"
  <> "- Memória total: `"
  <> int.to_string(memoria_total_mb())
  <> " MB`\n"
  <> "- Memória processos: `"
  <> int.to_string(memoria_processos_mb())
  <> " MB`\n"
  <> "- Processos ativos: `"
  <> int.to_string(contagem_processos())
  <> "`"
}

@external(erlang, "amelie_ffi", "memoria_total_mb")
pub fn memoria_total_mb() -> Int

@external(erlang, "amelie_ffi", "memoria_processos_mb")
pub fn memoria_processos_mb() -> Int

@external(erlang, "amelie_ffi", "contagem_processos")
pub fn contagem_processos() -> Int

fn incrementar(state: Estado, tipo: TipoContador) -> Estado {
  case tipo {
    MensagensProcessadas -> Estado(..state, mensagens: state.mensagens + 1)
    Erros -> Estado(..state, erros: state.erros + 1)
    MidiaPorTipo(MidiaImagem) -> Estado(..state, imagens: state.imagens + 1)
    MidiaPorTipo(MidiaAudio) -> Estado(..state, audios: state.audios + 1)
    MidiaPorTipo(MidiaVideo) -> Estado(..state, videos: state.videos + 1)
    MidiaPorTipo(MidiaDocumento) ->
      Estado(..state, documentos: state.documentos + 1)
    MidiaPorTipo(MidiaSticker) -> Estado(..state, stickers: state.stickers + 1)
  }
}
