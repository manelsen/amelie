// Core puro — recebe dados, devolve Acoes.
// Não executa nenhum efeito. Testável sem infraestrutura.

import core/comando/despachante
import core/prompt/montador
import core/validacao
import dominio/acao.{
  type Acao, BuscarUrlEResponder, EnfileirarMidia, EnviarResposta, GerarEEnviar,
  MidiaAudio, MidiaDocumento, MidiaImagem, MidiaSticker, MidiaVideo,
  NaoResponder,
}
import dominio/config.{type Config}
import dominio/erro.{type Erro}
import dominio/mensagem.{
  type Mensagem, type Turno, Audio, Comando, Documento, Imagem, Texto, Video,
}
import gleam/bool
import gleam/list
import gleam/option
import gleam/result
import gleam/string

pub fn processar(
  msg: Mensagem,
  config: Config,
  historico: List(Turno),
) -> Result(List(Acao), Erro) {
  // Ignora mensagens do próprio bot (previne loops)
  use <- bool.guard(validacao.e_mensagem_propria(msg), Ok([NaoResponder]))

  processar_filtrado(msg, config, historico)
}

fn processar_filtrado(
  msg: Mensagem,
  config: Config,
  historico: List(Turno),
) -> Result(List(Acao), Erro) {
  // A Amélie não atua em grupos. A ponte já descarta e sai do grupo; isto é
  // a segunda camada, para nenhuma mensagem de grupo gerar resposta.
  use <- bool.guard(msg.em_grupo, Ok([NaoResponder]))

  case msg.corpo {
    Texto(body) -> processar_texto(body, config, historico)
    Comando(nome, args) -> processar_comando(nome, args, config)
    Imagem(..) -> processar_midia(msg, config, MidiaImagem)
    Audio(..) -> processar_midia(msg, config, MidiaAudio)
    Video(..) -> processar_midia(msg, config, MidiaVideo)
    Documento(..) -> processar_midia(msg, config, MidiaDocumento)
    mensagem.Sticker(..) -> processar_midia(msg, config, MidiaSticker)
    mensagem.MidiaIndisponivel(mensagem) ->
      Ok([EnviarResposta(config.chat_id, mensagem)])
  }
}

/// Downloads de links de vídeo ficam desativados: os extratores abririam
/// conexões fora da validação de URL (SSRF).
pub const aviso_link_video_desativado = "O download de links de vídeo está desativado. Envie o arquivo de vídeo diretamente."

