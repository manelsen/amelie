/**
 * ClienteWhatsApp - Módulo para gerenciamento da conexão com WhatsApp
 * 
 * Este módulo encapsula toda a lógica de conexão, autenticação e sessão do WhatsApp,
 * incluindo reconexões, verificação de estado e envio de mensagens.
 */ 

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class ClienteWhatsApp extends EventEmitter {
  /**
   * Cria uma nova instância do cliente WhatsApp
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {Object} opcoes - Opções de configuração
   */
  constructor(registrador, opcoes = {}) {
    super();
    this.registrador = registrador;
    this.pronto = false;
    this.tentativasReconexao = 0;
    this.maxTentativasReconexao = opcoes.maxTentativasReconexao || 5;
    this.cliente = null;
    this.ultimoEnvio = Date.now();
    this.clienteId = opcoes.clienteId || 'principal';
    this.diretorioTemp = opcoes.diretorioTemp || '../temp';
    this.mensagensPendentes = [];
    
    // Garantir que o diretório de arquivos temporários exista
    if (!fs.existsSync(this.diretorioTemp)) {
      try {
        fs.mkdirSync(this.diretorioTemp, { recursive: true });
        this.debug('Diretório de arquivos temporários criado');
      } catch (erro) {
        this.registrador.error(`Erro ao criar diretório temporário: ${erro.message}`);
      }
    }
    
    this.inicializarCliente();
  }

  /**
   * Inicializa o cliente WhatsApp
   */
  inicializarCliente() {
    this.cliente = new Client({
      authStrategy: new LocalAuth({ clientId: this.clienteId }),
      puppeteer: {
        executablePath: process.env.CHROME_EXECUTABLE_PATH,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--js-flags=--expose-gc',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
        ],
        defaultViewport: {
          width: 800,
          height: 600
        },
        // Adicione um timeout para operações do navegador
        timeout: 60000,
        ignoreHTTPSErrors: true
      }
    });

    this.configurarOuvinteEventos();
    this.cliente.initialize();
  }

  /**
   * Configura todos os listeners de eventos do cliente
   */
  configurarOuvinteEventos() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    let pairingCodeRequested = false;

    rl.question('Digite 1 para gerar QR code ou 2 para código de pareamento: ', (opcao) => {
        if (opcao === '1') {
            this.cliente.on('qr', (qr) => {
                qrcode.generate(qr, { small: true });
                this.emit('qr', qr);
            });
        } else if (opcao === '2') {
            rl.question('Digite o número de telefone (ex: 351912345678, sem "+" ou espaços): ', async (phoneNumber) => {
                if (!/^\d{9,15}$/.test(phoneNumber)) {
                    rl.close();
                    return;
                }

                if (!pairingCodeRequested) {
                    const pairingCode = await this.cliente.requestPairingCode(phoneNumber);
                    console.log('Código de pareamento gerado: ', pairingCode);
                    this.emit('pairingCode', pairingCode); // Emite o código de pareamento
                    pairingCodeRequested = true;
                }
                rl.close();
            });
        } else {
            rl.close();
        }
    });
    // Evento quando o cliente está pronto
    this.cliente.on('ready', () => {
      this.pronto = true;
      this.tentativasReconexao = 0;
      this.registrador.info('Cliente WhatsApp pronto para uso');
      this.emit('pronto');
      
      // Processar mensagens pendentes com um pequeno atraso
      setTimeout(async () => {
        const mensagensEnviadas = await this.processarMensagensPendentes();
        if (mensagensEnviadas > 0) {
          this.registrador.info(`Enviadas ${mensagensEnviadas} mensagens pendentes após inicialização`);
        }
        // Depois processa notificações em arquivo
        await this.processarNotificacoesPendentes();
      }, 5000);
    });

    // Evento de desconexão
    this.cliente.on('disconnected', (razao) => {
      this.pronto = false;
      this.registrador.error(`Cliente desconectado: ${razao}`);
      this.emit('desconectado', razao);
      this.tratarReconexao();
    });

    // Evento para novas mensagens
    this.cliente.on('message_create', async (msg) => {
      if (!msg.fromMe) {
        this.emit('mensagem', msg);
      }
    });
    
    // Evento para entrada em grupo
    this.cliente.on('group_join', (notificacao) => {
      this.emit('entrada_grupo', notificacao);
    });
    
    // Evento para saída de grupo
    this.cliente.on('group_leave', (notificacao) => {
      this.emit('saida_grupo', notificacao);
    });
  }

  /**
   * Trata a lógica de reconexão automática
   */
  async tratarReconexao() {
    if (this.tentativasReconexao < this.maxTentativasReconexao) {
      this.tentativasReconexao++;
      this.registrador.info(`Tentativa de reconexão ${this.tentativasReconexao}/${this.maxTentativasReconexao}`);
      
      setTimeout(() => {
        try {
          this.inicializarCliente();
        } catch (erro) {
          this.registrador.error(`Erro na tentativa de reconexão: ${erro.message}`);
        }
      }, 5000); // Espera 5 segundos antes de tentar
    } else {
      this.registrador.error(`Número máximo de tentativas (${this.maxTentativasReconexao}) atingido`);
      this.emit('falha_reconexao');
    }
  }

