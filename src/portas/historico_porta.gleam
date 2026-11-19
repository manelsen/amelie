import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{type Turno}

pub type HistoricoPorta {
  HistoricoPorta(
    obter: fn(IdChat) -> Result(List(Turno), Erro),
    /// Grava os turnos em ordem, numa operação só: ou entram todos, um
    /// colado ao outro, ou nenhum. Pergunta e resposta vão juntas, para que
    /// duas conversas concorrentes do mesmo chat não se entrelacem.
    adicionar: fn(IdChat, List(Turno)) -> Result(Nil, Erro),
    limpar: fn(IdChat) -> Result(Nil, Erro),
  )
}
