// Despacha comandos. Puro — retorna Acao, não executa efeitos.

import core/validacao
import dominio/acao.{
  type Acao, AlterarModelo, ConsultarSpammers, ConsultarStatus, DesbloquearChat,
  EnviarResposta, LimparHistorico, ResetarWhatsApp, SalvarConfig,
  SnapshotHistorico, SolicitarPareamento,
}
import dominio/config.{type Config, Config, Curto, Longo}
import dominio/erro.{type Erro}

import dominio/provedor
import gleam/string

pub fn executar(
  nome: String,
  args: String,
  config: Config,
) -> Result(List(Acao), Erro) {
  case validacao.normalizar_nome_comando(nome) {
    "ajuda" | "start" -> Ok(ajuda(config))
    "reset" -> Ok(reset(config))
    "resumo" | "snapshot" | "compactar" ->
      Ok([SnapshotHistorico(config.chat_id)])
    "audio" -> toggle("audio", args, config)
    "imagem" -> toggle("imagem", args, config)
    "video" -> toggle("video", args, config)
    "doc" -> toggle("doc", args, config)
    "legenda" -> toggle("legenda", args, config)
    "longo" -> Ok(modo_descricao_cmd(Longo, config))
    "curto" -> Ok(modo_descricao_cmd(Curto, config))
    "cego" -> Ok(cego_cmd(config))
    "modelo" -> Ok(modelo_cmd(args, config))
    "parear" | "pair" | "whatsapp" ->
      Ok([SolicitarPareamento(config.chat_id, args)])
    "status" -> Ok([ConsultarStatus(config.chat_id)])
    "reset_whatsapp" | "reset-whatsapp" ->
      Ok([ResetarWhatsApp(config.chat_id, args)])
    "unban" | "desbloquear" ->
      Ok([DesbloquearChat(config.chat_id, string.trim(args))])
    "spammers" | "bloqueados" -> Ok([ConsultarSpammers(config.chat_id)])
    outro -> Error(erro.ErroComandoDesconhecido(outro))
  }
}

fn ajuda(cfg: Config) -> List(Acao) {
  let texto =
    "*Amélie — Comandos disponíveis*\n\n"
    <> "`.ajuda` — esta mensagem\n"
    <> "`.resumo` — resumir a conversa e compactar histórico\n"
    <> "`.reset` — resetar histórico e configurações\n"
    <> "`.audio` — alternar transcrição de áudio\n"
    <> "`.imagem` — alternar análise de imagem\n"
    <> "`.video` — alternar análise de vídeo\n"
    <> "`.doc` — alternar análise de documento\n"
    <> "`.legenda` — alternar legenda de vídeo\n"
    <> "`.longo` — usar descrição detalhada\n"
    <> "`.curto` — usar descrição concisa\n"
    <> "`.cego` — modo acessibilidade para deficientes visuais\n"
    <> "`.modelo` — mostrar provedor/modelo atual\n"
    <> "`.modelo provedor/modelo` — alterar provedor e modelo (admin)\n"
    <> "`.parear` — status ou pareamento do WhatsApp (admin)\n"
    <> "`.status` — painel de status e métricas do sistema (admin)\n"
    <> "`.reset_whatsapp` — resetar sessão do WhatsApp (admin)\n"
    <> "`.unban <chat_id>` — remover quarentena/bloqueio anti-spam (admin)\n"
    <> "`.spammers` — listar spammers recentes e bloqueios (admin)"
  [EnviarResposta(para: cfg.chat_id, corpo: texto)]
}

fn modelo_cmd(args: String, cfg: Config) -> List(Acao) {
  case string.trim(args) {
    "" -> [
      EnviarResposta(
        cfg.chat_id,
        "Provedor atual: `"
          <> provedor.para_string(cfg.provedor)
          <> "`\nModelo atual: `"
          <> cfg.modelo
          <> "`",
      ),
    ]
    spec ->
      case string.split_once(spec, "/") {
        Ok(#(provedor, modelo)) -> [
          AlterarModelo(
            chat_id: cfg.chat_id,
            provedor: string.trim(provedor),
            modelo: string.trim(modelo),
          ),
        ]
        Error(_) -> [
          EnviarResposta(
            cfg.chat_id,
            "Formato inválido. Use: `.modelo provedor/modelo`\nEx: `.modelo gemini/gemini-2.5-pro`",
          ),
        ]
      }
  }
}

