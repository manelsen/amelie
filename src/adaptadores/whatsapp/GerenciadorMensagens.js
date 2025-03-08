/**
 * GerenciadorMensagens - Módulo para processamento de mensagens do WhatsApp
 * 
 * Este módulo coordena o processamento de diferentes tipos de mensagens
 * (texto, imagem, áudio, vídeo) recebidas via WhatsApp.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FilaProcessadorImagem = require('../queue/FilaProcessadorImagem');
const FilaProcessador = require('../queue/FilaProcessador');

class GerenciadorMensagens {
  /**
   * Cria uma instância do gerenciador de mensagens
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {Object} clienteWhatsApp - Instância do cliente WhatsApp
   * @param {Object} gerenciadorConfig - Gerenciador de configurações do sistema
   * @param {Object} gerenciadorAI - Gerenciador de modelos de IA
   * @param {Object} filaProcessamento - Fila de processamento para tarefas assíncronas
   * @param {Object} gerenciadorTransacoes - Gerenciador de transações de mensagens
   */
  constructor(registrador, clienteWhatsApp, gerenciadorConfig, gerenciadorAI, filaProcessamento, gerenciadorTransacoes) {
    this.registrador = registrador;
    this.clienteWhatsApp = clienteWhatsApp;
    this.gerenciadorConfig = gerenciadorConfig;
    this.gerenciadorAI = gerenciadorAI;
    this.filaProcessamento = filaProcessamento;
    this.gerenciadorTransacoes = gerenciadorTransacoes;
    
    // Inicializar a fila de processamento, mas não delegar responsabilidades de resposta
    // A fila agora apenas processa e retorna resultados para este gerenciador

    this.filaProcessamento = new FilaProcessador(
      registrador, 
      gerenciadorAI, 
      null, // Removendo referência direta ao clienteWhatsApp
      { enviarRespostaDireta: false } // Configuração para impedir respostas diretas
    );

    this.filaProcessamentoImagem = new FilaProcessadorImagem(
      registrador, 
      gerenciadorAI, 
      null, // Removendo referência direta ao clienteWhatsApp
      { enviarRespostaDireta: false } // Configuração para impedir respostas diretas
    );

    
    this.ultimoAudioProcessado = null;
    this.diretorioTemp = '../temp';
    
    // Adicionar cache para controle de deduplicação de mensagens
    this.mensagensProcessadas = new Map();
    
    // Intervalo para limpar o cache periodicamente (a cada 30 minutos)
    setInterval(() => this.limparCacheMensagensAntigas(), 30 * 60 * 1000);
    
    // Garantir que o diretório temporário exista
    if (!fs.existsSync(this.diretorioTemp)) {
      fs.mkdirSync(this.diretorioTemp, { recursive: true });
      this.registrador.info('Diretório de arquivos temporários criado');
    }
    
    // Configurar callback para receber resultados de processamento de imagem
    this.configurarCallbacksProcessamento();
  }

/**
 * Inicializa o gerenciador e configura recuperação de mensagens
 */
