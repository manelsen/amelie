/**
 * ServicoMensagem - Centraliza o envio de mensagens no sistema
 * 
 * Implementa o padrão Railway com abordagem funcional para tratamento de erros.
 * 
 * @author Manel
 * @version 2.0.0
 */

const fs = require('fs');
const path = require('path');

// Versão simples do padrão Railway para fluxo de erros
const Resultado = {
  sucesso: (dados) => ({ sucesso: true, dados, erro: null }),
  falha: (erro) => ({ sucesso: false, dados: null, erro }),
  
  // Funções utilitárias para encadeamento
  mapear: (resultado, fn) => resultado.sucesso ? Resultado.sucesso(fn(resultado.dados)) : resultado,
  encadear: (resultado, fn) => resultado.sucesso ? fn(resultado.dados) : resultado,
  
  // Manipuladores de resultado
  dobrar: (resultado, aoSucesso, aoFalhar) => 
    resultado.sucesso ? aoSucesso(resultado.dados) : aoFalhar(resultado.erro)
};

/**
 * Funções puras - Processamento de texto
 */

// Função limparTextoResposta removida por redundância.
// A limpeza principal ocorre em GerenciadorAI.js.
/**
 * Obtém texto de resposta seguro
 * @param {string} texto - Texto original
 * @returns {Resultado} Resultado com texto processado
 */
const obterRespostaSegura = (texto) => {
  // Verificar nulidade e tipo no texto recebido (já processado por GerenciadorAI)
  if (!texto || typeof texto !== 'string') {
    return Resultado.falha(new Error("Texto de resposta nulo ou não é string"));
  }
  // Verificar se o texto está vazio após a limpeza prévia em GerenciadorAI
  // Usar trim() aqui apenas para a verificação de vazio.
  if (texto.trim() === '') {
    return Resultado.falha(new Error("Texto de resposta vazio após limpeza prévia"));
  }
  // Retorna o texto como está, confiando na limpeza anterior.
  return Resultado.sucesso(texto);
};

/**
 * Funções puras - Geração de snapshots
 */

/**
 * Captura snapshot de uma mensagem original
 * @param {Object} mensagemOriginal - Mensagem original
 * @param {Object} cliente - Cliente WhatsApp
 * @param {Object} registrador - Registrador para logs
 * @returns {Promise<Resultado>} Resultado com snapshot da mensagem
 */
