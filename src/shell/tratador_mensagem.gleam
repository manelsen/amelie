// Shell — executa os efeitos prescritos pelo core.
// Este módulo tem side effects: chama portas, grava histórico.

import core/anti_spam as core_anti_spam
import core/autorizacao
import core/privacidade
import core/processador
import dominio/acao.{
  AlterarModelo, AtivarPrompt, BuscarUrlEResponder, ConsultarMetricas,
  ConsultarSpammers, ConsultarStatus, DesbloquearChat, EnfileirarMidia,
  EnviarResposta, ExcluirPrompt, GerarEEnviar, LimparHistorico, ListarGrupos,
  ListarPrompts, ListarUsuarios, MidiaVideo, NaoResponder, ResetarWhatsApp,
  SalvarConfig, SalvarPrompt, SnapshotHistorico, SolicitarPareamento,
}
import dominio/config.{type Config}
import dominio/erro.{type Erro}
import dominio/id_chat.{type IdChat}
import dominio/mensagem.{type Mensagem, type Turno, TurnoUsuario}
import dominio/transacao.{RespostaTexto}
import gleam/bool
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/option.{type Option}
import gleam/result
import logging
import shell/anti_spam
import shell/arquivos_temporarios
import shell/fila_midia
import shell/metricas
import shell/sistema
import shell/tarefa_isolada
import shell/tratador/admin
import shell/tratador/base.{
  type Portas, avisar, entregar, extrair_trace_id, responder,
}
import shell/tratador/conversa
import shell/tratador/respostas_ia

/// O history sync do WhatsApp reenvia o histórico completo ao reconectar;
/// mensagens mais antigas que isso já foram respondidas antes.
const idade_maxima_mensagem_s = 172_800

const aviso_restrito = "⛔ Comando restrito ao administrador."

const aviso_erro_generico = "⚠️ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente."

/// Como a mensagem chegou: no ritmo do usuário ou em lote, depois de a
/// Amélie ficar fora do ar. Só muda a regra de anti-spam.
type Chegada {
  NoHorario
  Atrasada
}

pub fn tratar(msg: Mensagem, portas: Portas) -> Result(Nil, Erro) {
  tratar_chegada(msg, portas, NoHorario)
}

/// Mensagem enviada enquanto a Amélie estava fora do ar. Não é culpa do
/// usuário que ela chegue junto com outras, então não conta como rajada.
pub fn tratar_atrasada(msg: Mensagem, portas: Portas) -> Result(Nil, Erro) {
  tratar_chegada(msg, portas, Atrasada)
}

fn tratar_chegada(
  msg: Mensagem,
  portas: Portas,
  chegada: Chegada,
) -> Result(Nil, Erro) {
  let trace_id = extrair_trace_id(msg)
  logging.log(
    logging.Info,
    "["
      <> trace_id
      <> "] Mensagem recebida do chat "
      <> privacidade.mascarar(msg.chat_id)
      <> " (remetente: "
      <> privacidade.mascarar(msg.remetente)
      <> ")",
  )

  use <- bool.lazy_guard(mensagem_antiga(msg), fn() {
    logging.log(
      logging.Info,
      "["
        <> trace_id
        <> "] Mensagem ignorada por ser muito antiga (ts="
        <> int.to_string(msg.timestamp)
        <> "): "
        <> privacidade.mascarar(msg.chat_id),
    )
    limpar_midia_se_descartada(msg)
    Ok(Nil)
  })
  use <- bool.lazy_guard(ja_processada(msg, portas), fn() {
    logging.log(
      logging.Info,
      "["
        <> trace_id
        <> "] Mensagem ja processada, ignorando: "
        <> option.unwrap(msg.message_id, ""),
    )
    limpar_midia_se_descartada(msg)
    Ok(Nil)
  })
  processar_mensagem_com_anti_spam(msg, portas, chegada)
}

fn mensagem_antiga(msg: Mensagem) -> Bool {
  msg.timestamp > 0
  && sistema.agora_s() - msg.timestamp > idade_maxima_mensagem_s
}