fn reset(cfg: Config) -> List(Acao) {
  [
    SalvarConfig(config.padrao(cfg.chat_id)),
    LimparHistorico(cfg.chat_id),
    EnviarResposta(
      cfg.chat_id,
      "Histórico e configurações resetados. Podemos começar uma nova conversa.",
    ),
  ]
}

fn toggle(
  recurso: String,
  args: String,
  cfg: Config,
) -> Result(List(Acao), Erro) {
  case string.trim(string.lowercase(args)) {
    "on" -> {
      let nova = aplicar_toggle(recurso, True, cfg)
      Ok([
        SalvarConfig(nova),
        EnviarResposta(cfg.chat_id, mensagem_toggle(recurso, True)),
      ])
    }
    "off" -> {
      let nova = aplicar_toggle(recurso, False, cfg)
      Ok([
        SalvarConfig(nova),
        EnviarResposta(cfg.chat_id, mensagem_toggle(recurso, False)),
      ])
    }
    "" -> {
      let atual = estado_recurso(recurso, cfg)
      let nova = aplicar_toggle(recurso, !atual, cfg)
      Ok([
        SalvarConfig(nova),
        EnviarResposta(cfg.chat_id, mensagem_toggle(recurso, !atual)),
      ])
    }
    outro ->
      Error(erro.ErroValidacao(
        recurso,
        "valor inválido: " <> outro <> ". Use on ou off.",
      ))
  }
}

fn modo_descricao_cmd(modo: config.ModoDescricao, cfg: Config) -> List(Acao) {
  let nova = Config(..cfg, modo_descricao: modo)
  let label = config.modo_para_string(modo)
  [
    SalvarConfig(nova),
    EnviarResposta(cfg.chat_id, "Modo de descrição: " <> label <> "."),
  ]
}

fn cego_cmd(cfg: Config) -> List(Acao) {
  case cfg.modo_descricao {
    Longo -> {
      let nova = Config(..cfg, modo_descricao: Curto)
      [
        SalvarConfig(nova),
        EnviarResposta(cfg.chat_id, "Modo acessibilidade desativado."),
      ]
    }
    _ -> {
      let nova = Config(..cfg, imagem_ativo: True, modo_descricao: Longo)
      [
        SalvarConfig(nova),
        EnviarResposta(
          cfg.chat_id,
          "Modo acessibilidade ativado:\n"
            <> "- Análise de imagens: ativada\n"
            <> "- Modo de descrição: longo",
        ),
      ]
    }
  }
}

fn aplicar_toggle(recurso: String, valor: Bool, cfg: Config) -> Config {
  case recurso {
    "audio" -> Config(..cfg, audio_ativo: valor)
    "imagem" -> Config(..cfg, imagem_ativo: valor)
    "video" -> Config(..cfg, video_ativo: valor)
    "doc" -> Config(..cfg, doc_ativo: valor)
    "legenda" -> Config(..cfg, legenda_ativo: valor)
    _ -> cfg
  }
}

fn estado_recurso(recurso: String, cfg: Config) -> Bool {
  case recurso {
    "audio" -> cfg.audio_ativo
    "imagem" -> cfg.imagem_ativo
    "video" -> cfg.video_ativo
    "doc" -> cfg.doc_ativo
    "legenda" -> cfg.legenda_ativo
    _ -> False
  }
}

fn mensagem_toggle(recurso: String, ativo: Bool) -> String {
  case recurso, ativo {
    "legenda", True -> "Legenda ativada."
    "legenda", False -> "Legenda desativada."
    _, True -> recurso <> " ativado."
    _, False -> recurso <> " desativado."
  }
}
