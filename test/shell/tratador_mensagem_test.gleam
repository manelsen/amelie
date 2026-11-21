import core/anti_spam as core_anti_spam
import dominio/erro
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{Mensagem}

import dominio/video_contexto.{VideoContexto}
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/option.{Some}
import gleam/string
import gleeunit/should
import helpers/fixtures
import helpers/portas_fake
import portas/historico_porta
import portas/ia_porta
import shell/despachante_ia
import shell/fila_midia
import shell/metricas
import shell/tratador/base
import shell/tratador_mensagem

@external(erlang, "amelie_ffi", "now_ms")
fn now_ms() -> Int

fn met() {
  let assert Ok(m) = metricas.iniciar()
  m
}

fn spam() {
  portas_fake.anti_spam_ok()
}

pub fn tratar_texto_simples_retorna_ok_test() {
  let msg = fixtures.mensagem_texto("Olá!")
  let portas =
    portas_fake.portas_ok(fixtures.config_padrao(), "Olá! Posso ajudar.")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok
}

pub fn tratar_texto_envia_para_whatsapp_test() {
  let ref = process.new_subject()
  let cfg = fixtures.config_padrao()
  let msg = fixtures.mensagem_texto("teste")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref),
      despachante_ia: portas_fake.despachante_ia_ok("resposta esperada"),
      config: portas_fake.config_ok(cfg),
      historico: portas_fake.historico_com_midia(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let _ = tratador_mensagem.tratar(msg, portas)
  // Verifica que whatsapp recebeu a mensagem
  let received = process.receive(ref, 1000)
  received |> should.be_ok
  let assert Ok(#(chat_id, texto)) = received
  chat_id |> should.equal(fixtures.chat_id())
  texto |> should.equal("resposta esperada")
}

pub fn tratar_texto_frio_sem_midia_orienta_usuario_test() {
  let ref = process.new_subject()
  let cfg = fixtures.config_padrao()
  let msg = fixtures.mensagem_texto("me dá um conselho")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref),
      despachante_ia: portas_fake.despachante_ia_ok("resposta esperada"),
      config: portas_fake.config_ok(cfg),
      historico: portas_fake.historico_vazio(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let _ = tratador_mensagem.tratar(msg, portas)
  let received = process.receive(ref, 1000)
  received |> should.be_ok
  let assert Ok(#(chat_id, texto)) = received
  chat_id |> should.equal(fixtures.chat_id())
  should.be_true(string.contains(texto, "especializada na análise"))
}

pub fn tratar_texto_marca_transacao_entregue_test() {
  let ref = process.new_subject()
  let msg = fixtures.mensagem_texto("teste")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_ok(),
      despachante_ia: portas_fake.despachante_ia_ok("resposta esperada"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_capturar(ref),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok
  let assert Ok(portas_fake.Registrada(_)) = process.receive(ref, 1000)
  let assert Ok(portas_fake.MarcadaEntregue(1)) = process.receive(ref, 1000)
}

/// Envio que falha fica na fila offline: sem erro para quem chamou e, por
/// isso, sem o "tente novamente" que gerava resposta duplicada.
pub fn tratar_texto_falha_fica_na_fila_test() {
  let ref = process.new_subject()
  let msg = fixtures.mensagem_texto("teste")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_erro(erro.ErroComunicacao("offline")),
      despachante_ia: portas_fake.despachante_ia_ok("resposta esperada"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_capturar(ref),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok
  let assert Ok(portas_fake.Registrada(_)) = process.receive(ref, 1000)
  let assert Ok(portas_fake.ErroAtualizado(1, _, 1)) =
    process.receive(ref, 1000)
}

pub fn tratar_erro_config_retorna_erro_test() {
  let msg = fixtures.mensagem_texto("Olá")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_ok(),
      despachante_ia: portas_fake.despachante_ia_ok("ok"),
      config: portas_fake.config_erro(erro.ErroBancoDados("DB offline")),
      historico: portas_fake.historico_vazio(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_error
}

pub fn tratar_erro_ia_retorna_erro_test() {
  let msg = fixtures.mensagem_texto("Olá")
  let fila = case fila_midia.iniciar_todas() {
    Ok(f) -> f
    Error(_) -> panic as "fila"
  }
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_ok(),
      despachante_ia: portas_fake.despachante_ia_erro(erro.ErroIA("timeout")),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_com_midia(),
      fila: fila,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_error
}

pub fn tratar_imagem_enfileira_midia_test() {
  let msg = fixtures.mensagem_imagem()
  let portas = portas_fake.portas_ok(fixtures.config_padrao(), "ok")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok
}

pub fn tratar_imagem_desativada_retorna_ok_test() {
  let msg = fixtures.mensagem_imagem()
  let portas = portas_fake.portas_ok(fixtures.config_midia_off(), "ok")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok
}

pub fn extrair_trace_id_test() {
  let msg_com_id = fixtures.mensagem_texto("com id")
  base.extrair_trace_id(msg_com_id)
  |> should.equal("MSG00")

  // ID longo típico do WhatsApp (ex: 3EB02...)
  let msg_whatsapp =
    Mensagem(..msg_com_id, message_id: option.Some("3EB0286653E6E8F95418C0"))
  base.extrair_trace_id(msg_whatsapp)
  |> should.equal("3EB02")

  let msg_sem_id = Mensagem(..msg_com_id, message_id: option.None)
  base.extrair_trace_id(msg_sem_id)
  |> should.equal(string.slice(
    "req_"
      <> int.to_string(msg_sem_id.timestamp)
      <> "_"
      <> id_chat.para_texto(msg_sem_id.remetente),
    0,
    5,
  ))
}

pub fn tratar_com_rate_limit_envia_aviso_ao_usuario_test() {
  let ref = process.new_subject()
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref),
      despachante_ia: portas_fake.despachante_ia_ok("resposta"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )

  // Além do balde e da dívida de mídia adiada (10 + 20), a 31ª foto recebe
  // o aviso.
  enviar_fotos(portas, 31)

  // Aguarda e busca a mensagem que contém o aviso de rate limit
  let aviso = buscar_aviso(ref)
  should.be_true(string.contains(aviso, "Calma lá"))
}

pub fn atrasadas_em_lote_nao_recebem_aviso_de_spam_test() {
  let ref = process.new_subject()
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref),
      despachante_ia: portas_fake.despachante_ia_ok("resposta"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )

  let img1 =
    Mensagem(..fixtures.mensagem_imagem(), message_id: option.Some("IMG_1"))
  let img2 =
    Mensagem(..fixtures.mensagem_imagem(), message_id: option.Some("IMG_2"))
  let img3 =
    Mensagem(..fixtures.mensagem_imagem(), message_id: option.Some("IMG_3"))

  // As mesmas 3 imagens, chegando juntas depois de a Amélie voltar ao ar.
  let _ = tratador_mensagem.tratar_atrasada(img1, portas)
  let _ = tratador_mensagem.tratar_atrasada(img2, portas)
  let _ = tratador_mensagem.tratar_atrasada(img3, portas)

  sem_aviso_de_spam(ref) |> should.be_true
}

fn sem_aviso_de_spam(ref: process.Subject(#(IdChat, String))) -> Bool {
  case process.receive(ref, 300) {
    Error(Nil) -> True
    Ok(#(_chat_id, texto)) ->
      !string.contains(texto, "Calma lá") && sem_aviso_de_spam(ref)
  }
}

fn buscar_aviso(ref: process.Subject(#(IdChat, String))) -> String {
  let assert Ok(#(_chat_id, texto)) = process.receive(ref, 1000)
  case string.contains(texto, "Calma lá") {
    True -> texto
    False -> buscar_aviso(ref)
  }
}

pub fn tratar_com_unban_admin_test() {
  let ref = process.new_subject()
  let spam_actor = spam()
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref),
      despachante_ia: portas_fake.despachante_ia_ok("resposta"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam_actor,
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )

  // Mensagem de admin executando .unban
  let msg = fixtures.mensagem_comando("unban", "551199999999")
  let _ = tratador_mensagem.tratar(msg, portas)

  // Não sendo admin configurado no env, rejeita com comando restrito
  let assert Ok(#(_chat_id, texto)) = process.receive(ref, 1000)
  should.be_true(string.contains(texto, "restrito ao administrador"))
}

pub fn tratar_com_rate_limit_registra_incidente_spammer_test() {
  let ref_msg = process.new_subject()
  let ref_spam = process.new_subject()
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref_msg),
      despachante_ia: portas_fake.despachante_ia_ok("resposta"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_vazio(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_capturar(ref_spam),
      video_contexto: portas_fake.video_contexto_noop(),
      ponte: portas_fake.ponte_inacessivel(),
    )

  // Além do balde e da dívida de mídia adiada (10 + 20), a 31ª foto recebe
  // o aviso.
  enviar_fotos(portas, 31)

  let assert Ok(evento) = process.receive(ref_spam, 1000)
  case evento {
    portas_fake.IncidenteRegistrado(chat_id, _remetente, tel, motivo, strike) -> {
      chat_id |> should.equal(fixtures.chat_id())
      strike |> should.equal(1)
      string.contains(motivo, "Calma lá") |> should.be_true
      string.contains(tel, "+55") |> should.be_true
    }
  }
}

pub fn tratar_followup_video_ativo_responde_e_decrementa_test() {
  let ref_envio = process.new_subject()
  let ref_video = process.new_subject()
  let agora_s = now_ms() / 1000
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files/vid123",
      perguntas_restantes: 2,
      criado_em: agora_s - 10,
    )
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref_envio),
      despachante_ia: portas_fake.despachante_ia_ok(
        "O carro no vídeo é vermelho.",
      ),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_com_midia(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_capturar(Some(ctx), ref_video),
      ponte: portas_fake.ponte_inacessivel(),
    )

  let msg = fixtures.mensagem_texto("Que cor é o carro?")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok

  let assert Ok(#(chat_id, texto)) = process.receive(ref_envio, 1000)
  chat_id |> should.equal(fixtures.chat_id())
  texto |> should.equal("O carro no vídeo é vermelho.")

  let assert Ok(portas_fake.VideoObtido(_)) = process.receive(ref_video, 1000)
  let assert Ok(portas_fake.VideoPerguntasDecrementadas(_)) =
    process.receive(ref_video, 1000)
}

pub fn tratar_followup_video_expirado_limpa_e_responde_normalmente_test() {
  let ref_envio = process.new_subject()
  let ref_video = process.new_subject()
  let agora_s = now_ms() / 1000
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files/vid123",
      perguntas_restantes: 2,
      criado_em: agora_s - 2000,
    )
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref_envio),
      despachante_ia: portas_fake.despachante_ia_ok("resposta normal"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_com_midia(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_capturar(Some(ctx), ref_video),
      ponte: portas_fake.ponte_inacessivel(),
    )

  let msg = fixtures.mensagem_texto("Que cor é o carro?")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok

  let assert Ok(#(_chat_id, texto)) = process.receive(ref_envio, 1000)
  // A pergunta segue como conversa normal em vez de virar só um aviso.
  texto |> should.equal("resposta normal")

  let assert Ok(portas_fake.VideoObtido(_)) = process.receive(ref_video, 1000)
  let assert Ok(portas_fake.VideoRemovido(_)) = process.receive(ref_video, 1000)
}

pub fn tratar_followup_video_esgotado_limpa_e_responde_normalmente_test() {
  let ref_envio = process.new_subject()
  let ref_video = process.new_subject()
  let agora_s = now_ms() / 1000
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files/vid123",
      perguntas_restantes: 0,
      criado_em: agora_s - 60,
    )
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref_envio),
      despachante_ia: portas_fake.despachante_ia_ok("resposta normal"),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_com_midia(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_capturar(Some(ctx), ref_video),
      ponte: portas_fake.ponte_inacessivel(),
    )

  let msg = fixtures.mensagem_texto("Que cor é o carro?")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok

  let assert Ok(#(_chat_id, texto)) = process.receive(ref_envio, 1000)
  // A pergunta segue como conversa normal em vez de virar só um aviso.
  texto |> should.equal("resposta normal")

  let assert Ok(portas_fake.VideoObtido(_)) = process.receive(ref_video, 1000)
  let assert Ok(portas_fake.VideoRemovido(_)) = process.receive(ref_video, 1000)
}

pub fn tratar_followup_video_zera_perguntas_remove_arquivo_test() {
  let ref_envio = process.new_subject()
  let ref_video = process.new_subject()
  let agora_s = now_ms() / 1000
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files/vid123",
      perguntas_restantes: 1,
      criado_em: agora_s - 10,
    )
  let portas =
    base.Portas(
      mensageiro: portas_fake.mensageiro_capturar(ref_envio),
      despachante_ia: portas_fake.despachante_ia_ok(
        "Última resposta sobre o vídeo.",
      ),
      config: portas_fake.config_ok(fixtures.config_padrao()),
      historico: portas_fake.historico_com_midia(),
      fila: fila_midia.iniciar_todas() |> should.be_ok,
      prompts: portas_fake.prompt_noop(),
      metricas: met(),
      usuarios: portas_fake.usuario_noop(),
      grupos: portas_fake.grupo_noop(),
      transacoes: portas_fake.transacao_noop(),
      provedores_config: portas_fake.provedores_config_ok(),
      anti_spam: spam(),
      spammers: portas_fake.spammer_noop(),
      video_contexto: portas_fake.video_contexto_capturar(Some(ctx), ref_video),
      ponte: portas_fake.ponte_inacessivel(),
    )

  let msg = fixtures.mensagem_texto("Última dúvida?")
  let result = tratador_mensagem.tratar(msg, portas)
  result |> should.be_ok

  let assert Ok(#(_chat_id, texto)) = process.receive(ref_envio, 1000)
  texto |> should.equal("Última resposta sobre o vídeo.")

  let assert Ok(portas_fake.VideoObtido(_)) = process.receive(ref_video, 1000)
  let assert Ok(portas_fake.VideoPerguntasDecrementadas(_)) =
    process.receive(ref_video, 1000)
  let assert Ok(portas_fake.VideoRemovido(_)) = process.receive(ref_video, 1000)
}

fn portas_com_video(ref, despachante, video_contexto) -> base.Portas {
  let assert Ok(fila) = fila_midia.iniciar_todas()
  base.Portas(
    mensageiro: portas_fake.mensageiro_capturar(ref),
    despachante_ia: despachante,
    config: portas_fake.config_ok(fixtures.config_padrao()),
    historico: portas_fake.historico_com_midia(),
    fila: fila,
    prompts: portas_fake.prompt_noop(),
    metricas: met(),
    usuarios: portas_fake.usuario_noop(),
    grupos: portas_fake.grupo_noop(),
    transacoes: portas_fake.transacao_noop(),
    provedores_config: portas_fake.provedores_config_ok(),
    anti_spam: spam(),
    spammers: portas_fake.spammer_noop(),
    video_contexto: video_contexto,
    ponte: portas_fake.ponte_inacessivel(),
  )
}

pub fn falha_no_video_encerra_contexto_e_responde_sem_ele_test() {
  let ref = process.new_subject()
  let eventos = process.new_subject()
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files.google.com/v",
      perguntas_restantes: 2,
      criado_em: now_ms() / 1000,
    )
  let ia_sem_video =
    ia_porta.IAPorta(
      ..portas_fake.ia_ok("resposta sem vídeo"),
      processar_video: fn(_, _, _) { Error(erro.ErroIA("arquivo sumiu")) },
    )
  let portas =
    portas_com_video(
      ref,
      despachante_ia.DespachanteIA(
        gemini: ia_sem_video,
        openrouter: ia_sem_video,
      ),
      portas_fake.video_contexto_capturar(Some(ctx), eventos),
    )

  tratador_mensagem.tratar(fixtures.mensagem_texto("e o final?"), portas)
  |> should.be_ok

  process.receive(ref, 1000)
  |> should.equal(Ok(#(fixtures.chat_id(), "resposta sem vídeo")))
  // O contexto quebrado foi removido: a próxima mensagem não falha de novo.
  receber_ate(eventos, portas_fake.VideoRemovido(fixtures.chat_id()))
  |> should.be_true
}

fn receber_ate(sub, alvo) -> Bool {
  case process.receive(sub, 500) {
    Ok(ev) if ev == alvo -> True
    Ok(_) -> receber_ate(sub, alvo)
    Error(_) -> False
  }
}

fn enviar_fotos(portas: base.Portas, n: Int) -> Nil {
  list.each(de_1_a(n), fn(i) {
    let foto =
      Mensagem(
        ..fixtures.mensagem_imagem(),
        message_id: option.Some("IMG_" <> int.to_string(i)),
      )
    let _ = tratador_mensagem.tratar(foto, portas)
    Nil
  })
}

/// [1, 2, ..., n]
fn de_1_a(n: Int) -> List(Int) {
  list.index_map(list.repeat(Nil, n), fn(_, i) { i + 1 })
}

pub fn album_maior_que_o_balde_e_adiado_com_um_aviso_test() {
  let ref = process.new_subject()
  let ref_spam = process.new_subject()
  let portas =
    base.Portas(
      ..portas_fake.portas_ok(fixtures.config_padrao(), "Uma foto."),
      mensageiro: portas_fake.mensageiro_capturar(ref),
      anti_spam: spam(),
      spammers: portas_fake.spammer_capturar(ref_spam),
    )

  // 10 cabem no balde; a 11ª e a 12ª ficam adiadas.
  enviar_fotos(portas, 12)

  let avisos = coletar_textos(ref, [])
  list.filter(avisos, fn(t) { t == core_anti_spam.aviso_midias_adiadas })
  |> list.length
  |> should.equal(1)
  list.any(avisos, fn(t) { string.contains(t, "Calma lá") }) |> should.be_false
  // Adiar não é incidente de spam.
  process.receive(ref_spam, 100) |> should.be_error
}

fn coletar_textos(
  ref: process.Subject(#(IdChat, String)),
  acc: List(String),
) -> List(String) {
  case process.receive(ref, 500) {
    Ok(#(_, texto)) -> coletar_textos(ref, [texto, ..acc])
    Error(Nil) -> list.reverse(acc)
  }
}

// ---------------------------------------------------------------------------
// Histórico enviado à IA e gravado depois da entrega
// ---------------------------------------------------------------------------

fn portas_com_historico(ref, despachante, historico) -> base.Portas {
  base.Portas(
    ..portas_com_video(ref, despachante, portas_fake.video_contexto_noop()),
    historico: historico,
  )
}

fn historico_que_nao_grava() -> historico_porta.HistoricoPorta {
  historico_porta.HistoricoPorta(
    ..portas_fake.historico_com_midia(),
    adicionar: fn(_, _) { Error(erro.ErroBancoDados("disco cheio")) },
  )
}

fn conversa_longa(n: Int) -> List(mensagem.Turno) {
  list.flat_map(de_1_a(n), fn(i) {
    let s = int.to_string(i)
    [
      mensagem.TurnoUsuario("[imagem] pergunta " <> s),
      mensagem.TurnoAssistente("resposta " <> s),
    ]
  })
}

pub fn ia_recebe_historico_uma_vez_e_limitado_test() {
  let envios = process.new_subject()
  let chamadas = process.new_subject()
  let ia =
    ia_porta.IAPorta(
      ..portas_fake.ia_ok("ok"),
      gerar_texto: fn(prompt, hist, _) {
        process.send(chamadas, #(prompt, hist))
        Ok("ok")
      },
    )
  let cfg = fixtures.config_padrao()
  let portas =
    portas_com_historico(
      envios,
      despachante_ia.DespachanteIA(gemini: ia, openrouter: ia),
      portas_fake.historico_com(conversa_longa(30)),
    )

  tratador_mensagem.tratar(fixtures.mensagem_texto("e agora?"), portas)
  |> should.be_ok

  let assert Ok(#(prompt, hist)) = process.receive(chamadas, 1000)
  { list.length(hist) <= cfg.historico_max } |> should.be_true
  list.first(hist)
  |> should.equal(Ok(mensagem.TurnoUsuario("[imagem] pergunta 26")))
  list.last(hist) |> should.equal(Ok(mensagem.TurnoAssistente("resposta 30")))
  // O histórico vai só como turnos: o texto do prompt não o repete.
  string.contains(prompt, "resposta 30") |> should.be_false
  string.contains(prompt, "pergunta 30") |> should.be_false
  string.contains(prompt, "e agora?") |> should.be_true
}

pub fn falha_ao_gravar_historico_depois_da_entrega_nao_avisa_erro_test() {
  let envios = process.new_subject()
  let portas =
    portas_com_historico(
      envios,
      portas_fake.despachante_ia_ok("resposta certa"),
      historico_que_nao_grava(),
    )

  tratador_mensagem.tratar(fixtures.mensagem_texto("e agora?"), portas)
  |> should.be_ok

  // Só a resposta certa: nada de "ocorreu um erro" depois dela.
  coletar_textos(envios, []) |> should.equal(["resposta certa"])
}

pub fn falha_ao_gravar_historico_no_followup_de_video_nao_avisa_erro_test() {
  let envios = process.new_subject()
  let eventos = process.new_subject()
  let ctx =
    VideoContexto(
      chat_id: fixtures.chat_id(),
      uri: "https://files.google.com/v",
      perguntas_restantes: 2,
      criado_em: now_ms() / 1000,
    )
  let portas =
    base.Portas(
      ..portas_com_video(
        envios,
        portas_fake.despachante_ia_ok("sobre o vídeo"),
        portas_fake.video_contexto_capturar(Some(ctx), eventos),
      ),
      historico: historico_que_nao_grava(),
    )

  tratador_mensagem.tratar(fixtures.mensagem_texto("e o final?"), portas)
  |> should.be_ok

  coletar_textos(envios, []) |> should.equal(["sobre o vídeo"])
}
