// Respostas geradas pela IA: texto, página buscada e perguntas sobre o
// último vídeo do chat.

import core/acessibilidade
import core/privacidade
import core/prompt/montador
import dominio/config.{type Config}
import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{
  type Mensagem, type Turno, TurnoAssistente, TurnoUsuario,
}
import dominio/transacao.{RespostaIA}
import dominio/video_contexto.{type VideoContexto}
import gleam/bool
import gleam/int
import gleam/option
import gleam/result
import logging
import shell/despachante_ia
import shell/extrator_url
import shell/sistema
import shell/tratador/base.{
  type Portas, entregar, extrair_texto_usuario, extrair_trace_id,
}

/// Depois disso, perguntas sobre o último vídeo não usam mais o arquivo dele.
const validade_contexto_video_s = 1800

pub fn gerar_e_enviar(
  para: IdChat,
  prompt: String,
  msg: Mensagem,
  cfg: Config,
  hist: List(Turno),
  portas: Portas,
) -> Result(Nil, Erro) {
  case portas.video_contexto.obter(para) {
    Ok(option.Some(ctx)) ->
      responder_sobre_video(para, ctx, prompt, msg, cfg, hist, portas)
    _ -> {
      logging.log(
        logging.Info,
        "["
          <> extrair_trace_id(msg)
          <> "] Enviando texto gerado pela IA para "
          <> privacidade.mascarar(para),
      )
      responder_com_ia(para, prompt, msg, cfg, hist, portas)
    }
  }
}

pub fn buscar_url_e_responder(
  para: IdChat,
  texto: String,
  url: String,
  msg: Mensagem,
  cfg: Config,
  hist: List(Turno),
  portas: Portas,
) -> Result(Nil, Erro) {
  let prompt = case extrator_url.buscar(portas.ponte, url) {
    Ok(conteudo) -> montador.montar_com_url(texto, url, conteudo, cfg)
    Error(_) -> montador.montar(texto, cfg)
  }
  responder_com_ia(para, prompt, msg, cfg, hist, portas)
}

fn responder_com_ia(
  para: IdChat,
  prompt: String,
  msg: Mensagem,
  cfg: Config,
  hist: List(Turno),
  portas: Portas,
) -> Result(Nil, Erro) {
  use resposta <- result.try(despachante_ia.gerar_texto(
    portas.despachante_ia,
    prompt,
    montador.historico_para_ia(hist, cfg.historico_max),
    cfg.provedor,
    cfg.modelo,
  ))
  entregar_resposta_ia(para, resposta, extrair_texto_usuario(msg), msg, portas)
}

/// Pergunta de acompanhamento sobre o último vídeo do chat: responde com o
/// arquivo do vídeo enquanto houver cota e o contexto não tiver expirado.
/// Fora disso, ou se a IA não conseguir usar o vídeo, o contexto é encerrado
/// e a mensagem segue como conversa normal: ela nunca fica sem resposta.
fn responder_sobre_video(
  para: IdChat,
  ctx: VideoContexto,
  prompt: String,
  msg: Mensagem,
  cfg: Config,
  hist: List(Turno),
  portas: Portas,
) -> Result(Nil, Erro) {
  let expirado = sistema.agora_s() - ctx.criado_em >= validade_contexto_video_s
  use <- bool.lazy_guard(expirado || ctx.perguntas_restantes <= 0, fn() {
    encerrar_contexto_video(para, ctx.uri, cfg, portas)
    responder_com_ia(para, prompt, msg, cfg, hist, portas)
  })

  let texto_usuario = extrair_texto_usuario(msg)
  logging.log(
    logging.Info,
    "["
      <> extrair_trace_id(msg)
      <> "] Respondendo dúvida de follow-up sobre vídeo para "
      <> privacidade.mascarar(para)
      <> " ("
      <> int.to_string(ctx.perguntas_restantes)
      <> " pergunta(s) restante(s))",
  )
  let resposta_video =
    despachante_ia.processar_video(
      portas.despachante_ia,
      ctx.uri,
      montador.montar_followup_video(cfg, hist, texto_usuario),
      cfg.provedor,
      cfg.modelo,
    )
  use resposta <- ou_entao(resposta_video, fn(e) {
    logging.log(
      logging.Warning,
      "["
        <> extrair_trace_id(msg)
        <> "] Vídeo indisponível para follow-up ("
        <> erro.descricao(e)
        <> "); respondendo sem ele",
    )
    encerrar_contexto_video(para, ctx.uri, cfg, portas)
    responder_com_ia(para, prompt, msg, cfg, hist, portas)
  })
  use _ <- result.try(entregar_resposta_ia(
    para,
    resposta,
    texto_usuario,
    msg,
    portas,
  ))

  let restantes =
    portas.video_contexto.decrementar_perguntas(para)
    |> result.unwrap(or: 0)
  use <- bool.guard(restantes > 0, Ok(Nil))
  encerrar_contexto_video(para, ctx.uri, cfg, portas)
  Ok(Nil)
}

fn ou_entao(
  resultado: Result(String, Erro),
  se_falhar: fn(Erro) -> Result(Nil, Erro),
  continuar: fn(String) -> Result(Nil, Erro),
) -> Result(Nil, Erro) {
  case resultado {
    Ok(resposta) -> continuar(resposta)
    Error(e) -> se_falhar(e)
  }
}

/// Entrega a resposta da IA ao usuário e grava a pergunta e a resposta no
/// histórico. Só a entrega pode falhar: depois dela o usuário já tem a
/// resposta, e uma falha ao gravar o histórico vai para o log, não para
/// ele como "ocorreu um erro".
fn entregar_resposta_ia(
  para: IdChat,
  resposta: String,
  texto_usuario: String,
  msg: Mensagem,
  portas: Portas,
) -> Result(Nil, Erro) {
  let resposta_limpa = acessibilidade.sanitizar_saida_voz(resposta)
  use _ <- result.try(entregar(para, RespostaIA, resposta_limpa, msg, portas))
  portas.historico.adicionar(msg.chat_id, TurnoUsuario(texto_usuario))
  |> sistema.registrar_falha("Falha ao gravar pergunta no histórico")
  portas.historico.adicionar(msg.chat_id, TurnoAssistente(resposta_limpa))
  |> sistema.registrar_falha("Falha ao gravar resposta no histórico")
  Ok(Nil)
}

/// Esquece o vídeo do chat e apaga o arquivo dele no provedor de IA.
fn encerrar_contexto_video(
  chat_id: IdChat,
  uri: String,
  cfg: Config,
  portas: Portas,
) -> Nil {
  portas.video_contexto.remover(chat_id)
  |> sistema.registrar_falha("Falha ao remover contexto de vídeo")
  apagar_video_no_provedor(uri, cfg, portas)
}

pub fn apagar_video_no_provedor(uri: String, cfg: Config, portas: Portas) -> Nil {
  despachante_ia.deletar_arquivo(portas.despachante_ia, uri, cfg.provedor)
  |> sistema.registrar_falha("Falha ao apagar vídeo no provedor de IA")
}
