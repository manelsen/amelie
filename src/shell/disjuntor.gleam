// Circuit breaker como OTP actor.
// Protege chamadas de IA contra falhas em cascata.
// Estados: Fechado (normal) → Aberto (bloqueado) → SemiAberto (prova única com contenção)

import gleam/erlang/process.{type Subject}
import gleam/int
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
    /// Início da queda atual (circuito fora de `Fechado`), avisada ou não.
    queda_desde_ms: Option(Int),
    /// O `Abriu` da queda atual foi avisado (e o `Fechou` também deve ser).
    avisado: Bool,
    /// Quando saiu o último `Fechou`; conta para o intervalo mínimo.
    ultimo_fechou_ms: Int,
  )
}

/// Intervalo mínimo entre o último "voltou" e um novo "caiu": um provedor
/// oscilando gera no máximo um par de avisos nesse tempo. Uma queda que
/// começa dentro do intervalo não se perde: é avisada quando ele termina,
/// se o circuito continuar aberto.
pub const intervalo_avisos_ms = 900_000

pub fn sem_aviso() -> Aviso {
  Aviso(
    ao_mudar: fn(_) { Nil },
    queda_desde_ms: None,
    avisado: False,
    ultimo_fechou_ms: -intervalo_avisos_ms,
  )
}

pub fn avisando(ao_mudar: fn(Transicao) -> Nil) -> Aviso {
  Aviso(..sem_aviso(), ao_mudar: ao_mudar)
}

pub type EstadoActor {
  EstadoActor(
    estado: Estado,
    config: Config,
    aviso: Aviso,
    /// O próprio ator, para agendar a reavaliação de uma queda adiada.
    eu: Subject(Mensagem),
  )
}

pub type Mensagem {
  Verificar(Subject(Bool))
  ObterEstado(Subject(Estado))
  Sucesso
  Falha
  /// Fim do intervalo mínimo: avisa a queda adiada se o circuito seguir aberto.
  Reavaliar
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
    actor.new_with_initialiser(1000, fn(eu) {
      EstadoActor(estado: Fechado(0), config: config, aviso: aviso, eu: eu)
      |> actor.initialised
      |> actor.returning(eu)
      |> Ok
    })
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
    Reavaliar -> {
      // O temporizador e o relógio de parede podem divergir por alguns ms:
      // se ainda faltar tempo, agenda de novo em vez de perder o aviso.
      let novo = mudar(actor_state, actor_state.estado)
      case espera_aviso(novo.aviso, sistema.agora_ms()) {
        Some(espera) -> {
          process.send_after(novo.eu, int.max(espera, 1), Reavaliar)
          Nil
        }
        None -> Nil
      }
      actor.continue(novo)
    }
    Falha -> {
      let novo_estado = ao_falhar(actor_state.estado, actor_state.config)
      actor.continue(mudar(actor_state, novo_estado))
    }
  }
}

/// Troca o estado e avisa quando o circuito abre ou volta a fechar. Uma queda
/// que começa calada pelo intervalo mínimo agenda um `Reavaliar` para o fim
/// dele, para ser avisada mesmo sem novas chamadas ao provedor.
fn mudar(actor_state: EstadoActor, novo: Estado) -> EstadoActor {
  let agora = sistema.agora_ms()
  let #(enviar, aviso) =
    decidir_aviso(actor_state.aviso, actor_state.estado, novo, agora)
  case enviar {
    Some(t) -> aviso.ao_mudar(t)
    None -> Nil
  }
  case actor_state.aviso.queda_desde_ms, espera_aviso(aviso, agora) {
    None, Some(espera) -> {
      process.send_after(actor_state.eu, espera, Reavaliar)
      Nil
    }
    _, _ -> Nil
  }
  EstadoActor(..actor_state, estado: novo, aviso: aviso)
}

/// Quanto falta para poder avisar a queda em curso, se ela ainda não foi
/// avisada; `None` se não há queda calada.
pub fn espera_aviso(aviso: Aviso, agora_ms: Int) -> Option(Int) {
  case aviso.queda_desde_ms, aviso.avisado {
    Some(_), False ->
      Some(int.max(0, aviso.ultimo_fechou_ms + intervalo_avisos_ms - agora_ms))
    _, _ -> None
  }
}

/// Decide o aviso de cada mensagem do disjuntor. Roda a cada mensagem (e não
/// só nas transições) para que uma queda adiada pelo intervalo mínimo seja
/// avisada assim que ele terminar (por uma chamada ao provedor ou pelo
/// `Reavaliar` agendado).
pub fn decidir_aviso(
  aviso: Aviso,
  anterior: Estado,
  novo: Estado,
  agora_ms: Int,
) -> #(Option(Transicao), Aviso) {
  case anterior, novo {
    // Continua fechado: nada a avisar.
    Fechado(_), Fechado(_) -> #(None, aviso)
    // Fechou: avisa só se a queda foi avisada.
    _, Fechado(_) -> {
      let limpo = Aviso(..aviso, queda_desde_ms: None, avisado: False)
      case aviso.avisado, aviso.queda_desde_ms {
        True, Some(desde) -> #(
          Some(Fechou(fora_ms: agora_ms - desde)),
          Aviso(..limpo, ultimo_fechou_ms: agora_ms),
        )
        _, _ -> #(None, limpo)
      }
    }
    // Fora de `Fechado`: registra o início da queda e avisa quando puder.
    _, _ -> {
      let desde = case anterior, aviso.queda_desde_ms {
        Fechado(_), _ | _, None -> agora_ms
        _, Some(desde) -> desde
      }
      let aviso = Aviso(..aviso, queda_desde_ms: Some(desde))
      let pode =
        !aviso.avisado
        && agora_ms - aviso.ultimo_fechou_ms >= intervalo_avisos_ms
      case pode {
        True -> #(Some(Abriu), Aviso(..aviso, avisado: True))
        False -> #(None, aviso)
      }
    }
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
