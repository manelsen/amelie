// Ações sobre a conversa: histórico, resumo, mídia, prompts e modelo.

import core/acessibilidade
import core/privacidade
import dominio/acao
import dominio/config.{type Config}
import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{
  type Mensagem, type Turno, TurnoAssistente, TurnoUsuario,
}
import dominio/provedores_config
import dominio/transacao.{RespostaTexto}
import gleam/bool
import gleam/list
import gleam/option
import gleam/result
import gleam/string
import logging
import shell/despachante_ia
import shell/fila_midia
import shell/tratador/base.{type Portas, entregar, responder}
import shell/tratador/respostas_ia

const prompt_resumo = "Resuma esta conversa de forma concisa e acessível, destacando os pontos principais, decisões e tópicos discutidos:\n\n"

pub fn limpar_historico(
  chat_id: IdChat,
  cfg: Config,
  portas: Portas,
) -> Result(Nil, Erro) {
  case portas.video_contexto.remover(chat_id) {
    Ok(option.Some(uri)) ->
      respostas_ia.apagar_video_no_provedor(uri, cfg, portas)
    _ -> Nil
  }
  portas.historico.limpar(chat_id)
}

pub fn enfileirar_midia(
  chat_id: IdChat,
  tipo: acao.TipoMidia,
  msg: Mensagem,
  cfg: Config,
  portas: Portas,
) -> Result(Nil, Erro) {
  logging.log(
    logging.Info,
    "Enfileirando mídia para processamento no chat "
      <> privacidade.mascarar(chat_id),
  )
  // O turno do usuário é gravado pela fila_midia, junto com a resposta,
  // só quando a descrição dá certo.
  let ia_porta =
    despachante_ia.como_porta(despachante_ia.DespachanteIAPorta(
      despachante: portas.despachante_ia,
      provedor: cfg.provedor,
      modelo: cfg.modelo,
    ))
  fila_midia.enfileirar(
    portas.fila,
    chat_id,
    msg,
    tipo,
    fila_midia.Contexto(
      cfg:,
      ia: ia_porta,
      mensageiro: portas.mensageiro,
      transacoes: portas.transacoes,
      historico: portas.historico,
      video_contexto: portas.video_contexto,
      metricas: portas.metricas,
    ),
  )
}

pub fn ativar_prompt(
  chat_id: IdChat,
  nome: String,
  cfg: Config,
  portas: Portas,
) -> Result(Nil, Erro) {
  use maybe_texto <- result.try(portas.prompts.obter(chat_id, nome))
  case maybe_texto {
    option.Some(texto) -> {
      let nova = config.Config(..cfg, prompt_sistema: option.Some(texto))
      use _ <- result.try(portas.config.salvar(nova))
      responder(chat_id, "Prompt `" <> nome <> "` ativado.", portas)
    }
    option.None ->
      responder(chat_id, "Prompt `" <> nome <> "` não encontrado.", portas)
  }
}

pub fn listar_prompts(chat_id: IdChat, portas: Portas) -> Result(Nil, Erro) {
  use nomes <- result.try(portas.prompts.listar(chat_id))
  let texto = case nomes {
    [] -> "Nenhum prompt salvo."
    _ ->
      "*Prompts salvos:*\n\n"
      <> string.join(list.map(nomes, fn(n) { "- `" <> n <> "`" }), "\n")
  }
  responder(chat_id, texto, portas)
}

pub fn formatar_lista(
  titulo: String,
  itens: Result(List(String), Erro),
) -> String {
  case itens {
    Ok(itens) -> titulo <> "\n" <> string.join(itens, "\n")
    Error(_) -> "Vazio ou Erro"
  }
}

pub fn resumir_historico(
  chat_id: IdChat,
  cfg: Config,
  portas: Portas,
) -> Result(Nil, Erro) {
  logging.log(
    logging.Info,
    "Fazendo snapshot e resumo do histórico do chat "
      <> privacidade.mascarar(chat_id),
  )
  use hist <- result.try(portas.historico.obter(chat_id))
  let turnos = list.length(hist)
  use <- bool.lazy_guard(turnos < 2, fn() {
    responder(
      chat_id,
      "Ainda não há mensagens suficientes no histórico para gerar um resumo.",
      portas,
    )
  })

  use resumo <- result.try(despachante_ia.gerar_texto(
    portas.despachante_ia,
    prompt_resumo <> formatar_conversa(hist),
    [],
    cfg.provedor,
    cfg.modelo,
  ))
  let resumo_limpo = acessibilidade.sanitizar_saida_voz(resumo)

  // Compacta no banco se houver 10 ou mais turnos acumulados
  use _ <- result.try(case turnos >= 10 {
    True -> {
      use _ <- result.try(portas.historico.limpar(chat_id))
      portas.historico.adicionar(chat_id, [
        TurnoUsuario("Contexto anterior resumido: " <> resumo_limpo),
      ])
    }
    False -> Ok(Nil)
  })

  responder(chat_id, "📝 *Resumo da conversa:*\n\n" <> resumo_limpo, portas)
}

fn formatar_conversa(hist: List(Turno)) -> String {
  hist
  |> list.map(fn(t) {
    case t {
      TurnoUsuario(c) -> "Usuário: " <> c
      TurnoAssistente(c) -> "Amélie: " <> c
    }
  })
  |> string.join("\n")
}

pub fn alterar_modelo(
  chat_id: IdChat,
  provedor: String,
  modelo: String,
  msg: Mensagem,
  cfg: Config,
  portas: Portas,
) -> Result(Nil, Erro) {
  case
    provedores_config.validar_modelo(portas.provedores_config, provedor, modelo)
  {
    Ok(provedor_valido) -> {
      let nova = config.Config(..cfg, provedor: provedor_valido, modelo: modelo)
      use _ <- result.try(portas.config.salvar(nova))
      entregar(
        chat_id,
        RespostaTexto,
        "Modelo alterado: `" <> provedor <> "/" <> modelo <> "`",
        msg,
        portas,
      )
    }
    Error(e) ->
      entregar(chat_id, RespostaTexto, "❌ " <> erro.descricao(e), msg, portas)
  }
}
