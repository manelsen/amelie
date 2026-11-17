import adaptadores/gemini_http
import gleeunit/should

pub fn junta_todas_as_partes_de_texto_test() {
  "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Olá, \"},{\"text\":\"mundo.\"}]}}]}"
  |> gemini_http.extrair_texto_resposta
  |> should.equal(Ok("Olá, mundo."))
}

pub fn parte_sem_texto_nao_derruba_a_resposta_test() {
  "{\"candidates\":[{\"content\":{\"parts\":[{\"thoughtSignature\":\"abc\"},{\"text\":\"Resposta.\"}]}}]}"
  |> gemini_http.extrair_texto_resposta
  |> should.equal(Ok("Resposta."))
}

pub fn parte_de_pensamento_fica_de_fora_test() {
  "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"rascunho\",\"thought\":true},{\"text\":\"Final.\"}]}}]}"
  |> gemini_http.extrair_texto_resposta
  |> should.equal(Ok("Final."))
}

pub fn resposta_sem_texto_e_erro_test() {
  "{\"candidates\":[{\"finishReason\":\"SAFETY\"}]}"
  |> gemini_http.extrair_texto_resposta
  |> should.be_error
}

pub fn delecao_com_status_2xx_e_sucesso_test() {
  gemini_http.interpretar_delecao(200) |> should.equal(Ok(Nil))
  gemini_http.interpretar_delecao(204) |> should.equal(Ok(Nil))
}

pub fn delecao_de_arquivo_que_ja_nao_existe_e_sucesso_test() {
  gemini_http.interpretar_delecao(404) |> should.equal(Ok(Nil))
}

pub fn delecao_recusada_e_erro_test() {
  gemini_http.interpretar_delecao(403) |> should.be_error
  gemini_http.interpretar_delecao(500) |> should.be_error
  gemini_http.interpretar_delecao(302) |> should.be_error
}