iniciar() {
  // Registrar como handler de mensagens
  this.clienteWhatsApp.on('mensagem', this.processarMensagem.bind(this));
  this.clienteWhatsApp.on('entrada_grupo', this.processarEntradaGrupo.bind(this));
  
  // NOVO: Configurar ouvinte para recuperar transações após restart
  this.gerenciadorTransacoes.on('transacao_para_recuperar', this.recuperarTransacao.bind(this));
  
  // NOVO: Realizar recuperação inicial após 10 segundos
  setTimeout(async () => {
    await this.gerenciadorTransacoes.recuperarTransacoesIncompletas();
  }, 10000);
  
  this.registrador.info('🚀 GerenciadorMensagens inicializado com recuperação robusta');
}

  /**
   * Configura callbacks para receber resultados do processamento de filas
   */
  configurarCallbacksProcessamento() {
    // Registrar callback para receber respostas da fila de imagem
    this.filaProcessamentoImagem.setRespostaCallback(async (resultado) => {
      try {
        const { resposta, chatId, messageId, senderNumber, transacaoId, remetenteName } = resultado;
        
        // Recuperar mensagem original por referência usando o ID da mensagem
        let mensagemOriginal;
        try {
          mensagemOriginal = await this.clienteWhatsApp.cliente.getMessageById(messageId);
        } catch (erroMsg) {
          this.registrador.error(`Não foi possível recuperar a mensagem original: ${erroMsg.message}`);
          // Tentar enviar sem referência caso não consiga recuperar
          await this.clienteWhatsApp.enviarMensagem(senderNumber, resposta);
          return;
        }
        
        // Enviar resposta usando o cliente WhatsApp - o log será feito dentro deste método
        await this.enviarResposta(mensagemOriginal, resposta);
        
        // Atualizar a transação se houver um ID
        if (transacaoId) {
          await this.gerenciadorTransacoes.adicionarRespostaTransacao(transacaoId, resposta);
          await this.gerenciadorTransacoes.marcarComoEntregue(transacaoId);
        }
      } catch (erro) {
        this.registrador.error(`Erro ao processar resultado da fila de imagem: ${erro.message}`, { erro });
      }
    });
    
    // Verificar se o processador de vídeo tem a função setResultCallback antes de chamar
    if (this.filaProcessamento && typeof this.filaProcessamento.setResultCallback === 'function') {
      this.filaProcessamento.setResultCallback(async (resultado) => {
        try {
          const { resposta, chatId, messageId, senderNumber, transacaoId, remetenteName } = resultado;
          
          // Similar ao callback de imagem, mas para vídeos
          let mensagemOriginal;
          try {
            mensagemOriginal = await this.clienteWhatsApp.cliente.getMessageById(messageId);
          } catch (erroMsg) {
            this.registrador.error(`Não foi possível recuperar a mensagem de vídeo original: ${erroMsg.message}`);
            await this.clienteWhatsApp.enviarMensagem(senderNumber, resposta);
            return;
          }
          
          // Enviar resposta - o log será feito dentro deste método
          await this.enviarResposta(mensagemOriginal, resposta);
          
          // Atualizar a transação
          if (transacaoId) {
            await this.gerenciadorTransacoes.adicionarRespostaTransacao(transacaoId, resposta);
            await this.gerenciadorTransacoes.marcarComoEntregue(transacaoId);
          }
        } catch (erro) {
          this.registrador.error(`Erro ao processar resultado da fila de vídeo: ${erro.message}`, { erro });
        }
      });
    } else {
      this.registrador.warn('Fila de processamento de vídeo não suporta callbacks, algumas funcionalidades podem estar limitadas');
    }
  }

  /**
   * Limpa mensagens antigas do cache de deduplicação
   */
  limparCacheMensagensAntigas() {
    const agora = Date.now();
    let contador = 0;
    
    // Remover mensagens processadas há mais de 15 minutos
    for (const [id, timestamp] of this.mensagensProcessadas.entries()) {
      if (agora - timestamp > 15 * 60 * 1000) {
        this.mensagensProcessadas.delete(id);
        contador++;
      }
    }
    
    if (contador > 0) {
      this.registrador.debug(`Cache de deduplicação: removidas ${contador} entradas antigas`);
    }
  }

  /**
   * Verifica se uma mensagem é uma mensagem de sistema ou apenas metadados
   * @param {Object} msg - Mensagem do WhatsApp
   * @returns {boolean} Verdadeiro se for mensagem de sistema
   */
  ehMensagemSistema(msg) {
    // Verificar se a mensagem tem características de evento de sistema
    
    // 1. Verificar mensagens vazias ou com conteúdo padrão
    if (!msg.body && !msg.hasMedia) {
      return true;
    }
    
    // 2. Verificar tipos específicos de notificação do WhatsApp
    if (msg.type === 'notification' || msg.type === 'e2e_notification' || 
        msg.type === 'notification_template' || msg.type === 'call_log') {
      return true;
    }
    
    // 3. Verificar presença de marcadores específicos no objeto da mensagem
    // que indicam que é um evento de sistema e não uma mensagem real
    if (msg._data && (
        msg._data.subtype === 'system' || 
        msg._data.star === true && !msg.body && !msg.hasMedia || 
        msg._data.isStatusV3 === true ||
        msg._data.isViewOnce === true && !msg.body
    )) {
      return true;
    }
    
    // 4. Se a mensagem tem um ID específico de notificação
    if (msg.id && typeof msg.id.fromMe === 'boolean' && 
        msg.id._serialized && msg.id._serialized.includes('NOTIFICATION')) {
      return true;
    }
    
    return false;
  }

  /**
   * Remove emojis de um texto
   * @param {string} texto - Texto com emojis
   * @returns {string} Texto sem emojis
   */
  removerEmojis(texto) {
    return texto.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F0FF}\u{1F100}-\u{1F2FF}]/gu, '');
  }

  /**
   * Processa uma mensagem recebida do WhatsApp
   * @param {Object} msg - Mensagem do WhatsApp
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarMensagem(msg) {
    try {
      // Verificar deduplicação - não processar a mesma mensagem mais de uma vez
      const mensagemId = msg.id._serialized;
      
      if (this.mensagensProcessadas.has(mensagemId)) {
        this.registrador.debug(`Mensagem ${mensagemId} já processada. Ignorando.`);
        return false;
      }
      
      // Marcar mensagem como processada imediatamente
      this.mensagensProcessadas.set(mensagemId, Date.now());
      
      // Verificação adicional para detectar mensagens de sistema/metadados
      if (this.ehMensagemSistema(msg)) {
        this.registrador.debug(`Mensagem ${mensagemId} identificada como mensagem de sistema/metadados. Ignorando.`);
        return false;
      }
      
      const chat = await msg.getChat();
      await chat.sendSeen();
      
      const chatId = chat.id._serialized;
      const ehGrupo = chat.id._serialized.endsWith('@g.us');
      
      // Verificar se é um comando
      if (msg.body && msg.body.startsWith('/')) {
        return await this.processarComando(msg, chatId);
      }
      
      // Verificar se tem mídia
      if (msg.hasMedia) {
        return await this.processarMensagemComMidia(msg, chatId);
      }
      
      // Verificar regras de resposta para grupos
      if (ehGrupo) {
        const deveResponder = await this.clienteWhatsApp.deveResponderNoGrupo(msg, chat);
        if (!deveResponder) {
          this.registrador.debug("Mensagem não atende critérios de resposta do grupo");
          return false;
        }
      }
      
      // Processar mensagem de texto
      return await this.processarMensagemTexto(msg, chatId);
    } catch (erro) {
      this.registrador.error(`Erro ao processar mensagem: ${erro.message}`, { erro });
      
      try {
        await msg.reply('Desculpe, ocorreu um erro inesperado. Por favor, tente novamente mais tarde.');
      } catch (erroResposta) {
        this.registrador.error(`Não consegui enviar mensagem de erro: ${erroResposta.message}`);
      }
      
      return false;
    }
  }

  /**
   * Processa um comando recebido
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {string} chatId - ID do chat
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarComando(msg, chatId) {
    const [comando, ...args] = msg.body.slice(1).split(' ');
    this.registrador.info(`Comando: ${comando}, Argumentos: ${args}`);
    
    try {
      switch (comando.toLowerCase()) {
        case 'reset':
          await this.gerenciadorConfig.resetarConfig(chatId);
          await this.gerenciadorConfig.limparPromptSistemaAtivo(chatId);
          await msg.reply('Configurações resetadas para este chat. As transcrições de áudio e imagem foram habilitadas, e os prompts especiais foram desativados.');
          return true;

        case 'ajuda':
          const BOT_NAME = process.env.BOT_NAME || 'Amélie';
          const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';

          const textoAjuda = `Olá! Eu sou a ${BOT_NAME}, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Minha idealizadora é a Belle Utsch. 

Quer conhecê-la? Fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da ${BOT_NAME}? O link é ${LINK_GRUPO_OFICIAL}
Meu repositório fica em https://github.com/manelsen/amelie

Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço.

Comandos:

.cego - Aplica configurações para usuários com deficiência visual

.audio - Liga/desliga a transcrição de áudio
.video - Liga/desliga a interpretação de vídeo
.imagem - Liga/desliga a audiodescrição de imagem

.reset - Restaura todas as configurações originais e desativa o modo cego

.ajuda - Mostra esta mensagem de ajuda`;
          
          await msg.reply(textoAjuda);
          return true;

        case 'prompt':
          await this.tratarComandoPrompt(msg, args, chatId);
          return true;

        case 'config':
          await this.tratarComandoConfig(msg, args, chatId);
          return true;

        case 'users':
          await this.listarUsuariosGrupo(msg, chatId);
          return true;

        case 'cego':
          await this.tratarComandoCego(msg, chatId);
          return true;

        case 'audio':
          await this.tratarComandoAlternarMidia(msg, chatId, 'mediaAudio', 'transcrição de áudio');
          return true;

        case 'video':
          await this.tratarComandoAlternarMidia(msg, chatId, 'mediaVideo', 'interpretação de vídeo');
          return true;

        case 'imagem':
          await this.tratarComandoAlternarMidia(msg, chatId, 'mediaImage', 'audiodescrição de imagem');
          return true;

        case 'filas':
          await this.tratarComandoFilas(msg, args, chatId);
          return true;

        default:
          await msg.reply('Comando desconhecido. Use .ajuda para ver os comandos disponíveis.');
          return false;
      }
    } catch (erro) {
      this.registrador.error(`Erro ao processar comando: ${erro.message}`, { erro });
      await msg.reply('Desculpe, ocorreu um erro ao processar seu comando.');
      return false;
    }
  }

  /**
   * Gerencia as filas de processamento (vídeo e imagem)
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {Array} args - Argumentos do comando
   * @param {string} chatId - ID do chat
   */
  async tratarComandoFilas(msg, args, chatId) {
    const ehAdministrador = true; // Mudar isso para sua lógica de verificação de administrador
    
    if (!ehAdministrador) {
      await msg.reply('❌ Desculpe, apenas administradores podem gerenciar as filas.');
      return;
    }
    
    const [subcomando, tipoFila, ...resto] = args;
    
    switch (subcomando) {
      case 'status':
        let relatorio = '';
        
        if (!tipoFila || tipoFila === 'all' || tipoFila === 'todas') {
          // Mostrar status de todas as filas
          const relatorioVideo = await this.filaProcessamento.getFormattedQueueStatus();
          const relatorioImagem = await this.filaProcessamentoImagem.getFormattedQueueStatus();
          relatorio = relatorioVideo + "\n\n" + relatorioImagem;
        } else if (tipoFila === 'video' || tipoFila === 'videos') {
          relatorio = await this.filaProcessamento.getFormattedQueueStatus();
        } else if (tipoFila === 'imagem' || tipoFila === 'imagens' || tipoFila === 'image') {
          relatorio = await this.filaProcessamentoImagem.getFormattedQueueStatus();
        } else {
          await msg.reply('Tipo de fila inválido. Use: todas, video ou imagem');
          return;
        }
        
        await msg.reply(relatorio);
        break;
        
      case 'limpar':
        if (!tipoFila) {
          await msg.reply('Especifique o tipo de fila para limpar: todas, video ou imagem');
          return;
        }
        
        // Opção para limpar tudo ou apenas trabalhos completos
        const apenasCompletos = resto[0] !== 'tudo';
        const avisoLimpeza = apenasCompletos 
          ? 'Limpando apenas trabalhos concluídos e falhas...' 
          : '⚠️ ATENÇÃO: Isso vai limpar TODAS as filas, incluindo trabalhos em andamento!';
        
        await msg.reply(avisoLimpeza);
        
        if (tipoFila === 'all' || tipoFila === 'todas') {
          const resultadoVideo = await this.filaProcessamento.limparFilas(apenasCompletos);
          const resultadoImagem = await this.filaProcessamentoImagem.limparFilas(apenasCompletos);
          await msg.reply(`✅ Limpeza concluída!\nVídeos: ${JSON.stringify(resultadoVideo)}\nImagens: ${JSON.stringify(resultadoImagem)}`);
        } else if (tipoFila === 'video' || tipoFila === 'videos') {
          const resultado = await this.filaProcessamento.limparFilas(apenasCompletos);
          await msg.reply(`✅ Limpeza de filas de vídeo concluída: ${JSON.stringify(resultado)}`);
        } else if (tipoFila === 'imagem' || tipoFila === 'imagens' || tipoFila === 'image') {
          const resultado = await this.filaProcessamentoImagem.limparFilas(apenasCompletos);
          await msg.reply(`✅ Limpeza de filas de imagem concluída: ${JSON.stringify(resultado)}`);
        } else {
          await msg.reply('Tipo de fila inválido. Use: todas, video ou imagem');
        }
        break;
        
      default:
        await msg.reply(`Comando de filas desconhecido. Use:
.filas status [todas|video|imagem] - Mostra status das filas
.filas limpar [todas|video|imagem] [tudo] - Limpa filas (use 'tudo' para limpar mesmo trabalhos em andamento)`);
    }
  }

  /**
   * Registra este gerenciador como handler de mensagens no cliente WhatsApp
   * @param {ClienteWhatsApp} cliente - Instância do cliente WhatsApp
   */
  registrarComoHandler(cliente) {
    cliente.on('mensagem', this.processarMensagem.bind(this));
    cliente.on('entrada_grupo', this.processarEntradaGrupo.bind(this));
  }

  /**
   * Processa o evento de entrada em grupo
   * @param {Object} notificacao - Notificação de entrada no grupo
   */
  async processarEntradaGrupo(notificacao) {
    try {
      if (notificacao.recipientIds.includes(this.clienteWhatsApp.cliente.info.wid._serialized)) {
        const chat = await notificacao.getChat();
        const mensagem = await chat.sendMessage('Olá a todos! Estou aqui para ajudar. Aqui estão alguns comandos que vocês podem usar:');
        
        const BOT_NAME = process.env.BOT_NAME || 'Amélie';
        const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';
        
        const textoAjuda = `Olá! Eu sou a ${BOT_NAME}, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Minha idealizadora é a Belle Utsch. 

Quer conhecê-la? Fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da ${BOT_NAME}? O link é ${LINK_GRUPO_OFICIAL}
Meu repositório fica em https://github.com/manelsen/amelie

Esses são meus comandos disponíveis para configuração:

.cego - Aplica configurações para usuários com deficiência visual

.audio - Liga/desliga a transcrição de áudio
.video - Liga/desliga a interpretação de vídeo
.imagem - Liga/desliga a audiodescrição de imagem

.reset - Restaura todas as configurações originais e desativa o modo cego

.ajuda - Mostra esta mensagem de ajuda`;

        await chat.sendMessage(textoAjuda);
        
        this.registrador.info(`Bot foi adicionado ao grupo "${chat.name}" (${chat.id._serialized}) e enviou a saudação.`);
      }
    } catch (erro) {
      this.registrador.error(`Erro ao processar entrada em grupo: ${erro.message}`, { erro });
    }
  }

  /**
   * Ativa ou desativa um recurso de mídia
   * @param {Object} msg - Mensagem recebida
   * @param {string} chatId - ID do chat
   * @param {string} paramConfig - Parâmetro de configuração
   * @param {string} nomeRecurso - Nome amigável do recurso
   * @async
   */
  async tratarComandoAlternarMidia(msg, chatId, paramConfig, nomeRecurso) {
    try {
      // Obter configuração atual
      const config = await this.gerenciadorConfig.obterConfig(chatId);
      const valorAtual = config[paramConfig] === true;
      
      // Alternar para o valor oposto
      const novoValor = !valorAtual;
      await this.gerenciadorConfig.definirConfig(chatId, paramConfig, novoValor);
      
      // Informar o usuário sobre a nova configuração
      const mensagemStatus = novoValor ? 'ativada' : 'desativada';
      await msg.reply(`A ${nomeRecurso} foi ${mensagemStatus} para este chat.`);
      
      this.registrador.info(`${paramConfig} foi ${mensagemStatus} para o chat ${chatId}`);
      return true;
    } catch (erro) {
      this.registrador.error(`Erro ao alternar ${paramConfig}: ${erro.message}`, { erro });
      await msg.reply(`Desculpe, ocorreu um erro ao alternar a ${nomeRecurso}. Por favor, tente novamente.`);
      return false;
    }
  }

  /**
   * Configura o modo para usuários com deficiência visual
   * @param {Object} msg - Mensagem recebida
   * @param {string} chatId - ID do chat
   * @async
   */
  async tratarComandoCego(msg, chatId) {
    try {
      await this.gerenciadorConfig.definirConfig(chatId, 'mediaImage', true);
      await this.gerenciadorConfig.definirConfig(chatId, 'mediaAudio', false);
      
      const BOT_NAME = process.env.BOT_NAME || 'Amélie';
      const promptAudiomar = `Seu nome é ${BOT_NAME}. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. Seus comandos podem ser encontrados digitando .ajuda. Se alguém perguntar, aqui está sua lista de comandos: .cego - Aplica configurações para usuários com deficiência visual; .audio - Liga/desliga a transcrição de áudio; .video - Liga/desliga a interpretação de vídeo; .imagem - Liga/desliga a audiodescrição de imagem; .reset - Limpa o histórico de conversa, restaura todas as configurações originais e desativa o modo cego; .ajuda - Mostra esta mensagem de ajuda. Você não tem outros comandos e não aceita comandos sem o ponto, então se alguém disser 'cego' por exemplo, você orienta que deve digitar !cego. Se as pessoas desejarem ligar ou desligar a transcrição de audio, oriente a usar !audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima. Sua criadora e idealizadora foi a Belle Utsch. Você é baseada no Google Gemini Flash 2.0. Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo. Você lida com as pessoas com tato e bom humor. Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie. Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch. Você é uma assistente de AI especializada em audiodescrição, projetada para funcionar em um grupo de WhatsApp. Sua função principal é descrever imagens e stickers compartilhados no grupo, fornecendo uma audiodescrição profissional, detalhada, didática e polida.
      
      Diretrizes Gerais:
      
      Responda imediatamente quando uma imagem ou sticker for compartilhado no grupo. Mantenha suas respostas concisas, mas informativas. Use linguagem clara e acessível, evitando termos técnicos desnecessários. Seja respeitoso e inclusivo em todas as suas interações.
      
      Estrutura da Resposta: Para cada imagem ou sticker, sua resposta deve seguir este formato:
      
      [Audiodescrição]
      (Forneça uma descrição objetiva e detalhada da imagem) 
      
      Diretrizes para a Descrição Profissional:

      Comece com uma visão geral da imagem antes de entrar em detalhes.
      Descreva os elementos principais da imagem, do mais importante ao menos relevante.
      Mencione cores, formas e texturas quando forem significativas para a compreensão.
      Indique a posição dos elementos na imagem (por exemplo, "no canto superior direito").
      Descreva expressões faciais e linguagem corporal em fotos com pessoas.
      Mencione o tipo de imagem (por exemplo, fotografia, ilustração, pintura).
      Informe sobre o enquadramento (close-up, plano geral, etc.) quando relevante.
      Inclua detalhes do cenário ou fundo que contribuam para o contexto.
      Evite usar termos subjetivos como "bonito" ou "feio".
      Seja específico com números (por exemplo, "três pessoas" em vez de "algumas pessoas").
      Descreva texto visível na imagem, incluindo legendas ou títulos.
      Mencione a escala ou tamanho relativo dos objetos quando importante.
      Indique se a imagem é em preto e branco ou colorida.
      Descreva a iluminação se for um elemento significativo da imagem.
      Para obras de arte, inclua informações sobre o estilo artístico e técnicas utilizadas.`;

      await this.gerenciadorConfig.definirPromptSistema(chatId, BOT_NAME, promptAudiomar);
      await this.gerenciadorConfig.definirPromptSistemaAtivo(chatId, BOT_NAME);

      await msg.reply('Configurações para usuários com deficiência visual aplicadas com sucesso:\n' +
                      '- Descrição de imagens habilitada\n' +
                      '- Transcrição de áudio desabilitada\n' +
                      '- Prompt de audiodescrição ativado');

      this.registrador.info(`Configurações para usuários com deficiência visual aplicadas no chat ${chatId}`);
      return true;
    } catch (erro) {
      this.registrador.error(`Erro ao aplicar configurações para usuários com deficiência visual: ${erro.message}`, { erro });
      await msg.reply('Desculpe, ocorreu um erro ao aplicar as configurações. Por favor, tente novamente.');
      return false;
    }
  }

