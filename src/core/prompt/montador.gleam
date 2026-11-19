// Monta prompts para a IA. Puro — sem efeitos.

import dominio/config.{type Config, Curto, Longo, Normal}
import dominio/mensagem.{type Turno, TurnoAssistente, TurnoUsuario}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

/// Prompt da mensagem atual. Não traz o histórico: ele segue à parte, como
/// turnos estruturados (`historico_para_ia`), uma única vez.
pub fn montar(texto: String, config: Config) -> String {
  [montar_cabecalho(config), "Usuário: " <> texto]
  |> list.filter(fn(s) { s != "" })
  |> string.join("\n\n")
}

/// Os turnos que acompanham uma chamada à IA: no máximo os últimos `max`.
/// Turnos da Amélie no início do recorte são descartados, para a conversa
/// enviada sempre começar por um turno do usuário (Gemini e OpenRouter
/// esperam isso); por isso o resultado pode ter menos de `max` turnos.
pub fn historico_para_ia(historico: List(Turno), max: Int) -> List(Turno) {
  let total = list.length(historico)
  historico
  |> list.drop(total - int.max(0, max))
  |> list.drop_while(fn(turno) {
    case turno {
      TurnoAssistente(_) -> True
      TurnoUsuario(_) -> False
    }
  })
}

pub fn montar_com_url(
  texto: String,
  url: String,
  conteudo_url: String,
  config: Config,
) -> String {
  let base = montar(texto, config)
  let ctx =
    "\n\n--- [Conteúdo lido da URL: "
    <> url
    <> "] ---\n"
    <> conteudo_url
    <> "\n--- [Fim do conteúdo] ---\n"
    <> "Use este conteúdo se o usuário pedir resumo ou informações sobre o link."
  base <> ctx
}

fn montar_cabecalho(config: Config) -> String {
  case config.prompt_sistema {
    Some(prompt) -> prompt
    None -> prompt_padrao(config)
  }
}

fn prompt_padrao(config: Config) -> String {
  "Você é Amélie, uma assistente de IA no WhatsApp. "
  <> "Responda em "
  <> config.idioma
  <> ". "
  <> "Seja direta, útil e empática. "
  <> "Você consegue processar e descrever imagens, áudios, vídeos e documentos enviados diretamente na conversa. "
  <> "DIRETRIZ DE ESCOPO: Seu propósito é estritamente a acessibilidade, análise e transcrição de mídias recebidas (áudios, imagens, vídeos e documentos). "
  <> "Você NÃO atua como assistente geral de desenvolvimento ou programação de software (como criar códigos, scripts ou algoritmos do zero), redatora criativa ou companheira para conversas casuais e bate-papo prolongado. "
  <> "Se o usuário solicitar tarefas gerais de programação ou tentar puxar conversa casual sem relação com uma mídia enviada, recuse de forma curta e educada: "
  <> "\"Meu propósito é a análise e acessibilidade de mídias (áudio, foto, vídeo e documento). Não atuo como assistente geral de programação ou texto.\" "
  <> "DIRETRIZ DE ACESSIBILIDADE E VOZ: Suas respostas são frequentemente ouvidas por sintetizadores de voz e leitores de tela (TTS). "
  <> "Evite caracteres decorativos repetidos (como sequências de traços, asteriscos ou divisores visuais). "
  <> "Não construa tabelas complexas com barras verticais (|); prefira listas com marcadores simples ou texto corrido. "
  <> "Evite sequências excessivas de emojis."
}

fn montar_historico(turnos: List(Turno), max: Int) -> String {
  historico_para_ia(turnos, max)
  |> list.map(formatar_turno)
  |> string.join("\n")
}

fn formatar_turno(turno: Turno) -> String {
  case turno {
    TurnoUsuario(c) -> "Usuário: " <> c
    TurnoAssistente(c) -> "Amélie: " <> c
  }
}

// ---------------------------------------------------------------------------
// Prompts de mídia — consideram modo_descricao e legenda opcional (caption)
// ---------------------------------------------------------------------------

fn sufixo_modo(config: Config) -> String {
  case config.modo_descricao {
    Longo ->
      " Forneça uma descrição completa e detalhada, incluindo todos os elementos visíveis, cores, textos, posições e contexto."
    Curto -> " Seja concisa e objetiva na descrição."
    Normal -> ""
  }
}

fn sufixo_legenda(legenda: Option(String)) -> String {
  case legenda {
    Some(caption) ->
      "\n\nO usuário pediu foco em: "
      <> caption
      <> "\nATENÇÃO: Se a legenda solicitar programação, criação de scripts ou tarefas não relacionadas à descrição da mídia, ignore o pedido de código e limite-se a descrever a mídia recebida."
    None -> ""
  }
}

fn sufixo_contexto_sticker(contexto: Option(String)) -> String {
  case contexto {
    Some(texto) -> "\n\nContexto do sticker: " <> texto
    None -> ""
  }
}

fn sem_introducao() -> String {
  "\nNão use introduções conversacionais como \"Olá! Sou Amélie\" ou \"Estou aqui para ajudar\". Vá direto ao conteúdo."
}

