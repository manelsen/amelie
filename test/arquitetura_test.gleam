//// Guarda das camadas do hexágono. Lê os imports de `src/` e falha se algum
//// módulo depender de uma camada que a tabela do CLAUDE.md não permite, ou se
//// uma biblioteca de infraestrutura aparecer fora dos adaptadores.

import gleam/list
import gleam/string
import simplifile

const camadas = ["dominio", "portas", "core", "adaptadores", "shell"]

/// Único módulo fora das camadas: monta adaptadores e portas.
const ponto_de_entrada = "amelie"

/// Bibliotecas que falam com o mundo de fora (banco, servidor e cliente HTTP).
/// Só os adaptadores e o ponto de entrada podem importá-las.
const infraestrutura = ["sqlight", "mist", "gleam/httpc"]

fn camadas_permitidas(camada: String) -> List(String) {
  case camada {
    "dominio" -> ["dominio"]
    "portas" -> ["dominio"]
    "core" -> ["core", "dominio"]
    "adaptadores" -> ["adaptadores", "dominio", "portas"]
    "shell" -> ["shell", "core", "dominio", "portas"]
    // Módulo solto fora das camadas: não pode depender de nenhuma.
    _ -> []
  }
}

fn camada_de(modulo: String) -> String {
  case string.split_once(modulo, "/") {
    Ok(#(primeira, _)) -> primeira
    Error(_) -> modulo
  }
}

fn e_infraestrutura(importado: String) -> Bool {
  list.any(infraestrutura, fn(lib) {
    importado == lib || string.starts_with(importado, lib <> "/")
  })
}

/// Linhas `import` de código, ignorando as que estão dentro de uma string de
/// várias linhas.
fn imports(fonte: String) -> List(String) {
  let #(achados, _) =
    string.split(fonte, "\n")
    |> list.fold(#([], False), fn(estado, linha) {
      let #(achados, em_string) = estado
      let achados = case em_string, string.trim_start(linha) {
        False, "import " <> resto -> [modulo_importado(resto), ..achados]
        _, _ -> achados
      }
      #(achados, termina_em_string(string.to_graphemes(linha), em_string))
    })
  list.reverse(achados)
}

fn modulo_importado(resto: String) -> String {
  let resto = string.trim_start(resto)
  case string.split_once(resto, " ") {
    Ok(#(modulo, _)) -> trim_import(modulo)
    Error(_) -> trim_import(resto)
  }
}

/// Diz se a linha termina dentro de uma string, dado se começou dentro de uma.
/// Fora de string, `//` encerra a linha; dentro, `\` escapa o próximo caractere.
fn termina_em_string(caracteres: List(String), em_string: Bool) -> Bool {
  case em_string, caracteres {
    _, [] -> em_string
    False, ["/", "/", ..] -> False
    False, ["\"", ..resto] -> termina_em_string(resto, True)
    False, [_, ..resto] -> termina_em_string(resto, False)
    True, ["\\", _, ..resto] -> termina_em_string(resto, True)
    True, ["\"", ..resto] -> termina_em_string(resto, False)
    True, [_, ..resto] -> termina_em_string(resto, True)
  }
}

// `import a/b.{type X}` → `a/b`
fn trim_import(modulo: String) -> String {
  case string.split_once(modulo, ".") {
    Ok(#(nome, _)) -> nome
    Error(_) -> string.trim(modulo)
  }
}

/// Lista "arquivo: import proibido" para cada violação encontrada.
pub fn violacoes(arquivo: String, fonte: String) -> List(String) {
  let modulo =
    arquivo
    |> string.replace("src/", "")
    |> string.replace(".gleam", "")
  let camada = camada_de(modulo)
  let e_entrada = modulo == ponto_de_entrada
  // Só o módulo `amelie` em si monta tudo; um `amelie/x` não.
  let permitidas = case e_entrada {
    True -> camadas
    False -> camadas_permitidas(camada)
  }
  imports(fonte)
  |> list.filter(fn(importado) {
    let alvo = camada_de(importado)
    case importado == ponto_de_entrada || list.contains(camadas, alvo) {
      True -> !list.contains(permitidas, alvo)
      False ->
        e_infraestrutura(importado) && !e_entrada && camada != "adaptadores"
    }
  })
  |> list.map(fn(importado) { arquivo <> ": " <> importado })
}

pub fn camadas_respeitadas_test() {
  let assert Ok(arquivos) = simplifile.get_files(in: "src")
  let achados =
    arquivos
    |> list.filter(string.ends_with(_, ".gleam"))
    |> list.flat_map(fn(arquivo) {
      let assert Ok(fonte) = simplifile.read(arquivo)
      violacoes(arquivo, fonte)
    })
  assert achados == []
}

pub fn guarda_acusa_shell_importando_adaptador_test() {
  assert violacoes("src/shell/x.gleam", "import adaptadores/telegram_http\n")
    == ["src/shell/x.gleam: adaptadores/telegram_http"]
}

pub fn guarda_acusa_core_importando_porta_test() {
  assert violacoes(
      "src/core/x.gleam",
      "import dominio/acao\nimport portas/ia_porta.{type IAPorta}\n",
    )
    == ["src/core/x.gleam: portas/ia_porta"]
}

pub fn guarda_acusa_infraestrutura_fora_dos_adaptadores_test() {
  assert violacoes("src/shell/x.gleam", "import sqlight\nimport gleam/list\n")
    == ["src/shell/x.gleam: sqlight"]
  assert violacoes("src/adaptadores/x.gleam", "import sqlight\n") == []
  assert violacoes("src/amelie.gleam", "import adaptadores/x\n") == []
}

pub fn guarda_so_libera_o_ponto_de_entrada_real_test() {
  assert violacoes(
      "src/utilitarios.gleam",
      "import sqlight\nimport adaptadores/x\nimport gleam/list\n",
    )
    == [
      "src/utilitarios.gleam: sqlight",
      "src/utilitarios.gleam: adaptadores/x",
    ]
}

pub fn guarda_acusa_porta_importando_porta_test() {
  assert violacoes("src/portas/x.gleam", "import portas/y\nimport dominio/z\n")
    == ["src/portas/x.gleam: portas/y"]
}

pub fn guarda_acusa_camada_importando_o_ponto_de_entrada_test() {
  assert violacoes("src/core/x.gleam", "import amelie\n")
    == ["src/core/x.gleam: amelie"]
}

pub fn guarda_ignora_import_dentro_de_string_test() {
  let fonte =
    "import dominio/a\npub const exemplo = \"\nimport sqlight\n\\\" ainda\n\"\n// \"\nimport sqlight\n"
  assert violacoes("src/dominio/x.gleam", fonte)
    == ["src/dominio/x.gleam: sqlight"]
}

pub fn guarda_acusa_import_recuado_test() {
  assert violacoes("src/shell/x.gleam", "  import adaptadores/telegram_http\n")
    == ["src/shell/x.gleam: adaptadores/telegram_http"]
}

pub fn guarda_acusa_import_com_espacos_extras_test() {
  assert violacoes("src/shell/x.gleam", "import  adaptadores/telegram_http\n")
    == ["src/shell/x.gleam: adaptadores/telegram_http"]
}

pub fn guarda_nao_estende_a_excecao_a_submodulos_da_entrada_test() {
  assert violacoes("src/amelie/utilitarios.gleam", "import adaptadores/x\n")
    == ["src/amelie/utilitarios.gleam: adaptadores/x"]
}
