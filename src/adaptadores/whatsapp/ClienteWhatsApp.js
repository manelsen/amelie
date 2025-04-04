/**
 * ClienteWhatsApp - Módulo para gerenciamento da conexão com WhatsApp
 * 
 * Refatorado para adotar apenas responsabilidades de baixo nível,
 * mantendo o foco na comunicação direta com a API do WhatsApp.
 * 
 * @author Manel
 * @version 3.0.0
 */

const { Client, LocalAuth } = require('whatsapp-web.js'); // Reintroduzido LocalAuth
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Padrão Railway para operações funcionais
const Resultado = {
  sucesso: dados => ({ sucesso: true, dados, erro: null }),
  falha: erro => ({ sucesso: false, dados: null, erro }),
  
  dobrar: (resultado, aoSucesso, aoFalhar) => 
    resultado.sucesso ? aoSucesso(resultado.dados) : aoFalhar(resultado.erro)
};

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
    this.diretorioTemp = opcoes.diretorioTemp || './temp';

    // Garantir que o diretório de arquivos temporários exista
    this._garantirDiretorioExiste(this.diretorioTemp);

    this.inicializarCliente();
  }

  /**
   * Garantir que um diretório exista
   * @param {string} diretorio - Caminho do diretório
   * @private
   */
  _garantirDiretorioExiste(diretorio) {
    if (!fs.existsSync(diretorio)) {
      try {
        fs.mkdirSync(diretorio, { recursive: true });
        this.registrador.debug(`[Whats] Diretório criado: ${diretorio}`);
      } catch (erro) {
        this.registrador.error(`[Whats] Erro ao criar diretório: ${erro.message}`);
      }
    }
  }

  /**
   * Inicializa o cliente WhatsApp
   */
  inicializarCliente() {
    this.cliente = new Client({
      authStrategy: new LocalAuth({ clientId: this.clienteId }), // Reintroduzido LocalAuth para salvar sessão
      puppeteer: {
        executablePath: '/usr/bin/google-chrome',
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
          '--aggressive-cache-discard',
          '--disable-cache',
          '--disable-application-cache',
          '--disable-offline-load-stale-cache',
          '--disk-cache-size=0'
        ],
        defaultViewport: {
          width: 800,
          height: 600
        },
        timeout: 60000,
        ignoreHTTPSErrors: true
      }
    });

    this.configurarOuvinteEventos();
    this.cliente.initialize().then(() => {
      this.registrador.info('[Whats] Cliente inicializado, aguardando para solicitar código de pareamento...');
      
      // Aguarda um tempo definido para verificar se a conexão automática falhou
      // e então tenta solicitar o código de pareamento se necessário.
      setTimeout(async () => {
          // VERIFICAÇÃO ADICIONADA: Só tenta solicitar o código se o cliente NÃO estiver pronto
          if (!this.pronto) {
              this.registrador.info('[Whats] Cliente não conectou automaticamente via sessão salva. Tentando solicitar código de pareamento...');
              const phoneNumber = process.env.PAIRING_PHONE_NUMBER;
              if (!phoneNumber) {
                  this.registrador.warn('[Whats] Variável PAIRING_PHONE_NUMBER não definida e conexão automática falhou. Use o QR Code se aparecer.');
                  return;
              }
              
              try {
                  this.registrador.info(`[Whats] Solicitando código de pareamento para o número: ${phoneNumber}`);
                  const code = await this.cliente.requestPairingCode(phoneNumber);
                  this.registrador.info(`[Whats] Código de pareamento recebido: ${code}. Insira este código no seu telefone.`);
                  this.emit('pairing_code', code);
              } catch (error) {
                  this.registrador.error(`[Whats] Erro ao solicitar código de pareamento: ${error.message}`);
                  this.registrador.info('[Whats] Falha ao obter código de pareamento. Se um QR Code for exibido, use-o.');
              }
          } else {
              this.registrador.debug('[Whats] Cliente já está pronto, não é necessário solicitar código de pareamento.');
          }
      }, 15000); // Aguarda 15 segundos para dar chance à LocalAuth
    });
  }

  /**
   * Configura todos os listeners de eventos do cliente
   */
  configurarOuvinteEventos() {
    // Evento para código QR
    this.cliente.on('qr', (qr) => {
      qrcode.generate(qr, { small: true });
      this.registrador.info('[Whats] Código QR gerado para autenticação.');
      this.emit('qr', qr);
    });

    // Evento quando o cliente está pronto
    this.cliente.on('ready', () => {
      this.pronto = true;
      this.tentativasReconexao = 0;
      this.registrador.info('[Whats] Cliente pronto para uso.');
      this.emit('pronto');
    });

    // Evento de desconexão
    this.cliente.on('disconnected', (razao) => {
      this.pronto = false;
      this.registrador.error(`[Whats] Cliente desconectado: ${razao}`);
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
    
    // Evento de falha na autenticação
    this.cliente.on('auth_failure', (msg) => {
      this.registrador.error(`[Whats] FALHA NA AUTENTICAÇÃO: ${msg}`);
      this.pronto = false; // Garante que o estado 'pronto' seja falso
      this.emit('falha_autenticacao', msg);
      // Poderia tentar reiniciar aqui, mas a desconexão já deve tratar isso
    });
  }

  /**
   * Trata a lógica de reconexão automática
   */
  async tratarReconexao() {
    if (this.tentativasReconexao < this.maxTentativasReconexao) {
      this.tentativasReconexao++;
      this.registrador.info(`[Whats] Tentativa de reconexão ${this.tentativasReconexao}/${this.maxTentativasReconexao}`);

      setTimeout(() => {
        try {
          this.inicializarCliente();
        } catch (erro) {
          this.registrador.error(`[Whats] Erro na tentativa de reconexão: ${erro.message}`);
        }
      }, 5000); // Espera 5 segundos antes de tentar
    } else {
      this.registrador.error(`[Whats] Máximo de tentativas (${this.maxTentativasReconexao}) atingido.`);
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
      this.registrador.error(`[Whats] Erro ao verificar estado real: ${erro.message}`);
      // Em caso de erro, ainda retornamos true se o cliente disser que está pronto
      return this.pronto;
    }
  }

  /**
   * Envia uma mensagem (versão simplificada - apenas comunicação básica)
   * @param {string} para - ID do destinatário 
   * @param {string} conteudo - Texto da mensagem
   * @param {Object|null} opcoes - Opções de envio como quotedMessageId
   * @returns {Promise<boolean>} Sucesso do envio
   */
  async enviarMensagem(para, conteudo, opcoes = null) {
    try {
      // Transformar o ID para o formato esperado caso necessário
      const destinatarioReal = para.includes('@') ? para : `${para}@c.us`;
      
      if (opcoes && opcoes.quotedMessageId) {
        // Envio com citação
        await this.cliente.sendMessage(destinatarioReal, conteudo, { quotedMessageId: opcoes.quotedMessageId });
      } else {
        // Envio direto
        await this.cliente.sendMessage(destinatarioReal, conteudo);
      }
      
      this.ultimoEnvio = Date.now();
      return true;
    } catch (erro) {
      this.registrador.error(`[Whats] Erro ao enviar mensagem: ${erro.message}`);
      return false;
    }
  }

  /**
   * Salva uma notificação para ser entregue posteriormente
   * @param {string} destinatario - ID do destinatário
   * @param {string} conteudo - Texto da mensagem
   * @param {Object} opcoes - Opções adicionais
   * @returns {Promise<string>} Caminho do arquivo de notificação
   */
  async salvarNotificacaoPendente(destinatario, conteudo, opcoes = {}) {
    try {
      // Diretório para salvar as notificações pendentes
      const diretorioTemp = this.diretorioTemp;
      this._garantirDiretorioExiste(diretorioTemp);

      // Criar dados da notificação
      const notificacao = {
        para: destinatario,
        conteudo,
        timestamp: Date.now(),
        tentativas: 0,
        criadoEm: new Date().toISOString(),
        ultimaTentativa: null,
        statusEntrega: 'pendente',
        ...opcoes
      };

      // Nome do arquivo baseado no destinatário e timestamp
      const nomeArquivo = `notificacao_${destinatario.replace('@c.us', '')}_${Date.now()}.json`;
      const caminhoArquivo = path.join(diretorioTemp, nomeArquivo);

      // Salvar no arquivo
      await fs.promises.writeFile(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
      this.registrador.info(`[Whats] Notificação salva para envio posterior: ${caminhoArquivo}`);

      return caminhoArquivo;
    } catch (erro) {
      this.registrador.error(`[Whats] Erro ao salvar notificação pendente: ${erro.message}`);
      throw erro;
    }
  }

  /**
   * Processa notificações pendentes
   * @returns {Promise<number>} Número de notificações processadas
   */
  async processarNotificacoesPendentes() {
    try {
      const diretorioTemp = this.diretorioTemp;
      if (!fs.existsSync(diretorioTemp)) return 0;

      // Obter todos os arquivos de notificação
      const arquivos = await fs.promises.readdir(diretorioTemp);
      const notificacoes = arquivos.filter(file => file.startsWith('notificacao_') && file.endsWith('.json'));

      if (notificacoes.length === 0) return 0;

      this.registrador.info(`[Whats] Encontradas ${notificacoes.length} notificações pendentes.`); // Simplificado
      let processadas = 0;

      for (const arquivo of notificacoes) {
        try {
          const caminhoArquivo = path.join(diretorioTemp, arquivo);
          const conteudo = await fs.promises.readFile(caminhoArquivo, 'utf8');
          const notificacao = JSON.parse(conteudo);

          // Verificar se o cliente está pronto
          if (!await this.estaProntoRealmente()) {
            this.registrador.warn(`[Whats] Cliente não pronto para processar notificação: ${arquivo}`);
            continue;
          }

          // Marcar chat como visto antes de enviar (evita problemas de estado)
          try {
            const chat = await this.cliente.getChatById(notificacao.para);
            await chat.sendSeen();
          } catch (erroChat) {
            this.registrador.warn(`[Whats] Não foi possível marcar chat como visto: ${erroChat.message}`);
            // Continuar mesmo assim
          }

          // Pequena pausa antes de enviar (estabilidade)
          await new Promise(resolve => setTimeout(resolve, 800));

          // Tentar enviar a mensagem
          try {
            await this.cliente.sendMessage(notificacao.para, notificacao.conteudo);
            
            // Remover o arquivo após envio bem-sucedido
            await fs.promises.unlink(caminhoArquivo);
            this.registrador.info(`[Whats] ✅ Notificação pendente enviada.`); // Removido 'para'

            processadas++;
          } catch (erroEnvio) {
            // Atualizar contadores de tentativas na notificação
            notificacao.tentativas = (notificacao.tentativas || 0) + 1;
            notificacao.ultimaTentativa = Date.now();

            // Salvar notificação atualizada
            await fs.promises.writeFile(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
            this.registrador.warn(`[Whats] ❌ Falha ao processar notificação (${notificacao.tentativas} tentativas): ${erroEnvio.message}`);
          }
        } catch (erroProcessamento) {
          this.registrador.error(`[Whats] Erro ao processar arquivo de notificação ${arquivo}: ${erroProcessamento.message}`);
        }
      }

      if (processadas > 0) {
        this.registrador.info(`[Whats] Processadas ${processadas} notificações pendentes.`); // Simplificado
      }

      return processadas;
    } catch (erro) {
      this.registrador.error(`[Whats] Erro ao verificar diretório de notificações: ${erro.message}`);
      return 0;
    }
  }

  /**
   * Força uma reconexão do WhatsApp sem reiniciar completamente
   * @returns {Promise<boolean>} Sucesso da reconexão
   */
  async reconectar() {
    this.registrador.debug('[Whats] Tentando reconexão simples...');

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
        this.registrador.debug('[Whats] Reconexão bem-sucedida!');
        this.tentativasReconexao = 0;
        return true;
      } else {
        this.registrador.warn('[Whats] Reconexão não surtiu efeito.');
        return false;
      }
    } catch (erro) {
      this.registrador.error(`[Whats] Erro na reconexão: ${erro.message}`);
      return false;
    }
  }

  /**
   * Realiza uma reinicialização completa do cliente
   * @returns {Promise<boolean>} Sucesso da reinicialização
   */
  async reiniciarCompleto() {
    this.registrador.info('[Whats] Iniciando reinicialização completa...');
    this.pronto = false;

    try {
      // 1. Desconectar completamente
      if (this.cliente.pupBrowser) {
        try {
          // Destruir a página atual antes para evitar falhas
          if (this.cliente.pupPage) {
            await this.cliente.pupPage.close().catch(() => { });
          }
          await this.cliente.pupBrowser.close().catch(() => { });
        } catch (err) {
          this.registrador.warn(`[Whats] Erro ao fechar navegador: ${err.message}`);
        }
      }

      // 2. Pausa para garantir liberação de recursos
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 3. Destruir completamente o cliente
      try {
        await this.cliente.destroy().catch(() => { });
      } catch (err) {
        this.registrador.warn(`[Whats] Erro na destruição do cliente: ${err.message}`);
      }

      // 4. Pausa para garantir liberação de recursos
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 5. Limpar todos os listeners
      this.cliente.removeAllListeners();

      // 6. Inicializar um cliente totalmente novo
      this.inicializarCliente();

      this.registrador.info('[Whats] Reinicialização completa concluída. Aguardando reconexão...');
      return true;
    } catch (erro) {
      this.registrador.error(`[Whats] Erro grave na reinicialização: ${erro.message}`);
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
      const mensagensObtidas = await chat.fetchMessages({ limit: limite * 2 });

      if (!mensagensObtidas || !Array.isArray(mensagensObtidas)) {
        this.registrador.warn(`[Whats] Não foi possível obter mensagens para o chat ${chatId}`);
        return [];
      }

      // Filtrar e mapear as mensagens
      const mensagens = mensagensObtidas
        .filter(msg => msg.body && !msg.body.startsWith('.')) // Filtra comandos
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
      this.registrador.error(`[Whats] Erro ao obter histórico de mensagens: ${erro.message}`);
      return []; // Retorna array vazio em caso de erro
    }
  }

  /**
   * Verifica se devemos responder a uma mensagem em grupo
   * @param {Object} msg - Objeto da mensagem
   * @param {Object} chat - Objeto do chat
   * @returns {Promise<boolean>} Verdadeiro se deve responder
   */
  async deveResponderNoGrupo(msg, chat) {
    const chatId = chat.id._serialized;
    const msgId = msg.id._serialized;
    const botId = this.cliente?.info?.wid?._serialized;
    const nomeGrupo = chat.name || chatId;
    const prefixoLog = `[Whats][GrupoResp][${nomeGrupo}]`; // Contexto mais curto

    this.registrador.debug(`${prefixoLog} INICIO: Verificando msg ${msgId}.`); // Removido Bot ID

    // Log inicial das propriedades da mensagem
    this.registrador.debug(`${prefixoLog} Props: Body='${msg.body}', Media=${msg.hasMedia}, Quoted=${msg.hasQuotedMsg}, Type=${msg.type}`); // Mais curto

    // 1. Verificar se é comando
    this.registrador.debug(`${prefixoLog} Passo 1: Comando?`);
    if (typeof msg.body === 'string' && msg.body.startsWith('.')) {
      const comando = msg.body.split(' ')[0];
      this.registrador.debug(`${prefixoLog} -> SIM (Comando: ${comando})`);
      return true;
    }
    this.registrador.debug(`${prefixoLog} -> NÃO`);

    // 2. Verificar se tem mídia
    this.registrador.debug(`${prefixoLog} Passo 2: Mídia?`);
    if (msg.hasMedia) {
      this.registrador.debug(`${prefixoLog} -> SIM (Tipo: ${msg.type})`);
      return true;
    }
    this.registrador.debug(`${prefixoLog} -> NÃO`);

    // 3. Verificar menções
    this.registrador.debug(`${prefixoLog} Passo 3: Menção?`);
    if (botId) {
      try {
        const mencoes = await msg.getMentions();
        const botMencionado = mencoes.some(mencao => mencao.id._serialized === botId);
        this.registrador.debug(`${prefixoLog} Verif. menção: ${botMencionado}`);
        if (botMencionado) {
          this.registrador.debug(`${prefixoLog} -> SIM`);
          return true;
        }
      } catch (errorMencao) {
        // Manter como erro, pois é uma falha inesperada
        this.registrador.error(`${prefixoLog} FALHA CRÍTICA ao verificar menções: ${errorMencao.message}`);
        this.registrador.debug(`${prefixoLog} -> ERRO`);
        return false;
      }
    } else {
      this.registrador.warn(`${prefixoLog} ID do bot não disponível, pulando verif. menção.`);
    }
    this.registrador.debug(`${prefixoLog} -> NÃO`);

    // 4. Verificar citação de mensagem do bot
    this.registrador.debug(`${prefixoLog} Passo 4: Citação do bot?`);
    if (msg.hasQuotedMsg) {
      try {
        const msgCitada = await msg.getQuotedMessage();
        if (msgCitada) {
            this.registrador.debug(`${prefixoLog} Msg citada obtida. É do bot? ${msgCitada.fromMe}.`);
            if (msgCitada.fromMe) {
              this.registrador.debug(`${prefixoLog} -> SIM`);
              return true;
            } else {
              this.registrador.debug(`${prefixoLog} Msg citada NÃO é do bot.`);
            }
        } else {
             this.registrador.warn(`${prefixoLog} Msg citada retornou null/undefined.`);
        }
      } catch (errorCitacao) {
        // Manter como erro, pois é uma falha inesperada
        this.registrador.error(`${prefixoLog} FALHA CRÍTICA ao verificar msg citada: ${errorCitacao.message}`);
        this.registrador.debug(`${prefixoLog} -> ERRO`);
        return false;
      }
    } else {
        this.registrador.debug(`${prefixoLog} Não possui citação.`);
    }
    this.registrador.debug(`${prefixoLog} -> NÃO`);

    // 5. Nenhuma condição atendida
    this.registrador.debug(`${prefixoLog} FIM: Nenhuma condição atendida. Não responder.`);
    return false;
  }
}

module.exports = ClienteWhatsApp;
