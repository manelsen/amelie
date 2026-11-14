//// Teste ponta a ponta: do JSON que a ponte manda ao `/webhook` até o POST
//// que volta para a ponte em `/send`, com as peças de produção no meio.
////
//// Reais: o adaptador de entrada (`whatsmeow_webhook`), o receptor, o
//// tratador, o core, a entrega auditada, o SQLite (em memória), a fila
//// offline e o adaptador de saída (`whatsmeow_http`), que fala HTTP de verdade
//// com uma ponte falsa levantada aqui. Falsa: só a IA.

import adaptadores/config_sqlite
import adaptadores/historico_sqlite
import adaptadores/transacao_sqlite
import adaptadores/usuario_sqlite
import adaptadores/whatsmeow_http
import adaptadores/whatsmeow_webhook
import dominio/erro
import dominio/id_chat.{type IdChat}
import dominio/mensagem
import dominio/transacao.{Entregue}
import gleam/bit_array
import gleam/bytes_tree
import gleam/erlang/process.{type Subject}
import gleam/http/request.{type Request}
import gleam/http/response.{type Response}
import gleam/int
import gleam/list
import gleam/option
import gleam/otp/actor
import gleam/string
import gleeunit/should
import helpers/portas_fake
import mist.{type Connection, type ResponseData}
import portas/ponte_porta
import shell/despachante_ia.{type DespachanteIA}
import shell/fila_atrasadas
import shell/fila_midia
import shell/fila_offline
import shell/metricas
import shell/receptor_whatsapp
import shell/sistema
import shell/tratador/base.{type Portas, Portas}
import sqlight

const token = "token-da-ponte-falsa-com-mais-de-32-caracteres"

const chat = "5531999990000@s.whatsapp.net"

// ---------------------------------------------------------------------------
// Ponte falsa
// ---------------------------------------------------------------------------

type Modo {
  /// Sessão no ar: `/send` responde 200.
  NoAr
  /// Sessão caída: `/send` responde 503 com o código da ponte.
  SessaoFora
}

type Pedido {
  Definir(Modo)
  Obter(Subject(Modo))
}

type Ponte {
  Ponte(url: String, modo: Subject(Pedido), envios: Subject(String))
}

fn iniciar_modo() -> Subject(Pedido) {
  let assert Ok(iniciado) =
    actor.new(NoAr)
    |> actor.on_message(fn(modo, pedido) {
      case pedido {
        Definir(novo) -> actor.continue(novo)
        Obter(resposta) -> {
          process.send(resposta, modo)
          actor.continue(modo)
        }
      }
    })
    |> actor.start
  iniciado.data
}

fn modo_atual(modo: Subject(Pedido)) -> Modo {
  process.call(modo, 1000, Obter)
}

/// Sobe a ponte falsa numa porta livre. Cada `/send` aceito ou recusado chega
/// em `envios` com o texto enviado.
fn iniciar_ponte() -> Ponte {
  let modo = iniciar_modo()
  let envios = process.new_subject()
  let porta = process.new_subject()
  let assert Ok(_) =
    mist.new(fn(req) { tratar_na_ponte(req, modo, envios) })
    |> mist.port(0)
    |> mist.bind("127.0.0.1")
    |> mist.after_start(fn(numero, _, _) { process.send(porta, numero) })
    |> mist.start
  let assert Ok(numero) = process.receive(porta, 2000)
  Ponte(
    url: "http://127.0.0.1:" <> int.to_string(numero),
    modo: modo,
    envios: envios,
  )
}

fn tratar_na_ponte(
  req: Request(Connection),
  modo: Subject(Pedido),
  envios: Subject(String),
) -> Response(ResponseData) {
  case request.get_header(req, ponte_porta.cabecalho_token) {
    Ok(t) if t == token -> tratar_autenticado(req, modo, envios)
    _ -> responder(401, "{\"code\":\"unauthorized\",\"error\":\"token\"}")
  }
}

fn tratar_autenticado(
  req: Request(Connection),
  modo: Subject(Pedido),
  envios: Subject(String),
) -> Response(ResponseData) {
  case req.path, modo_atual(modo) {
    "/health", NoAr -> responder(200, "{\"connected\":true,\"logged_in\":true}")
    "/health", SessaoFora ->
      responder(200, "{\"connected\":false,\"logged_in\":false}")
    "/send", estado -> {
      let assert Ok(lido) = mist.read_body(req, 1024 * 1024)
      let assert Ok(corpo) = bit_array.to_string(lido.body)
      process.send(envios, corpo)
      case estado {
        NoAr -> responder(200, "{\"ok\":true}")
        SessaoFora ->
          responder(
            503,
            "{\"code\":\"whatsapp_disconnected\",\"error\":\"sessão fora\"}",
          )
      }
    }
    // Reações, "digitando" e afins: aceitas sem registro.
    _, _ -> responder(200, "{\"ok\":true}")
  }
}

