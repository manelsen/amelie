import adaptadores/armazenamento_sqlite
import adaptadores/config_sqlite
import adaptadores/gemini_http
import adaptadores/grupo_sqlite
import adaptadores/historico_sqlite
import adaptadores/openrouter_http
import adaptadores/prompt_sqlite
import adaptadores/roteador_mensageiro
import adaptadores/spammer_sqlite
import adaptadores/telegram_http
import adaptadores/telegram_webhook
import adaptadores/transacao_sqlite
import adaptadores/usuario_sqlite
import adaptadores/video_contexto_sqlite
import adaptadores/whatsmeow_http
import adaptadores/whatsmeow_webhook
import dominio/id_chat.{type IdChat}
import dominio/provedores_config
import gleam/bytes_tree
import gleam/erlang/process
import gleam/http/request.{type Request}
import gleam/http/response
import gleam/int
import gleam/option.{type Option}
import gleam/result
import gleam/string
import mist.{type Connection, type ResponseData}
import portas/armazenamento_porta.{type ArmazenamentoPorta}
import portas/mensageiro_porta.{type MensageiroPorta}
import portas/ponte_porta
import portas/telegram_porta.{type TelegramPorta}
import shell/arvore_supervisao
import shell/avisos_ponte
import shell/despachante_ia
import shell/fila_atrasadas.{type FilaAtrasadas}
import shell/fila_offline
import shell/ia_resiliente
import shell/receptor_telegram
import shell/receptor_whatsapp
import shell/saude
import shell/seguranca_http
import shell/sistema
import shell/tratador/base.{type Portas, Portas}
import simplifile
import sqlight

import dot_env
import logging

// ---------------------------------------------------------------------------
// FFI — variáveis de ambiente
// ---------------------------------------------------------------------------

@external(erlang, "amelie_ffi", "ensure_applications_started")
fn garantir_aplicacoes_iniciadas() -> Nil