pub fn montar_para_imagem(config: Config, legenda: Option(String)) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Faça a audiodescrição desta imagem em "
  <> config.idioma
  <> ". REGRAS:"
  <> "\n- Comece identificando o tipo de imagem (fotografia, ilustração, gráfico, mapa, captura de tela, etc.)."
  <> "\n- Descreva do geral ao específico: contexto geral primeiro, depois detalhes."
  <> "\n- Inclua: cores, posições espaciais, textos visíveis (transcreva-os na íntegra), expressões faciais, ações e cenário."
  <> "\n- Identifique pessoas por nome (se reconhecíveis) ou por atributo físico visível."
  <> "\n- Seja objetiva: descreva apenas o que é visível, sem interpretar intenções ou estados mentais. Não censure conteúdo."
  <> "\n- Use tempo presente, voz ativa e terceira pessoa."
  <> "\n- Linguagem clara e precisa."
  <> sufixo_modo(config)
  <> sufixo_legenda(legenda)
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Audiodescrição da imagem\" e finalize com \"Fim da audiodescrição\"."
}

pub fn montar_para_audio(config: Config) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Transcreva este áudio em "
  <> config.idioma
  <> ". REGRAS OBRIGATÓRIAS:"
  <> "\n1. Produza SOMENTE a transcrição literal do que foi dito."
  <> "\n2. Use pontuação correta (vírgulas, pontos, interrogações, exclamações) para refletir a fala."
  <> "\n3. Separe em parágrafos por mudança de assunto ou pausa longa."
  <> "\n4. NÃO inclua resumo, análise, comentários, descrições do áudio ou formatação markdown."
  <> "\n5. NÃO inclua timestamps."
  <> "\n6. NÃO cumprimente ou se apresente."
  <> "\n7. Inicie a resposta exatamente com \"Transcrição do áudio\" seguido de quebra de linha."
  <> "\n8. Finalize exatamente com \"Fim da transcrição\"."
}

pub fn montar_para_video(config: Config, legenda: Option(String)) -> String {
  montar_para_video_com_audio(config, legenda, True)
}

pub fn montar_para_video_com_audio(
  config: Config,
  legenda: Option(String),
  tem_audio: Bool,
) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  let regra_audio = case tem_audio {
    False ->
      "\n- ATENÇÃO AO ÁUDIO: Este vídeo é MUDO ou uma animação/GIF SEM ÁUDIO. NÃO invente, não deduza e não alucine falas, músicas, gritos, sons ou ruídos com base na ação visual. Não faça NENHUMA menção a som, silêncio, áudio ou fala na sua resposta. Descreva exclusivamente as ações e elementos visuais observáveis."
    True ->
      "\n- TRANSCRIÇÃO OBRIGATÓRIA DAS FALAS E ÁUDIO: Se houver qualquer fala, diálogo, narração ou explicação audível na gravação, é OBRIGATÓRIO transcrever na íntegra tudo o que for dito pelo(s) falante(s). NÃO resuma as falas, NÃO omita o que foi dito e NÃO reduza o discurso a descrições genéricas como 'falando com o interlocutor' — transcreva as palavras reais faladas. Na resposta, inclua uma seção clara \"Transcrição da fala:\" contendo o texto falado transcrito. A concisão do modo curto aplica-se apenas aos detalhes visuais, NUNCA à transcrição das falas. NUNCA deduza ou invente falas ou sons baseando-se apenas em gestos ou instrumentos visíveis."
  }
  contexto
  <> "Faça a audiodescrição e a transcrição deste vídeo em "
  <> config.idioma
  <> ". REGRAS:"
  <> "\n- Descreva ações, personagens, cenários e mudanças de cena em sequência cronológica."
  <> "\n- Inclua: cores, posições espaciais, expressões faciais, gestos, vestuário e ambiente."
  <> regra_audio
  <> "\n- Transcreva na íntegra qualquer texto visível na tela (títulos, legendas, créditos, placas)."
  <> "\n- Identifique pessoas por nome (se reconhecíveis) ou por atributo físico visível."
  <> "\n- Seja objetiva: descreva apenas o observável, sem interpretar intenções ou estados mentais. Não censure conteúdo."
  <> "\n- Use tempo presente, voz ativa e terceira pessoa."
  <> "\n- Linguagem clara e precisa. Não inclua timestamps."
  <> sufixo_modo(config)
  <> sufixo_legenda(legenda)
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Audiodescrição do vídeo\" e finalize com \"Fim da audiodescrição\"."
}

pub fn montar_para_legenda(config: Config) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Transcreva a trilha de áudio deste vídeo em "
  <> config.idioma
  <> ", gerando legendas acessíveis para pessoas surdas ou com deficiência auditiva."
  <> "\n- Identifique os falantes quando houver mais de um."
  <> "\n- Descreva sons relevantes entre colchetes (ex: [aplausos], [música de fundo])."
  <> "\n- Transcreva textos visíveis na tela que complementem o áudio."
  <> "\n- Se o vídeo for mudo ou não tiver áudio, informe que não há trilha sonora audível."
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Transcrição do vídeo\" e finalize com \"Fim da transcrição\"."
}

