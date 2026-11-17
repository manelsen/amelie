import core/prompt/montador
import dominio/config.{Longo}
import dominio/mensagem
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import helpers/fixtures

pub fn montar_inclui_texto_usuario_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("Qual é a capital do Brasil?", cfg)
  string.contains(prompt, "Qual é a capital do Brasil?") |> should.be_true
}

pub fn montar_inclui_prompt_padrao_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("teste", cfg)
  string.contains(prompt, "Amélie") |> should.be_true
}

pub fn montar_inclui_idioma_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("teste", cfg)
  string.contains(prompt, "pt-BR") |> should.be_true
}

pub fn montar_usa_prompt_personalizado_test() {
  let cfg = fixtures.config_com_prompt()
  let prompt = montador.montar("teste", cfg)
  string.contains(prompt, "assistente de testes") |> should.be_true
}

pub fn montar_nao_repete_o_historico_no_texto_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("nova pergunta", cfg)
  string.contains(prompt, "Amélie: ") |> should.be_false
  string.contains(prompt, "Usuário: nova pergunta") |> should.be_true
}

pub fn montar_historico_vazio_sem_separador_extra_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("só isso", cfg)
  string.starts_with(prompt, "\n\n") |> should.be_false
}

pub fn montar_para_imagem_sem_prompt_personalizado_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_imagem(cfg, None)
  string.contains(prompt, "imagem") |> should.be_true
}

pub fn montar_para_imagem_com_prompt_personalizado_test() {
  let cfg = fixtures.config_com_prompt()
  let prompt = montador.montar_para_imagem(cfg, None)
  string.contains(prompt, "assistente de testes") |> should.be_true
  string.contains(prompt, "imagem") |> should.be_true
}

pub fn montar_para_audio_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_audio(cfg)
  string.contains(prompt, "áudio") |> should.be_true
}

pub fn montar_para_video_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_video(cfg, None)
  string.contains(prompt, "vídeo") |> should.be_true
  string.contains(prompt, "TRANSCRIÇÃO OBRIGATÓRIA DAS FALAS E ÁUDIO")
  |> should.be_true
  string.contains(prompt, "NÃO resuma as falas") |> should.be_true
  string.contains(prompt, "NUNCA deduza ou invente falas") |> should.be_true
}

pub fn montar_para_video_sem_audio_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_video_com_audio(cfg, None, False)
  string.contains(prompt, "vídeo") |> should.be_true
  string.contains(prompt, "MUDO ou uma animação/GIF SEM ÁUDIO")
  |> should.be_true
  string.contains(prompt, "NÃO invente, não deduza e não alucine falas")
  |> should.be_true
  string.contains(prompt, "Não faça NENHUMA menção a som")
  |> should.be_true
}

pub fn montar_para_documento_sem_prompt_personalizado_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_documento(cfg, None)
  string.contains(prompt, "documento") |> should.be_true
}

pub fn montar_para_documento_com_prompt_personalizado_test() {
  let cfg = fixtures.config_com_prompt()
  let prompt = montador.montar_para_documento(cfg, None)
  string.contains(prompt, "assistente de testes") |> should.be_true
  string.contains(prompt, "documento") |> should.be_true
}

pub fn montar_para_sticker_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_sticker(cfg, None)
  string.contains(prompt, "sticker") |> should.be_true
  string.contains(prompt, "Audiodescrição do sticker") |> should.be_true
}

pub fn montar_para_sticker_com_contexto_test() {
  let cfg = fixtures.config_padrao()
  let prompt =
    montador.montar_para_sticker(
      cfg,
      Some("figurinha animada com personagem sorrindo"),
    )
  string.contains(prompt, "Contexto do sticker") |> should.be_true
  string.contains(prompt, "personagem sorrindo") |> should.be_true
}