const capturarSnapshotMensagem = async (mensagemOriginal, cliente, registrador) => {
  try {
    if (!mensagemOriginal) {
      return Resultado.falha(new Error("Mensagem original não fornecida"));
    }
    
    // Extrair dados essenciais da mensagem
    const snapshot = {
      id: mensagemOriginal.id && mensagemOriginal.id._serialized ? mensagemOriginal.id._serialized : null,
      body: mensagemOriginal.body || '',
      tipo: mensagemOriginal.type || 'texto',
      data: new Date().toISOString(),
      
      // Metadados do remetente
      remetente: {
        id: mensagemOriginal.author || mensagemOriginal.from,
        nome: null // será preenchido abaixo
      },
      
      // Metadados do chat
      chat: {
        id: null,
        tipo: null,
        nome: null
      },
      
      // Dados técnicos para referência
      referenciaTecnica: {
        stanzaId: mensagemOriginal._data ? mensagemOriginal._data.id : null,
        participant: mensagemOriginal._data ? mensagemOriginal._data.participant : null
      },
      
      // Flag para indicar se há mídia
      temMidia: mensagemOriginal.hasMedia || false,
      tipoMidia: mensagemOriginal.hasMedia ? (mensagemOriginal.type || 'desconhecido') : null,
      
      // Timestamp de criação do snapshot
      timestampSnapshot: Date.now()
    };
    
    // Tentar obter nome do remetente
    try {
      if (cliente) {
        const contato = await cliente.getContactById(snapshot.remetente.id);
        snapshot.remetente.nome = contato.pushname || contato.name || contato.shortName || 'Usuário';
      } else {
        snapshot.remetente.nome = 'Usuário';
      }
    } catch (erroContato) {
      registrador.debug(`Erro ao obter nome do contato: ${erroContato.message}`);
      snapshot.remetente.nome = 'Usuário';
    }
    
    // Obter dados do chat
    try {
      if (typeof mensagemOriginal.getChat === 'function') {
        const chat = await mensagemOriginal.getChat();
        snapshot.chat.id = chat.id._serialized;
        snapshot.chat.tipo = chat.isGroup ? 'grupo' : 'individual';
        snapshot.chat.nome = chat.name || (chat.isGroup ? 'Grupo' : 'Chat');
      } else {
        snapshot.chat.id = mensagemOriginal.from;
        snapshot.chat.tipo = mensagemOriginal.from.includes('@g.us') ? 'grupo' : 'individual';
        snapshot.chat.nome = 'Chat';
      }
    } catch (erroChat) {
      registrador.debug(`Erro ao obter dados do chat: ${erroChat.message}`);
      snapshot.chat.id = mensagemOriginal.from;
      snapshot.chat.tipo = mensagemOriginal.from.includes('@g.us') ? 'grupo' : 'individual';
      snapshot.chat.nome = 'Chat';
    }
    
    // Se for mídia, capturar descrição
    if (snapshot.temMidia) {
      try {
        if (mensagemOriginal.type === 'image') {
          snapshot.descricaoMidia = '📷 [Imagem]';
        } else if (mensagemOriginal.type === 'video') {
          snapshot.descricaoMidia = '🎥 [Vídeo]';
        } else if (mensagemOriginal.type === 'audio' || mensagemOriginal.type === 'ptt') {
          snapshot.descricaoMidia = '🔊 [Áudio]';
        } else if (mensagemOriginal.type === 'document') {
          snapshot.descricaoMidia = '📄 [Documento]';
        } else {
          snapshot.descricaoMidia = '[Mídia]';
        }
      } catch (erroMidia) {
        snapshot.descricaoMidia = '[Mídia]';
      }
    }
    
    return Resultado.sucesso(snapshot);
  } catch (erro) {
    registrador.error(`Erro ao capturar snapshot de mensagem: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

/**
 * Gera texto de contexto a partir de um snapshot
 * @param {Object} snapshot - Snapshot da mensagem original
 * @returns {Resultado} Resultado com texto de contexto
 */
const gerarTextoContexto = (snapshot) => {
  if (!snapshot) {
    return Resultado.falha(new Error("Snapshot não fornecido"));
  }
  
  try {
    let textoContexto;
    
    // Para mensagens de texto simples
    if (!snapshot.temMidia) {
      textoContexto = `📩 Em resposta a ${snapshot.remetente.nome}: "${snapshot.body.substring(0, 50)}${snapshot.body.length > 50 ? '...' : ''}"`;
    }
    // Para mensagens com mídia
    else if (snapshot.temMidia) {
      const textoAdicional = snapshot.body ? ` com mensagem: "${snapshot.body.substring(0, 30)}${snapshot.body.length > 30 ? '...' : ''}"` : '';
      textoContexto = `📩 Em resposta a ${snapshot.descricaoMidia} de ${snapshot.remetente.nome}${textoAdicional}`;
    }
    else {
      textoContexto = `📩 Em resposta a uma mensagem anterior`;
    }
    
    return Resultado.sucesso(textoContexto);
  } catch (erro) {
    return Resultado.falha(erro);
  }
};

/**
 * Verifica se a mensagem original ainda está utilizável
 * @param {Object} mensagem - Objeto de mensagem
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado indicando se a mensagem está utilizável
 */
const verificarMensagemUtilizavel = async (mensagem, registrador) => {
  try {
    if (!mensagem) {
      return Resultado.falha(new Error("Mensagem não fornecida"));
    }
    
    // Verificar propriedades básicas
    if (!mensagem.id || !mensagem.from) {
      return Resultado.falha(new Error("Mensagem sem propriedades essenciais"));
    }
    
    // Verificar se o método reply está acessível
    if (typeof mensagem.reply !== 'function') {
      return Resultado.falha(new Error("Método reply não disponível na mensagem"));
    }
    
    // Tentar acessar o chat associado (operação que falha se a mensagem expirou)
    if (typeof mensagem.getChat === 'function') {
      try {
        await mensagem.getChat();
      } catch (erroChatAcesso) {
        return Resultado.falha(new Error(`Não foi possível acessar o chat: ${erroChatAcesso.message}`));
      }
    }
    
    return Resultado.sucesso(true);
  } catch (erro) {
    registrador.debug(`Erro ao verificar mensagem: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

/**
 * Funções puras - Estratégias de envio
 */

/**
 * Estratégia 1: Tentativa de envio direto com reply
 * @param {Object} mensagemOriginal - Mensagem original para responder
 * @param {string} textoSeguro - Texto já processado para resposta
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const envioComReplyDireto = async (mensagemOriginal, textoSeguro, registrador) => {
  try {
    await mensagemOriginal.reply(textoSeguro);
    return Resultado.sucesso({ metodoUsado: 'reply_direto' });
  } catch (erroReply) {
    registrador.warn(`❗ Falha no método reply direto: ${erroReply.message}`);
    return Resultado.falha(erroReply);
  }
};

/**
 * Estratégia 2: Tentativa de envio com citação via ID
 * @param {Object} clienteWhatsApp - Cliente WhatsApp
 * @param {string} destinatario - ID do destinatário
 * @param {string} textoSeguro - Texto já processado para resposta
 * @param {string} mensagemOriginalId - ID da mensagem original
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const envioComCitacaoId = async (clienteWhatsApp, destinatario, textoSeguro, mensagemOriginalId, registrador) => {
  try {
    await clienteWhatsApp.cliente.sendMessage(
      destinatario, 
      textoSeguro, 
      { quotedMessageId: mensagemOriginalId }
    );
    return Resultado.sucesso({ metodoUsado: 'citacao_id' });
  } catch (erroCitacao) {
    registrador.warn(`Falha na citação via ID: ${erroCitacao.message}`);
    return Resultado.falha(erroCitacao);
  }
};

/**
 * Estratégia 3: Envio com contexto reconstruído via snapshot
 * @param {Object} clienteWhatsApp - Cliente WhatsApp
 * @param {string} destinatario - ID do destinatário
 * @param {string} textoSeguro - Texto já processado para resposta
 * @param {Object} snapshot - Snapshot da mensagem original
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const envioComContextoSnapshot = async (clienteWhatsApp, destinatario, textoSeguro, snapshot, registrador) => {
  try {
    const resultadoContexto = gerarTextoContexto(snapshot);
    
    return Resultado.dobrar(
      resultadoContexto,
      async (textoContexto) => {
        const conteudoComContexto = `${textoContexto}\n\n${textoSeguro}`;
        
        registrador.info(`Enviando com contexto reconstruído via snapshot para ${destinatario}`);
        
        await clienteWhatsApp.cliente.sendMessage(destinatario, conteudoComContexto);
        return Resultado.sucesso({ metodoUsado: 'contexto_snapshot' });
      },
      (erro) => {
        registrador.error(`Erro ao gerar contexto: ${erro.message}`);
        return Resultado.falha(erro);
      }
    );
  } catch (erroSnapshot) {
    registrador.error(`Falha no envio com snapshot: ${erroSnapshot.message}`);
    return Resultado.falha(erroSnapshot);
  }
};

/**
 * Estratégia 4: Envio direto sem contexto (último recurso)
 * @param {Object} clienteWhatsApp - Cliente WhatsApp
 * @param {string} destinatario - ID do destinatário
 * @param {string} textoSeguro - Texto já processado para resposta
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const envioDiretoSemContexto = async (clienteWhatsApp, destinatario, textoSeguro, registrador) => {
  try {
    registrador.warn(`⚠️ ALERTA DE ACESSIBILIDADE: Enviando sem preservação de contexto para ${destinatario}`);
    
    await clienteWhatsApp.cliente.sendMessage(destinatario, textoSeguro);
    return Resultado.sucesso({ metodoUsado: 'direto_sem_contexto' });
  } catch (erroDireto) {
    registrador.error(`Falha no envio direto: ${erroDireto.message}`);
    return Resultado.falha(erroDireto);
  }
};

/**
 * Funções para integração com transações e recuperação
 */

/**
 * Salva a mensagem como notificação pendente para recuperação posterior
 * @param {Object} clienteWhatsApp - Cliente WhatsApp
 * @param {string} destinatario - ID do destinatário
 * @param {string} texto - Texto da mensagem
 * @param {Object} snapshot - Snapshot da mensagem original (opcional)
 * @param {string} transacaoId - ID da transação (opcional)
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const salvarComoNotificacaoPendente = async (clienteWhatsApp, destinatario, texto, snapshot, transacaoId, registrador) => {
  try {
    if (!destinatario) {
      return Resultado.falha(new Error("Destinatário não fornecido"));
    }
    
    // Se temos snapshot, salvar com contexto reconstruído
    const resultadoFinal = await Resultado.encadear(
      snapshot ? gerarTextoContexto(snapshot) : Resultado.sucesso(null),
      async (textoContexto) => {
        try {
          const conteudoFinal = textoContexto 
            ? `${textoContexto}\n\n${texto}`
            : texto;
          
          // Apenas salvar usando a interface do cliente WhatsApp
          const caminhoNotificacao = await clienteWhatsApp.salvarNotificacaoPendente(
            destinatario, 
            conteudoFinal,
            { transacaoId, temContexto: !!textoContexto }
          );
          
          registrador.info(`Mensagem salva como notificação pendente para ${destinatario}: ${caminhoNotificacao}`);
          return Resultado.sucesso({ salvo: true, caminho: caminhoNotificacao });
        } catch (erroSalvar) {
          return Resultado.falha(erroSalvar);
        }
      }
    );
    
    return resultadoFinal;
  } catch (erro) {
    registrador.error(`Erro ao salvar notificação pendente: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

/**
 * Atualiza o status da transação
 * @param {Object} gerenciadorTransacoes - Gerenciador de transações (opcional)
 * @param {string} transacaoId - ID da transação
 * @param {boolean} sucesso - Indica se a operação foi bem-sucedida
 * @param {Error} erro - Objeto de erro (opcional)
 * @param {Object} registrador - Objeto para logging
 * @returns {Promise<Resultado>} Resultado da operação
 */
const atualizarStatusTransacao = async (gerenciadorTransacoes, transacaoId, sucesso, erro, registrador) => {
  if (!gerenciadorTransacoes || !transacaoId) {
    return Resultado.sucesso({ transacaoAtualizada: false });
  }
  
  try {
    if (sucesso) {
      await gerenciadorTransacoes.marcarComoEntregue(transacaoId);
      registrador.debug(`Transação ${transacaoId} marcada como entregue`);
    } else if (erro) {
      await gerenciadorTransacoes.registrarFalhaEntrega(
        transacaoId,
        `Erro ao enviar: ${erro.message}`
      );
      registrador.debug(`Falha registrada para transação ${transacaoId}: ${erro.message}`);
    }
    return Resultado.sucesso({ transacaoAtualizada: true });
  } catch (erroTransacao) {
    registrador.error(`Erro ao atualizar transação: ${erroTransacao.message}`);
    return Resultado.falha(erroTransacao);
  }
};

/**
 * Cria o serviço de mensagens centralizado
 * @param {Object} registrador - Registrador para logs
 * @param {Object} clienteWhatsApp - Cliente WhatsApp
 * @param {Object} gerenciadorTransacoes - Gerenciador de transações (opcional)
 * @returns {Object} Serviço de mensagens com métodos públicos
 */
const criarServicoMensagem = (registrador, clienteWhatsApp, gerenciadorTransacoes = null) => {
  
  /**
   * Função central para envio de mensagens com estratégias em fallback
   * Implementa o padrão Railway para tratamento de erros
   * @param {Object} mensagemOriginal - Mensagem original
   * @param {string} texto - Texto da resposta
   * @param {string} transacaoId - ID da transação (opcional)
   * @returns {Promise<Resultado>} Resultado do envio
   */
  const enviarResposta = async (mensagemOriginal, texto, transacaoId = null) => {
    // Obter texto seguro
    const resultadoTexto = obterRespostaSegura(texto);
    
    if (!resultadoTexto.sucesso) {
      registrador.error(`Texto inválido: ${resultadoTexto.erro.message}`);
      return resultadoTexto;
    }
    
    const textoSeguro = resultadoTexto.dados;
    
    // Capturar snapshot para preservação de contexto
    const resultadoSnapshot = await capturarSnapshotMensagem(
      mensagemOriginal, 
      clienteWhatsApp.cliente,
      registrador
    );
    
    // Snapshot opcional - continuar mesmo sem ele
    const snapshot = resultadoSnapshot.sucesso ? resultadoSnapshot.dados : null;
    
    // Verificar destinatário para fallbacks
    const destinatario = mensagemOriginal?.from || mensagemOriginal?.author;
    if (!destinatario) {
      const erro = new Error("Impossível determinar destinatário para resposta");
      registrador.error(erro.message);
      return Resultado.falha(erro);
    }
    
    // Sequência de estratégias de envio em pipeline
    
    // ESTRATÉGIA 1: Resposta direta com citação (o método ideal)
    const resultadoVerificacao = await verificarMensagemUtilizavel(mensagemOriginal, registrador);
    
    if (resultadoVerificacao.sucesso) {
      const resultadoReplyDireto = await envioComReplyDireto(mensagemOriginal, textoSeguro, registrador);
      
      if (resultadoReplyDireto.sucesso) {
        // Atualizar status da transação
        await atualizarStatusTransacao(gerenciadorTransacoes, transacaoId, true, null, registrador);
        return resultadoReplyDireto;
      }
      // Continuar para a próxima estratégia se falhar
    }
    
    // ESTRATÉGIA 2: Tentar usar citação via ID
    if (mensagemOriginal?.id?._serialized) {
      const resultadoCitacao = await envioComCitacaoId(
        clienteWhatsApp, 
        destinatario, 
        textoSeguro,
        mensagemOriginal.id._serialized,
        registrador
      );
      
      if (resultadoCitacao.sucesso) {
        // Atualizar status da transação
        await atualizarStatusTransacao(gerenciadorTransacoes, transacaoId, true, null, registrador);
        return resultadoCitacao;
      }
      // Continuar para a próxima estratégia se falhar
    }
    
    // ESTRATÉGIA 3: Usar snapshot para criar contexto textual
    if (snapshot) {
      const resultadoContexto = await envioComContextoSnapshot(
        clienteWhatsApp,
        destinatario,
        textoSeguro,
        snapshot,
        registrador
      );
      
      if (resultadoContexto.sucesso) {
        // Atualizar status da transação
        await atualizarStatusTransacao(gerenciadorTransacoes, transacaoId, true, null, registrador);
        return resultadoContexto;
      }
      // Continuar para a próxima estratégia se falhar
    }
    
    // ESTRATÉGIA 4: Envio direto sem contexto (último recurso)
    const resultadoDireto = await envioDiretoSemContexto(
      clienteWhatsApp,
      destinatario,
      textoSeguro,
      registrador
    );
    
    if (resultadoDireto.sucesso) {
      // Atualizar status da transação
      await atualizarStatusTransacao(gerenciadorTransacoes, transacaoId, true, null, registrador);
      return resultadoDireto;
    }
    
    // Todas as estratégias falharam, salvar para recuperação posterior
    const erro = new Error("Todas as estratégias de envio falharam");
    registrador.error(erro.message);
    
    // Salvar notificação pendente e atualizar transação
    await salvarComoNotificacaoPendente(clienteWhatsApp, destinatario, textoSeguro, snapshot, transacaoId, registrador);
    await atualizarStatusTransacao(gerenciadorTransacoes, transacaoId, false, erro, registrador);
    
    return Resultado.falha(erro);
  };
  
  /**
   * Envia mensagem direta sem contexto (para mensagens do sistema)
   * @param {string} destinatario - ID do destinatário
   * @param {string} texto - Texto da mensagem
   * @param {Object} opcoes - Opções adicionais (opcional)
   * @returns {Promise<Resultado>} Resultado do envio
   */
  const enviarMensagemDireta = async (destinatario, texto, opcoes = {}) => {
    // Obter texto seguro
    const resultadoTexto = obterRespostaSegura(texto);
    
    if (!resultadoTexto.sucesso) {
      registrador.error(`Texto inválido: ${resultadoTexto.erro.message}`);
      return resultadoTexto;
    }
    
    const textoSeguro = resultadoTexto.dados;
    
    try {
      await clienteWhatsApp.cliente.sendMessage(destinatario, textoSeguro);
      
      // Atualizar transação se fornecida
      if (opcoes.transacaoId) {
        await atualizarStatusTransacao(gerenciadorTransacoes, opcoes.transacaoId, true, null, registrador);
      }
      
      return Resultado.sucesso({ metodoUsado: 'envio_direto' });
    } catch (erro) {
      registrador.error(`Erro no envio direto para ${destinatario}: ${erro.message}`);
      
      // Atualizar transação se fornecida
      if (opcoes.transacaoId) {
        await atualizarStatusTransacao(gerenciadorTransacoes, opcoes.transacaoId, false, erro, registrador);
      }
      
      // Salvar como notificação pendente
      await salvarComoNotificacaoPendente(clienteWhatsApp, destinatario, textoSeguro, null, opcoes.transacaoId, registrador);
      
      return Resultado.falha(erro);
    }
  };
  
  /**
   * Recupera e processa notificações pendentes
   * @returns {Promise<Resultado>} Resultado da recuperação
   */
  const processarNotificacoesPendentes = async () => {
    try {
      const notificacoesProcessadas = await clienteWhatsApp.processarNotificacoesPendentes();
      return Resultado.sucesso({ notificacoesProcessadas });
    } catch (erro) {
      registrador.error(`Erro ao processar notificações pendentes: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };
  
  // Retornar objeto imutável com métodos públicos
  return Object.freeze({
    enviarResposta,
    enviarMensagemDireta,
    processarNotificacoesPendentes,
    
    // Métodos auxiliares úteis para uso externo
    capturarSnapshotMensagem: async (msg) => {
      const resultado = await capturarSnapshotMensagem(msg, clienteWhatsApp.cliente, registrador);
      return Resultado.dobrar(
        resultado,
        (dados) => dados,
        (erro) => {
          registrador.error(`Erro ao capturar snapshot: ${erro.message}`);
          return null;
        }
      );
    },
    
    gerarTextoContexto: (snapshot) => {
      const resultado = gerarTextoContexto(snapshot);
      return Resultado.dobrar(
        resultado,
        (dados) => dados,
        (erro) => {
          registrador.error(`Erro ao gerar texto de contexto: ${erro.message}`);
          return "";
        }
      );
    },
    
    // Compartilhar Resultado para uso externo
    Resultado
  });
};

module.exports = criarServicoMensagem;
