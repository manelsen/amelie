import gleam/erlang/process
import gleam/option.{Some}
import gleeunit/should
import helpers/portas_fake
import shell/arvore_supervisao
import shell/cache_ia
import shell/disjuntor
import shell/manutencao
import shell/metricas

pub fn arvore_supervisao_inicializacao_test() {
  let transacoes = portas_fake.transacao_noop()
  let mensageiro = portas_fake.mensageiro_ok()

  let assert Ok(#(_sup, procs)) =
    arvore_supervisao.iniciar(
      transacoes,
      mensageiro,
      portas_fake.ponte_inacessivel(),
    )

  // 1. Circuit breaker responde normalmente
  disjuntor.pode_executar(procs.cb_gemini) |> should.be_true
  disjuntor.pode_executar(procs.cb_openrouter) |> should.be_true

  // 2. Cache IA armazena e recupera
  cache_ia.guardar(procs.cache_gemini, "chave_teste", "valor_teste")
  cache_ia.obter(procs.cache_gemini, "chave_teste")
  |> should.equal(Some("valor_teste"))

  // 3. Métricas acumulam
  metricas.registrar(procs.metricas, metricas.MensagensProcessadas)
  let estado_metricas = metricas.consultar(procs.metricas)
  estado_metricas.mensagens |> should.equal(1)

  // 4. Manutenção supervisionada responde a comando sob demanda
  manutencao.executar_agora(procs.manutencao)
}

pub fn arvore_supervisao_recuperacao_apos_crash_test() {
  let transacoes = portas_fake.transacao_noop()
  let mensageiro = portas_fake.mensageiro_ok()

  let assert Ok(#(_sup, procs)) =
    arvore_supervisao.iniciar(
      transacoes,
      mensageiro,
      portas_fake.ponte_inacessivel(),
    )

  // Registra métrica inicial
  metricas.registrar(procs.metricas, metricas.MensagensProcessadas)
  { metricas.consultar(procs.metricas) }.mensagens |> should.equal(1)

  // Obtém o PID do processo atual
  let assert Ok(pid_antigo) = process.subject_owner(procs.metricas)

  // Simula um crash fatal no worker
  process.kill(pid_antigo)

  // Verifica que o supervisor OneForOne recriou o processo com um novo PID.
  // Espera ativa, não tempo fixo: numa máquina ocupada o reinício passa de
  // 100 ms e o teste falhava sem haver defeito.
  let assert Ok(pid_novo) = esperar_novo_dono(procs.metricas, pid_antigo, 200)
  { pid_antigo == pid_novo } |> should.be_false

  // O subject nomeado continua funcionando normalmente!
  metricas.registrar(procs.metricas, metricas.MensagensProcessadas)
  { metricas.consultar(procs.metricas) }.mensagens |> should.equal(1)
}

pub fn arvore_supervisao_isolamento_de_falhas_test() {
  let transacoes = portas_fake.transacao_noop()
  let mensageiro = portas_fake.mensageiro_ok()

  let assert Ok(#(_sup, procs)) =
    arvore_supervisao.iniciar(
      transacoes,
      mensageiro,
      portas_fake.ponte_inacessivel(),
    )

  // Salva dado no cache
  cache_ia.guardar(procs.cache_gemini, "teste_isolamento", "dado_protegido")

  // Mata o circuit breaker
  let assert Ok(pid_cb) = process.subject_owner(procs.cb_gemini)
  process.kill(pid_cb)

  // Espera o supervisor recriar o disjuntor (ver `esperar_novo_dono`).
  let assert Ok(_) = esperar_novo_dono(procs.cb_gemini, pid_cb, 200)

  // O cache permaneceu intacto e o dado ainda existe
  cache_ia.obter(procs.cache_gemini, "teste_isolamento")
  |> should.equal(Some("dado_protegido"))

  // E o circuit breaker foi reiniciado
  disjuntor.pode_executar(procs.cb_gemini) |> should.be_true
}

/// Até `tentativas` × 10 ms pelo dono do subject nomeado, diferente de `antigo`.
fn esperar_novo_dono(
  subject: process.Subject(m),
  antigo: process.Pid,
  tentativas: Int,
) -> Result(process.Pid, Nil) {
  case process.subject_owner(subject) {
    Ok(pid) if pid != antigo -> Ok(pid)
    _ if tentativas <= 0 -> Error(Nil)
    _ -> {
      process.sleep(10)
      esperar_novo_dono(subject, antigo, tentativas - 1)
    }
  }
}