/**
 * Verifica se o cliente realmente está pronto para uso
 * @returns {Promise<boolean>} Verdadeiro se o cliente estiver realmente pronto
 */
async estaProntoRealmente() {
  // Verificação básica
  if (!this.pronto || !this.cliente) {
    return false;
  }
  
  try {
    // Verificação simplificada - se o cliente tem um ID (wid) e diz que está pronto
    // já é suficiente na maioria dos casos
    if (this.cliente.info && this.cliente.info.wid) {
      return true;
    }
    
    // Apenas se a verificação acima falhar, tentamos uma verificação mais profunda
    if (this.cliente.pupPage) {
      const estadoConexao = await this.cliente.pupPage.evaluate(() => {
        return window.Store && 
               window.Store.Conn && 
               window.Store.Conn.connected;
      }).catch(() => null);
      
      // Se conseguimos verificar que está conectado, retornamos true
      // Mas se não conseguimos verificar (erro ou null), ainda assim retornamos true
      // desde que o cliente esteja em estado "pronto"
      return estadoConexao !== false;
    }
    
    // Se chegou aqui, o cliente parece estar inicializado, mas não conseguimos verificar completamente
    // Vamos considerar pronto se o status básico estiver ok
    return this.pronto;
  } catch (erro) {
    this.registrador.error(`Erro ao verificar estado real: ${erro.message}`);
    // Em caso de erro, ainda retornamos true se o cliente disser que está pronto
    return this.pronto;
  }
}

/**
 * Envia uma mensagem como resposta à mensagem original
 * @param {string} para - ID do destinatário 
 * @param {string} conteudo - Texto da mensagem
 * @param {Object|null} opcoes - Objeto de mensagem original OU objeto com opções
 * @returns {Promise<boolean>} Sucesso do envio
 */
