// Testes do Circuit Breaker e contenção no estado SemiAberto.

import gleam/erlang/process
import gleam/option
import gleeunit/should
import shell/disjuntor.{
  Aberto, Config, Fechado, SemiAberto, iniciar_com_config, obter_estado,
  pode_executar, registrar_falha, registrar_sucesso,
}

pub fn circuito_inicia_fechado_e_permite_execucao_test() {
  let cfg = Config(limite_falhas: 3, reset_ms: 100, timeout_sondagem_ms: 50)
  let assert Ok(cb) = iniciar_com_config(cfg)

  pode_executar(cb) |> should.be_true
  case obter_estado(cb) {
    Fechado(0) -> Nil
    _ -> should.fail()
  }
}

pub fn circuito_abre_apos_atingir_limite_de_falhas_test() {
  let cfg = Config(limite_falhas: 3, reset_ms: 100, timeout_sondagem_ms: 50)
  let assert Ok(cb) = iniciar_com_config(cfg)

  // 1ª falha
  registrar_falha(cb)
  pode_executar(cb) |> should.be_true
  case obter_estado(cb) {
    Fechado(1) -> Nil
    _ -> should.fail()
  }

  // 2ª falha
  registrar_falha(cb)
  pode_executar(cb) |> should.be_true
  case obter_estado(cb) {
    Fechado(2) -> Nil
    _ -> should.fail()
  }

  // 3ª falha -> deve abrir o circuito
  registrar_falha(cb)
  pode_executar(cb) |> should.be_false
  case obter_estado(cb) {
    Aberto(_) -> Nil
    _ -> should.fail()
  }
}

pub fn circuito_bloqueia_durante_resfriamento_test() {
  let cfg = Config(limite_falhas: 2, reset_ms: 100, timeout_sondagem_ms: 50)
  let assert Ok(cb) = iniciar_com_config(cfg)

  registrar_falha(cb)
  registrar_falha(cb)

  // Aberto
  pode_executar(cb) |> should.be_false
  pode_executar(cb) |> should.be_false
}

pub fn semi_aberto_permite_apenas_um_probe_concorrente_test() {
  // Reset rápido de 40ms para teste determinístico
  let cfg = Config(limite_falhas: 2, reset_ms: 40, timeout_sondagem_ms: 200)
  let assert Ok(cb) = iniciar_com_config(cfg)

  registrar_falha(cb)
  registrar_falha(cb)

  // Circuito aberto
  pode_executar(cb) |> should.be_false

  // Aguarda expirar reset_ms
  process.sleep(50)

  // 1ª chamada transiciona para SemiAberto e recebe True (prova única)
  pode_executar(cb) |> should.be_true

  case obter_estado(cb) {
    SemiAberto(probe_em_voo: True, ..) -> Nil
    _ -> should.fail()
  }

  // Chamadas subsequentes concorrentes são bloqueadas enquanto o probe está em voo!
  pode_executar(cb) |> should.be_false
  pode_executar(cb) |> should.be_false

  // Quando o probe reporta sucesso, o circuito fecha e permite todas novamente
  registrar_sucesso(cb)
  case obter_estado(cb) {
    Fechado(0) -> Nil
    _ -> should.fail()
  }
  pode_executar(cb) |> should.be_true
  pode_executar(cb) |> should.be_true
}

pub fn semi_aberto_reabre_em_caso_de_falha_do_probe_test() {
  let cfg = Config(limite_falhas: 2, reset_ms: 40, timeout_sondagem_ms: 200)
  let assert Ok(cb) = iniciar_com_config(cfg)

  registrar_falha(cb)
  registrar_falha(cb)

  process.sleep(50)

  // Primeiro probe liberado
  pode_executar(cb) |> should.be_true

  // Probe falha -> reabre circuito imediatamente
  registrar_falha(cb)
  case obter_estado(cb) {
    Aberto(_) -> Nil
    _ -> should.fail()
  }

  pode_executar(cb) |> should.be_false
}

