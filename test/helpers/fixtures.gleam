// Fixtures de teste — constantes compartilhadas entre todos os testes.

import dominio/config.{type Config, Config, Curto}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{
  type Mensagem, type Turno, Mensagem, TurnoAssistente, TurnoUsuario,
}
import dominio/provedor
import gleam/option.{None, Some}

@external(erlang, "amelie_ffi", "now_ms")
fn now_ms() -> Int

fn agora_s() -> Int {
  now_ms() / 1000
}

/// IdChat a partir da forma textual (`tg:<n>` ou JID); falha o teste se inválida.
pub fn id(texto: String) -> IdChat {
  let assert Ok(id) = id_chat.de_texto(texto)
  id
}

pub fn chat_id() -> IdChat {
  id("5531999990000@c.us")
}

pub fn remetente() -> IdChat {
  id("5531888880000@c.us")
}

pub fn config_padrao() -> Config {
  Config(
    chat_id: chat_id(),
    provedor: provedor.Gemini,
    modelo: "gemini-3.5-flash-lite",
    historico_max: 10,
    prompt_sistema: None,
    audio_ativo: True,
    imagem_ativo: True,
    video_ativo: True,
    doc_ativo: True,
    legenda_ativo: False,
    idioma: "pt-BR",
    modo_descricao: Curto,
  )
}

pub fn config_com_prompt() -> Config {
  Config(
    ..config_padrao(),
    prompt_sistema: Some("Você é um assistente de testes."),
  )
}

pub fn config_midia_off() -> Config {
  Config(
    ..config_padrao(),
    audio_ativo: False,
    imagem_ativo: False,
    video_ativo: False,
    doc_ativo: False,
  )
}

pub fn mensagem_texto(body: String) -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Texto(body),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn mensagem_comando(nome: String, args: String) -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Comando(nome, args),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn mensagem_imagem() -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Imagem(mime: "image/jpeg", dados: <<255, 216, 255>>),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn mensagem_audio() -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Audio(mime: "audio/ogg; codecs=opus", dados: <<
      79,
      103,
      103,
    >>),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn mensagem_video() -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Video(caminho_temp: "/tmp/video.mp4", mime: "video/mp4"),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn mensagem_sticker() -> Mensagem {
  Mensagem(
    chat_id: chat_id(),
    remetente: remetente(),
    message_id: Some("MSG001"),
    corpo: mensagem.Sticker(mime: "image/webp", dados: <<82, 73, 70, 70>>),
    timestamp: agora_s(),
    em_grupo: False,
    nome_grupo: None,
    menciona_bot: False,
    legenda: None,
  )
}

pub fn historico_vazio() -> List(Turno) {
  []
}

pub fn historico_com_turnos() -> List(Turno) {
  [
    TurnoUsuario("Olá"),
    TurnoAssistente("Olá! Como posso ajudar?"),
    TurnoUsuario("Tudo bem?"),
    TurnoAssistente("Tudo bem! E você?"),
  ]
}

pub fn historico_com_midia() -> List(Turno) {
  [
    TurnoUsuario("[imagem]"),
    TurnoAssistente(
      "Audiodescrição da imagem: Uma xícara de café sobre a mesa.",
    ),
  ]
}
