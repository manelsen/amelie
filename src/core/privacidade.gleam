// Privacidade em log. Puro — não faz IO.

import dominio/id_chat.{type IdChat}
import gleam/list
import gleam/string

/// Mascara o identificador de um usuário para log: telefone, JID do WhatsApp
/// (com ou sem agente/dispositivo), ID de grupo ou ID do Telegram (`tg:`).
/// Mantém os 4 primeiros e os 4 últimos caracteres do usuário e o servidor,
/// para correlacionar linhas de log sem expor o identificador inteiro.
/// Mesma regra de `maskID` na ponte Go, mais o prefixo `tg:`.
pub fn mascarar_id(id: String) -> String {
  case string.starts_with(id, "tg:") {
    True -> "tg:" <> mascarar_jid(string.drop_start(id, 3))
    False -> mascarar_jid(id)
  }
}

/// `mascarar_id` sobre a forma textual de um IdChat.
pub fn mascarar(id: IdChat) -> String {
  mascarar_id(id_chat.para_texto(id))
}

fn mascarar_jid(id: String) -> String {
  let #(local, sufixo_servidor) = case string.split_once(id, "@") {
    Ok(#(local, servidor)) -> #(local, "@" <> servidor)
    Error(Nil) -> #(id, "")
  }
  let #(usuario, resto) =
    local
    |> string.to_graphemes
    |> list.split_while(fn(g) { g != "." && g != ":" })
  let usuario = string.concat(usuario)
  let resto = mascarar_resto(string.concat(resto))
  let tamanho = string.length(usuario)
  let mascarado = case tamanho > 8 {
    True ->
      string.slice(usuario, 0, 4)
      <> "****"
      <> string.slice(usuario, tamanho - 4, 4)
    False -> "****"
  }
  mascarado <> resto <> sufixo_servidor
}

/// Sufixo de agente/dispositivo (`:12`, `.0:12`) é curto e fica visível. Qualquer
/// outra coisa depois do separador (texto de exibição como "Telegram: 987654321")
/// é mascarada, para nunca devolver um identificador inteiro.
fn mascarar_resto(resto: String) -> String {
  let sem_separador = string.drop_start(resto, 1)
  let curto =
    string.length(resto) <= 6
    && list.all(string.to_graphemes(resto), fn(g) {
      string.contains(".:0123456789", g)
    })
  case resto, curto {
    "", _ -> ""
    _, True -> resto
    _, False ->
      string.slice(resto, 0, 1) <> mascarar_jid(string.trim(sem_separador))
  }
}