/**
 * Processa uma mensagem de texto com persistência aprimorada
 */
async processarMensagemTexto(msg, chatId) {
  try {
    const chat = await msg.getChat();
    const remetente = await this.obterOuCriarUsuario(msg.author || msg.from, chat);
    
    // Criar transação para esta mensagem
    const transacao = await this.gerenciadorTransacoes.criarTransacao(msg, chat);
    this.registrador.info(`Nova transação criada: ${transacao.id} para mensagem de ${remetente.name}`);
    
    // NOVO: Salvar dados essenciais para recuperação
    await this.gerenciadorTransacoes.adicionarDadosRecuperacao(transacao.id, {
      tipo: 'texto',
      remetenteId: msg.from,
      remetenteNome: remetente.name,
      chatId: chatId,
      textoOriginal: msg.body,
      timestampOriginal: msg.timestamp
    });
    
    // Marcar como processando
    await this.gerenciadorTransacoes.marcarComoProcessando(transacao.id);
    
    // ✨ AQUI ESTAVA O ERRO! Precisamos montar o histórico da conversa ✨
    // Obter histórico do chat
    const historico = await this.clienteWhatsApp.obterHistoricoMensagens(chatId);
    
    // Verificar se a última mensagem já é a atual
    const ultimaMensagem = historico.length > 0 ? historico[historico.length - 1] : '';
    const mensagemUsuarioAtual = `${remetente.name}: ${msg.body}`;
    
    // Só adiciona a mensagem atual se ela não for a última do histórico
    const textoHistorico = ultimaMensagem.includes(msg.body)
      ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}`
      : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}\n${mensagemUsuarioAtual}`;
    
    // Obter resposta da IA
    let resposta = await this.gerarRespostaComTexto(textoHistorico, chatId);

    // Adicionar resposta à transação
    await this.gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resposta);
    
    // Enviar a resposta
    try {
      const enviado = await this.enviarResposta(msg, resposta, transacao.id);
      
      if (enviado) {
        // Marcar como entregue com sucesso
        await this.gerenciadorTransacoes.marcarComoEntregue(transacao.id);
      } else {
        // Mensagem foi colocada em fila
        this.registrador.info(`Resposta para transação ${transacao.id} colocada na fila de pendentes`);
      }
      
      return true;
    } catch (erroEnvio) {
      this.registrador.error(`Erro ao enviar mensagem: ${erroEnvio.message}`, { erro: erroEnvio });
      
      // Registrar falha na entrega
      await this.gerenciadorTransacoes.registrarFalhaEntrega(
        transacao.id, 
        `Erro ao enviar: ${erroEnvio.message}`
      );
      
      return false;
    }
  } catch (erro) {
    this.registrador.error(`Erro ao processar mensagem de texto: ${erro.message}`, { erro });
    return false;
  }
}
/**
 * Recupera uma transação interrompida
 * @param {Object} transacao - Transação a ser recuperada
 */
