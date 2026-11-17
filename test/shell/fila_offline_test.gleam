// Testes do ciclo de retry da fila offline.

import dominio/erro
import dominio/transacao as t
import gleam/erlang/process
import gleam/list
import gleam/option.{None, Some}
import gleeunit/should
import helpers/fixtures
import helpers/portas_fake
import portas/mensageiro_porta.{MensageiroPorta}
import portas/ponte_porta.{StatusPonte}
import portas/transacao_porta.{type TransacaoPorta, TransacaoPorta}
import shell/fila_offline
import shell/sistema

fn ponte_ok() {
  portas_fake.ponte_com_status(StatusPonte(conectado: True, logado: True))
}

fn ponte_deslogada() {
  portas_fake.ponte_com_status(StatusPonte(conectado: True, logado: False))
}

fn tx_pendente(id: Int, tentativas: Int) -> t.Transacao {
  t.Transacao(
    id: Some(id),
    chat_id: fixtures.id("chat1@c.us"),
    remetente: "amelie",
    tipo: "texto",
    conteudo: "mensagem pendente",
    status: t.Falha,
    criado_em: 0,
    atualizado_em: None,
    tentativas: tentativas,
    erro: None,
  )
}

// ---------------------------------------------------------------------------
// Retry com sucesso
// ---------------------------------------------------------------------------

pub fn retry_sucesso_marca_entregue_test() {
  let ref_entregue = process.new_subject()
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(_, _) { Ok(Nil) },
      atualizar_erro: fn(_, _, _) { Ok(Nil) },
      obter_pendentes: fn() { Ok([tx_pendente(99, 1)]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(id) {
        process.send(ref_entregue, id)
        Ok(Nil)
      },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) { Ok(Nil) },
      enviar_citando: fn(_, _, _, _) { Ok(Nil) },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 3)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  let assert Ok(id) = process.receive(ref_entregue, 100)
  id |> should.equal(99)
}

// ---------------------------------------------------------------------------
// Retry com falha
// ---------------------------------------------------------------------------