pub fn main() {
  dot_env.new()
  |> dot_env.load

  logging.configure()
  garantir_aplicacoes_iniciadas()

  let bridge_token = seguranca_http.token_ponte()
  let assert True = string.byte_size(bridge_token) >= 32
    as "Defina BRIDGE_TOKEN com pelo menos 32 caracteres aleatórios"

  let gemini_api_key = sistema.ler_env_ou("GEMINI_API_KEY", "")
  let openrouter_api_key = sistema.ler_env_ou("OPENROUTER_API_KEY", "")
  let telegram_bot_token = sistema.ler_env_ou("TELEGRAM_BOT_TOKEN", "")
  let telegram_secret_token = sistema.ler_env_ou("TELEGRAM_SECRET_TOKEN", "")
  let telegram_admin_chat_id = sistema.admin_chat_id()

  let url_ponte = sistema.url_ponte()
  let db_path = sistema.ler_env_ou("DB_PATH", "./db/amelie.sqlite")
  let port_str = sistema.ler_env_ou("PORT", "4000")
  let offline_retry_interval_str =
    sistema.ler_env_ou("OFFLINE_RETRY_INTERVAL_MS", "30000")
  let port =
    int.parse(port_str)
    |> result.unwrap(or: 4000)
  let offline_retry_interval_ms =
    int.parse(offline_retry_interval_str)
    |> result.unwrap(or: 30_000)
  let manutencao_intervalo_str =
    sistema.ler_env_ou("MANUTENCAO_INTERVALO_MS", "3600000")
  let manutencao_intervalo_ms =
    int.parse(manutencao_intervalo_str)
    |> result.unwrap(or: 3_600_000)

  let provedores_config =
    simplifile.read("./config/providers.yaml")
    |> result.replace_error(Nil)
    |> result.try(fn(texto) {
      provedores_config.parsear(texto) |> result.replace_error(Nil)
    })
    |> result.unwrap(provedores_config.padrao())

  use conn <- sqlight.with_connection(db_path)

  let _ = sqlight.exec("PRAGMA journal_mode = WAL;", conn)
  let _ = sqlight.exec("PRAGMA busy_timeout = 5000;", conn)
  let _ = sqlight.exec("PRAGMA synchronous = NORMAL;", conn)

  let config_p = config_sqlite.criar(conn)
  let historico_p = historico_sqlite.criar(conn)
  let prompts_p = prompt_sqlite.criar(conn)
  let usuarios_p = usuario_sqlite.criar(conn)
  let grupos_p = grupo_sqlite.criar(conn)
  let transacoes_p = transacao_sqlite.criar(conn)
  let spammers_p = spammer_sqlite.criar(conn)
  let video_contexto_p = video_contexto_sqlite.criar(conn)
  let conexao_ponte =
    whatsmeow_http.Conexao(url: url_ponte, token: bridge_token)
  let whatsapp = whatsmeow_http.criar(conexao_ponte)
  let telegram = telegram_http.criar(telegram_bot_token)
  let mensageiro = roteador_mensageiro.criar(whatsapp, telegram)
  let ponte = whatsmeow_http.criar_ponte(conexao_ponte)

  // O admin recebe os avisos (ponte, provedores de IA, anti-spam) pelo
  // Telegram; sem bot, não há a quem avisar.
  let admin_avisos = case telegram_bot_token {
    "" -> option.None
    _ -> telegram_admin_chat_id
  }

  let #(_supervisor, procs) =
    arvore_supervisao.iniciar_completo(
      transacoes_p,
      mensageiro,
      ponte,
      manutencao_intervalo_ms,
      admin_avisos,
    )
    |> result.lazy_unwrap(fn() {
      panic as "falha ao iniciar árvore de supervisão de processos de suporte"
    })

  let gemini_ia =
    gemini_http.criar(gemini_api_key)
    |> ia_resiliente.envolver(procs.cb_gemini, procs.cache_gemini)
  let openrouter_ia =
    openrouter_http.criar(openrouter_api_key)
    |> ia_resiliente.envolver(procs.cb_openrouter, procs.cache_openrouter)
  let despachante_ia =
    despachante_ia.DespachanteIA(gemini: gemini_ia, openrouter: openrouter_ia)

  let _ =
    fila_offline.agendar_processamento(
      procs.fila_offline,
      offline_retry_interval_ms,
    )

  let portas =
    Portas(
      mensageiro: mensageiro,
      despachante_ia: despachante_ia,
      config: config_p,
      historico: historico_p,
      fila: procs.fila,
      prompts: prompts_p,
      metricas: procs.metricas,
      usuarios: usuarios_p,
      grupos: grupos_p,
      transacoes: transacoes_p,
      provedores_config: provedores_config,
      anti_spam: procs.anti_spam,
      spammers: spammers_p,
      video_contexto: video_contexto_p,
      ponte: ponte,
    )

  // Uma TelegramPorta só, para o long polling e para o webhook.
  let telegram_api = telegram_http.criar_api(string.trim(telegram_bot_token))
  case string.trim(telegram_bot_token) {
    "" -> Nil
    _ -> receptor_telegram.iniciar(telegram_api, portas, procs.fila_atrasadas)
  }

  let rotas =
    Rotas(
      portas: portas,
      atrasadas: procs.fila_atrasadas,
      armazenamento: armazenamento_sqlite.criar(conn),
      telegram_secret: telegram_secret_token,
      telegram_api: telegram_api,
      telegram_ativo: telegram_bot_token != "",
      admin_avisos: admin_avisos,
      bridge_token: bridge_token,
    )

  let assert Ok(_) =
    mist.new(fn(req) { tratar_requisicao(req, rotas) })
    |> mist.port(port)
    |> mist.bind("0.0.0.0")
    |> mist.start

  process.sleep_forever()
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/// O que o roteador HTTP precisa, montado uma vez no `main`.
type Rotas {
  Rotas(
    portas: Portas,
    atrasadas: FilaAtrasadas,
    armazenamento: ArmazenamentoPorta,
    telegram_secret: String,
    telegram_api: TelegramPorta,
    telegram_ativo: Bool,
    admin_avisos: Option(IdChat),
    bridge_token: String,
  )
}

fn tratar_requisicao(
  req: Request(Connection),
  rotas: Rotas,
) -> response.Response(ResponseData) {
  let Rotas(
    portas:,
    atrasadas:,
    armazenamento:,
    telegram_secret:,
    telegram_api:,
    telegram_ativo:,
    admin_avisos:,
    bridge_token:,
  ) = rotas
  case req.path {
    "/webhook" ->
      proteger_webhook(req, ponte_porta.cabecalho_token, bridge_token, fn(req) {
        tratar_webhook(req, portas, atrasadas)
      })
    "/webhook/telegram" ->
      tratar_webhook_telegram(
        req,
        portas,
        atrasadas,
        telegram_secret,
        telegram_api,
      )
    "/webhook/bridge-event" ->
      proteger_webhook(req, ponte_porta.cabecalho_token, bridge_token, fn(req) {
        tratar_evento_ponte(req, portas.mensageiro, admin_avisos)
      })
    "/health" -> {
      let detalhada =
        seguranca_http.autorizado(
          req,
          ponte_porta.cabecalho_token,
          bridge_token,
        )
      let #(codigo, corpo) = case detalhada {
        True -> saude.detalhada(armazenamento, portas.ponte, telegram_ativo)
        False -> saude.publica(armazenamento, portas.ponte)
      }
      resposta_json(codigo, corpo)
    }
    _ -> resposta_json(404, "{\"error\":\"not found\"}")
  }
}