pub fn montar_para_sticker_animado_test() {
  let cfg = fixtures.config_padrao()
  let prompt =
    montador.montar_para_sticker_animado(cfg, Some("figurinha/sticker animada"))
  string.contains(prompt, "sticker animado") |> should.be_true
  string.contains(prompt, "animação inteira") |> should.be_true
  string.contains(prompt, "Audiodescrição do sticker") |> should.be_true
}

// Testes para modo de descrição
pub fn montar_para_imagem_modo_longo_test() {
  let cfg = config.Config(..fixtures.config_padrao(), modo_descricao: Longo)
  let prompt = montador.montar_para_imagem(cfg, None)
  string.contains(prompt, "completa e detalhada") |> should.be_true
}

pub fn montar_para_imagem_modo_curto_test() {
  let cfg = fixtures.config_padrao()
  // curto is default
  let prompt = montador.montar_para_imagem(cfg, None)
  string.contains(prompt, "concisa e objetiva") |> should.be_true
}

// Testes para legenda
pub fn montar_para_legenda_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_legenda(cfg)
  string.contains(prompt, "legendas") |> should.be_true
  string.contains(prompt, "surdas") |> should.be_true
}

// Testes para caption (legenda da mídia)
pub fn montar_para_imagem_com_caption_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_imagem(cfg, Some("descreva as roupas"))
  string.contains(prompt, "descreva as roupas") |> should.be_true
  string.contains(prompt, "foco em") |> should.be_true
}

fn turnos(n: Int) -> List(mensagem.Turno) {
  int.range(from: n, to: 0, with: [], run: fn(acc, i) { [i, ..acc] })
  |> list.flat_map(fn(i) {
    let s = int.to_string(i)
    [
      mensagem.TurnoUsuario("pergunta " <> s),
      mensagem.TurnoAssistente("resposta " <> s),
    ]
  })
}

pub fn historico_para_ia_guarda_os_ultimos_max_turnos_test() {
  montador.historico_para_ia(turnos(20), 4)
  |> should.equal([
    mensagem.TurnoUsuario("pergunta 19"),
    mensagem.TurnoAssistente("resposta 19"),
    mensagem.TurnoUsuario("pergunta 20"),
    mensagem.TurnoAssistente("resposta 20"),
  ])
}

pub fn historico_para_ia_comeca_por_turno_do_usuario_test() {
  // Max ímpar corta no meio de um par: a resposta solta do início sai.
  montador.historico_para_ia(turnos(20), 3)
  |> should.equal([
    mensagem.TurnoUsuario("pergunta 20"),
    mensagem.TurnoAssistente("resposta 20"),
  ])
}

pub fn historico_para_ia_curto_fica_inteiro_test() {
  montador.historico_para_ia(turnos(2), 50) |> should.equal(turnos(2))
}

pub fn historico_para_ia_max_zero_ou_negativo_e_vazio_test() {
  montador.historico_para_ia(turnos(3), 0) |> should.equal([])
  montador.historico_para_ia(turnos(3), -1) |> should.equal([])
}

pub fn followup_video_respeita_max_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_followup_video(cfg, turnos(20), "e o final?")
  string.contains(prompt, "pergunta 1\n") |> should.be_false
  string.contains(prompt, "pergunta 20") |> should.be_true
}

pub fn montar_inclui_diretrizes_de_voz_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar("olá", cfg)
  string.contains(prompt, "sintetizadores de voz") |> should.be_true
  string.contains(prompt, "barras verticais") |> should.be_true
}

pub fn montar_para_documento_inclui_regras_acessibilidade_e_financeiras_test() {
  let cfg = fixtures.config_padrao()
  let prompt = montador.montar_para_documento(cfg, None)
  string.contains(prompt, "boleto bancário") |> should.be_true
  string.contains(prompt, "vencimento") |> should.be_true
  string.contains(prompt, "código de barras") |> should.be_true
  string.contains(prompt, "PIX") |> should.be_true
  string.contains(prompt, "sintetizador de voz") |> should.be_true
  string.contains(prompt, "Descrição do documento") |> should.be_true
  string.contains(prompt, "Fim da descrição") |> should.be_true
}