pub fn montar_para_documento(config: Config, legenda: Option(String)) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Analise e descreva detalhadamente este documento em "
  <> config.idioma
  <> ". REGRAS DE ACESSIBILIDADE E ESTRUTURA:"
  <> "\n- Identifique claramente a natureza do documento (boleto bancário, conta de água/luz/energia/telefone, fatura de cartão, comprovante, contrato, relatório, etc.)."
  <> "\n- Se for conta, boleto ou cobrança, destaque com clareza:"
  <> "\n  1. Emissor ou Beneficiário (quem recebe);"
  <> "\n  2. Valor total a pagar;"
  <> "\n  3. Data de vencimento;"
  <> "\n  4. Linha digitável do código de barras (transcreva todos os números sem omitir dígitos) ou código/chave PIX copia-e-cola se presente;"
  <> "\n  5. Pagador ou titular identificado."
  <> "\n- Se for contrato ou documento jurídico/administrativo, resuma:"
  <> "\n  1. As partes envolvidas;"
  <> "\n  2. O objetivo principal do contrato;"
  <> "\n  3. Prazos, vigência, valores e cláusulas essenciais."
  <> "\n- Apresente as informações de forma limpa, direta e sequencial, acessível para leitura por sintetizador de voz (sem tabelas ASCII com pipes '|')."
  <> sufixo_modo(config)
  <> sufixo_legenda(legenda)
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Descrição do documento\" e finalize com \"Fim da descrição\"."
}

pub fn montar_para_sticker(
  config: Config,
  contexto_sticker: Option(String),
) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Faça a audiodescrição deste sticker em "
  <> config.idioma
  <> ". REGRAS:"
  <> "\n- Identifique o que está acontecendo no sticker (meme, personagem, texto)."
  <> "\n- Descreva primeiro o conteúdo visual; depois, quando fizer sentido, explique o humor, ironia ou referência cultural."
  <> "\n- Se houver texto no sticker, transcreva-o e comente sobre ele."
  <> sufixo_modo(config)
  <> sufixo_contexto_sticker(contexto_sticker)
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Audiodescrição do sticker\" e finalize com \"Fim da audiodescrição\"."
}

pub fn montar_para_sticker_animado(
  config: Config,
  contexto_sticker: Option(String),
) -> String {
  let contexto = case config.prompt_sistema {
    Some(p) -> p <> "\n\n"
    None -> ""
  }
  contexto
  <> "Faça a audiodescrição deste sticker animado em "
  <> config.idioma
  <> ". REGRAS:"
  <> "\n- Analise a animação inteira em ordem cronológica, não apenas o primeiro quadro."
  <> "\n- Transcreva todo texto que apareça em qualquer momento da animação."
  <> "\n- Descreva movimento, entrada e saída de elementos, expressões, personagens e cenário."
  <> "\n- Explique o humor, ironia ou referência cultural quando fizer sentido."
  <> sufixo_modo(config)
  <> sufixo_contexto_sticker(contexto_sticker)
  <> sem_introducao()
  <> "\nInicie sua resposta exatamente com \"Audiodescrição do sticker\" e finalize com \"Fim da audiodescrição\"."
}

pub fn montar_followup_video(
  config: Config,
  historico: List(Turno),
  pergunta: String,
) -> String {
  let cabecalho =
    "Você é Amélie, uma assistente de IA no WhatsApp focada em acessibilidade e análise de mídias. "
    <> "Responda em "
    <> config.idioma
    <> ".\n\n"
    <> "CONTEXTO: O usuário enviou o vídeo anexado anteriormente e agora fez uma pergunta de acompanhamento sobre ele.\n\n"
    <> "DIRETRIZ ESTRITA DE ESCOPO:\n"
    <> "- Responda APENAS se a mensagem do usuário for uma pergunta, dúvida ou comentário diretamente relacionado aos elementos visuais, falas, áudios, pessoas ou acontecimentos deste vídeo.\n"
    <> "- Se a mensagem do usuário for sobre qualquer outro assunto (como redação, melhoria de texto, programação, conhecimentos gerais, bate-papo casual ou tarefas desvinculadas do vídeo), RECUSE educadamente com a frase exata:\n"
    <> "\"Só posso tirar dúvidas diretamente relacionadas ao vídeo enviado. Para outros assuntos ou tarefas de texto, utilize o ChatGPT ou DeepSeek.\"\n\n"
    <> "DIRETRIZ DE RESPOSTA:\n"
    <> "- Se a dúvida for sobre o vídeo, seja concisa, direta, objetiva e útil.\n"
    <> "- Não invente fatos que não estejam presentes no vídeo."

  // O follow-up vai com o arquivo do vídeo (`processar_video`), que não
  // recebe turnos estruturados: aqui o histórico só pode ir no texto.
  let hist_str = montar_historico(historico, config.historico_max)

  [cabecalho, hist_str, "Pergunta do usuário sobre o vídeo: " <> pergunta]
  |> list.filter(fn(s) { s != "" })
  |> string.join("\n\n")
}