async enviarMensagem(para, conteudo, opcoes = null) {
  // Verificação básica de prontidão
  const clientePronto = await this.estaProntoRealmente();
  
  // NOVO: Flag para controlar se devemos tentar reply ou não
  let tentarReply = true;
  
  // NOVO: Verificação de segurança para identificar mensagens após restart
  if (opcoes && opcoes.isRecoveredMessage) {
    tentarReply = false; // Nunca tente reply em mensagens recuperadas
  }
  
  // Tentar extrair o ID do destinatário de várias formas possíveis
  const destinatarioReal = para.includes('@') ? para : `${para}@c.us`;
  
  // Determinar se estamos lidando com um objeto de mensagem ou opções
  let mensagemOriginal = null;
  let quotedMessageId = null;
  
  if (opcoes) {
    if (opcoes.quotedMessageId) {
      // Novo formato: opções com ID da mensagem para citar
      quotedMessageId = opcoes.quotedMessageId;
    } else if (opcoes.reply && typeof opcoes.reply === 'function') {
      // Formato antigo: objeto de mensagem completo
      mensagemOriginal = opcoes;
    }
  }

  // NOVA VERIFICAÇÃO DE SEGURANÇA: Se estamos após restart, fazer uma abordagem direta
  if (!clientePronto || !tentarReply) {
    try {
      this.registrador.info(`Enviando mensagem direta para ${destinatarioReal} (${tentarReply ? 'cliente não pronto' : 'modo recovery'})`);
      
      // Enviar mensagem direta sem tentar responder
      await this.cliente.sendMessage(destinatarioReal, conteudo);
      
      this.ultimoEnvio = Date.now();
      this.registrador.info(`Mensagem enviada com sucesso (envio direto) para ${destinatarioReal}`);
      return true;
    } catch (erroEnvio) {
      this.registrador.warn(`Falha no envio direto para ${destinatarioReal}, adicionando à fila de pendentes: ${erroEnvio.message}`);
      
      this.mensagensPendentes.push({ 
        para: destinatarioReal, 
        conteudo, 
        timestamp: Date.now(),
        naoUsarReply: true // Marca para não tentar usar reply
      });
      
      await this.salvarNotificacaoPendente(destinatarioReal, conteudo, { naoUsarReply: true });
      return false;
    }
  }
  
  // Tentar enviar com reply apenas se temos uma mensagem original válida
  const usarReply = mensagemOriginal && typeof mensagemOriginal.reply === 'function';
  let tentativas = 0;
  const maxTentativas = 3;
  
  while (tentativas < maxTentativas) {
    try {
      if (usarReply) {
        // Tenta responder à mensagem original
        await mensagemOriginal.reply(conteudo);
      } else if (quotedMessageId) {
        // Tenta responder citando a mensagem pelo ID
        await this.cliente.sendMessage(destinatarioReal, conteudo, { quotedMessageId });
      } else {
        // Caso não tenha mensagem original, envia normalmente
        await this.cliente.sendMessage(destinatarioReal, conteudo);
      }
      
      this.ultimoEnvio = Date.now();
      this.registrador.debug(`Mensagem enviada com sucesso para ${destinatarioReal}`);
      return true;
    } catch (erro) {
      tentativas++;
      this.registrador.error(`Erro ao enviar mensagem (tentativa ${tentativas}): ${erro.message}`);
      
      // NOVO: Se falhar com reply, tenta sem reply na próxima vez
      if (erro.message.includes('quoted message') || erro.message.includes('Could not get')) {
        this.registrador.info(`Erro de mensagem citada, tentando envio direto...`);
        
        try {
          // Tenta enviar diretamente sem citação
          await this.cliente.sendMessage(destinatarioReal, conteudo);
          
          this.ultimoEnvio = Date.now();
          this.registrador.info(`Mensagem enviada com sucesso (sem citação) para ${destinatarioReal}`);
          return true;
        } catch (erroSimples) {
          this.registrador.error(`Falha também no envio simples: ${erroSimples.message}`);
        }
      }
      
      if (tentativas >= maxTentativas) {
        // Salvar para tentativa futura, marcando para não usar reply
        await this.salvarNotificacaoPendente(destinatarioReal, conteudo, { naoUsarReply: true });
        throw erro;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

  async processarMensagensPendentes() {
    if (!await this.estaProntoRealmente() || this.mensagensPendentes.length === 0) {
      return 0;
    }
    
    this.registrador.info(`Processando ${this.mensagensPendentes.length} mensagens pendentes...`);
    let enviadas = 0;
    const novasPendentes = [];
    
    for (const msg of this.mensagensPendentes) {
      try {
        if (msg.mensagemOriginalId) {
          try {
            // Tentativa de recuperar a mensagem original pelo ID
            const msgOriginal = await this.cliente.getMessageById(msg.mensagemOriginalId);
            if (msgOriginal) {
              await msgOriginal.reply(msg.conteudo);
              this.ultimoEnvio = Date.now();
              this.registrador.info(`Mensagem pendente enviada como resposta à mensagem original`);
              enviadas++;
              continue;
            }
          } catch (erroMsg) {
            this.registrador.warn(`Não foi possível recuperar a mensagem original: ${erroMsg.message}`);
            // Continuamos para tentar enviar normalmente
          }
        }
        
        await this.cliente.sendMessage(msg.para, msg.conteudo);
        this.ultimoEnvio = Date.now();
        this.registrador.info(`Mensagem pendente enviada com sucesso para ${msg.para}`);
        enviadas++;
      } catch (erro) {
        this.registrador.error(`Erro ao enviar mensagem pendente: ${erro.message}`);
        
        // Retentar apenas mensagens recentes (menos de 30 minutos)
        if (Date.now() - msg.timestamp < 30 * 60 * 1000) {
          novasPendentes.push(msg);
        } else {
          // Para mensagens antigas, só mantém a notificação em arquivo
          await this.salvarNotificacaoPendente(msg.para, msg.conteudo, null);
        }
      }
    }
    
    this.mensagensPendentes = novasPendentes;
    return enviadas;
  }

/**
 * Salva uma notificação para envio posterior
 * @param {string} para - ID do destinatário
 * @param {string} conteudo - Texto da mensagem
 * @param {Object} opcoes - Objeto de mensagem original ou opções
 * @returns {Promise<string>} Caminho do arquivo de notificação
 */
async salvarNotificacaoPendente(para, conteudo, opcoes = null) {
  try {
    // Diretório para salvar as notificações pendentes
    const diretorioTemp = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(diretorioTemp)) {
      fs.mkdirSync(diretorioTemp, { recursive: true });
    }
    
    // Extrair o ID da mensagem original, se disponível
    let mensagemOriginalId = null;
    
    if (opcoes) {
      if (opcoes.quotedMessageId) {
        // Novo formato com ID
        mensagemOriginalId = opcoes.quotedMessageId;
      } else if (opcoes.id && opcoes.id._serialized) {
        // Formato antigo com objeto de mensagem
        mensagemOriginalId = opcoes.id._serialized;
      }
    }
    
    // Criar dados da notificação
    const notificacao = {
      para,
      conteudo,
      timestamp: Date.now(),
      tentativas: 0,
      criadoEm: new Date().toISOString(),
      ultimaTentativa: null,
      statusEntrega: 'pendente',
      mensagemOriginalId
    };
    
    // Nome do arquivo baseado no destinatário e timestamp
    const nomeArquivo = `notificacao_${para.replace('@c.us', '')}_${Date.now()}.json`;
    const caminhoArquivo = path.join(diretorioTemp, nomeArquivo);
    
    // Salvar no arquivo
    fs.writeFileSync(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
    this.registrador.info(`Notificação salva para envio posterior: ${caminhoArquivo}`);
    
    return caminhoArquivo;
  } catch (erro) {
    this.registrador.error(`Erro ao salvar notificação pendente: ${erro.message}`);
    throw erro;
  }
}

/**
 * Processa notificações pendentes incluindo transações
 * @returns {Promise<number>} Número de notificações processadas
 */
async processarNotificacoesPendentes() {
  try {
    const diretorioTemp = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(diretorioTemp)) return 0;
    
    // Obter todos os arquivos de notificação
    const arquivos = fs.readdirSync(diretorioTemp)
      .filter(file => file.startsWith('notificacao_') && file.endsWith('.json'));
    
    if (arquivos.length === 0) return 0;
    
    this.registrador.info(`Encontradas ${arquivos.length} notificações pendentes para processar`);
    let processados = 0;
    
    for (const arquivo of arquivos) {
      try {
        const caminhoArquivo = path.join(diretorioTemp, arquivo);
        const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
        const notificacao = JSON.parse(conteudo);
        
        // Verificar se o cliente está pronto
        if (!await this.estaProntoRealmente()) {
          this.registrador.warn(`Cliente não está pronto para processar notificação: ${arquivo}`);
          continue;
        }
        
        // Marcar chat como visto antes de enviar (evita problemas de estado)
        try {
          const chat = await this.cliente.getChatById(notificacao.para);
          await chat.sendSeen();
        } catch (erroChat) {
          this.registrador.warn(`Não foi possível marcar chat como visto: ${erroChat.message}`);
          // Continuar mesmo assim
        }
        
        // Pequena pausa antes de enviar (estabilidade)
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // Tentar enviar a mensagem
        try {
          if (notificacao.naoUsarReply) {
            // Enviar mensagem sem tentar responder à mensagem original
            this.registrador.info(`Enviando notificação diretamente (sem reply) para ${notificacao.para}`);
            await this.cliente.sendMessage(notificacao.para, notificacao.conteudo);
          } else {
            // Tentar enviar normalmente (pode tentar usar reply)
            this.registrador.info(`Processando notificação pendente para ${notificacao.para}`);
            await this.enviarMensagem(
              notificacao.para, 
              notificacao.conteudo, 
              { 
                isRecoveredNotification: true, 
                transacaoId: notificacao.transacaoId 
              }
            );
          }
          
          // Remover o arquivo após envio bem-sucedido
          fs.unlinkSync(caminhoArquivo);
          this.registrador.info(`✅ Notificação pendente enviada para ${notificacao.para}`);
          
          // Se a notificação tem transação associada, atualizar status
          if (notificacao.transacaoId && this.gerenciadorTransacoes) {
            try {
              await this.gerenciadorTransacoes.marcarComoEntregue(notificacao.transacaoId);
              this.registrador.info(`✅ Transação ${notificacao.transacaoId} atualizada após recuperação`);
            } catch (erroTransacao) {
              this.registrador.warn(`Não foi possível atualizar transação ${notificacao.transacaoId}: ${erroTransacao.message}`);
            }
          }
          
          processados++;
        } catch (erroEnvio) {
          // Atualizar contadores de tentativas na notificação
          notificacao.tentativas = (notificacao.tentativas || 0) + 1;
          notificacao.ultimaTentativa = Date.now();
          
          // Se falhar por problema de mensagem citada, ou após várias tentativas, marcar para não usar reply
          if (erroEnvio.message.includes('quoted message') || 
              erroEnvio.message.includes('Could not get') || 
              notificacao.tentativas >= 3) {
            
            notificacao.naoUsarReply = true;
            this.registrador.info(`Notificação ${arquivo} marcada para envio sem reply nas próximas tentativas`);
          }
          
          // Salvar notificação atualizada
          fs.writeFileSync(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
          this.registrador.warn(`❌ Falha ao processar notificação (${notificacao.tentativas} tentativas): ${erroEnvio.message}`);
          
          // Se já tentou muitas vezes, tenta um método diferente
          if (notificacao.tentativas >= 5) {
            try {
              this.registrador.info(`Tentando método alternativo para notificação problemática...`);
              // Método desespero: envio direto via API
              await this.cliente.sendMessage(notificacao.para, notificacao.conteudo);
              
              // Se conseguiu, remover arquivo
              fs.unlinkSync(caminhoArquivo);
              this.registrador.info(`✅ Notificação problemática resolvida via método alternativo!`);
              processados++;
            } catch (erroFinal) {
              this.registrador.error(`💔 Todos os métodos falharam para notificação: ${erroFinal.message}`);
            }
          }
        }
      } catch (erroProcessamento) {
        this.registrador.error(`Erro ao processar arquivo de notificação ${arquivo}: ${erroProcessamento.message}`);
        
        // Se o arquivo estiver corrompido, tentar mover para outra pasta
        try {
          const diretorioErros = path.join(process.cwd(), 'temp', 'erros');
          if (!fs.existsSync(diretorioErros)) {
            fs.mkdirSync(diretorioErros, { recursive: true });
          }
          
          const caminhoOriginal = path.join(diretorioTemp, arquivo);
          const caminhoDestino = path.join(diretorioErros, `${arquivo}.corrupto`);
          
          fs.renameSync(caminhoOriginal, caminhoDestino);
          this.registrador.info(`Arquivo corrompido movido para: ${caminhoDestino}`);
        } catch (erroMover) {
          this.registrador.error(`Não foi possível mover arquivo corrompido: ${erroMover.message}`);
        }
      }
      
      // Pequena pausa entre processamentos para não sobrecarregar
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (processados > 0) {
      this.registrador.info(`✨ Processadas ${processados} notificações pendentes com sucesso!`);
    }
    
    return processados;
  } catch (erro) {
    this.registrador.error(`Erro ao processar notificações pendentes: ${erro.message}`);
    return 0;
  }
}

  /**
   * Força uma reconexão do WhatsApp sem reiniciar completamente
   * @returns {Promise<boolean>} Sucesso da reconexão
   */
  async reconectar() {
    this.registrador.debug('Tentando reconexão simples do WhatsApp...');
    
    try {
      // Tentar reconectar sem reiniciar tudo
      await this.cliente.pupPage.evaluate(() => {
        if (window.Store && window.Store.Conn) {
          window.Store.Conn.reconnect();
          return true;
        }
        return false;
      }).catch(() => false);
      
      // Dar um tempo para a reconexão ocorrer
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Verificar se realmente reconectou
      const reconectouRealmente = await this.estaProntoRealmente();
      
      if (reconectouRealmente) {
        this.registrador.debug('Reconexão bem-sucedida!');
        this.tentativasReconexao = 0;
        return true;
      } else {
        this.registrador.warn('Reconexão não surtiu efeito');
        return false;
      }
    } catch (erro) {
      this.registrador.error(`Erro na reconexão: ${erro.message}`);
      return false;
    }
  }

  /**
   * Realiza uma reinicialização completa do cliente
   * @returns {Promise<boolean>} Sucesso da reinicialização
   */
  async reiniciarCompleto() {
    this.registrador.info('Iniciando reinicialização completa do cliente...');
    this.pronto = false;
    
    try {
      // 1. Desconectar completamente
      if (this.cliente.pupBrowser) {
        try {
          // Destruir a página atual antes para evitar falhas
          if (this.cliente.pupPage) {
            await this.cliente.pupPage.close().catch(() => {});
          }
          await this.cliente.pupBrowser.close().catch(() => {});
        } catch (err) {
          this.registrador.warn(`Erro ao fechar navegador: ${err.message}`);
        }
      }
      
      // 2. Pausa para garantir liberação de recursos
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 3. Destruir completamente o cliente
      try {
        await this.cliente.destroy().catch(() => {});
      } catch (err) {
        this.registrador.warn(`Erro na destruição do cliente: ${err.message}`);
      }
      
      // 4. Pausa para garantir liberação de recursos
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // 5. Limpar todos os listeners
      this.cliente.removeAllListeners();
      
      // 6. Inicializar um cliente totalmente novo
      this.inicializarCliente();
      
      this.registrador.info('Reinicialização completa concluída. Aguardando reconexão...');
      return true;
    } catch (erro) {
      this.registrador.error(`Erro grave na reinicialização: ${erro.message}`);
      return false;
    }
  }
  
  /**
   * Obtém histórico de mensagens do chat
   * @param {string} chatId - ID do chat
   * @param {number} limite - Número máximo de mensagens
   * @returns {Promise<Array>} Lista de mensagens formatada
   */
  async obterHistoricoMensagens(chatId, limite = 50) {
    try {
      // Obter o objeto de chat pelo ID
      const chat = await this.cliente.getChatById(chatId);
      
      // Carregar as mensagens diretamente
      const mensagensObtidas = await chat.fetchMessages({limit: limite * 2});
      
      if (!mensagensObtidas || !Array.isArray(mensagensObtidas)) {
        this.registrador.warn(`Não foi possível obter mensagens para o chat ${chatId}`);
        return [];
      }
      
      // Filtrar e mapear as mensagens
      const mensagens = mensagensObtidas
        .filter(msg => msg.body && !msg.body.startsWith('!')) // Filtra comandos
        .slice(-limite * 2) // Limita ao número de mensagens
        .map(msg => {
          const remetente = msg.fromMe ? 
            (process.env.BOT_NAME || 'Amélie') : 
            (msg._data.notifyName || msg.author || 'Usuário');
          
          let conteudo = msg.body || '';
          
          // Adiciona informação sobre mídia
          if (msg.hasMedia) {
            if (msg.type === 'image') conteudo = `[Imagem] ${conteudo}`;
            else if (msg.type === 'audio' || msg.type === 'ptt') conteudo = `[Áudio] ${conteudo}`;
            else if (msg.type === 'video') conteudo = `[Vídeo] ${conteudo}`;
            else conteudo = `[Mídia] ${conteudo}`;
          }
          
          return `${remetente}: ${conteudo}`;
        });
      
      return mensagens;
    } catch (erro) {
        this.registrador.error(`Erro ao obter histórico de mensagens: ${erro.message}`, { erro });
        return []; // Retorna array vazio em caso de erro
      }
    }
    
    /**
     * Verifica se devemos responder a uma mensagem em grupo
     * @param {Object} msg - Objeto de mensagem
     * @param {Object} chat - Objeto do chat
     * @returns {Promise<boolean>} Verdadeiro se devemos responder
     */
    async deveResponderNoGrupo(msg, chat) {
      if (msg.body && msg.body.startsWith('!')) {
        this.registrador.debug("Respondendo porque é um comando");
        return true;
      }
  
      const mencoes = await msg.getMentions();
      const botMencionado = mencoes.some(mencao => 
        mencao.id._serialized === this.cliente.info.wid._serialized
      );
      
      if (botMencionado) {
        this.registrador.debug("Respondendo porque o bot foi mencionado");
        return true;
      }
  
      if (msg.hasQuotedMsg) {
        const msgCitada = await msg.getQuotedMessage();
        if (msgCitada.fromMe) {
          this.registrador.debug("Respondendo porque é uma resposta ao bot");
          return true;
        }
      }
  
      this.registrador.debug("Não é nenhum caso especial e não vou responder");
      return false;
    }
  }
  
  module.exports = ClienteWhatsApp;