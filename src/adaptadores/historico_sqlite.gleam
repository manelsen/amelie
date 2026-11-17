// Adaptador SQLite para histórico de conversa por chat.
// Implementa HistoricoPorta usando sqlight.

import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{type Turno, TurnoAssistente, TurnoUsuario}
import gleam/dynamic/decode
import gleam/result
import portas/historico_porta.{type HistoricoPorta, HistoricoPorta}
import sqlight

const schema = "CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  papel TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  criado_em INTEGER NOT NULL DEFAULT (unixepoch())
)"

/// Quantos turnos cada chat guarda. O que vai à IA é recortado por
/// `historico_max` (padrão 50) no core; este teto, folgado acima dele, só
/// impede a tabela de crescer sem fim e mantém a leitura de `obter` limitada.
/// `.resumo` resume o que estiver guardado.
pub const turnos_guardados_por_chat = 200

const schema_idx = "CREATE INDEX IF NOT EXISTS idx_historico_chat
  ON historico (chat_id, id)"

pub fn criar(conn: sqlight.Connection) -> HistoricoPorta {
  let _ = sqlight.exec(schema, conn)
  let _ = sqlight.exec(schema_idx, conn)
  HistoricoPorta(
    obter: fn(chat_id) { obter(conn, chat_id) },
    adicionar: fn(chat_id, turno) { adicionar(conn, chat_id, turno) },
    limpar: fn(chat_id) { limpar(conn, chat_id) },
  )
}

fn obter(conn: sqlight.Connection, chat_id: IdChat) -> Result(List(Turno), Erro) {
  let sql =
    "SELECT papel, conteudo FROM historico
     WHERE chat_id = ?
     ORDER BY id ASC"

  sqlight.query(
    sql,
    on: conn,
    with: [sqlight.text(id_chat.para_texto(chat_id))],
    expecting: turno_decoder(),
  )
  |> result.map_error(fn(e) { erro.ErroBancoDados(e.message) })
}

fn turno_decoder() -> decode.Decoder(Turno) {
  use papel <- decode.then(decode.at([0], decode.string))
  use conteudo <- decode.then(decode.at([1], decode.string))
  case papel {
    "usuario" -> decode.success(TurnoUsuario(conteudo))
    _ -> decode.success(TurnoAssistente(conteudo))
  }
}

fn adicionar(
  conn: sqlight.Connection,
  chat_id: IdChat,
  turno: Turno,
) -> Result(Nil, Erro) {
  let sql = "INSERT INTO historico (chat_id, papel, conteudo) VALUES (?, ?, ?)"
  let #(papel, conteudo) = case turno {
    TurnoUsuario(c) -> #("usuario", c)
    TurnoAssistente(c) -> #("assistente", c)
  }

  let chat = sqlight.text(id_chat.para_texto(chat_id))
  sqlight.query(
    sql,
    on: conn,
    with: [chat, sqlight.text(papel), sqlight.text(conteudo)],
    expecting: decode.dynamic,
  )
  |> result.map_error(fn(e) { erro.ErroBancoDados(e.message) })
  |> result.try(fn(_) { podar(conn, chat) })
}

/// Apaga os turnos do chat além dos `turnos_guardados_por_chat` mais novos.
fn podar(conn: sqlight.Connection, chat: sqlight.Value) -> Result(Nil, Erro) {
  let sql =
    "DELETE FROM historico
     WHERE chat_id = ?1
       AND id <= (SELECT id FROM historico WHERE chat_id = ?1
                  ORDER BY id DESC LIMIT 1 OFFSET ?2)"
  sqlight.query(
    sql,
    on: conn,
    with: [chat, sqlight.int(turnos_guardados_por_chat)],
    expecting: decode.dynamic,
  )
  |> result.map(fn(_) { Nil })
  |> result.map_error(fn(e) { erro.ErroBancoDados(e.message) })
}

fn limpar(conn: sqlight.Connection, chat_id: IdChat) -> Result(Nil, Erro) {
  let sql = "DELETE FROM historico WHERE chat_id = ?"
  sqlight.query(
    sql,
    on: conn,
    with: [sqlight.text(id_chat.para_texto(chat_id))],
    expecting: decode.dynamic,
  )
  |> result.map(fn(_) { Nil })
  |> result.map_error(fn(e) { erro.ErroBancoDados(e.message) })
}
