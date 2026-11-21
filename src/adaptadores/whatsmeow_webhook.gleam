//// Adaptador de entrada da ponte whatsmeow: converte o JSON que a ponte manda
//// aos webhooks do Gleam nos tipos de `portas/ponte_porta`. É o par do
//// `telegram_webhook` para o WhatsApp.

import dominio/id_chat.{type IdChat}
import dominio/mensagem.{Mensagem, Texto}
import gleam/bit_array
import gleam/dynamic/decode
import gleam/json
import gleam/option
import gleam/result
import gleam/string
import portas/ponte_porta.{
  type EventoPonte, type Webhook, CodigoPareamentoGerado, Webhook, WhatsappCaiu,
  WhatsappVoltou,
}

/// Confere que o caminho da mídia está dentro do spool privado da ponte.
@external(erlang, "amelie_ffi", "validate_bridge_media")
fn validar_arquivo(path: String) -> Result(String, String)

pub fn decodificar_webhook(body: BitArray) -> Result(Webhook, Nil) {
  case bit_array.to_string(body) {
    Error(_) -> Error(Nil)
    Ok(s) ->
      json.parse(s, mensagem_decoder())
      |> result.map_error(fn(_) { Nil })
      |> result.try(validar_webhook)
  }
}

fn validar_webhook(webhook: Webhook) -> Result(Webhook, Nil) {
  let arquivo = case webhook.msg.corpo {
    mensagem.Video(caminho_temp: caminho, ..) -> option.Some(caminho)
    _ -> webhook.arquivo
  }
  case arquivo {
    option.None -> Ok(webhook)
    option.Some(caminho) ->
      validar_arquivo(caminho)
      |> result.map(fn(_) { webhook })
      |> result.map_error(fn(_) { Nil })
  }
}

fn mensagem_decoder() -> decode.Decoder(Webhook) {
  use chat_id <- decode.field("chat_id", jid_decoder())
  use from <- decode.field("from", jid_decoder())
  use message_id <- decode.optional_field(
    "message_id",
    option.None,
    decode.string |> decode.map(option.Some),
  )
  use text <- decode.optional_field("text", "", decode.string)
  use ts <- decode.field("ts", decode.int)
  use em_grupo <- decode.field("em_grupo", decode.bool)
  use nome_grupo <- decode.optional_field(
    "nome_grupo",
    option.None,
    decode.string |> decode.map(option.Some),
  )
  use menciona <- decode.optional_field("menciona_bot", False, decode.bool)
  use caption <- decode.optional_field(
    "legenda",
    option.None,
    decode.string |> decode.map(option.Some),
  )

  use tipo <- decode.optional_field("tipo", "texto", decode.string)
  use mime <- decode.optional_field("mime", "", decode.string)
  use dados <- decode.optional_field("dados", "", decode.string)
  use caminho <- decode.optional_field("caminho_temp", "", decode.string)

  let #(corpo, arquivo) = parsear_corpo(tipo, text, mime, dados, caminho)
  let msg =
    Mensagem(
      chat_id: chat_id,
      remetente: from,
      message_id: message_id,
      corpo: corpo,
      timestamp: ts,
      em_grupo: em_grupo,
      nome_grupo: nome_grupo,
      menciona_bot: menciona,
      legenda: caption,
    )
  decode.success(Webhook(msg: msg, arquivo: arquivo))
}

/// A ponte só entrega mensagens do WhatsApp: um `tg:` aqui é forjado.
fn jid_decoder() -> decode.Decoder(IdChat) {
  use texto <- decode.then(decode.string)
  case id_chat.whatsapp(texto) {
    Ok(id) -> decode.success(id)
    Error(Nil) -> decode.failure(id_chat.telegram(0), "JID do WhatsApp")
  }
}

fn parsear_corpo(
  tipo: String,
  text: String,
  mime: String,
  dados: String,
  caminho_temp: String,
) -> #(mensagem.Conteudo, option.Option(String)) {
  // Mídia chega por arquivo (`caminho_temp`); `dados` em base64 só aparece em
  // payloads antigos que ainda estejam na fila do bridge.
  let #(bytes, arquivo) = case caminho_temp {
    "" -> #(
      bit_array.base64_decode(dados) |> result.unwrap(or: <<>>),
      option.None,
    )
    _ -> #(<<>>, option.Some(caminho_temp))
  }
  case tipo {
    "imagem" -> #(mensagem.Imagem(mime: mime, dados: bytes), arquivo)
    "audio" -> #(mensagem.Audio(mime: mime, dados: bytes), arquivo)
    "documento" -> #(
      mensagem.Documento(mime: mime, dados: bytes, nome: text),
      arquivo,
    )
    "sticker" -> #(mensagem.Sticker(mime: mime, dados: bytes), arquivo)
    // Vídeo segue em disco até o upload para a IA; fila_midia apaga o arquivo.
    "video" -> #(
      mensagem.Video(caminho_temp: caminho_temp, mime: mime),
      option.None,
    )
    "midia_indisponivel" -> #(
      mensagem.MidiaIndisponivel(mensagem: text),
      option.None,
    )
    _ -> {
      let corpo = case string.trim(text) {
        "." <> rest -> {
          case string.split_once(rest, " ") {
            Ok(#(nome, args)) ->
              mensagem.Comando(string.lowercase(nome), string.trim(args))
            Error(_) -> mensagem.Comando(string.lowercase(rest), "")
          }
        }
        _ -> Texto(text)
      }
      #(corpo, option.None)
    }
  }
}

pub fn decodificar_evento(body: BitArray) -> Result(EventoPonte, Nil) {
  use s <- result.try(
    bit_array.to_string(body)
    |> result.map_error(fn(_) { Nil }),
  )
  let decoder = {
    use evento <- decode.field("evento", decode.string)
    use phone <- decode.optional_field("phone", "", decode.string)
    use code <- decode.optional_field("code", "", decode.string)
    use motivo <- decode.optional_field("motivo", "Desconectado", decode.string)
    case evento {
      "pairing_code" -> decode.success(CodigoPareamentoGerado(phone, code))
      "whatsapp_up" -> decode.success(WhatsappVoltou)
      _ -> decode.success(WhatsappCaiu(motivo))
    }
  }
  json.parse(s, decoder)
  |> result.map_error(fn(_) { Nil })
}
