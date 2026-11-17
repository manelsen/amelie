// Comandos administrativos. A autorização já foi feita por
// tratador_mensagem.executar_acao: aqui só chegam pedidos do admin.

import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import gleam/bool
import gleam/int
import gleam/list
import gleam/string
import portas/ponte_porta.{type PontePorta, StatusPonte}
import shell/anti_spam
import shell/metricas
import shell/sistema
import shell/tratador/base.{type Portas, avisar}

pub fn solicitar_pareamento(
  chat_id: IdChat,
  args: String,
  portas: Portas,
) -> Result(Nil, Erro) {
  use <- bool.lazy_guard(whatsapp_conectado(portas.ponte), fn() {
    avisar(
      chat_id,
      "✅ O WhatsApp já está conectado e funcionando perfeitamente!",
      portas,
    )
  })
  case telefone_informado(args) {
    "" ->
      avisar(
        chat_id,
        "⚠️ WhatsApp desconectado. Por favor, informe seu número com DDD.\nEx: `/parear 5531999990000`",
        portas,
      )
    numero ->
      case portas.ponte.pedir_codigo_pareamento(numero) {
        Ok(codigo) ->
          avisar(
            chat_id,
            "📱 *Código de pareamento gerado:*\n`"
              <> codigo
              <> "` (para +"
              <> numero
              <> ")\n\n"
              <> "👉 *No WhatsApp do seu celular:*\n"
              <> "Aparelhos conectados > Conectar com número de telefone > Digite o código.",
            portas,
          )
        Error(motivo) ->
          avisar(chat_id, "❌ Falha ao gerar pairing code: " <> motivo, portas)
      }
  }
}

fn whatsapp_conectado(ponte: PontePorta) -> Bool {
  case ponte.checar_status() {
    Ok(StatusPonte(_, True)) -> True
    _ -> False
  }
}

/// O telefone passado no comando ou, sem ele, o MOBILE_NUMBER configurado.
fn telefone_informado(args: String) -> String {
  case string.trim(args) {
    "" -> sistema.ler_env_ou("MOBILE_NUMBER", "")
    numero -> numero
  }
}

pub fn consultar_status(chat_id: IdChat, portas: Portas) -> Result(Nil, Erro) {
  let status_wa = case portas.ponte.checar_status() {
    Ok(StatusPonte(_, True)) -> "🟢 Conectado"
    Ok(StatusPonte(_, False)) -> "🟡 Desconectado (aguardando login)"
    Error(_) -> "🔴 Inacessível"
  }
  let estado = metricas.consultar(portas.metricas)
  let total_midias =
    estado.imagens
    + estado.audios
    + estado.videos
    + estado.documentos
    + estado.stickers

  avisar(
    chat_id,
    "📊 *Painel Administrativo — Amélie*\n\n"
      <> "*Canais de Mensageria:*\n"
      <> "• *WhatsApp:* "
      <> status_wa
      <> "\n"
      <> "• *Telegram:* 🟢 Ativo (Poller operacional)\n\n"
      <> "*Métricas BEAM:*\n"
      <> "• Memória total: `"
      <> int.to_string(metricas.memoria_total_mb())
      <> " MB`\n"
      <> "• Memória processos: `"
      <> int.to_string(metricas.memoria_processos_mb())
      <> " MB`\n"
      <> "• Processos OTP: `"
      <> int.to_string(metricas.contagem_processos())
      <> "`\n\n"
      <> "*Mensagens & Mídia:*\n"
      <> "• Mensagens processadas: `"
      <> int.to_string(estado.mensagens)
      <> "`\n"
      <> "• Erros registrados: `"
      <> int.to_string(estado.erros)
      <> "`\n"
      <> "• Mídias processadas: `"
      <> int.to_string(total_midias)
      <> "`\n"
      <> "• Chats em quarentena (anti-spam): `"
      <> case anti_spam.contar_silenciados(portas.anti_spam) {
      Ok(qtd) -> int.to_string(qtd)
      Error(Nil) -> "indisponível"
    }
      <> "`",
    portas,
  )
}

pub fn resetar_whatsapp(
  chat_id: IdChat,
  args: String,
  portas: Portas,
) -> Result(Nil, Erro) {
  let tel = telefone_informado(args)
  case portas.ponte.resetar_sessao(tel) {
    Ok(Nil) -> {
      let texto = case tel {
        "" ->
          "🔄 *Reset do WhatsApp iniciado!*\n\nSessão anterior desconectada e dados locais limpos.\nPara parear um novo celular, execute: `/parear <telefone>`"
        num ->
          "🔄 *Reset do WhatsApp iniciado!*\n\nSessão anterior desconectada e dados locais limpos para o número `+"
          <> num
          <> "`.\nUm novo código de pareamento será enviado aqui em instantes."
      }
      avisar(chat_id, texto, portas)
    }
    Error(motivo) ->
      avisar(
        chat_id,
        "❌ Falha ao solicitar reset do WhatsApp: " <> motivo,
        portas,
      )
  }
}

pub fn desbloquear_chat(
  chat_id: IdChat,
  alvo: String,
  portas: Portas,
) -> Result(Nil, Erro) {
  case string.trim(alvo) {
    "" ->
      avisar(
        chat_id,
        "⚠️ Informe o chat_id a ser desbloqueado.\nEx: `.unban 5531999990000`",
        portas,
      )
    alvo_id ->
      case anti_spam.desbloquear(portas.anti_spam, alvo_id) {
        Ok(True) ->
          avisar(
            chat_id,
            "✅ Chat `" <> alvo_id <> "` desbloqueado com sucesso!",
            portas,
          )
        Error(Nil) ->
          avisar(
            chat_id,
            "⚠️ Anti-spam indisponível no momento (reiniciando). Tente de novo em instantes.",
            portas,
          )
        Ok(False) ->
          avisar(
            chat_id,
            "ℹ️ O chat `" <> alvo_id <> "` não estava em quarentena ou bloqueio.",
            portas,
          )
      }
  }
}

pub fn consultar_spammers(chat_id: IdChat, portas: Portas) -> Result(Nil, Erro) {
  let texto = case portas.spammers.listar_top(10) {
    Ok([]) -> "🛡️ *Anti-Spam:* Nenhum incidente registrado no banco de dados."
    Ok(lista) ->
      "🛡️ *Spammers Registrados (Top 10):*\n\n"
      <> {
        lista
        |> list.map(fn(spammer) {
          "• `"
          <> spammer.telefone
          <> "` — "
          <> int.to_string(spammer.total_incidentes)
          <> " ocorrência(s) (strike máx: "
          <> int.to_string(spammer.ultimo_strike)
          <> ")"
        })
        |> string.join("\n")
      }
      <> "\n\n💡 Use `.unban <chat_id_ou_telefone>` para liberar."
    Error(_) -> "Erro ao consultar spammers no banco de dados."
  }
  avisar(chat_id, texto, portas)
}