/// Deduplicação: o history sync pode reenviar mensagens já processadas.
/// Marca a mensagem como recebida e diz se ela já tinha passado por aqui.
/// Sem message_id (raro) ou com o banco fora, a mensagem é processada.
fn ja_processada(msg: Mensagem, portas: Portas) -> Bool {
  case msg.message_id {
    option.None -> False
    option.Some(msg_id) ->
      case portas.transacoes.foi_recebida(msg.chat_id, msg_id) {
        Ok(True) -> True
        Ok(False) -> {
          portas.transacoes.marcar_recebida(msg.chat_id, msg_id)
          |> sistema.registrar_falha("Falha ao marcar mensagem como recebida")
          False
        }
        Error(_) -> False
      }
  }
}

fn processar_mensagem_com_anti_spam(
  msg: Mensagem,
  portas: Portas,
  chegada: Chegada,
) -> Result(Nil, Erro) {
  let decisao = case chegada {
    NoHorario ->
      anti_spam.verificar(
        portas.anti_spam,
        msg.chat_id,
        msg.remetente,
        msg.corpo,
      )
    Atrasada ->
      anti_spam.verificar_atrasada(portas.anti_spam, msg.chat_id, msg.remetente)
  }
  case decisao {
    core_anti_spam.Permitido -> processar_mensagem(msg, portas)
    core_anti_spam.AvisoLimite(motivo, nivel) ->
      avisar_limite(motivo, nivel, msg, portas)
    core_anti_spam.Adiar(espera_ms, avisar_usuario) ->
      adiar_midia(espera_ms, avisar_usuario, msg, portas)
    core_anti_spam.Descartado -> {
      limpar_midia_se_descartada(msg)
      Ok(Nil)
    }
    core_anti_spam.Silenciado(notificar_admin) ->
      descartar_silenciado(notificar_admin, msg, portas)
  }
}

/// Mídia além do balde: em vez de descartar (e pedir para reenviar), segue
/// para o processamento quando a recarga cobrir o custo. A verificação já
/// foi feita e o custo, descontado. Se a Amélie reiniciar no meio da espera,
/// a mídia adiada se perde.
///
/// A dívida é por chat; o total de mídias em espera, com seus bytes em
/// memória, tem teto global. Sem vaga, a mídia não é guardada e o usuário
/// é avisado para reenviar mais tarde.
fn adiar_midia(
  espera_ms: Int,
  avisar_usuario: Bool,
  msg: Mensagem,
  portas: Portas,
) -> Result(Nil, Erro) {
  case sistema.reservar_vaga(vagas_adiadas, max_midias_adiadas) {
    False -> {
      logging.log(
        logging.Warning,
        "["
          <> extrair_trace_id(msg)
          <> "] Teto global de mídias adiadas atingido; mídia recusada para "
          <> privacidade.mascarar(msg.chat_id),
      )
      limpar_midia_se_descartada(msg)
      avisar(msg.chat_id, aviso_adiadas_lotado, portas)
    }
    True -> {
      logging.log(
        logging.Info,
        "["
          <> extrair_trace_id(msg)
          <> "] Mídia adiada por "
          <> int.to_string(espera_ms / 1000)
          <> "s para "
          <> privacidade.mascarar(msg.chat_id),
      )
      sistema.disparar(fn() {
        process.sleep(espera_ms)
        // Isolado: a vaga volta mesmo se o processamento quebrar.
        let desfecho =
          tarefa_isolada.executar(
            fn() {
              processar_mensagem(msg, portas)
              |> sistema.registrar_falha("Falha ao processar mídia adiada")
            },
            tempo_maximo_adiada_ms,
          )
        sistema.liberar_vaga(vagas_adiadas)
        case desfecho {
          tarefa_isolada.Terminou -> Nil
          // Não dá para saber se a mídia já chegou à fila de mídia, então o
          // arquivo temporário fica para a varredura de órfãos (1 h).
          tarefa_isolada.Quebrou | tarefa_isolada.Estourou -> {
            logging.log(
              logging.Error,
              "["
                <> extrair_trace_id(msg)
                <> "] Mídia adiada não foi processada para "
                <> privacidade.mascarar(msg.chat_id),
            )
            avisar(msg.chat_id, fila_midia.aviso_falha_midia, portas)
            |> sistema.registrar_falha("Falha ao avisar mídia adiada perdida")
          }
        }
      })
      case avisar_usuario {
        True -> avisar(msg.chat_id, core_anti_spam.aviso_midias_adiadas, portas)
        False -> Ok(Nil)
      }
    }
  }
}

