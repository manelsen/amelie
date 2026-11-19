// Fila de mídia — executa processamento assíncrono de imagem, áudio, vídeo e documento.
// Shell: tem side effects (chama IA, envia mensagens).

import core/acessibilidade
import core/privacidade
import core/prompt/montador
import dominio/acao.{
  type TipoMidia, MidiaAudio, MidiaDocumento, MidiaImagem, MidiaSticker,
  MidiaVideo,
}
import dominio/config.{type Config}
import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{
  type Mensagem, Audio, Documento, Imagem, TurnoAssistente, TurnoUsuario, Video,
}
import dominio/transacao
import dominio/video_contexto.{VideoContexto}
import gleam/bool
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import gleam/string
import logging
import portas/historico_porta.{type HistoricoPorta}
import portas/ia_porta.{type IAPorta}
import portas/mensageiro_porta.{type MensageiroPorta}
import portas/transacao_porta.{type TransacaoPorta}
import portas/video_contexto_porta.{type VideoContextoPorta}
import shell/entrega_auditada
import shell/metricas.{type Metricas}
import shell/sistema
import shell/tarefa_isolada
import simplifile

pub type FilaMidia =
  Subject(MensagemFila)

pub type FilasMidia {
  FilasMidia(
    imagem: FilaMidia,
    audio: FilaMidia,
    video: FilaMidia,
    documento: FilaMidia,
    sticker: FilaMidia,
  )
}

/// Tudo de que um job de mídia precisa além da própria mensagem.
pub type Contexto {
  Contexto(
    cfg: Config,
    ia: IAPorta,
    mensageiro: MensageiroPorta,
    transacoes: TransacaoPorta,
    historico: HistoricoPorta,
    video_contexto: VideoContextoPorta,
    metricas: Metricas,
  )
}

pub type MensagemFila {
  Enfileirar(chat_id: IdChat, msg: Mensagem, tipo: TipoMidia, ctx: Contexto)
  Parar
}

/// Teto de um job de mídia. O mais longo é o vídeo: upload (até 2 min),
/// espera o arquivo ficar ativo (até 1 min) e a descrição, com as
/// retentativas do disjuntor.
const tempo_maximo_job_ms = 600_000

/// Roda o job em processo próprio: um panic ou uma trava derrubava o ator, e
/// com ele os jobs que esperavam na fila do tipo, sem aviso a ninguém. A
/// fila segue serial (um job por vez por tipo); quem teve o job perdido
/// recebe o aviso de falha.
fn executar_job(
  chat_id: IdChat,
  msg: Mensagem,
  tipo: TipoMidia,
  ctx: Contexto,
) -> Nil {
  let desfecho =
    tarefa_isolada.executar(
      fn() {
        processar(chat_id, msg, tipo, ctx)
        |> sistema.registrar_falha(
          "Erro ao processar mídia em " <> privacidade.mascarar(chat_id),
        )
      },
      tempo_maximo_job_ms,
    )
  let motivo = case desfecho {
    tarefa_isolada.Terminou -> None
    tarefa_isolada.Quebrou -> Some("quebrou")
    tarefa_isolada.Estourou -> Some("passou do tempo máximo")
  }
  case motivo {
    None -> Nil
    Some(motivo) -> {
      logging.log(
        logging.Error,
        "["
          <> rotulo_log(tipo)
          <> "]"
          <> tag_trace(msg)
          <> " Job "
          <> motivo
          <> " para "
          <> privacidade.mascarar(chat_id),
      )
      let _ =
        avisar_falha(chat_id, msg, ctx, erro.ErroIA("job de mídia " <> motivo))
      Nil
    }
  }
}

/// Quantas perguntas de acompanhamento um vídeo aceita depois da descrição.
const perguntas_followup_video = 2

