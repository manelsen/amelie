// Circuit breaker como OTP actor.
// Protege chamadas de IA contra falhas em cascata.
// Estados: Fechado (normal) → Aberto (bloqueado) → SemiAberto (prova única com contenção)

import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import shell/sistema

pub const limite_falhas_padrao = 5

pub const reset_ms_padrao = 60_000

pub const timeout_sondagem_ms_padrao = 15_000

pub type Estado {
  Fechado(falhas: Int)
  Aberto(ultima_falha_ms: Int)
  SemiAberto(probe_em_voo: Bool, desde_ms: Int)
}

pub type Config {
  Config(limite_falhas: Int, reset_ms: Int, timeout_sondagem_ms: Int)
}

/// Mudança de estado que interessa a quem opera a Amélie.
pub type Transicao {
  /// Fechado → aberto: o provedor parou de ser chamado.
  Abriu
  /// Voltou a fechar depois de aberto; `fora_ms` é quanto tempo ficou fora.
  Fechou(fora_ms: Int)
}

/// Quem é avisado das transições, e a memória que evita aviso repetido.
pub type Aviso {
  Aviso(
    ao_mudar: fn(Transicao) -> Nil,
    /// O `Abriu` desta queda foi avisado (e o `Fechou` também deve ser).
    avisado: Bool,
    /// Quando o último `Abriu` avisado aconteceu.
    aberto_desde_ms: Int,
    /// Quando saiu o último `Fechou`; conta para o intervalo mínimo.
    ultimo_fechou_ms: Int,
  )
}

/// Intervalo mínimo entre o último "voltou" e um novo "caiu": um provedor
/// oscilando gera no máximo um par de avisos nesse tempo.
pub const intervalo_avisos_ms = 900_000

pub fn sem_aviso() -> Aviso {
  Aviso(
    ao_mudar: fn(_) { Nil },
    avisado: False,
    aberto_desde_ms: 0,
    ultimo_fechou_ms: -intervalo_avisos_ms,
  )
}

pub fn avisando(ao_mudar: fn(Transicao) -> Nil) -> Aviso {
  Aviso(..sem_aviso(), ao_mudar: ao_mudar)
}

pub type EstadoActor {
  EstadoActor(estado: Estado, config: Config, aviso: Aviso)
}

pub type Mensagem {
  Verificar(Subject(Bool))
  ObterEstado(Subject(Estado))
  Sucesso
  Falha
}

pub fn iniciar() -> Result(Subject(Mensagem), actor.StartError) {
  iniciar_com_config(Config(
    limite_falhas: limite_falhas_padrao,
    reset_ms: reset_ms_padrao,
    timeout_sondagem_ms: timeout_sondagem_ms_padrao,
  ))
}

pub fn iniciar_com_config(
  config: Config,
) -> Result(Subject(Mensagem), actor.StartError) {
  iniciar_actor(config, None, sem_aviso())
  |> result.map(fn(started) { started.data })
}

pub fn iniciar_actor(
  config: Config,
  name: Option(process.Name(Mensagem)),
  aviso: Aviso,
) -> Result(actor.Started(Subject(Mensagem)), actor.StartError) {
  let builder =
    actor.new(EstadoActor(estado: Fechado(0), config: config, aviso: aviso))
    |> actor.on_message(tratar)

  let builder = case name {
    Some(n) -> actor.named(builder, n)
    None -> builder
  }

  actor.start(builder)
}

/// `ao_mudar` roda dentro do ator: deve só despachar o aviso, sem bloquear.
pub fn supervisionado(
  name: process.Name(Mensagem),
  ao_mudar: fn(Transicao) -> Nil,
) -> supervision.ChildSpecification(Subject(Mensagem)) {
  supervision.worker(fn() {
    iniciar_actor(
      Config(
        limite_falhas: limite_falhas_padrao,
        reset_ms: reset_ms_padrao,
        timeout_sondagem_ms: timeout_sondagem_ms_padrao,
      ),
      Some(name),
      avisando(ao_mudar),
    )
  })
}

fn tratar(
  actor_state: EstadoActor,
  msg: Mensagem,
) -> actor.Next(EstadoActor, Mensagem) {
  case msg {
    Verificar(reply) -> {
      let #(pode, novo_estado) = checar(actor_state.estado, actor_state.config)
      process.send(reply, pode)
      actor.continue(mudar(actor_state, novo_estado))
    }
    ObterEstado(reply) -> {
      process.send(reply, actor_state.estado)
      actor.continue(actor_state)
    }
    Sucesso -> actor.continue(mudar(actor_state, Fechado(0)))
    Falha -> {
      let novo_estado = ao_falhar(actor_state.estado, actor_state.config)
      actor.continue(mudar(actor_state, novo_estado))
    }
  }
}