const vagas_adiadas = "midias_adiadas"

/// Teto global de mídias em espera, somando todos os chats. Com 20 por
/// chat, cobre 5 rajadas grandes ao mesmo tempo.
const max_midias_adiadas = 100

/// Só enfileirar na fila de mídia; o job em si tem teto próprio lá.
const tempo_maximo_adiada_ms = 60_000

pub const aviso_adiadas_lotado = "⏳ Estou com muitas mídias na fila agora e não consegui guardar esta. Por favor, reenvie daqui a alguns minutos."

fn avisar_limite(
  motivo: String,
  nivel: Int,
  msg: Mensagem,
  portas: Portas,
) -> Result(Nil, Erro) {
  let tel = core_anti_spam.extrair_telefone(msg.remetente)
  portas.spammers.registrar(msg.chat_id, msg.remetente, tel, motivo, nivel)
  |> sistema.registrar_falha("Falha ao registrar incidente de spam")
  logging.log(
    logging.Warning,
    "["
      <> extrair_trace_id(msg)
      <> "] Rate limit acionado para "
      <> privacidade.mascarar(msg.remetente)
      <> " ("
      <> privacidade.mascarar(msg.chat_id)
      <> "): "
      <> motivo,
  )
  limpar_midia_se_descartada(msg)
  avisar(msg.chat_id, motivo, portas)
}

fn descartar_silenciado(
  notificar_admin: option.Option(String),
  msg: Mensagem,
  portas: Portas,
) -> Result(Nil, Erro) {
  let tel = core_anti_spam.extrair_telefone(msg.remetente)
  portas.spammers.registrar(
    msg.chat_id,
    msg.remetente,
    tel,
    "Quarentena / Blackhole",
    3,
  )
  |> sistema.registrar_falha("Falha ao registrar incidente de spam")
  logging.log(
    logging.Warning,
    "["
      <> extrair_trace_id(msg)
      <> "] Mensagem descartada silenciosamente por quarentena anti-spam: "
      <> privacidade.mascarar(msg.remetente)
      <> " ("
      <> privacidade.mascarar(msg.chat_id)
      <> ")",
  )
  limpar_midia_se_descartada(msg)
  case notificar_admin, sistema.admin_chat_id() {
    option.Some(alerta), option.Some(admin) -> avisar(admin, alerta, portas)
    _, _ -> Ok(Nil)
  }
}

fn limpar_midia_se_descartada(msg: Mensagem) -> Nil {
  case msg.corpo {
    mensagem.Video(caminho_temp: caminho, ..) -> {
      let _ = arquivos_temporarios.deletar(caminho)
      Nil
    }
    _ -> Nil
  }
}

fn processar_mensagem(msg: Mensagem, portas: Portas) -> Result(Nil, Erro) {
  let trace_id = extrair_trace_id(msg)
  logging.log(
    logging.Info,
    "["
      <> trace_id
      <> "] Processando mensagem: "
      <> privacidade.mascarar(msg.chat_id),
  )

  portas.usuarios.registrar(msg.chat_id)
  |> sistema.registrar_falha("Falha ao registrar usuário")
  case msg.em_grupo {
    True ->
      portas.grupos.registrar(
        msg.chat_id,
        option.unwrap(msg.nome_grupo, "Grupo"),
      )
      |> sistema.registrar_falha("Falha ao registrar grupo")
    False -> Nil
  }

  metricas.registrar(portas.metricas, metricas.MensagensProcessadas)
  use e <- result.try_recover(tratar_interno(msg, portas))
  limpar_midia_se_descartada(msg)
  metricas.registrar(portas.metricas, metricas.Erros)
  logging.log(
    logging.Warning,
    "["
      <> trace_id
      <> "] Erro ao processar mensagem de "
      <> privacidade.mascarar(msg.remetente)
      <> ": "
      <> erro.descricao(e),
  )
  let _ = avisar(msg.chat_id, aviso_erro_generico, portas)
  Error(e)
}

