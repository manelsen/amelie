// Acesso ao sistema: relógio, variáveis de ambiente, processos avulsos e
// registro de falhas acessórias. Único ponto do shell que declara essas FFIs;
// os demais módulos importam daqui.

import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import gleam/erlang/process
import gleam/int
import gleam/option.{type Option}
import gleam/result
import logging

/// URL da ponte whatsmeow quando WHATSMEOW_URL não está definida.
pub const url_ponte_padrao = "http://localhost:8080"

@external(erlang, "amelie_ffi", "now_ms")
pub fn agora_ms() -> Int

pub fn agora_s() -> Int {
  agora_ms() / 1000
}

@external(erlang, "amelie_ffi", "get_env")
pub fn ler_env(nome: String) -> Result(String, Nil)

pub fn ler_env_ou(nome: String, padrao: String) -> String {
  ler_env(nome) |> result.unwrap(or: padrao)
}

/// Chat do admin no Telegram; `None` se `TELEGRAM_ADMIN_CHAT_ID` estiver
/// vazio ou não for um número.
pub fn admin_chat_id() -> Option(IdChat) {
  ler_env_ou("TELEGRAM_ADMIN_CHAT_ID", "")
  |> int.parse
  |> result.map(id_chat.telegram)
  |> option.from_result
}

pub fn url_ponte() -> String {
  ler_env_ou("WHATSMEOW_URL", url_ponte_padrao)
}

/// Roda `tarefa` num processo próprio, sem vínculo com quem chamou: uma
/// falha nela não derruba o chamador.
/// Reserva uma vaga num contador global `nome` limitado a `maximo`. Devolve
/// False se não couber; quem reservou devolve a vaga com `liberar_vaga`.
@external(erlang, "amelie_ffi", "reservar_vaga")
pub fn reservar_vaga(nome: String, maximo: Int) -> Bool

@external(erlang, "amelie_ffi", "liberar_vaga")
pub fn liberar_vaga(nome: String) -> Nil

pub fn disparar(tarefa: fn() -> a) -> Nil {
  process.spawn_unlinked(tarefa)
  Nil
}

/// Efeito acessório: a falha não interrompe o fluxo, mas fica no log.
pub fn registrar_falha(resultado: Result(a, Erro), contexto: String) -> Nil {
  case resultado {
    Ok(_) -> Nil
    Error(e) ->
      logging.log(logging.Warning, contexto <> ": " <> erro.descricao(e))
  }
}
