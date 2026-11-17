// Adaptador HTTP para Google Gemini API.
// Implementa IAPorta.

import adaptadores/gemini_diagnostico
import adaptadores/gemini_url
import dominio/erro.{type Erro}
import dominio/mensagem.{type Turno, TurnoAssistente, TurnoUsuario}
import gleam/bit_array
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/http
import gleam/http/request
import gleam/httpc
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import gleam/string
import logging
import portas/ia_porta.{type IAPorta, IAPorta}

const base_url = "https://generativelanguage.googleapis.com/v1beta/models/"

pub fn criar(api_key: String) -> IAPorta {
  IAPorta(
    gerar_texto: fn(prompt, historico, modelo) {
      gerar_texto(api_key, prompt, historico, modelo)
    },
    processar_imagem: fn(dados, mime, prompt, modelo) {
      processar_inline(api_key, dados, mime, prompt, modelo)
    },
    processar_audio: fn(dados, mime, prompt, modelo) {
      processar_audio(api_key, dados, mime, prompt, modelo)
    },
    processar_video: fn(uri, prompt, modelo) {
      processar_video(api_key, uri, prompt, modelo)
    },
    processar_documento: fn(dados, mime, prompt, modelo) {
      processar_inline(api_key, dados, mime, prompt, modelo)
    },
    fazer_upload_video: fn(caminho, mime) {
      fazer_upload_video(api_key, caminho, mime)
    },
    aguardar_video_ativo: fn(uri) { aguardar_video_ativo(api_key, uri) },
    deletar_arquivo: fn(uri) { deletar_arquivo(api_key, uri) },
  )
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

fn gerar_texto(
  api_key: String,
  prompt: String,
  historico: List(Turno),
  modelo: String,
) -> Result(String, Erro) {
  let contents = historico_para_contents(historico, prompt)
  let body =
    json.object([#("contents", json.preprocessed_array(contents))])
    |> json.to_string

  use resp_body <- result.try(post_gemini(api_key, modelo, body))
  extrair_texto_resposta(resp_body)
}

fn historico_para_contents(
  historico: List(Turno),
  prompt_atual: String,
) -> List(json.Json) {
  let turnos_json =
    list.map(historico, fn(turno) {
      case turno {
        TurnoUsuario(c) -> conteudo_json("user", c)
        TurnoAssistente(c) -> conteudo_json("model", c)
      }
    })
  list.append(turnos_json, [conteudo_json("user", prompt_atual)])
}

fn conteudo_json(role: String, text: String) -> json.Json {
  json.object([
    #("role", json.string(role)),
    #(
      "parts",
      json.preprocessed_array([json.object([#("text", json.string(text))])]),
    ),
  ])
}

// ---------------------------------------------------------------------------
// Mídia inline (imagem, áudio, documento)
// ---------------------------------------------------------------------------

fn processar_inline(
  api_key: String,
  dados: BitArray,
  mime: String,
  prompt: String,
  modelo: String,
) -> Result(String, Erro) {
  // Gemini não aceita parâmetros de codec no MIME type (ex: "audio/ogg; codecs=opus").
  let mime = case string.split_once(mime, ";") {
    Ok(#(base, _)) -> string.trim(base)
    Error(_) -> mime
  }
  let b64 = bit_array.base64_encode(dados, True)
  let parts =
    json.preprocessed_array([
      json.object([#("text", json.string(prompt))]),
      json.object([
        #(
          "inline_data",
          json.object([
            #("mime_type", json.string(mime)),
            #("data", json.string(b64)),
          ]),
        ),
      ]),
    ])

  let body =
    json.object([
      #("contents", json.preprocessed_array([json.object([#("parts", parts)])])),
    ])
    |> json.to_string

  use resp_body <- result.try(post_gemini(api_key, modelo, body))
  extrair_texto_resposta(resp_body)
}

fn processar_audio(
  api_key: String,
  dados: BitArray,
  mime: String,
  prompt: String,
  modelo: String,
) -> Result(String, Erro) {
  use _ <- result.try(validar_midia_nao_vazia(dados, "áudio"))

  let mime = normalizar_mime(mime)
  use uri <- result.try(
    enviar_dados_ffi(api_key, dados, mime) |> interpretar_upload,
  )
  let resultado = {
    use _ <- result.try(aguardar_arquivo_ativo(api_key, uri, "áudio"))
    processar_arquivo_com_system(api_key, uri, mime, prompt, modelo)
  }
  deletar_arquivo(api_key, uri)
  |> registrar_falha_delecao
  resultado
}

// ---------------------------------------------------------------------------
// Vídeo (via File API URI)
// ---------------------------------------------------------------------------

fn processar_video(
  api_key: String,
  uri: String,
  prompt: String,
  modelo: String,
) -> Result(String, Erro) {
  let parts =
    json.preprocessed_array([
      json.object([#("text", json.string(prompt))]),
      json.object([
        #("file_data", json.object([#("file_uri", json.string(uri))])),
      ]),
    ])

  let body =
    json.object([
      #("contents", json.preprocessed_array([json.object([#("parts", parts)])])),
    ])
    |> json.to_string

  use resp_body <- result.try(post_gemini(api_key, modelo, body))
  extrair_texto_resposta(resp_body)
}

// Envia prompt como system_instruction (prioridade alta no Gemini) em vez de contents.
fn processar_arquivo_com_system(
  api_key: String,
  uri: String,
  mime: String,
  prompt: String,
  modelo: String,
) -> Result(String, Erro) {
  let body =
    json.object([
      #(
        "system_instruction",
        json.object([
          #(
            "parts",
            json.preprocessed_array([
              json.object([#("text", json.string(prompt))]),
            ]),
          ),
        ]),
      ),
      #(
        "contents",
        json.preprocessed_array([
          json.object([
            #(
              "parts",
              json.preprocessed_array([
                json.object([
                  #(
                    "file_data",
                    json.object([
                      #("mime_type", json.string(mime)),
                      #("file_uri", json.string(uri)),
                    ]),
                  ),
                ]),
              ]),
            ),
          ]),
        ]),
      ),
    ])
    |> json.to_string

  use resp_body <- result.try(post_gemini(api_key, modelo, body))
  extrair_texto_resposta(resp_body)
}

// ---------------------------------------------------------------------------
// File API — upload, poll, delete
// ---------------------------------------------------------------------------

fn fazer_upload_video(
  api_key: String,
  caminho: String,
  mime: String,
) -> Result(String, Erro) {
  // Gemini File API exige multipart binary — usamos FFI para enviar o arquivo diretamente.
  fazer_upload_arquivo(api_key, caminho, mime)
}

fn fazer_upload_arquivo(
  api_key: String,
  caminho: String,
  mime: String,
) -> Result(String, Erro) {
  enviar_arquivo_ffi(api_key, caminho, mime) |> interpretar_upload
}

fn interpretar_upload(resultado: Result(String, String)) -> Result(String, Erro) {
  use corpo <- result.try(result.map_error(resultado, erro.ErroUpload))
  extrair_uri_arquivo(corpo)
  |> result.replace_error(erro.ErroUpload("uri ausente na resposta"))
}

// Polling com até 20 tentativas (3s cada = 60s máximo).
fn aguardar_video_ativo(api_key: String, uri: String) -> Result(Nil, Erro) {
  aguardar_arquivo_ativo(api_key, uri, "vídeo")
}

fn aguardar_arquivo_ativo(
  api_key: String,
  uri: String,
  tipo: String,
) -> Result(Nil, Erro) {
  aguardar_loop(api_key, uri, 20, tipo)
}

fn aguardar_loop(
  api_key: String,
  uri: String,
  restantes: Int,
  tipo: String,
) -> Result(Nil, Erro) {
  case restantes {
    0 -> Error(erro.ErroUpload("timeout aguardando " <> tipo <> " ficar ativo"))
    n -> {
      use req <- result.try(
        requisicao_gemini(uri, api_key)
        |> result.map_error(fn(_) {
          erro.ErroComunicacao("url de status inválida")
        }),
      )
      use resp <- result.try(
        httpc.send(req)
        |> result.map_error(fn(_) {
          erro.ErroUpload("falha ao verificar status do " <> tipo)
        }),
      )
      case resp.status {
        200 ->
          case string.contains(resp.body, "\"ACTIVE\"") {
            True -> Ok(Nil)
            False -> {
              process.sleep(3000)
              aguardar_loop(api_key, uri, n - 1, tipo)
            }
          }
        // 5xx são transitórios — retentar
        s if s >= 500 -> {
          process.sleep(3000)
          aguardar_loop(api_key, uri, n - 1, tipo)
        }
        status ->
          Error(erro.ErroUpload(
            "status inesperado ao ativar "
            <> tipo
            <> ": "
            <> int.to_string(status),
          ))
      }
    }
  }
}

fn normalizar_mime(mime: String) -> String {
  case string.split_once(mime, ";") {
    Ok(#(base, _)) -> string.trim(base)
    Error(_) -> mime
  }
}

fn validar_midia_nao_vazia(dados: BitArray, tipo: String) -> Result(Nil, Erro) {
  case bit_array.byte_size(dados) > 0 {
    True -> Ok(Nil)
    False -> Error(erro.ErroMidia(tipo <> " vazio recebido do WhatsApp"))
  }
}

fn deletar_arquivo(api_key: String, uri: String) -> Result(Nil, Erro) {
  use req <- result.try(
    requisicao_gemini(uri, api_key)
    |> result.map_error(fn(_) {
      erro.ErroComunicacao("url de deleção inválida")
    }),
  )

  let req = req |> request.set_method(http.Delete)
  use resp <- result.try(
    httpc.send(req)
    |> result.map_error(fn(e) {
      erro.ErroComunicacao(
        "falha ao apagar arquivo no Gemini: " <> string.inspect(e),
      )
    }),
  )
  interpretar_delecao(resp.status)
}

/// O áudio enviado à File API é apagado logo após o uso; se não der, a
/// resposta segue mesmo assim e a falha só vai para o log.
fn registrar_falha_delecao(resultado: Result(Nil, Erro)) -> Nil {
  case resultado {
    Ok(Nil) -> Nil
    Error(e) ->
      logging.log(
        logging.Warning,
        "[Gemini] Falha ao apagar áudio temporário: " <> erro.descricao(e),
      )
  }
}

/// Resultado de um DELETE na File API pelo status HTTP. 404 conta como
/// sucesso: o arquivo já não existe (a File API apaga sozinha após 48 h, ou
/// outra limpeza chegou antes), que é o estado pedido.
pub fn interpretar_delecao(status: Int) -> Result(Nil, Erro) {
  case status {
    s if s >= 200 && s < 300 -> Ok(Nil)
    404 -> Ok(Nil)
    s ->
      Error(erro.ErroIA(
        "Gemini recusou apagar arquivo: status " <> int.to_string(s),
      ))
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/// Monta uma requisição autenticada para a API do Gemini. A chave vai no
/// cabeçalho `x-goog-api-key`, nunca na URL, que aparece em logs e erros.
/// Recusa qualquer host fora da API: as URIs de arquivo vêm de respostas,
/// e a chave não pode seguir para outro destino.
fn requisicao_gemini(
  url: String,
  api_key: String,
) -> Result(request.Request(String), Nil) {
  case gemini_url.url_da_api(url) {
    False -> Error(Nil)
    True ->
      request.to(url)
      |> result.map(request.set_header(_, "x-goog-api-key", api_key))
  }
}

fn post_gemini(
  api_key: String,
  modelo: String,
  body: String,
) -> Result(String, Erro) {
  use req <- result.try(
    requisicao_gemini(base_url <> modelo <> ":generateContent", api_key)
    |> result.map_error(fn(_) { erro.ErroComunicacao("url gemini inválida") }),
  )

  let req =
    req
    |> request.set_method(http.Post)
    |> request.set_header("content-type", "application/json")
    |> request.set_body(body)

  use resp <- result.try(
    httpc.send(req)
    |> result.map_error(fn(e) {
      erro.ErroComunicacao("falha ao chamar Gemini: " <> string.inspect(e))
    }),
  )

  case resp.status {
    200 -> Ok(resp.body)
    429 -> Error(erro.ErroIA("rate limit Gemini"))
    status ->
      Error(erro.ErroIA("Gemini retornou status " <> int.to_string(status)))
  }
}

// ---------------------------------------------------------------------------
// Decodificação de respostas JSON (gleam_json 3.x — json.parse + decode)
// ---------------------------------------------------------------------------

/// Junta o texto das partes do primeiro candidato. A resposta pode vir em
/// várias partes; partes sem texto (assinatura de pensamento, por exemplo)
/// e partes de pensamento ficam de fora em vez de derrubar a resposta.
pub fn extrair_texto_resposta(json_str: String) -> Result(String, Erro) {
  // {"candidates":[{"content":{"parts":[{"text":"..."}, ...]}}]}
  let parte = {
    use texto <- decode.optional_field("text", "", decode.string)
    use pensamento <- decode.optional_field("thought", False, decode.bool)
    decode.success(case pensamento {
      True -> ""
      False -> texto
    })
  }
  let decoder =
    decode.at(
      ["candidates"],
      decode.list(decode.at(["content", "parts"], decode.list(parte))),
    )

  let texto = case json.parse(json_str, decoder) {
    Ok([partes, ..]) -> string.concat(partes)
    _ -> ""
  }
  case string.trim(texto) {
    "" -> {
      logging.log(
        logging.Warning,
        "[Gemini] Resposta sem texto: "
          <> gemini_diagnostico.resumir_resposta_sem_texto(json_str),
      )
      Error(erro.ErroIA("formato de resposta Gemini inesperado"))
    }
    _ -> Ok(texto)
  }
}

fn extrair_uri_arquivo(json_str: String) -> Result(String, Nil) {
  let decoder = decode.at(["file"], decode.at(["uri"], decode.string))
  json.parse(json_str, decoder)
  |> result.map_error(fn(_) { Nil })
}

// ---------------------------------------------------------------------------
// FFI
// ---------------------------------------------------------------------------

@external(erlang, "amelie_gleam_ffi", "upload_bytes")
fn enviar_dados_ffi(
  api_key: String,
  dados: BitArray,
  mime: String,
) -> Result(String, String)

@external(erlang, "amelie_gleam_ffi", "upload_file")
fn enviar_arquivo_ffi(
  api_key: String,
  caminho: String,
  mime: String,
) -> Result(String, String)