async recuperarTransacao(transacao) {
  try {
    this.registrador.info(`⏱️ Recuperando transação ${transacao.id} após reinicialização`);
    
    if (!transacao.dadosRecuperacao || !transacao.resposta) {
      this.registrador.warn(`Transação ${transacao.id} não possui dados suficientes para recuperação`);
      return false;
    }
    
    const { remetenteId, chatId } = transacao.dadosRecuperacao;
    
    if (!remetenteId || !chatId) {
      this.registrador.warn(`Dados insuficientes para recuperar transação ${transacao.id}`);
      return false;
    }
    
    // Enviar mensagem diretamente usando as informações persistidas
    await this.clienteWhatsApp.enviarMensagem(
      remetenteId, 
      transacao.resposta,
      { isRecoveredMessage: true }
    );
    
    // Marcar como entregue
    await this.gerenciadorTransacoes.marcarComoEntregue(transacao.id);
    
    this.registrador.info(`✅ Transação ${transacao.id} recuperada e entregue com sucesso!`);
    return true;
  } catch (erro) {
    this.registrador.error(`Falha na recuperação da transação ${transacao.id}: ${erro.message}`);
    return false;
  }
}


/**
 * Verifica se o bot foi mencionado na mensagem
 * @param {Object} msg - Mensagem do WhatsApp
 * @returns {Promise<boolean>} Verdadeiro se o bot foi mencionado
 */
