import core/privacidade
import gleeunit/should

pub fn mascarar_telefone_test() {
  privacidade.mascarar_id("5531999990000")
  |> should.equal("5531****0000")
}

pub fn mascarar_jid_test() {
  privacidade.mascarar_id("5531999990000@s.whatsapp.net")
  |> should.equal("5531****0000@s.whatsapp.net")
}

pub fn mascarar_jid_com_dispositivo_test() {
  privacidade.mascarar_id("5531999990000:12@s.whatsapp.net")
  |> should.equal("5531****0000:12@s.whatsapp.net")
}

pub fn mascarar_grupo_test() {
  privacidade.mascarar_id("120363012345678901@g.us")
  |> should.equal("1203****8901@g.us")
}

pub fn mascarar_telegram_test() {
  privacidade.mascarar_id("tg:123456789")
  |> should.equal("tg:1234****6789")
}

pub fn mascarar_id_curto_test() {
  privacidade.mascarar_id("123456@lid")
  |> should.equal("****@lid")
}

pub fn mascarar_texto_de_exibicao_telegram_test() {
  privacidade.mascarar_id("Telegram: 987654321")
  |> should.equal("****:9876****4321")
}

pub fn mascarar_texto_de_exibicao_lid_test() {
  privacidade.mascarar_id("LID: 123456789012345")
  |> should.equal("****:1234****2345")
}

pub fn mascarar_vazio_test() {
  privacidade.mascarar_id("")
  |> should.equal("****")
}