fn responder(status: Int, corpo: String) -> Response(ResponseData) {
  response.new(status)
  |> response.set_header("content-type", "application/json")
  |> response.set_body(mist.Bytes(bytes_tree.from_string(corpo)))
}

/// Espera o próximo `/send` que contenha `trecho`, ignorando outros envios.
fn esperar_envio(ponte: Ponte, trecho: String) -> String {
  case process.receive(ponte.envios, 5000) {
    Ok(corpo) ->
      case string.contains(corpo, trecho) {
        True -> corpo
        False -> esperar_envio(ponte, trecho)
      }
    Error(Nil) -> panic as { "a ponte não recebeu envio com: " <> trecho }
  }
}

// ---------------------------------------------------------------------------
// Montagem da Amélie
// ---------------------------------------------------------------------------

fn montar(conn: sqlight.Connection, ponte: Ponte, ia: DespachanteIA) -> Portas {
  let conexao = whatsmeow_http.Conexao(url: ponte.url, token: token)
  let assert Ok(fila) = fila_midia.iniciar_todas()
  let assert Ok(met) = metricas.iniciar()
  Portas(
    mensageiro: whatsmeow_http.criar(conexao),
    despachante_ia: ia,
    config: config_sqlite.criar(conn),
    historico: historico_sqlite.criar(conn),
    fila: fila,
    prompts: portas_fake.prompt_noop(),
    metricas: met,
    usuarios: usuario_sqlite.criar(conn),
    grupos: portas_fake.grupo_noop(),
    transacoes: transacao_sqlite.criar(conn),
    provedores_config: portas_fake.provedores_config_ok(),
    anti_spam: portas_fake.anti_spam_ok(),
    spammers: portas_fake.spammer_noop(),
    video_contexto: portas_fake.video_contexto_noop(),
    ponte: whatsmeow_http.criar_ponte(conexao),
  )
}

/// O corpo que a ponte manda ao `/webhook` para uma mensagem de texto.
fn webhook(message_id: String, texto: String) -> BitArray {
  bit_array.from_string(
    "{\"chat_id\":\""
    <> chat
    <> "\",\"from\":\""
    <> chat
    <> "\",\"message_id\":\""
    <> message_id
    <> "\",\"text\":\""
    <> texto
    <> "\",\"ts\":"
    <> int.to_string(sistema.agora_s())
    <> ",\"em_grupo\":false}",
  )
}

/// Uma foto, no formato antigo com os bytes em base64 no próprio JSON (a
/// ponte ainda aceita), para não depender do spool de mídia em disco.
fn webhook_imagem(message_id: String) -> BitArray {
  bit_array.from_string(
    "{\"chat_id\":\""
    <> chat
    <> "\",\"from\":\""
    <> chat
    <> "\",\"message_id\":\""
    <> message_id
    <> "\",\"tipo\":\"imagem\",\"mime\":\"image/jpeg\",\"dados\":\""
    <> bit_array.base64_encode(<<255, 216, 255, 224, 0, 16>>, True)
    <> "\",\"ts\":"
    <> int.to_string(sistema.agora_s())
    <> ",\"em_grupo\":false}",
  )
}

/// O que o `/webhook` faz: decodifica pelo adaptador e despacha pelo receptor.
fn chegar(corpo: BitArray, portas: Portas) -> Nil {
  let assert Ok(entrada) = whatsmeow_webhook.decodificar_webhook(corpo)
  let assert Ok(atrasadas) = fila_atrasadas.iniciar()
  receptor_whatsapp.despachar(entrada, portas, atrasadas)
}

fn id_do_chat() -> IdChat {
  let assert Ok(id) = id_chat.whatsapp(chat)
  id
}

/// Espera a transação do chat chegar a `status` (a entrega roda em outro
/// processo e a auditoria é gravada logo depois do envio).
fn esperar_status(
  portas: Portas,
  status: transacao.StatusTransacao,
  tentativas: Int,
) -> List(transacao.Transacao) {
  let assert Ok(transacoes) = portas.transacoes.obter_por_chat(id_do_chat())
  case list.any(transacoes, fn(tx) { tx.status == status }), tentativas {
    True, _ -> transacoes
    False, 0 -> panic as "transação não chegou ao status esperado"
    False, _ -> {
      process.sleep(20)
      esperar_status(portas, status, tentativas - 1)
    }
  }
}