async verificarMencaoBotNaMensagem(msg) {
  try {
    // Verificar menções diretas (@Amélie)
    const mencoes = await msg.getMentions();
    if (mencoes && mencoes.length > 0) {
      const botWid = this.clienteWhatsApp.cliente.info.wid._serialized;
      return mencoes.some(mencao => mencao.id._serialized === botWid);
    }
    
    // Verificar por menção no texto (como "Amélie")
    const BOT_NAME = process.env.BOT_NAME || 'Amélie';
    const regexNomeBot = new RegExp(`\\b${BOT_NAME}\\b`, 'i');
    if (regexNomeBot.test(msg.body)) {
      return true;
    }
    
    return false;
  } catch (erro) {
    this.registrador.error(`Erro ao verificar menção do bot: ${erro.message}`);
    return false;
  }
}

  /**
   * Processa uma mensagem com mídia
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {string} chatId - ID do chat
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarMensagemComMidia(msg, chatId) {
    try {
      const dadosAnexo = await msg.downloadMedia();
      if (!dadosAnexo || !dadosAnexo.data) {
        this.registrador.error('Não foi possível obter dados de mídia.');
        return false;
      }
      
      // Inferir MIME type se não estiver disponível
      let mimeType = dadosAnexo.mimetype;
      if (!mimeType) {
        mimeType = this.inferirMimeType(Buffer.from(dadosAnexo.data, 'base64'));
        dadosAnexo.mimetype = mimeType;
        this.registrador.info(`MIME inferido: ${mimeType}`);
      }
      
      // Processar de acordo com o tipo de mídia
      if (mimeType.startsWith('audio/')) {
        return await this.processarMensagemAudio(msg, dadosAnexo, chatId);
      } else if (mimeType.startsWith('image/')) {
        return await this.processarMensagemImagem(msg, dadosAnexo, chatId);
      } else if (mimeType.startsWith('video/')) {
        return await this.processarMensagemVideo(msg, dadosAnexo, chatId);
      } else {
        this.registrador.info(`Tipo de mídia não suportado: ${mimeType}`);
        return false;
      }
    } catch (erro) {
      this.registrador.error(`Erro ao processar mídia: ${erro.message}`, { erro });
      await msg.reply('Desculpe, ocorreu um erro ao processar sua mídia.');
      return false;
    }
  }

  /**
   * Infere o MIME type de um buffer de dados
   * @param {Buffer} buffer - Buffer de dados
   * @returns {string} MIME type inferido
   */
  inferirMimeType(buffer) {
    if (!buffer || buffer.length < 12) {
      return 'application/octet-stream';
    }
    
    const bytesHex = buffer.slice(0, 12).toString('hex').toLowerCase();
    
    // Tipos de imagem
    if (bytesHex.startsWith('89504e47')) return 'image/png';
    if (bytesHex.startsWith('ffd8ff')) return 'image/jpeg';
    if (bytesHex.startsWith('47494638')) return 'image/gif';
    if (bytesHex.startsWith('424d')) return 'image/bmp';
    if (bytesHex.startsWith('52494646') && bytesHex.includes('57454250')) return 'image/webp';
    
    // Tipos de áudio
    if (bytesHex.startsWith('4944330') || bytesHex.startsWith('fffb')) return 'audio/mpeg';
    if (bytesHex.startsWith('52494646') && bytesHex.includes('57415645')) return 'audio/wav';
    if (bytesHex.startsWith('4f676753')) return 'audio/ogg';
    
    // Tipos de vídeo
    if (bytesHex.includes('66747970')) return 'video/mp4';
    if (bytesHex.startsWith('1a45dfa3')) return 'video/webm';
    if (bytesHex.startsWith('52494646') && bytesHex.includes('41564920')) return 'video/avi';
    if (bytesHex.startsWith('3026b275')) return 'video/x-ms-wmv';
    
    return 'application/octet-stream';
  }

  /**
   * Processa uma mensagem com áudio
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {Object} audioData - Dados do áudio
   * @param {string} chatId - ID do chat
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarMensagemAudio(msg, audioData, chatId) {
    try {
      const chat = await msg.getChat();
      const config = await this.gerenciadorConfig.obterConfig(chatId);
      const remetente = await this.obterOuCriarUsuario(msg.author || msg.from, chat);
      
      if (!config.mediaAudio) {
        return false;
      }
      
      const tamanhoAudioMB = audioData.data.length / (1024 * 1024);
      if (tamanhoAudioMB > 20) {
        await msg.reply('Desculpe, só posso processar áudios de até 20MB.');
        return false;
      }
      
      const ehPTT = audioData.mimetype === 'audio/ogg; codecs=opus';
      this.registrador.debug(`Processando arquivo de áudio: ${ehPTT ? 'PTT' : 'Áudio regular'}`);
      
      const hashAudio = crypto.createHash('md5').update(audioData.data).digest('hex');
      if (this.ultimoAudioProcessado === hashAudio) {
        await msg.reply('Este áudio já foi processado recentemente. Por favor, envie um novo áudio.');
        return false;
      }
      this.ultimoAudioProcessado = hashAudio;
      
      // Criar transação para esta mensagem
      const transacao = await this.gerenciadorTransacoes.criarTransacao(msg, chat);
      this.registrador.info(`Nova transação criada: ${transacao.id} para mensagem de áudio`);
      
      // Marcar como processando
      await this.gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Processar o áudio com a IA
      const resultado = await this.gerenciadorAI.processarAudio(audioData, hashAudio, config);
      
      // Adicionar resposta à transação
      await this.gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resultado);
      
      try {
        const enviado = await this.enviarResposta(msg, resultado);
        
        if (enviado) {
          await this.gerenciadorTransacoes.marcarComoEntregue(transacao.id);
        }
        
        return true;
      } catch (erroEnvio) {
        this.registrador.error(`Erro ao enviar resposta de áudio: ${erroEnvio.message}`, { erro: erroEnvio });
        await this.gerenciadorTransacoes.registrarFalhaEntrega(transacao.id, `Erro ao enviar: ${erroEnvio.message}`);
        return false;
      }
    } catch (erro) {
      this.registrador.error(`Erro ao processar mensagem de áudio: ${erro.message}`, { erro });
      await msg.reply('Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.');
      return false;
    }
  }

  /**
   * Processa uma mensagem com imagem usando a fila de processamento desacoplada
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {Object} imagemData - Dados da imagem
   * @param {string} chatId - ID do chat
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarMensagemImagem(msg, imagemData, chatId) {
    try {
      const chat = await msg.getChat();
      const config = await this.gerenciadorConfig.obterConfig(chatId);
      const remetente = await this.obterOuCriarUsuario(msg.author || msg.from, chat);
      
      if (!config.mediaImage) {
        this.registrador.info(`Descrição de imagem desabilitada para o chat ${chatId}. Ignorando mensagem de imagem.`);
        return false;
      }
      
      // Criar transação para esta mensagem de imagem
      const transacao = await this.gerenciadorTransacoes.criarTransacao(msg, chat);
      this.registrador.info(`Nova transação criada: ${transacao.id} para mensagem de imagem de ${remetente.name}`);
      
      // Enviar feedback inicial (opcional - avisa o usuário que a imagem está sendo processada)
      // await msg.reply("✨ Estou processando sua imagem! Aguarde um momento...");
      
      // Marcar transação como processando
      await this.gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Determinar o prompt do usuário
      let promptUsuario = `Analise esta imagem de forma extremamente detalhada para pessoas com deficiência visual.
      Inclua:
      1. Se for uma receita, recibo ou documento, transcreva o texto integralmente, verbatim, incluindo, mas não limitado, a CNPJ, produtos, preços, nomes de remédios, posologia, nome do profissional e CRM, etc.
      2. Número exato de pessoas, suas posições e roupas (cores, tipos)
      3. Ambiente e cenário completo, em todos os planos
      4. Todos os objetos visíveis 
      5. Movimentos e ações detalhadas
      6. Expressões faciais
      7. Textos visíveis
      8. Qualquer outro detalhe relevante

      Crie uma descrição organizada e acessível.`;
      
      if (msg.body && msg.body.trim() !== '') {
        promptUsuario = msg.body.trim();
      }
      
      // MUDANÇA IMPORTANTE: Adicionando à fila de imagem desacoplada,
      // mas agora passando o callback para o gerenciador de mensagens
      await this.filaProcessamentoImagem.add('process-image', {
        imageData: imagemData, 
        chatId, 
        messageId: msg.id._serialized,
        mimeType: imagemData.mimetype,
        userPrompt: promptUsuario,
        senderNumber: msg.from,
        transacaoId: transacao.id,
        remetenteName: remetente.name // Adicionando o nome do remetente para o log
      }, { 
        removeOnComplete: true,
        removeOnFail: false,
        timeout: 60000 // 1 minuto
      });
      
      this.registrador.info(`🚀 Imagem de ${remetente.name} adicionada à fila com sucesso (transação ${transacao.id})`);
      return true;
      
    } catch (erro) {
      this.registrador.error(`Erro ao processar mensagem de imagem: ${erro.message}`, { erro });
      
      // Verificar se é um erro de segurança
      if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {
        
        // Salvar a imagem para análise posterior
        try {
          const diretorioBlocked = path.join(process.cwd(), 'blocked');
          if (!fs.existsSync(diretorioBlocked)) {
            fs.mkdirSync(diretorioBlocked, { recursive: true });
          }
          
          // Salvar a imagem
          const dataHora = new Date().toISOString().replace(/[:.-]/g, '_');
          const remetente = msg.from || 'unknown';
          const caminhoImagem = path.join(diretorioBlocked, `blocked_image_${remetente}_${dataHora}.jpg`);
          
          const buffer = Buffer.from(imagemData.data, 'base64');
          fs.writeFileSync(caminhoImagem, buffer);
          
          // Salvar metadados
          const metadados = {
            timestamp: new Date().toISOString(),
            tipoArquivo: imagemData.mimetype || 'image/unknown',
            erro: erro.message,
            remetente: {
              id: msg.from || 'desconhecido',
              author: msg.author || msg.from || 'desconhecido'
            },
            grupo: chatId.endsWith('@g.us') ? {
              id: chatId
            } : null,
            mensagem: {
              id: msg.id._serialized || 'desconhecido',
              prompt: msg.body || '',
            }
          };
          
          const caminhoMetadados = path.join(diretorioBlocked, `blocked_image_${remetente}_${dataHora}.json`);
          fs.writeFileSync(caminhoMetadados, JSON.stringify(metadados, null, 2), 'utf8');
          
          this.registrador.warn(`⚠️ Imagem bloqueada por segurança salva em: ${caminhoImagem}`);
        } catch (erroSave) {
          this.registrador.error(`Erro ao salvar imagem bloqueada: ${erroSave.message}`);
        }
        
        await msg.reply('Este conteúdo não pôde ser processado por questões de segurança.');
      } else {
        await msg.reply('Desculpe, ocorreu um erro ao processar a imagem. Por favor, tente novamente.');
      }
      
      return false;
    }
  }

  /**
   * Processa uma mensagem com vídeo de forma assíncrona
   * @param {Object} msg - Mensagem do WhatsApp
   * @param {Object} videoData - Dados do vídeo
   * @param {string} chatId - ID do chat
   * @returns {Promise<boolean>} Sucesso do processamento
   */
  async processarMensagemVideo(msg, videoData, chatId) {
    try {
      const chat = await msg.getChat();
      const config = await this.gerenciadorConfig.obterConfig(chatId);
      const remetente = await this.obterOuCriarUsuario(msg.author || msg.from, chat);
      
      if (!config.mediaVideo) {
        this.registrador.info(`Descrição de vídeo desabilitada para o chat ${chatId}. Ignorando mensagem de vídeo.`);
        return false;
      }
      
      // Criar transação para esta mensagem de vídeo
      const transacao = await this.gerenciadorTransacoes.criarTransacao(msg, chat);
      this.registrador.info(`Nova transação criada: ${transacao.id} para mensagem de vídeo de ${remetente.name}`);
      
      // Enviar feedback inicial e continuar processamento
      // await msg.reply("✨ Estou colocando seu vídeo na fila de processamento! Você receberá o resultado em breve...");
      
      // Marcar transação como processando
      await this.gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Determinar o prompt do usuário
      let promptUsuario = `Analise este vídeo de forma extremamente detalhada para pessoas com deficiência visual.
Inclua:
1. Número exato de pessoas, suas posições e roupas (cores, tipos)
2. Ambiente e cenário completo
3. Todos os objetos visíveis 
4. Movimentos e ações detalhadas
5. Expressões faciais
6. Textos visíveis
7. Qualquer outro detalhe relevante

Crie uma descrição organizada e acessível.`;
      
      if (msg.body && msg.body.trim() !== '') {
        promptUsuario = msg.body.trim();
      }
      
      // Cria um arquivo temporário para o vídeo
      const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
      const arquivoTemporario = `./temp/video_${dataHora}_${Math.floor(Math.random() * 10000)}.mp4`;
      const trabalhoId = `video_${chatId}_${Date.now()}`;
      
      try {
        this.registrador.info(`Salvando arquivo de vídeo ${arquivoTemporario}...`);
        const videoBuffer = Buffer.from(videoData.data, 'base64');
        
        await fs.promises.writeFile(arquivoTemporario, videoBuffer);
        this.registrador.info(`✅ Arquivo de vídeo salvo com sucesso: ${arquivoTemporario} (${Math.round(videoBuffer.length / 1024)} KB)`);
        
        const stats = await fs.promises.stat(arquivoTemporario);
        if (stats.size !== videoBuffer.length) {
          throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
        }
        
        // Adicionar à fila de processamento
        await this.filaProcessamento.add('process-video', {
          tempFilename: arquivoTemporario,
          chatId,
          messageId: msg.id._serialized,
          mimeType: videoData.mimetype,
          userPrompt: promptUsuario,
          senderNumber: msg.from,
          transacaoId: transacao.id,
          remetenteName: remetente.name // Adicionando o nome do remetente para o log
        }, { 
          jobId: trabalhoId,
          removeOnComplete: true,
          removeOnFail: false,
          timeout: 300000 // 5 minutos
        });
        
        this.registrador.info(`🚀 Vídeo de ${remetente.name} adicionado à fila com sucesso: ${arquivoTemporario} (Job ${trabalhoId})`);
        return true;
        
      } catch (erroProcessamento) {
        this.registrador.error(`❌ Erro ao processar vídeo: ${erroProcessamento.message}`);
        
        // Tentar notificar o usuário sobre o erro
        await msg.reply("Ai, tive um probleminha com seu vídeo. Poderia tentar novamente?").catch(() => {});
        
        // Registrar falha na transação
        await this.gerenciadorTransacoes.registrarFalhaEntrega(transacao.id, `Erro no processamento: ${erroProcessamento.message}`);
        
        // Limpar arquivo se existir
        if (fs.existsSync(arquivoTemporario)) {
          await fs.promises.unlink(arquivoTemporario).catch(err => {
            this.registrador.error(`Erro ao remover arquivo temporário: ${err.message}`);
          });
          this.registrador.info(`Arquivo temporário ${arquivoTemporario} removido após erro`);
        }
        
        return false;
      }
    } catch (erro) {
      this.registrador.error(`Erro ao processar mensagem de vídeo: ${erro.message}`, { erro });
      
      let mensagemAmigavel = 'Desculpe, ocorreu um erro ao adicionar seu vídeo à fila de processamento.';
      
      if (erro.message.includes('too large')) {
        mensagemAmigavel = 'Ops! Este vídeo parece ser muito grande para eu processar. Poderia enviar uma versão menor ou comprimida?';
      } else if (erro.message.includes('format')) {
        mensagemAmigavel = 'Esse formato de vídeo está me dando trabalho! Poderia tentar enviar em outro formato?';
      } else if (erro.message.includes('timeout')) {
        mensagemAmigavel = 'O processamento demorou mais que o esperado. Talvez o vídeo seja muito complexo?';
      }
      
      await msg.reply(mensagemAmigavel).catch(erroResposta => {
        this.registrador.error(`Não consegui enviar mensagem de erro: ${erroResposta.message}`);
      });
      
      return false;
    }
  }

  /**
   * Obtém ou cria um registro de usuário
   * @param {string} remetente - ID do remetente
   * @param {Object} chat - Objeto do chat
   * @returns {Promise<Object>} Informações do usuário
   */
  async obterOuCriarUsuario(remetente, chat) {
    try {
      // Se temos gerenciadorConfig, usar o método dele
      if (this.gerenciadorConfig) {
        return await this.gerenciadorConfig.obterOuCriarUsuario(remetente, this.clienteWhatsApp.cliente);
      }

// Implementação alternativa caso o gerenciadorConfig não esteja disponível
const contato = await this.clienteWhatsApp.cliente.getContactById(remetente);
      
let nome = contato.pushname || contato.name || contato.shortName;

if (!nome || nome.trim() === '') {
  const idSufixo = remetente.substring(0, 6);
  nome = `User${idSufixo}`;
}

return {
  id: remetente,
  name: nome,
  joinedAt: new Date()
};
} catch (erro) {
this.registrador.error(`Erro ao obter informações do usuário: ${erro.message}`);
const idSufixo = remetente.substring(0, 6);
return {
  id: remetente,
  name: `User${idSufixo}`,
  joinedAt: new Date()
};
}
}