fn proteger_webhook(
  req: Request(Connection),
  cabecalho: String,
  segredo: String,
  handler: fn(Request(Connection)) -> response.Response(ResponseData),
) -> response.Response(ResponseData) {
  case seguranca_http.autorizar_webhook(req, cabecalho, segredo) {
    Ok(_) -> handler(req)
    Error(status) -> resposta_json(status, "{\"error\":\"request rejected\"}")
  }
}

fn tratar_evento_ponte(
  req: Request(Connection),
  mensageiro: MensageiroPorta,
  admin: Option(IdChat),
) -> response.Response(ResponseData) {
  case mist.read_body(req, 1024 * 1024) {
    Error(_) -> resposta_json(400, "{\"error\":\"failed to read body\"}")
    Ok(req_with_body) -> {
      case whatsmeow_webhook.decodificar_evento(req_with_body.body) {
        Error(_) -> resposta_json(400, "{\"error\":\"invalid payload\"}")
        Ok(evt) ->
          // Falha no envio vira 502: a ponte tenta de novo.
          case avisos_ponte.avisar(evt, mensageiro, admin) {
            Ok(Nil) -> resposta_json(200, "{\"ok\":true}")
            Error(_) ->
              resposta_json(502, "{\"error\":\"telegram send failed\"}")
          }
      }
    }
  }
}

fn tratar_webhook_telegram(
  req: Request(Connection),
  portas: Portas,
  atrasadas: FilaAtrasadas,
  secret_token: String,
  api: TelegramPorta,
) -> response.Response(ResponseData) {
  proteger_webhook(
    req,
    "x-telegram-bot-api-secret-token",
    secret_token,
    fn(req) { processar_corpo_telegram(req, portas, atrasadas, api) },
  )
}

fn processar_corpo_telegram(
  req: Request(Connection),
  portas: Portas,
  atrasadas: FilaAtrasadas,
  api: TelegramPorta,
) -> response.Response(ResponseData) {
  case mist.read_body(req, 1024 * 1024) {
    Error(_) -> resposta_json(400, "{\"error\":\"failed to read body\"}")
    Ok(req_with_body) ->
      case telegram_webhook.parsear_evento(req_with_body.body) {
        Error(_) ->
          resposta_json(400, "{\"error\":\"invalid telegram payload\"}")
        Ok(telegram_porta.EventoIgnorado(_)) ->
          resposta_json(200, "{\"ok\":true,\"ignored\":true}")
        Ok(evento) -> {
          receptor_telegram.despachar_evento(evento, api, portas, atrasadas)
          resposta_json(200, "{\"ok\":true}")
        }
      }
  }
}

fn tratar_webhook(
  req: Request(Connection),
  portas: Portas,
  atrasadas: FilaAtrasadas,
) -> response.Response(ResponseData) {
  case mist.read_body(req, 20 * 1024 * 1024) {
    Error(_) -> resposta_json(400, "{\"error\":\"failed to read body\"}")
    Ok(req_with_body) ->
      case whatsmeow_webhook.decodificar_webhook(req_with_body.body) {
        Error(_) -> resposta_json(400, "{\"error\":\"invalid payload\"}")
        Ok(webhook) -> {
          receptor_whatsapp.despachar(webhook, portas, atrasadas)
          resposta_json(202, "{\"ok\":true}")
        }
      }
  }
}

fn resposta_json(status: Int, body: String) -> response.Response(ResponseData) {
  response.new(status)
  |> response.set_header("content-type", "application/json")
  |> response.set_body(mist.Bytes(bytes_tree.from_string(body)))
}
