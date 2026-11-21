import gleam/http
import gleam/http/request.{type Request}
import shell/sistema

pub fn token_ponte() -> String {
  sistema.ler_env_ou("BRIDGE_TOKEN", "")
}

/// O webhook fica fechado se o segredo não foi configurado.
pub fn autorizado(req: Request(a), cabecalho: String, segredo: String) -> Bool {
  case segredo, request.get_header(req, cabecalho) {
    "", _ -> False
    _, Ok(token) -> comparar_tokens(token, segredo)
    _, _ -> False
  }
}

pub fn autorizar_webhook(
  req: Request(a),
  cabecalho: String,
  segredo: String,
) -> Result(Nil, Int) {
  case autorizado(req, cabecalho, segredo) {
    False -> Error(401)
    True ->
      case req.method {
        http.Post -> Ok(Nil)
        _ -> Error(405)
      }
  }
}

@external(erlang, "amelie_ffi", "constant_time_equal")
fn comparar_tokens(a: String, b: String) -> Bool