/**
* Envia uma resposta à mensagem original
* @param {Object} mensagemOriginal - Mensagem original para responder
* @param {string} texto - Texto da resposta
* @returns {Promise<boolean>} Sucesso do envio
*/
async enviarResposta(mensagemOriginal, texto, transacaoId = null) {
  try {
    if (!texto || typeof texto !== 'string' || texto.trim() === '') {
      this.registrador.error('Tentativa de enviar mensagem inválida:', { texto });
      texto = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
    }

    // Verificação de segurança para casos onde a mensagem original não é mais válida
    if (!mensagemOriginal || typeof mensagemOriginal.getChat !== 'function') {
      this.registrador.warn(`Mensagem original inválida ou inacessível, tentando recuperação alternativa`);
      
      // Se temos transacaoId, tentamos recuperar dados de lá
      if (transacaoId) {
        const transacao = await this.gerenciadorTransacoes.obterTransacao(transacaoId);
        if (transacao && transacao.dadosRecuperacao && transacao.dadosRecuperacao.remetenteId) {
          this.registrador.info(`Recuperando envio via dados da transação ${transacaoId}`);
          return await this.clienteWhatsApp.enviarMensagem(transacao.dadosRecuperacao.remetenteId, texto);
        }
      }
      
      // Alternativa: tenta usar campos disponíveis na mensagem original
      if (mensagemOriginal && mensagemOriginal.from) {
        return await this.clienteWhatsApp.enviarMensagem(mensagemOriginal.from, texto);
      }
      
      this.registrador.error(`Impossível enviar mensagem - referências quebradas e sem transação recuperável`);
      return false;
    }

    // Restante da função como antes...
    let textoReduzido = texto.trim();
    textoReduzido = textoReduzido.replace(/^(?:amélie:[\s]*)+/i, '');
    textoReduzido = textoReduzido.replace(/^(?:amelie:[\s]*)+/i, '');
    textoReduzido = textoReduzido.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');

    // Obter informações do remetente e do chat
    const chat = await mensagemOriginal.getChat();
    const ehGrupo = chat.id._serialized.endsWith('@g.us');
    const remetente = await this.obterOuCriarUsuario(mensagemOriginal.author || mensagemOriginal.from);
    const nomeRemetente = remetente.name;

    // Preparar o texto de log
    let prefixoLog = `\nMensagem de ${nomeRemetente}`;

    // Adicionar informação do grupo, se aplicável
    if (ehGrupo) {
      prefixoLog += ` no grupo "${chat.name || 'Desconhecido'}"`;
    }

    // Obter o corpo da mensagem original
    const mensagemOriginalTexto = mensagemOriginal.body || "[Mídia sem texto]";

    // Log no formato solicitado
    this.registrador.debug(`${prefixoLog}: ${mensagemOriginalTexto}\nResposta: ${textoReduzido}`);

    // Enviar a mensagem usando o método atualizado do ClienteWhatsApp
    const chatId = chat.id._serialized;
    const enviado = await this.clienteWhatsApp.enviarMensagem(chatId, textoReduzido, mensagemOriginal);

    // Se não foi enviado mas também não lançou erro, é porque foi enfileirado
    if (!enviado) {
      this.registrador.info(`Mensagem para ${chatId} colocada na fila de pendentes`);
    }

    return enviado;
  } catch (erro) {
    this.registrador.error('Erro ao enviar resposta:', { 
      erro: erro.message,
      stack: erro.stack,
      texto: texto
    });

    // Tentar salvar como notificação pendente
    try {
      // Se temos transacaoId, usamos os dados da transação
      if (transacaoId) {
        const transacao = await this.gerenciadorTransacoes.obterTransacao(transacaoId);
        if (transacao && transacao.dadosRecuperacao && transacao.dadosRecuperacao.remetenteId) {
          await this.clienteWhatsApp.salvarNotificacaoPendente(
            transacao.dadosRecuperacao.remetenteId, 
            texto, 
            { transacaoId }
          );
          this.registrador.info(`Mensagem salva como notificação pendente via transação ${transacaoId}`);
          return false;
        }
      }

      // Tentar via mensagem original como fallback
      if (mensagemOriginal && mensagemOriginal.chat) {
        const chatId = mensagemOriginal.chat.id._serialized;
        await this.clienteWhatsApp.salvarNotificacaoPendente(chatId, texto, mensagemOriginal);
        this.registrador.info(`Mensagem salva como notificação pendente para ${chatId}`);
      } else {
        this.registrador.error(`Não foi possível salvar notificação pendente - dados insuficientes`);
      }
    } catch (erroSalvar) {
      this.registrador.error(`Falha ao salvar notificação pendente: ${erroSalvar.message}`);
    }

    return false;
  }
}

