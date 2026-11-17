import adaptadores/historico_sqlite
import dominio/mensagem.{TurnoAssistente, TurnoUsuario}
import gleam/int
import gleam/list
import gleeunit/should
import helpers/fixtures
import sqlight

pub fn adicionar_e_obter_em_ordem_test() {
  use conn <- sqlight.with_connection("file:hist_ordem?mode=memory")
  let porta = historico_sqlite.criar(conn)
  let chat = fixtures.id("chat_ordem@c.us")

  porta.adicionar(chat, TurnoUsuario("oi")) |> should.be_ok
  porta.adicionar(chat, TurnoAssistente("olá")) |> should.be_ok

  porta.obter(chat)
  |> should.equal(Ok([TurnoUsuario("oi"), TurnoAssistente("olá")]))
}

pub fn guarda_so_os_turnos_mais_novos_de_cada_chat_test() {
  use conn <- sqlight.with_connection("file:hist_poda?mode=memory")
  let porta = historico_sqlite.criar(conn)
  let chat = fixtures.id("chat_poda@c.us")
  let outro = fixtures.id("chat_outro@c.us")
  let teto = historico_sqlite.turnos_guardados_por_chat

  porta.adicionar(outro, TurnoUsuario("não some")) |> should.be_ok
  int.range(from: 1, to: teto + 6, with: Nil, run: fn(_, i) {
    porta.adicionar(chat, TurnoUsuario(int.to_string(i))) |> should.be_ok
    Nil
  })

  let assert Ok(turnos) = porta.obter(chat)
  list.length(turnos) |> should.equal(teto)
  list.first(turnos) |> should.equal(Ok(TurnoUsuario("6")))
  list.last(turnos)
  |> should.equal(Ok(TurnoUsuario(int.to_string(teto + 5))))
  // A poda é por chat: os outros ficam intactos.
  porta.obter(outro) |> should.equal(Ok([TurnoUsuario("não some")]))
}