pub fn retry_falha_atualiza_tentativas_test() {
  let ref_erro = process.new_subject()
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(_, _) { Ok(Nil) },
      atualizar_erro: fn(id, _msg, tentativas) {
        process.send(ref_erro, #(id, tentativas))
        Ok(Nil)
      },
      obter_pendentes: fn() { Ok([tx_pendente(5, 1)]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(_) { Ok(Nil) },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) { Error(erro.ErroComunicacao("offline")) },
      enviar_citando: fn(_, _, _, _) { Error(erro.ErroComunicacao("offline")) },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 3)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  let assert Ok(#(id, tentativas)) = process.receive(ref_erro, 100)
  id |> should.equal(5)
  tentativas |> should.equal(2)
}

// ---------------------------------------------------------------------------
// Descarte após máximo de tentativas
// ---------------------------------------------------------------------------

pub fn retry_descarta_apos_max_tentativas_test() {
  let ref_status = process.new_subject()
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(id, status) {
        process.send(ref_status, #(id, status))
        Ok(Nil)
      },
      atualizar_erro: fn(_, _, _) { Ok(Nil) },
      obter_pendentes: fn() { Ok([tx_pendente(3, 3)]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(_) { Ok(Nil) },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) { Error(erro.ErroComunicacao("offline")) },
      enviar_citando: fn(_, _, _, _) { Error(erro.ErroComunicacao("offline")) },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 3)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  let assert Ok(#(id, status)) = process.receive(ref_status, 100)
  id |> should.equal(3)
  status |> should.equal(t.Descartada)
}

// ---------------------------------------------------------------------------
// Sem pendentes
// ---------------------------------------------------------------------------

pub fn sem_pendentes_nao_envia_test() {
  let ref_enviou = process.new_subject()
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(_, _) { Ok(Nil) },
      atualizar_erro: fn(_, _, _) { Ok(Nil) },
      obter_pendentes: fn() { Ok([]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(_) { Ok(Nil) },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) {
        process.send(ref_enviou, True)
        Ok(Nil)
      },
      enviar_citando: fn(_, _, _, _) { Ok(Nil) },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 3)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  process.receive(ref_enviou, 50) |> should.be_error
}

// ---------------------------------------------------------------------------
// Transação sem id é ignorada
// ---------------------------------------------------------------------------

pub fn tx_sem_id_e_ignorada_test() {
  let ref_enviou = process.new_subject()
  let tx_sem_id =
    t.Transacao(
      id: None,
      chat_id: fixtures.id("chat1@c.us"),
      remetente: "amelie",
      tipo: "texto",
      conteudo: "órfã",
      status: t.Falha,
      criado_em: 0,
      atualizado_em: None,
      tentativas: 0,
      erro: None,
    )
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(_, _) { Ok(Nil) },
      atualizar_erro: fn(_, _, _) { Ok(Nil) },
      obter_pendentes: fn() { Ok([tx_sem_id]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(_) { Ok(Nil) },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) {
        process.send(ref_enviou, True)
        Ok(Nil)
      },
      enviar_citando: fn(_, _, _, _) { Ok(Nil) },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 3)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  process.receive(ref_enviou, 50) |> should.be_error
}

// ---------------------------------------------------------------------------
// Classificação de erro definitivo e descarte imediato
// ---------------------------------------------------------------------------

pub fn classificacao_erro_definitivo_test() {
  // Transitórios (não definitivos)
  fila_offline.e_erro_definitivo(erro.ErroComunicacao("offline"))
  |> should.be_false
  fila_offline.e_erro_definitivo(erro.ErroTimeout("chamada http"))
  |> should.be_false
  fila_offline.e_erro_definitivo(erro.ErroBancoDados("locked"))
  |> should.be_false
  fila_offline.e_erro_definitivo(erro.ErroIA("503 indisponível"))
  |> should.be_false

  // Definitivos (devem ser descartados)
  fila_offline.e_erro_definitivo(erro.ErroValidacao("campo", "invalido"))
  |> should.be_true
  fila_offline.e_erro_definitivo(erro.ErroNaoAutorizado)
  |> should.be_true
  fila_offline.e_erro_definitivo(erro.ErroComunicacao(
    "whatsmeow retornou status 400 [invalid_chat_id]",
  ))
  |> should.be_true
  fila_offline.e_erro_definitivo(erro.ErroComunicacao(
    "Telegram: 403 Forbidden: bot was blocked by the user",
  ))
  |> should.be_true
}

pub fn retry_descarta_imediatamente_em_erro_definitivo_test() {
  let ref_status = process.new_subject()
  let transacoes =
    TransacaoPorta(
      registrar: fn(tx) { Ok(tx) },
      atualizar_status: fn(id, status) {
        process.send(ref_status, #(id, status))
        Ok(Nil)
      },
      atualizar_erro: fn(_, _, _) { Ok(Nil) },
      obter_pendentes: fn() { Ok([tx_pendente(7, 1)]) },
      obter_por_chat: fn(_) { Ok([]) },
      marcar_entregue: fn(_) { Ok(Nil) },
      limpar_antigas: fn() { Ok(Nil) },
      foi_recebida: fn(_, _) { Ok(False) },
      marcar_recebida: fn(_, _) { Ok(Nil) },
    )
  let mensageiro =
    MensageiroPorta(
      enviar: fn(_, _) {
        Error(erro.ErroComunicacao(
          "whatsmeow: [invalid_chat_id] destinatario inexistente",
        ))
      },
      enviar_citando: fn(_, _, _, _) {
        Error(erro.ErroComunicacao("whatsmeow: [invalid_chat_id]"))
      },
      reagir: fn(_, _, _, _) { Ok(Nil) },
    )

  // tentativas_max é 5, mas deve descartar NA PRIMEIRA tentativa pois o erro é definitivo!
  let assert Ok(fila) =
    fila_offline.iniciar(transacoes, mensageiro, ponte_ok(), 5)
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)

  let assert Ok(#(id, status)) = process.receive(ref_status, 100)
  id |> should.equal(7)
  status |> should.equal(t.Descartada)
}

// ---------------------------------------------------------------------------
// Sessão do WhatsApp fora do ar
// ---------------------------------------------------------------------------

const erro_logout = "whatsmeow retornou status 503 [whatsapp_logged_out]: sessão removida pelo WhatsApp"

pub fn classificacao_erro_sessao_test() {
  fila_offline.e_erro_sessao(erro.ErroComunicacao(erro_logout))
  |> should.be_true
  fila_offline.e_erro_sessao(erro.ErroComunicacao(
    "whatsmeow retornou status 503 [whatsapp_disconnected]: websocket fechado",
  ))
  |> should.be_true
  fila_offline.e_erro_sessao(erro.ErroComunicacao(
    "whatsmeow retornou status 400 [invalid_chat_id]",
  ))
  |> should.be_false
  fila_offline.e_erro_sessao(erro.ErroTimeout("[whatsapp_disconnected]"))
  |> should.be_false

  // Sessão fora do ar não é motivo para descartar a resposta.
  fila_offline.e_erro_definitivo(erro.ErroComunicacao(erro_logout))
  |> should.be_false
}

type Evento {
  Enviou
  AtualizouErro(id: Int, tentativas: Int)
  AtualizouStatus(id: Int, status: t.StatusTransacao)
}

fn transacoes_capturar(
  ref: process.Subject(Evento),
  pendentes: List(t.Transacao),
) -> TransacaoPorta {
  TransacaoPorta(
    registrar: fn(tx) { Ok(tx) },
    atualizar_status: fn(id, status) {
      process.send(ref, AtualizouStatus(id, status))
      Ok(Nil)
    },
    atualizar_erro: fn(id, _, tentativas) {
      process.send(ref, AtualizouErro(id, tentativas))
      Ok(Nil)
    },
    obter_pendentes: fn() { Ok(pendentes) },
    obter_por_chat: fn(_) { Ok([]) },
    marcar_entregue: fn(_) { Ok(Nil) },
    limpar_antigas: fn() { Ok(Nil) },
    foi_recebida: fn(_, _) { Ok(False) },
    marcar_recebida: fn(_, _) { Ok(Nil) },
  )
}

fn mensageiro_capturar(
  ref: process.Subject(Evento),
  resultado: Result(Nil, erro.Erro),
) {
  MensageiroPorta(
    enviar: fn(_, _) {
      process.send(ref, Enviou)
      resultado
    },
    enviar_citando: fn(_, _, _, _) { resultado },
    reagir: fn(_, _, _, _) { Ok(Nil) },
  )
}

fn processar(
  pendentes: List(t.Transacao),
  ponte,
  envio: Result(Nil, erro.Erro),
) -> List(Evento) {
  let ref = process.new_subject()
  let assert Ok(fila) =
    fila_offline.iniciar(
      transacoes_capturar(ref, pendentes),
      mensageiro_capturar(ref, envio),
      ponte,
      3,
    )
  process.send(fila, fila_offline.ProcessarPendentes)
  process.sleep(50)
  coletar(ref, [])
}

fn coletar(ref: process.Subject(Evento), acc: List(Evento)) -> List(Evento) {
  case process.receive(ref, 20) {
    Ok(evento) -> coletar(ref, [evento, ..acc])
    Error(_) -> list.reverse(acc)
  }
}

pub fn sessao_fora_do_ar_nao_envia_nem_gasta_tentativa_test() {
  let tx = t.Transacao(..tx_pendente(11, 2), criado_em: sistema.agora_s())

  processar([tx], ponte_deslogada(), Ok(Nil))
  |> should.equal([])
}

pub fn ponte_inacessivel_tambem_aguarda_test() {
  let tx = t.Transacao(..tx_pendente(12, 0), criado_em: sistema.agora_s())

  processar([tx], portas_fake.ponte_inacessivel(), Ok(Nil))
  |> should.equal([])
}

pub fn sessao_fora_do_ar_alem_do_prazo_descarta_test() {
  let criado_em = sistema.agora_s() - fila_offline.prazo_espera_sessao_s - 60
  let tx = t.Transacao(..tx_pendente(13, 1), criado_em: criado_em)

  processar([tx], ponte_deslogada(), Ok(Nil))
  |> should.equal([AtualizouErro(13, 1), AtualizouStatus(13, t.Descartada)])
}

pub fn sessao_fora_do_ar_nao_segura_telegram_test() {
  let tx =
    t.Transacao(
      ..tx_pendente(14, 0),
      chat_id: fixtures.id("tg:123"),
      criado_em: sistema.agora_s(),
    )

  processar([tx], ponte_deslogada(), Ok(Nil))
  |> should.equal([Enviou])
}

pub fn erro_de_sessao_no_reenvio_nao_gasta_tentativa_test() {
  // A ponte disse que estava de pé, mas a sessão caiu antes do envio.
  processar(
    [tx_pendente(15, 2)],
    ponte_ok(),
    Error(erro.ErroComunicacao(erro_logout)),
  )
  |> should.equal([Enviou, AtualizouErro(15, 2)])
}

pub fn falha_trava_o_chat_no_ciclo_mas_nao_os_outros_test() {
  // Duas partes de uma resposta e uma transação de outro chat. A primeira
  // parte falha: a segunda não pode sair antes dela; o outro chat segue.
  let parte1 = tx_pendente(21, 0)
  let parte2 = tx_pendente(22, 0)
  let outro = t.Transacao(..tx_pendente(23, 0), chat_id: fixtures.id("tg:999"))

  processar(
    [parte1, parte2, outro],
    ponte_ok(),
    Error(erro.ErroComunicacao("telegram status 502")),
  )
  |> should.equal([Enviou, AtualizouErro(21, 1), Enviou, AtualizouErro(23, 1)])
}

pub fn sessao_fora_ve_o_prazo_de_todas_as_do_chat_test() {
  // Com a sessão fora nada sai do chat, então a ordem não trava o ciclo:
  // as duas vencidas são descartadas agora, não só a primeira.
  let vencida = sistema.agora_s() - fila_offline.prazo_espera_sessao_s - 60
  let a = t.Transacao(..tx_pendente(31, 0), criado_em: vencida)
  let b = t.Transacao(..tx_pendente(32, 0), criado_em: vencida)

  processar([a, b], ponte_deslogada(), Ok(Nil))
  |> should.equal([
    AtualizouErro(31, 0),
    AtualizouStatus(31, t.Descartada),
    AtualizouErro(32, 0),
    AtualizouStatus(32, t.Descartada),
  ])
}

// ---------------------------------------------------------------------------
// Laço de agendamento
// ---------------------------------------------------------------------------

// Com a fila sem dono (reiniciando), o laço não morre nem derruba quem o
// disparou; quando o nome volta a ter dono, os pedidos voltam a chegar.
pub fn laco_sobrevive_a_nome_sem_dono_test() {
  let nome = process.new_name("fila_offline_ausente")
  let fila = process.named_subject(nome)

  let laco = fila_offline.agendar_processamento(fila, 10)
  // Algumas voltas com o nome sem dono.
  process.sleep(50)
  process.is_alive(laco) |> should.be_true

  let assert Ok(Nil) = process.register(process.self(), nome)
  process.receive(fila, 1000)
  |> should.equal(Ok(fila_offline.ProcessarPendentes))

  process.kill(laco)
  let _ = process.unregister(nome)
  Nil
}