/**
* Gera resposta baseada em texto e imagem
* @param {string} promptUsuario - Prompt do usuário
* @param {Object} imagemData - Dados da imagem
* @param {string} chatId - ID do chat
* @returns {Promise<string>} Resposta gerada
*/
async gerarRespostaComTextoEImagem(promptUsuario, imagemData, chatId) {
try {
const configUsuario = await this.gerenciadorConfig.obterConfig(chatId);

const parteImagem = {
  inlineData: {
    data: imagemData.data.toString('base64'),
    mimeType: imagemData.mimetype
  }
};

const partesConteudo = [
  parteImagem,
  { text: promptUsuario }
];

const modelo = this.gerenciadorAI.obterOuCriarModelo({
  model: "gemini-2.0-flash",
  temperature: configUsuario.temperature,
  topK: configUsuario.topK,
  topP: configUsuario.topP,
  maxOutputTokens: configUsuario.maxOutputTokens,
  systemInstruction: configUsuario.systemInstructions
});

// Adicionar timeout de 45 segundos
const promessaResultado = modelo.generateContent(partesConteudo);
const promessaTimeout = new Promise((_, reject) => 
  setTimeout(() => reject(new Error("Timeout da API Gemini")), 45000)
);

const resultado = await Promise.race([promessaResultado, promessaTimeout]);
let textoResposta = resultado.response.text();

if (!textoResposta) {
  throw new Error('Resposta vazia gerada pelo modelo');
}

textoResposta = this.removerEmojis(textoResposta);

return textoResposta;
} catch (erro) {
this.registrador.error(`Erro ao gerar resposta com texto e imagem: ${erro.message}`);
return "Desculpe, ocorreu um erro ao gerar a resposta para a imagem. Por favor, tente novamente ou reformule sua pergunta.";
}
}