fn processar_texto(
  body: String,
  config: Config,
  historico: List(Turno),
) -> Result(List(Acao), Erro) {
  // Verificar se é comando camuflado como texto (começa com ".")
  case validacao.parsear_comando(body) {
    Ok(#(nome, args)) -> processar_comando(nome, args, config)
    Error(_) -> {
      use texto_val <- result.try(validacao.validar_texto(body))
      case extrair_url(texto_val) {
        option.Some(url) ->
          case e_url_video(url) && config.video_ativo {
            True ->
              Ok([
                EnviarResposta(
                  para: config.chat_id,
                  corpo: aviso_link_video_desativado,
                ),
              ])
            False ->
              Ok([
                BuscarUrlEResponder(
                  para: config.chat_id,
                  texto: texto_val,
                  url: url,
                ),
              ])
          }
        option.None -> {
          case tem_midia_no_historico(historico) {
            True -> {
              let prompt = montador.montar(texto_val, config)
              Ok([GerarEEnviar(para: config.chat_id, prompt: prompt)])
            }
            False -> {
              let msg_explicativa =
                "👋 Olá! Eu sou a Amélie, especializada na análise e acessibilidade de mídias (áudios, imagens, vídeos e documentos).\n\n"
                <> "Para iniciar uma conversa, envie uma mídia (áudio, foto, vídeo ou documento) ou um link de vídeo. "
                <> "Não atuo como assistente geral de texto ou programação."
              Ok([EnviarResposta(para: config.chat_id, corpo: msg_explicativa)])
            }
          }
        }
      }
    }
  }
}

/// Turno que o shell insere no histórico efetivo do administrador. Só conta
/// por igualdade exata: um usuário comum não consegue gravar um turno que
/// seja exatamente este texto antes de destravar a conversa.
pub const marcador_admin = "[admin]"

pub fn tem_midia_no_historico(historico: List(Turno)) -> Bool {
  list.any(historico, fn(t) {
    case t {
      mensagem.TurnoUsuario(conteudo) ->
        string.contains(conteudo, "[imagem]")
        || string.contains(conteudo, "[áudio]")
        || string.contains(conteudo, "[vídeo]")
        || string.contains(conteudo, "[documento")
        || string.contains(conteudo, "[sticker]")
        || conteudo == marcador_admin
        || string.contains(conteudo, "http://")
        || string.contains(conteudo, "https://")
      mensagem.TurnoAssistente(conteudo) ->
        string.contains(conteudo, "Audiodescrição da imagem")
        || string.contains(conteudo, "Transcrição do áudio")
        || string.contains(conteudo, "Audiodescrição do vídeo")
        || string.contains(conteudo, "Transcrição do vídeo")
    }
  })
}

fn e_url_video(url: String) -> Bool {
  let url = string.lowercase(url)
  string.contains(url, "tiktok.com/")
  || string.contains(url, "vm.tiktok.com/")
  || string.contains(url, "instagram.com/reel")
  || string.contains(url, "instagram.com/reels/")
  || string.contains(url, "instagram.com/p/")
  || string.contains(url, "instagram.com/tv/")
  || string.contains(url, "instagram.com/stories/")
  || string.contains(url, "youtube.com/shorts/")
  || string.contains(url, "youtube.com/live/")
  || string.contains(url, "youtube.com/embed/")
  || string.contains(url, "youtube.com/watch")
  || string.contains(url, "m.youtube.com/watch")
  || string.contains(url, "music.youtube.com/watch")
  || string.contains(url, "youtu.be/")
}

fn extrair_url(texto: String) -> option.Option(String) {
  texto
  |> dividir_em_palavras()
  |> list.map(limpar_url)
  |> list.find(fn(palavra) {
    string.starts_with(palavra, "https://")
    || string.starts_with(palavra, "http://")
  })
  |> option.from_result
}

fn dividir_em_palavras(texto: String) -> List(String) {
  dividir_graphemes(string.to_graphemes(texto), [], [])
}

fn dividir_graphemes(
  restantes: List(String),
  palavra_atual: List(String),
  palavras: List(String),
) -> List(String) {
  case restantes {
    [] -> finalizar_palavra(palavra_atual, palavras) |> list.reverse
    [grapheme, ..resto] ->
      case string.trim(grapheme) == "" {
        True ->
          dividir_graphemes(
            resto,
            [],
            finalizar_palavra(palavra_atual, palavras),
          )
        False -> dividir_graphemes(resto, [grapheme, ..palavra_atual], palavras)
      }
  }
}

fn finalizar_palavra(
  palavra_atual: List(String),
  palavras: List(String),
) -> List(String) {
  case palavra_atual {
    [] -> palavras
    _ -> [palavra_atual |> list.reverse |> string.concat, ..palavras]
  }
}

/// Tira a pontuação em volta de um link: `<https://x.com>`, `(https://x.com).`.
/// Repete até não sobrar nada a tirar. Um `)` só sai se estiver sem par, para
/// preservar links como `https://pt.wikipedia.org/wiki/Mercúrio_(planeta)`.
fn limpar_url(palavra: String) -> String {
  palavra
  |> remover_prefixos(["<", "(", "[", "\"", "'"])
  |> remover_sufixos([
    ">",
    ")",
    "]",
    "}",
    ".",
    ",",
    ";",
    ":",
    "!",
    "?",
    "\"",
    "'",
  ])
}

fn remover_prefixos(texto: String, prefixos: List(String)) -> String {
  case list.find(prefixos, string.starts_with(texto, _)) {
    Ok(p) ->
      remover_prefixos(string.drop_start(texto, string.length(p)), prefixos)
    Error(_) -> texto
  }
}

fn remover_sufixos(texto: String, sufixos: List(String)) -> String {
  let removivel = fn(s) {
    string.ends_with(texto, s) && { s != ")" || parenteses_sem_par(texto) }
  }
  case list.find(sufixos, removivel) {
    Ok(s) -> remover_sufixos(string.drop_end(texto, string.length(s)), sufixos)
    Error(_) -> texto
  }
}

fn parenteses_sem_par(texto: String) -> Bool {
  let contar = fn(c) { list.length(string.split(texto, c)) - 1 }
  contar(")") > contar("(")
}

fn processar_comando(
  nome: String,
  args: String,
  config: Config,
) -> Result(List(Acao), Erro) {
  despachante.executar(nome, args, config)
}

fn processar_midia(
  msg: Mensagem,
  config: Config,
  tipo: acao.TipoMidia,
) -> Result(List(Acao), Erro) {
  let ativa = case tipo {
    MidiaImagem -> config.imagem_ativo
    MidiaAudio -> config.audio_ativo
    MidiaVideo -> config.video_ativo
    MidiaDocumento -> config.doc_ativo
    MidiaSticker -> config.imagem_ativo
  }

  use <- bool.guard(!ativa, Ok([NaoResponder]))
  Ok([EnfileirarMidia(chat_id: msg.chat_id, tipo: tipo)])
}