pub fn iniciar_uma_actor(
  name: Option(process.Name(MensagemFila)),
) -> Result(actor.Started(FilaMidia), actor.StartError) {
  let builder =
    actor.new(Nil)
    |> actor.on_message(fn(state, msg) {
      case msg {
        Parar -> actor.stop()
        Enfileirar(chat_id, mensagem, tipo, ctx) -> {
          executar_job(chat_id, mensagem, tipo, ctx)
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

pub fn supervisionado_um(
  name: process.Name(MensagemFila),
) -> supervision.ChildSpecification(FilaMidia) {
  supervision.worker(fn() { iniciar_uma_actor(Some(name)) })
}

fn iniciar_uma() -> Result(FilaMidia, actor.StartError) {
  iniciar_uma_actor(None)
  |> result.map(fn(started) { started.data })
}

pub fn iniciar_todas() -> Result(FilasMidia, actor.StartError) {
  use img <- result.try(iniciar_uma())
  use aud <- result.try(iniciar_uma())
  use vid <- result.try(iniciar_uma())
  use doc <- result.try(iniciar_uma())
  use stk <- result.try(iniciar_uma())
  Ok(FilasMidia(
    imagem: img,
    audio: aud,
    video: vid,
    documento: doc,
    sticker: stk,
  ))
}

pub fn enfileirar(
  filas: FilasMidia,
  chat_id: IdChat,
  msg: Mensagem,
  tipo: TipoMidia,
  ctx: Contexto,
) -> Result(Nil, Erro) {
  let fila = case tipo {
    MidiaImagem -> filas.imagem
    MidiaAudio -> filas.audio
    MidiaVideo -> filas.video
    MidiaDocumento -> filas.documento
    MidiaSticker -> filas.sticker
  }
  process.send(fila, Enfileirar(chat_id, msg, tipo, ctx))
  Ok(Nil)
}

/// Escolhe como a IA descreve cada mídia; o resto do roteiro é comum a todas.
/// Um tipo que não bate com o corpo da mensagem é ignorado.
fn processar(
  chat_id: IdChat,
  msg: Mensagem,
  tipo: TipoMidia,
  ctx: Contexto,
) -> Result(Nil, Erro) {
  let Contexto(cfg:, ia:, ..) = ctx
  case tipo, msg.corpo {
    MidiaImagem, Imagem(mime:, dados:) ->
      descrever(chat_id, msg, tipo, ctx, fn() {
        let prompt = montador.montar_para_imagem(cfg, msg.legenda)
        ia.processar_imagem(dados, mime, prompt, cfg.modelo)
      })
    MidiaAudio, Audio(mime:, dados:) ->
      descrever(chat_id, msg, tipo, ctx, fn() {
        let prompt = montador.montar_para_audio(cfg)
        ia.processar_audio(dados, mime, prompt, cfg.modelo)
        |> result.map(limpar_timestamps)
      })
    MidiaDocumento, Documento(mime:, dados:, ..) ->
      descrever(chat_id, msg, tipo, ctx, fn() {
        let prompt = montador.montar_para_documento(cfg, msg.legenda)
        ia.processar_documento(dados, mime, prompt, cfg.modelo)
      })
    // Stickers são tratados como imagens para a IA
    MidiaSticker, mensagem.Sticker(mime:, dados:) ->
      descrever(chat_id, msg, tipo, ctx, fn() {
        let prompt = montador.montar_para_sticker(cfg, msg.legenda)
        ia.processar_imagem(dados, mime, prompt, cfg.modelo)
      })
    MidiaVideo, Video(caminho_temp:, mime:) ->
      descrever(chat_id, msg, tipo, ctx, fn() {
        descrever_video(chat_id, caminho_temp, mime, msg, ctx)
      })
    _, _ -> Ok(Nil)
  }
}

/// Roteiro comum: avisa com ⌛, pede a descrição à IA e, se der certo,
/// marca 🆗 e entrega a resposta citando a mensagem original.
fn descrever(
  chat_id: IdChat,
  msg: Mensagem,
  tipo: TipoMidia,
  ctx: Contexto,
  gerar: fn() -> Result(String, Erro),
) -> Result(Nil, Erro) {
  let prefixo = "[" <> rotulo_log(tipo) <> "]" <> tag_trace(msg)
  logging.log(
    logging.Info,
    prefixo <> " Iniciando processamento para " <> privacidade.mascarar(chat_id),
  )
  reagir(msg, "⌛", ctx.mensageiro)
  use resposta <- result.try(
    gerar() |> result.map_error(avisar_falha(chat_id, msg, ctx, _)),
  )
  logging.log(
    logging.Info,
    prefixo <> " Concluído para " <> privacidade.mascarar(chat_id),
  )
  metricas.registrar(ctx.metricas, metricas.MidiaPorTipo(tipo))
  reagir(msg, "🆗", ctx.mensageiro)
  entregar(chat_id, tipo, resposta, msg, ctx)
}

/// Aviso enviado quando a IA não consegue descrever a mídia; sem ele o
/// usuário só veria o ⌛ parado. Vai pela entrega auditada: se a sessão
/// estiver fora, a fila offline o entrega depois. Falha de entrega da
/// descrição não passa por aqui: a fila offline reenvia a própria resposta.
pub const aviso_falha_midia = "⚠️ Não consegui processar sua mídia. Tente enviar novamente."

fn avisar_falha(chat_id: IdChat, msg: Mensagem, ctx: Contexto, e: Erro) -> Erro {
  reagir(msg, "⚠️", ctx.mensageiro)
  entrega_auditada.enviar(
    chat_id,
    transacao.RespostaTexto,
    aviso_falha_midia,
    ctx.mensageiro,
    ctx.transacoes,
  )
  |> sistema.registrar_falha("Falha ao avisar erro de mídia")
  e
}

/// Sobe o vídeo para a IA, pede a descrição e guarda o arquivo para as
/// perguntas de acompanhamento. O arquivo local é apagado logo após o upload.
fn descrever_video(
  chat_id: IdChat,
  caminho: String,
  mime: String,
  msg: Mensagem,
  ctx: Contexto,
) -> Result(String, Erro) {
  let prompt = prompt_video(ctx.cfg, msg.legenda, caminho)
  let upload = ctx.ia.fazer_upload_video(caminho, mime)
  let _ = simplifile.delete_file(caminho)
  use uri <- result.try(upload)
  let processamento = {
    use _ <- result.try(ctx.ia.aguardar_video_ativo(uri))
    ctx.ia.processar_video(uri, prompt, ctx.cfg.modelo)
  }
  case processamento {
    Error(e) -> {
      ctx.ia.deletar_arquivo(uri)
      |> sistema.registrar_falha("Falha ao apagar vídeo no provedor de IA")
      Error(e)
    }
    Ok(resposta) -> {
      lembrar_video(chat_id, uri, ctx)
      Ok(resposta)
    }
  }
}

fn prompt_video(cfg: Config, legenda: Option(String), caminho: String) -> String {
  let eh_sticker_animado =
    legenda
    |> option.unwrap("")
    |> string.contains("figurinha/sticker")
  use <- bool.lazy_guard(eh_sticker_animado, fn() {
    montador.montar_para_sticker_animado(cfg, legenda)
  })
  let tem_audio = video_tem_audio(caminho)
  case cfg.legenda_ativo && tem_audio {
    True -> montador.montar_para_legenda(cfg)
    False -> montador.montar_para_video_com_audio(cfg, legenda, tem_audio)
  }
}

/// Troca o vídeo de referência do chat: apaga o anterior no provedor, para
/// não acumular arquivos, e guarda o novo com a cota de perguntas.
fn lembrar_video(chat_id: IdChat, uri: String, ctx: Contexto) -> Nil {
  case ctx.video_contexto.remover(chat_id) {
    Ok(Some(uri_antigo)) ->
      ctx.ia.deletar_arquivo(uri_antigo)
      |> sistema.registrar_falha("Falha ao apagar vídeo anterior no provedor")
    _ -> Nil
  }
  ctx.video_contexto.salvar(VideoContexto(
    chat_id:,
    uri:,
    perguntas_restantes: perguntas_followup_video,
    criado_em: sistema.agora_s(),
  ))
  |> sistema.registrar_falha("Falha ao guardar contexto de vídeo")
}

fn tag_trace(msg: Mensagem) -> String {
  case msg.message_id {
    option.Some(id) if id != "" -> " [" <> string.slice(id, 0, 5) <> "]"
    _ -> ""
  }
}

fn rotulo_log(tipo: TipoMidia) -> String {
  case tipo {
    MidiaImagem -> "Imagem"
    MidiaAudio -> "Áudio"
    MidiaVideo -> "Vídeo"
    MidiaDocumento -> "Doc"
    MidiaSticker -> "Sticker"
  }
}

/// Como a mídia do usuário aparece no histórico da conversa.
fn rotulo_usuario(tipo: TipoMidia, legenda: Option(String)) -> String {
  let base = case tipo {
    MidiaImagem -> "[imagem]"
    MidiaAudio -> "[áudio]"
    MidiaVideo -> "[vídeo]"
    MidiaDocumento -> "[documento]"
    MidiaSticker -> "[sticker]"
  }
  case tipo, legenda {
    MidiaImagem, Some(l) | MidiaVideo, Some(l) | MidiaDocumento, Some(l) ->
      base <> " " <> l
    _, _ -> base
  }
}

// Reage à mensagem original. Fire-and-forget — ignora falha.
fn reagir(msg: Mensagem, emoji: String, mensageiro: MensageiroPorta) -> Nil {
  case msg.message_id {
    option.Some(mid) -> {
      let _ = mensageiro.reagir(msg.chat_id, mid, msg.remetente, emoji)
      Nil
    }
    option.None -> Nil
  }
}

// Entrega citando a mensagem original quando possível e grava no histórico.
fn entregar(
  chat_id: IdChat,
  tipo: TipoMidia,
  resposta: String,
  msg: Mensagem,
  ctx: Contexto,
) -> Result(Nil, Erro) {
  let resposta_sanitizada = acessibilidade.sanitizar_saida_voz(resposta)
  ctx.historico.adicionar(chat_id, [
    TurnoUsuario(rotulo_usuario(tipo, msg.legenda)),
    TurnoAssistente(resposta_sanitizada),
  ])
  |> sistema.registrar_falha("Falha ao gravar mídia e resposta no histórico")
  case msg.message_id {
    option.Some(mid) ->
      entrega_auditada.enviar_citando(
        chat_id,
        transacao.DescricaoMidia(tipo),
        resposta_sanitizada,
        mid,
        msg.remetente,
        ctx.mensageiro,
        ctx.transacoes,
      )
    option.None ->
      entrega_auditada.enviar(
        chat_id,
        transacao.DescricaoMidia(tipo),
        resposta_sanitizada,
        ctx.mensageiro,
        ctx.transacoes,
      )
  }
}

// Remove timestamps (MM:SS ou HH:MM:SS) que o Gemini insiste em gerar,
// e colapsa linhas vazias resultantes.
fn limpar_timestamps(texto: String) -> String {
  let limpo = remover_timestamps_ffi(texto)
  // Colapsa múltiplas quebras de linha em no máximo duas (separador de parágrafo)
  colapsar_linhas_vazias(limpo)
}

fn colapsar_linhas_vazias(texto: String) -> String {
  case string.contains(texto, "\n\n\n") {
    True -> colapsar_linhas_vazias(string.replace(texto, "\n\n\n", "\n\n"))
    False -> string.trim(texto)
  }
}

@external(erlang, "amelie_gleam_ffi", "strip_timestamps")
fn remover_timestamps_ffi(texto: String) -> String

@external(erlang, "amelie_gleam_ffi", "video_tem_audio")
fn video_tem_audio(caminho: String) -> Bool
