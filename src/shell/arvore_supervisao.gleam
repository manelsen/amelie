// shell/arvore_supervisao.gleam
// Árvore de supervisão OTP para os atores de suporte do shell da Amélie.
// Garante auto-recuperação transparente (let it crash) com estratégia OneForOne
// e subjects nomeados (named_subject) para comunicação estável entre reinícios.

import dominio/id_chat.{type IdChat}
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None}
import gleam/otp/actor
import gleam/otp/static_supervisor
import portas/mensageiro_porta.{type MensageiroPorta}
import portas/ponte_porta.{type PontePorta}
import portas/transacao_porta.{type TransacaoPorta}
import shell/anti_spam
import shell/avisos_ia
import shell/cache_ia
import shell/disjuntor
import shell/fila_atrasadas
import shell/fila_midia
import shell/fila_offline
import shell/manutencao
import shell/metricas

pub type ProcessosSupervisionados {
  ProcessosSupervisionados(
    cb_gemini: Subject(disjuntor.Mensagem),
    cb_openrouter: Subject(disjuntor.Mensagem),
    cache_gemini: Subject(cache_ia.MensagemCache),
    cache_openrouter: Subject(cache_ia.MensagemCache),
    metricas: Subject(metricas.MensagemMetrica),
    fila: fila_midia.FilasMidia,
    fila_offline: Subject(fila_offline.Mensagem),
    fila_atrasadas: fila_atrasadas.FilaAtrasadas,
    manutencao: Subject(manutencao.MensagemManutencao),
    anti_spam: Subject(anti_spam.MensagemAntiSpam),
  )
}

pub fn iniciar(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
) -> Result(
  #(static_supervisor.Supervisor, ProcessosSupervisionados),
  actor.StartError,
) {
  iniciar_completo(
    transacoes,
    mensageiro,
    ponte,
    manutencao.intervalo_padrao_ms,
    None,
  )
}

pub fn iniciar_com_intervalo_manutencao(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
  intervalo_manutencao_ms: Int,
) -> Result(
  #(static_supervisor.Supervisor, ProcessosSupervisionados),
  actor.StartError,
) {
  iniciar_completo(transacoes, mensageiro, ponte, intervalo_manutencao_ms, None)
}

pub fn iniciar_completo(
  transacoes: TransacaoPorta,
  mensageiro: MensageiroPorta,
  ponte: PontePorta,
  intervalo_manutencao_ms: Int,
  admin_chat_id: Option(IdChat),
) -> Result(
  #(static_supervisor.Supervisor, ProcessosSupervisionados),
  actor.StartError,
) {
  let name_cb_gemini = process.new_name("amelie_cb_gemini")
  let name_cb_openrouter = process.new_name("amelie_cb_openrouter")
  let name_cache_gemini = process.new_name("amelie_cache_gemini")
  let name_cache_openrouter = process.new_name("amelie_cache_openrouter")
  let name_metricas = process.new_name("amelie_metricas")
  let name_fila_img = process.new_name("amelie_fila_imagem")
  let name_fila_aud = process.new_name("amelie_fila_audio")
  let name_fila_vid = process.new_name("amelie_fila_video")
  let name_fila_doc = process.new_name("amelie_fila_documento")
  let name_fila_stk = process.new_name("amelie_fila_sticker")
  let name_fila_offline = process.new_name("amelie_fila_offline")
  let name_fila_atrasadas = process.new_name("amelie_fila_atrasadas")
  let name_manutencao = process.new_name("amelie_manutencao")
  let name_anti_spam = process.new_name("amelie_anti_spam")

  let procs =
    ProcessosSupervisionados(
      cb_gemini: process.named_subject(name_cb_gemini),
      cb_openrouter: process.named_subject(name_cb_openrouter),
      cache_gemini: process.named_subject(name_cache_gemini),
      cache_openrouter: process.named_subject(name_cache_openrouter),
      metricas: process.named_subject(name_metricas),
      fila: fila_midia.FilasMidia(
        imagem: process.named_subject(name_fila_img),
        audio: process.named_subject(name_fila_aud),
        video: process.named_subject(name_fila_vid),
        documento: process.named_subject(name_fila_doc),
        sticker: process.named_subject(name_fila_stk),
      ),
      fila_offline: process.named_subject(name_fila_offline),
      fila_atrasadas: process.named_subject(name_fila_atrasadas),
      manutencao: process.named_subject(name_manutencao),
      anti_spam: process.named_subject(name_anti_spam),
    )

  let builder =
    static_supervisor.new(static_supervisor.OneForOne)
    |> static_supervisor.restart_tolerance(intensity: 5, period: 10)
    |> static_supervisor.add(disjuntor.supervisionado(
      name_cb_gemini,
      avisos_ia.notificador("Gemini", mensageiro, admin_chat_id),
    ))
    |> static_supervisor.add(disjuntor.supervisionado(
      name_cb_openrouter,
      avisos_ia.notificador("OpenRouter", mensageiro, admin_chat_id),
    ))
    |> static_supervisor.add(cache_ia.supervisionado(name_cache_gemini))
    |> static_supervisor.add(cache_ia.supervisionado(name_cache_openrouter))
    |> static_supervisor.add(metricas.supervisionado(name_metricas))
    |> static_supervisor.add(fila_midia.supervisionado_um(name_fila_img))
    |> static_supervisor.add(fila_midia.supervisionado_um(name_fila_aud))
    |> static_supervisor.add(fila_midia.supervisionado_um(name_fila_vid))
    |> static_supervisor.add(fila_midia.supervisionado_um(name_fila_doc))
    |> static_supervisor.add(fila_midia.supervisionado_um(name_fila_stk))
    |> static_supervisor.add(fila_offline.supervisionado(
      transacoes,
      mensageiro,
      ponte,
      3,
      name_fila_offline,
    ))
    |> static_supervisor.add(fila_atrasadas.supervisionado(name_fila_atrasadas))
    |> static_supervisor.add(manutencao.supervisionado(
      transacoes,
      intervalo_manutencao_ms,
      name_manutencao,
    ))
    |> static_supervisor.add(anti_spam.supervisionado(
      name_anti_spam,
      admin_chat_id,
    ))

  case static_supervisor.start(builder) {
    Ok(started) -> Ok(#(started.data, procs))
    Error(err) -> Error(err)
  }
}