pub fn semi_aberto_permite_novo_probe_apos_timeout_do_anterior_test() {
  // timeout_sondagem_ms de 30ms
  let cfg = Config(limite_falhas: 2, reset_ms: 40, timeout_sondagem_ms: 30)
  let assert Ok(cb) = iniciar_com_config(cfg)

  registrar_falha(cb)
  registrar_falha(cb)

  process.sleep(50)

  // 1º probe iniciado
  pode_executar(cb) |> should.be_true

  // Bloqueado enquanto em voo
  pode_executar(cb) |> should.be_false

  // Se o probe original sumir ou travar, após timeout_sondagem_ms um novo probe pode tentar
  process.sleep(40)
  pode_executar(cb) |> should.be_true
}

// --- Avisos de transição ---------------------------------------------------

fn transicoes(caixa: process.Subject(disjuntor.Transicao)) -> disjuntor.Aviso {
  disjuntor.avisando(fn(t) { process.send(caixa, t) })
}

pub fn circuito_avisa_quando_abre_e_quando_volta_test() {
  let caixa = process.new_subject()
  let cfg = Config(limite_falhas: 2, reset_ms: 10, timeout_sondagem_ms: 50)
  let assert Ok(iniciado) =
    disjuntor.iniciar_actor(cfg, option.None, transicoes(caixa))
  let cb = iniciado.data

  registrar_falha(cb)
  process.receive(caixa, 30) |> should.be_error
  registrar_falha(cb)
  process.receive(caixa, 100) |> should.equal(Ok(disjuntor.Abriu))

  process.sleep(20)
  // Aberto → SemiAberto não é transição avisada.
  pode_executar(cb) |> should.be_true
  process.receive(caixa, 30) |> should.be_error

  registrar_sucesso(cb)
  let assert Ok(disjuntor.Fechou(fora_ms)) = process.receive(caixa, 100)
  { fora_ms >= 0 } |> should.be_true
}

pub fn prova_que_falha_nao_reavisa_test() {
  let caixa = process.new_subject()
  let cfg = Config(limite_falhas: 1, reset_ms: 10, timeout_sondagem_ms: 50)
  let assert Ok(iniciado) =
    disjuntor.iniciar_actor(cfg, option.None, transicoes(caixa))
  let cb = iniciado.data
  registrar_falha(cb)
  process.receive(caixa, 100) |> should.equal(Ok(disjuntor.Abriu))
  process.sleep(20)
  pode_executar(cb) |> should.be_true
  // SemiAberto → Aberto: continua a mesma queda.
  registrar_falha(cb)
  process.receive(caixa, 50) |> should.be_error
}

pub fn decidir_aviso_segura_oscilacao_test() {
  let inicio = disjuntor.sem_aviso()
  let #(enviar, a1) = disjuntor.decidir_aviso(inicio, disjuntor.Abriu, 1000)
  enviar |> should.equal(option.Some(disjuntor.Abriu))

  let #(enviar, a2) =
    disjuntor.decidir_aviso(a1, disjuntor.Fechou(fora_ms: 0), 61_000)
  enviar |> should.equal(option.Some(disjuntor.Fechou(fora_ms: 60_000)))

  // Caiu de novo 1 min depois de voltar: dentro do intervalo, sem aviso,
  // e o "voltou" dessa queda também fica em silêncio.
  let #(enviar, a3) = disjuntor.decidir_aviso(a2, disjuntor.Abriu, 121_000)
  enviar |> should.equal(option.None)
  let #(enviar, a4) =
    disjuntor.decidir_aviso(a3, disjuntor.Fechou(fora_ms: 0), 181_000)
  enviar |> should.equal(option.None)

  // Passado o intervalo desde o último "voltou", avisa de novo.
  let depois = 61_000 + disjuntor.intervalo_avisos_ms
  let #(enviar, _) = disjuntor.decidir_aviso(a4, disjuntor.Abriu, depois)
  enviar |> should.equal(option.Some(disjuntor.Abriu))
}