fn tratar_interno(msg: Mensagem, portas: Portas) -> Result(Nil, Erro) {
  use cfg <- result.try(portas.config.obter(msg.chat_id))
  use hist <- result.try(portas.historico.obter(msg.chat_id))
  let admin_id = sistema.admin_chat_id()
  let hist_efetivo = case autorizacao.eh_admin(admin_id, msg) {
    True -> [TurnoUsuario(processador.marcador_admin), ..hist]
    False -> hist
  }
  use acoes <- result.try(processador.processar(msg, cfg, hist_efetivo))
  let vai_enfileirar_video =
    list.any(acoes, fn(a) {
      case a {
        EnfileirarMidia(_, MidiaVideo) -> True
        _ -> False
      }
    })
  case vai_enfileirar_video {
    False -> limpar_midia_se_descartada(msg)
    True -> Nil
  }
  acoes
  |> list.map(executar_acao(_, admin_id, msg, cfg, hist, portas))
  |> result.all
  |> result.map(fn(_) { Nil })
}

/// Executa uma ação prescrita pelo core, depois de passar pelo portão único
/// de autorização: ações administrativas de quem não é admin são recusadas
/// aqui, antes de qualquer efeito.
fn executar_acao(
  acao: acao.Acao,
  admin_id: Option(IdChat),
  msg: Mensagem,
  cfg: Config,
  hist: List(Turno),
  portas: Portas,
) -> Result(Nil, Erro) {
  use <- bool.lazy_guard(!autorizacao.permitido(acao, admin_id, msg), fn() {
    avisar(msg.chat_id, aviso_restrito, portas)
  })
  case acao {
    GerarEEnviar(para, prompt) ->
      respostas_ia.gerar_e_enviar(para, prompt, msg, cfg, hist, portas)
    BuscarUrlEResponder(para, texto, url) ->
      respostas_ia.buscar_url_e_responder(
        para,
        texto,
        url,
        msg,
        cfg,
        hist,
        portas,
      )
    EnviarResposta(para, corpo) ->
      entregar(para, RespostaTexto, corpo, msg, portas)
    SalvarConfig(nova_cfg) -> portas.config.salvar(nova_cfg)
    LimparHistorico(chat_id) -> conversa.limpar_historico(chat_id, cfg, portas)
    EnfileirarMidia(chat_id, tipo) ->
      conversa.enfileirar_midia(chat_id, tipo, msg, cfg, portas)
    SalvarPrompt(chat_id, nome, texto) ->
      portas.prompts.definir(chat_id, nome, texto)
    ExcluirPrompt(chat_id, nome) -> portas.prompts.excluir(chat_id, nome)
    AtivarPrompt(chat_id, nome) ->
      conversa.ativar_prompt(chat_id, nome, cfg, portas)
    ListarPrompts(chat_id) -> conversa.listar_prompts(chat_id, portas)
    ConsultarMetricas(chat_id) ->
      responder(
        chat_id,
        metricas.formatar(metricas.consultar(portas.metricas)),
        portas,
      )
    ListarUsuarios(chat_id) ->
      responder(
        chat_id,
        conversa.formatar_lista(
          "👥 Usuários ativos:",
          portas.usuarios.listar()
            |> result.map(list.map(_, id_chat.para_texto)),
        ),
        portas,
      )
    ListarGrupos(chat_id) ->
      responder(
        chat_id,
        conversa.formatar_lista("👥 Grupos ativos:", portas.grupos.listar()),
        portas,
      )
    SnapshotHistorico(chat_id) ->
      conversa.resumir_historico(chat_id, cfg, portas)
    AlterarModelo(chat_id, provedor, modelo) ->
      conversa.alterar_modelo(chat_id, provedor, modelo, msg, cfg, portas)
    SolicitarPareamento(chat_id, args) ->
      admin.solicitar_pareamento(chat_id, args, portas)
    ConsultarStatus(chat_id) -> admin.consultar_status(chat_id, portas)
    ResetarWhatsApp(chat_id, args) ->
      admin.resetar_whatsapp(chat_id, args, portas)
    DesbloquearChat(chat_id, alvo) ->
      admin.desbloquear_chat(chat_id, alvo, portas)
    ConsultarSpammers(chat_id) -> admin.consultar_spammers(chat_id, portas)
    NaoResponder -> Ok(Nil)
  }
}