/// Espera o histórico do chat ter `quantos` turnos e devolve quantos tem.
fn esperar_turnos(portas: Portas, quantos: Int, tentativas: Int) -> Int {
  let assert Ok(turnos) = portas.historico.obter(id_do_chat())
  let n = list.length(turnos)
  case n >= quantos, tentativas {
    True, _ | _, 0 -> n
    False, _ -> {
      process.sleep(20)
      esperar_turnos(portas, quantos, tentativas - 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

pub fn foto_vai_a_ia_e_a_descricao_volta_pela_ponte_test() {
  use conn <- sqlight.with_connection(":memory:")
  let ponte = iniciar_ponte()
  let portas =
    montar(
      conn,
      ponte,
      portas_fake.despachante_ia_ok("Uma xícara de café sobre a mesa."),
    )

  chegar(webhook_imagem("M1"), portas)

  let corpo = esperar_envio(ponte, "xícara de café")
  string.contains(corpo, "\"chat_id\":\"" <> chat <> "\"") |> should.be_true

  // Auditoria: a descrição ficou registrada como entregue.
  let transacoes = esperar_status(portas, Entregue, 100)
  list.any(transacoes, fn(tx) {
    tx.status == Entregue && string.contains(tx.conteudo, "xícara de café")
  })
  |> should.be_true

  // Histórico: a foto e a descrição estão gravadas.
  esperar_turnos(portas, 2, 100) |> should.equal(2)
}

pub fn texto_solto_recebe_a_apresentacao_sem_chamar_a_ia_test() {
  use conn <- sqlight.with_connection(":memory:")
  let ponte = iniciar_ponte()
  // Se a IA fosse chamada, a resposta seria uma mensagem de erro.
  let portas =
    montar(
      conn,
      ponte,
      portas_fake.despachante_ia_erro(erro.ErroIA("não devia ser chamada")),
    )

  chegar(webhook("M2", "Oi, tudo bem?"), portas)

  let corpo = esperar_envio(ponte, "Eu sou a Amélie")
  // Responde citando a mensagem recebida.
  string.contains(corpo, "\"quoted_message_id\":\"M2\"") |> should.be_true
  let _ = esperar_status(portas, Entregue, 100)
  Nil
}

pub fn comando_responde_sem_chamar_a_ia_test() {
  use conn <- sqlight.with_connection(":memory:")
  let ponte = iniciar_ponte()
  // Se a IA fosse chamada, a resposta seria uma mensagem de erro.
  let portas =
    montar(
      conn,
      ponte,
      portas_fake.despachante_ia_erro(erro.ErroIA("não devia ser chamada")),
    )

  chegar(webhook("M5", ".ajuda"), portas)

  let _ = esperar_envio(ponte, ".reset")
  // Espera a auditoria antes de a conexão com o banco fechar.
  let _ = esperar_status(portas, Entregue, 100)
  Nil
}

pub fn resposta_espera_a_sessao_voltar_e_sai_pela_fila_offline_test() {
  use conn <- sqlight.with_connection(":memory:")
  let ponte = iniciar_ponte()
  let portas =
    montar(conn, ponte, portas_fake.despachante_ia_ok("Resposta guardada."))
  process.send(ponte.modo, Definir(SessaoFora))

  chegar(webhook_imagem("M3"), portas)

  // A ponte recusou: a resposta fica pendente, não se perde.
  let _ = esperar_envio(ponte, "Resposta guardada.")
  let _ = esperar_status(portas, transacao.Pendente, 100)

  // A sessão volta e a fila offline faz o reenvio.
  process.send(ponte.modo, Definir(NoAr))
  let assert Ok(fila) =
    fila_offline.iniciar(portas.transacoes, portas.mensageiro, portas.ponte, 3)
  process.send(fila, fila_offline.ProcessarPendentes)

  let _ = esperar_envio(ponte, "Resposta guardada.")
  let _ = esperar_status(portas, Entregue, 100)
  Nil
}

// Garante que o tipo de conteúdo decodificado é o de texto (e não comando),
// para o primeiro cenário exercitar o caminho da IA.
pub fn webhook_de_texto_chega_como_texto_test() {
  let assert Ok(entrada) =
    whatsmeow_webhook.decodificar_webhook(webhook("M4", "Oi"))
  entrada.msg.corpo |> should.equal(mensagem.Texto("Oi"))
  entrada.arquivo |> should.equal(option.None)
}
