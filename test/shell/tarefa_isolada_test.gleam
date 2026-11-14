import gleam/erlang/process
import gleam/list
import gleeunit/should
import shell/tarefa_isolada

pub fn tarefa_normal_termina_test() {
  tarefa_isolada.executar(fn() { Nil }, 1000)
  |> should.equal(tarefa_isolada.Terminou)
}

pub fn tarefa_instantanea_nunca_parece_quebrada_test() {
  // A tarefa pode terminar antes de quem chama passar a vigiá-la; isso não
  // pode virar Quebrou.
  list.repeat(Nil, 2000)
  |> list.each(fn(_) {
    tarefa_isolada.executar(fn() { Nil }, 1000)
    |> should.equal(tarefa_isolada.Terminou)
  })
}

pub fn tarefa_que_quebra_nao_derruba_quem_chama_test() {
  tarefa_isolada.executar(fn() { panic as "falha simulada" }, 1000)
  |> should.equal(tarefa_isolada.Quebrou)
}

pub fn tarefa_travada_estoura_e_morre_test() {
  let ref = process.new_subject()
  tarefa_isolada.executar(
    fn() {
      // Bem acima do limite de 20 ms: numa máquina ocupada, 200 ms chegavam
      // a passar antes de a tarefa ser encerrada.
      process.sleep(1000)
      process.send(ref, Nil)
    },
    20,
  )
  |> should.equal(tarefa_isolada.Estourou)
  // Encerrada: o envio de depois da espera nunca acontece.
  process.receive(ref, 1200) |> should.be_error
}

pub fn tarefa_morre_junto_com_quem_chama_test() {
  // Um ator reiniciado não pode ter o job antigo correndo junto com o novo.
  let comecou = process.new_subject()
  let terminou = process.new_subject()
  let chamador =
    process.spawn_unlinked(fn() {
      tarefa_isolada.executar(
        fn() {
          process.send(comecou, Nil)
          process.sleep(200)
          process.send(terminou, Nil)
        },
        10_000,
      )
    })
  // Só mata quem chama depois que a tarefa de fato começou.
  let assert Ok(Nil) = process.receive(comecou, 1000)
  process.kill(chamador)
  process.receive(terminou, 400) |> should.be_error
}