/// Troca o estado e avisa quando o circuito abre ou volta a fechar.
fn mudar(actor_state: EstadoActor, novo: Estado) -> EstadoActor {
  let transicao = case actor_state.estado, novo {
    Fechado(_), Aberto(_) -> Some(Abriu)
    Fechado(_), _ -> None
    _, Fechado(_) -> Some(Fechou(fora_ms: 0))
    _, _ -> None
  }
  let aviso = case transicao {
    None -> actor_state.aviso
    Some(t) -> {
      let #(enviar, aviso) =
        decidir_aviso(actor_state.aviso, t, sistema.agora_ms())
      case enviar {
        Some(t) -> aviso.ao_mudar(t)
        None -> Nil
      }
      aviso
    }
  }
  EstadoActor(..actor_state, estado: novo, aviso: aviso)
}

/// Decide se a transição vira aviso. Um `Abriu` só é avisado se o último
/// `Fechou` avisado foi há mais de `intervalo_avisos_ms`; um `Fechou` só é
/// avisado se o `Abriu` daquela queda foi, e leva quanto tempo ficou fora.
pub fn decidir_aviso(
  aviso: Aviso,
  transicao: Transicao,
  agora_ms: Int,
) -> #(Option(Transicao), Aviso) {
  case transicao, aviso.avisado {
    Abriu, False ->
      case agora_ms - aviso.ultimo_fechou_ms >= intervalo_avisos_ms {
        True -> #(
          Some(Abriu),
          Aviso(..aviso, avisado: True, aberto_desde_ms: agora_ms),
        )
        False -> #(None, aviso)
      }
    Fechou(_), True -> #(
      Some(Fechou(fora_ms: agora_ms - aviso.aberto_desde_ms)),
      Aviso(..aviso, avisado: False, ultimo_fechou_ms: agora_ms),
    )
    _, _ -> #(None, aviso)
  }
}

pub fn checar(estado: Estado, config: Config) -> #(Bool, Estado) {
  let agora = sistema.agora_ms()
  case estado {
    Fechado(_) -> #(True, estado)
    Aberto(ultima) ->
      case agora - ultima > config.reset_ms {
        True -> #(True, SemiAberto(probe_em_voo: True, desde_ms: agora))
        False -> #(False, estado)
      }
    SemiAberto(probe_em_voo, desde_ms) ->
      case probe_em_voo {
        True ->
          case agora - desde_ms > config.timeout_sondagem_ms {
            True -> #(True, SemiAberto(probe_em_voo: True, desde_ms: agora))
            False -> #(False, estado)
          }
        False -> #(True, SemiAberto(probe_em_voo: True, desde_ms: agora))
      }
  }
}

pub fn ao_falhar(estado: Estado, config: Config) -> Estado {
  case estado {
    Fechado(f) -> {
      let novo = f + 1
      case novo >= config.limite_falhas {
        True -> Aberto(sistema.agora_ms())
        False -> Fechado(novo)
      }
    }
    SemiAberto(..) -> Aberto(sistema.agora_ms())
    Aberto(_) -> Aberto(sistema.agora_ms())
  }
}

/// Verifica se o CB permite execução (False = bloqueado).
/// Em caso de timeout ou indisponibilidade temporária do actor, não bloqueia por padrão.
pub fn pode_executar(cb: Subject(Mensagem)) -> Bool {
  let reply = process.new_subject()
  process.send(cb, Verificar(reply))
  case process.receive(reply, 1000) {
    Ok(pode) -> pode
    Error(_) -> True
  }
}

/// Obtém o estado atual do CB para inspeção e testes.
pub fn obter_estado(cb: Subject(Mensagem)) -> Estado {
  let reply = process.new_subject()
  process.send(cb, ObterEstado(reply))
  case process.receive(reply, 1000) {
    Ok(estado) -> estado
    Error(_) -> Fechado(0)
  }
}

pub fn registrar_sucesso(cb: Subject(Mensagem)) -> Nil {
  process.send(cb, Sucesso)
}

pub fn registrar_falha(cb: Subject(Mensagem)) -> Nil {
  process.send(cb, Falha)
}