/**
* Gera resposta baseada apenas em texto
* @param {string} promptUsuario - Prompt do usuário
* @param {string} chatId - ID do chat
* @returns {Promise<string>} Resposta gerada
*/
async gerarRespostaComTexto(promptUsuario, chatId) {
try {
const configUsuario = await this.gerenciadorConfig.obterConfig(chatId);

// Usar o gerenciadorAI para processar o texto
return await this.gerenciadorAI.processarTexto(promptUsuario, configUsuario);
} catch (erro) {
this.registrador.error(`Erro ao gerar resposta de texto: ${erro.message}`);
return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
}
}

/**
* Processa comandos relacionados a prompts
* @param {Object} msg - Mensagem recebida
* @param {Array} args - Argumentos do comando
* @param {string} chatId - ID do chat
* @async
*/
async tratarComandoPrompt(msg, args, chatId) {
const [subcomando, nome, ...resto] = args;

switch (subcomando) {
case 'set':
  if (nome && resto.length > 0) {
    const textoPrompt = resto.join(' ');
    await this.gerenciadorConfig.definirPromptSistema(chatId, nome, textoPrompt);
    await msg.reply(`System Instruction "${nome}" definida com sucesso.`);
  } else {
    await msg.reply('Uso correto: .prompt set <nome> <texto>');
  }
  break;
  
case 'get':
  if (nome) {
    const prompt = await this.gerenciadorConfig.obterPromptSistema(chatId, nome);
    if (prompt) {
      await msg.reply(`System Instruction "${nome}":\n${prompt.text}`);
    } else {
      await msg.reply(`System Instruction "${nome}" não encontrada.`);
    }
  } else {
    await msg.reply('Uso correto: .prompt get <nome>');
  }
  break;
  
case 'list':
  const prompts = await this.gerenciadorConfig.listarPromptsSistema(chatId);
  if (prompts.length > 0) {
    const listaPrompts = prompts.map(p => p.name).join(', ');
    await msg.reply(`System Instructions disponíveis: ${listaPrompts}`);
  } else {
    await msg.reply('Nenhuma System Instruction definida.');
  }
  break;
  
case 'use':
  if (nome) {
    const prompt = await this.gerenciadorConfig.obterPromptSistema(chatId, nome);
    if (prompt) {
      await this.gerenciadorConfig.definirPromptSistemaAtivo(chatId, nome);
      await msg.reply(`System Instruction "${nome}" ativada para este chat.`);
    } else {
      await msg.reply(`System Instruction "${nome}" não encontrada.`);
    }
  } else {
    await msg.reply('Uso correto: .prompt use <nome>');
  }
  break;
  
case 'clear':
  await this.gerenciadorConfig.limparPromptSistemaAtivo(chatId);
  await msg.reply('System Instruction removida. Usando o modelo padrão.');
  break;
  
case 'delete':
  if (nome) {
    // Verificar se o prompt existe antes de tentar excluir
    const promptExiste = await this.gerenciadorConfig.obterPromptSistema(chatId, nome);
    if (promptExiste) {
      // Verificar se o prompt está ativo
      const config = await this.gerenciadorConfig.obterConfig(chatId);
      const estaAtivo = config.activePrompt === nome;
      
      // Excluir o prompt
      const sucesso = await this.gerenciadorConfig.excluirPromptSistema(chatId, nome);
      
      if (sucesso) {
        // Se o prompt excluído estava ativo, desativá-lo
        if (estaAtivo) {
          await this.gerenciadorConfig.limparPromptSistemaAtivo(chatId);
        }
        await msg.reply(`System Instruction "${nome}" excluída com sucesso.`);
      } else {
        await msg.reply(`Erro ao excluir System Instruction "${nome}".`);
      }
    } else {
      await msg.reply(`System Instruction "${nome}" não encontrada.`);
    }
  } else {
    await msg.reply('Uso correto: .prompt delete <nome>');
  }
  break;
  
default:
  await msg.reply('Subcomando de prompt desconhecido. Use .ajuda para ver os comandos disponíveis.');
}
}

/**
* Processa comandos relacionados a configurações
* @param {Object} msg - Mensagem recebida
* @param {Array} args - Argumentos do comando
* @param {string} chatId - ID do chat
* @async
*/
async tratarComandoConfig(msg, args, chatId) {
const [subcomando, param, valor] = args;

switch (subcomando) {
case 'set':
  if (param && valor) {
    if (['temperature', 'topK', 'topP', 'maxOutputTokens', 'mediaImage', 'mediaAudio', 'mediaVideo'].includes(param)) {
      const valorNum = (param.startsWith('media')) ? (valor === 'true') : parseFloat(valor);
      if (!isNaN(valorNum) || typeof valorNum === 'boolean') {
        await this.gerenciadorConfig.definirConfig(chatId, param, valorNum);
        await msg.reply(`Parâmetro ${param} definido como ${valorNum}`);
      } else {
        await msg.reply(`Valor inválido para ${param}. Use um número ou "true"/"false" se for mídia.`);
      }
    } else {
      await msg.reply(`Parâmetro desconhecido: ${param}`);
    }
  } else {
    await msg.reply('Uso correto: !config set <param> <valor>');
  }
  break;
  
case 'get':
  const config = await this.gerenciadorConfig.obterConfig(chatId);
  if (param) {
    if (config.hasOwnProperty(param)) {
      await msg.reply(`${param}: ${config[param]}`);
    } else {
      await msg.reply(`Parâmetro desconhecido: ${param}`);
    }
  } else {
    const textoConfig = Object.entries(config)
      .map(([chave, valor]) => `${chave}: ${valor}`)
      .join('\n');
    await msg.reply(`Configuração atual:\n${textoConfig}`);
  }
  break;
  
default:
  await msg.reply('Subcomando de config desconhecido. Use .ajuda para ver os comandos disponíveis.');
}
}

/**
* Lista os usuários de um grupo
* @param {Object} msg - Mensagem recebida
* @param {string} chatId - ID do chat (opcional)
* @async
*/
async listarUsuariosGrupo(msg, chatId) {
try {
const chat = await msg.getChat();
if (chat.isGroup) {
  const grupo = await this.gerenciadorConfig.obterOuCriarGrupo(chat);
  
  const participantes = await chat.participants;
  const listaUsuarios = await Promise.all(participantes.map(async (p) => {
    const usuario = await this.obterOuCriarUsuario(p.id._serialized, chat);
    return `${usuario.name} (${p.id.user})`;
  }));
  
  await msg.reply(`Usuários no grupo "${grupo.title}":\n${listaUsuarios.join('\n')}`);
} else {
  await msg.reply('Este comando só funciona em grupos.');
}
} catch (erro) {
this.registrador.error(`Erro ao listar usuários do grupo: ${erro.message}`);
await msg.reply('Desculpe, ocorreu um erro ao listar os usuários do grupo.');
}
}
}

module.exports = GerenciadorMensagens;