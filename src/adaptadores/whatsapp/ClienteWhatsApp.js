/**
 * ClienteWhatsApp - Módulo funcional para gerenciamento da conexão com WhatsApp
 * 
 * @author Manel
 * @version 3.1.0 (Funcional)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * Cria uma nova instância funcional do cliente WhatsApp
 * @param {Object} registrador - Objeto logger para registro de eventos
 * @param {Object} opcoes - Opções de configuração
 */
const criarClienteWhatsApp = (registrador, opcoes = {}) => {
  const eventos = new EventEmitter();
  let pronto = false;
  let tentativasReconexao = 0;
  const maxTentativasReconexao = opcoes.maxTentativasReconexao || 5;
  let cliente = null;
  let ultimoEnvio = Date.now();
  const clienteId = opcoes.clienteId || 'principal';
  const diretorioTemp = opcoes.diretorioTemp || './temp';

  const garantirDiretorioExiste = (diretorio) => {
    if (!fs.existsSync(diretorio)) {
      try {
        fs.mkdirSync(diretorio, { recursive: true });
      } catch (erro) {
        registrador.error(`[Whats] Erro ao criar diretório: ${erro.message}`);
      }
    }
  };

  garantirDiretorioExiste(diretorioTemp);

  const configurarOuvinteEventos = (instanciaCliente) => {
    instanciaCliente.on('qr', (qr) => {
      if (process.env.PAIRING_PHONE_NUMBER) {
        registrador.info('[Whats] QR Code recebido, mas PAIRING_PHONE_NUMBER está definido. Aguardando Pairing Code...');
        return;
      }
      qrcode.generate(qr, { small: true });
      registrador.info('[Whats] Código QR gerado para autenticação.');
      eventos.emit('qr', qr);
    });

    instanciaCliente.on('ready', () => {
      pronto = true;
      tentativasReconexao = 0;
      registrador.info('[Whats] Evento "ready" recebido. Cliente pronto.');
      eventos.emit('pronto');
    });

    instanciaCliente.on('disconnected', (razao) => {
      const timestamp = new Date().toISOString();
      registrador.error(`[Whats][${timestamp}] Evento "disconnected" recebido. Razão: ${razao}`);
      pronto = false;
      eventos.emit('desconectado', razao);
      tratarReconexao();
    });

    instanciaCliente.on('change_state', state => {
        registrador.info(`[Whats] Evento "change_state" recebido. Novo estado: ${state}`);
    });

    instanciaCliente.on('message_create', async (msg) => {
      if (!msg.fromMe) {
        eventos.emit('mensagem', msg);
      }
    });

    instanciaCliente.on('group_join', (notificacao) => {
      eventos.emit('entrada_grupo', notificacao);
    });

    instanciaCliente.on('group_leave', (notificacao) => {
      eventos.emit('saida_grupo', notificacao);
    });
    
    instanciaCliente.on('auth_failure', (msg) => {
      const timestamp = new Date().toISOString();
      registrador.error(`[Whats][DEBUG][${timestamp}] Evento "auth_failure" recebido: ${msg}`);
      pronto = false;
      eventos.emit('falha_autenticacao', msg);
    });
  };

  const inicializarCliente = () => {
    cliente = new Client({
      authStrategy: new LocalAuth({ clientId: clienteId }),
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--js-flags=--expose-gc',
        ],
        defaultViewport: { width: 800, height: 600 },
        timeout: 60000,
        ignoreHTTPSErrors: true
      }
    });

    configurarOuvinteEventos(cliente);
    
    cliente.initialize().then(async () => {
      registrador.info('[Whats] Cliente inicializado.');
      
      if (process.env.PAIRING_PHONE_NUMBER && !pronto) {
          setTimeout(async () => {
            if (!pronto) {
               try {
                   registrador.info(`[Whats] Solicitando código de pareamento para ${process.env.PAIRING_PHONE_NUMBER}`);
                   const code = await cliente.requestPairingCode(process.env.PAIRING_PHONE_NUMBER);
                   registrador.info(`[Whats] Código de pareamento recebido: ${code}`);
                   eventos.emit('pairing_code', code);
               } catch (e) {
                   registrador.error(`[Whats] Erro ao solicitar Pairing Code: ${e.message}`);
               }
            }
          }, 5000);
      }
    });
  };

  const tratarReconexao = () => {
    if (tentativasReconexao < maxTentativasReconexao) {
      tentativasReconexao++;
      registrador.info(`[Whats] Tentativa de reconexão ${tentativasReconexao}/${maxTentativasReconexao}`);
      setTimeout(() => {
        try {
          inicializarCliente();
        } catch (erro) {
          registrador.error(`[Whats] Erro na tentativa de reconexão: ${erro.message}`);
        }
      }, 5000);
    } else {
      registrador.error(`[Whats] Máximo de tentativas (${maxTentativasReconexao}) atingido.`);
      eventos.emit('falha_reconexao');
    }
  };

  const estaProntoRealmente = async () => {
    if (!pronto || !cliente) return false;
    try {
      if (cliente.info && cliente.info.wid) return true;
      if (cliente.pupPage) {
        const estadoConexao = await cliente.pupPage.evaluate(() => {
          return window.Store && window.Store.Conn && window.Store.Conn.connected;
        }).catch(() => null);
        return estadoConexao !== false;
      }
      return pronto;
    } catch (erro) {
      registrador.error(`[Whats] Erro ao verificar estado real: ${erro.message}`);
      return pronto;
    }
  };

  const enviarMensagem = async (para, conteudo, opcoesEnvio = null) => {
    try {
      const destinatarioReal = para.includes('@') ? para : `${para}@c.us`;
      if (opcoesEnvio && opcoesEnvio.quotedMessageId) {
        await cliente.sendMessage(destinatarioReal, conteudo, { quotedMessageId: opcoesEnvio.quotedMessageId });
      } else {
        await cliente.sendMessage(destinatarioReal, conteudo);
      }
      ultimoEnvio = Date.now();
      return true;
    } catch (erro) {
      registrador.error(`[Whats] Erro ao enviar mensagem: ${erro.message}`);
      return false;
    }
  };

  const salvarNotificacaoPendente = async (destinatario, conteudo, opcoesNotif = {}) => {
    try {
      garantirDiretorioExiste(diretorioTemp);
      const notificacao = {
        para: destinatario,
        conteudo,
        timestamp: Date.now(),
        tentativas: 0,
        criadoEm: new Date().toISOString(),
        ultimaTentativa: null,
        statusEntrega: 'pendente',
        ...opcoesNotif
      };
      const nomeArquivo = `notificacao_${destinatario.replace('@c.us', '')}_${Date.now()}.json`;
      const caminhoArquivo = path.join(diretorioTemp, nomeArquivo);
      await fs.promises.writeFile(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
      registrador.info(`[Whats] Notificação salva para envio posterior: ${caminhoArquivo}`);
      return caminhoArquivo;
    } catch (erro) {
      registrador.error(`[Whats] Erro ao salvar notificação pendente: ${erro.message}`);
      throw erro;
    }
  };

  const processarNotificacoesPendentes = async () => {
    try {
      if (!fs.existsSync(diretorioTemp)) return 0;
      const arquivos = await fs.promises.readdir(diretorioTemp);
      const notificacoes = arquivos.filter(file => file.startsWith('notificacao_') && file.endsWith('.json'));
      if (notificacoes.length === 0) return 0;

      registrador.info(`[Whats] Encontradas ${notificacoes.length} notificações pendentes.`);
      let processadas = 0;

      for (const arquivo of notificacoes) {
        try {
          const caminhoArquivo = path.join(diretorioTemp, arquivo);
          const conteudoJson = await fs.promises.readFile(caminhoArquivo, 'utf8');
          const notificacao = JSON.parse(conteudoJson);

          if (!await estaProntoRealmente()) {
            registrador.warn(`[Whats] Cliente não pronto para processar notificação: ${arquivo}`);
            continue;
          }

          try {
            const chat = await cliente.getChatById(notificacao.para);
            await chat.sendSeen();
          } catch (erroChat) {
            registrador.warn(`[Whats] Não foi possível marcar chat como visto: ${erroChat.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 800));

          try {
            await cliente.sendMessage(notificacao.para, notificacao.conteudo);
            await fs.promises.unlink(caminhoArquivo);
            registrador.info(`[Whats] ✅ Notificação pendente enviada.`);
            processadas++;
          } catch (erroEnvio) {
            notificacao.tentativas = (notificacao.tentativas || 0) + 1;
            notificacao.ultimaTentativa = Date.now();
            await fs.promises.writeFile(caminhoArquivo, JSON.stringify(notificacao, null, 2), 'utf8');
            registrador.warn(`[Whats] ❌ Falha ao processar notificação (${notificacao.tentativas} tentativas): ${erroEnvio.message}`);
          }
        } catch (erroProcessamento) {
          registrador.error(`[Whats] Erro ao processar arquivo de notificação ${arquivo}: ${erroProcessamento.message}`);
        }
      }

      if (processadas > 0) {
        registrador.info(`[Whats] Processadas ${processadas} notificações pendentes.`);
      }

      return processadas;
    } catch (erro) {
      registrador.error(`[Whats] Erro ao verificar diretório de notificações: ${erro.message}`);
      return 0;
    }
  };

  const obterHistoricoMensagens = async (chatId, limite = 50) => {
    try {
      const chat = await cliente.getChatById(chatId);
      const mensagensObtidas = await chat.fetchMessages({ limit: limite * 2 });
      if (!mensagensObtidas || !Array.isArray(mensagensObtidas)) return [];

      return mensagensObtidas
        .filter(msg => msg.body && !msg.body.startsWith('.'))
        .slice(-limite * 2)
        .map(msg => {
          const remetente = msg.fromMe ? (process.env.BOT_NAME || 'Amélie') : (msg._data.notifyName || msg.author || 'Usuário');
          let conteudo = msg.body || '';
          if (msg.hasMedia) {
            if (msg.type === 'image') conteudo = `[Image] ${conteudo}`;
            else if (msg.type === 'audio' || msg.type === 'ptt') conteudo = `[Áudio] ${conteudo}`;
            else if (msg.type === 'video') conteudo = `[Vídeo] ${conteudo}`;
            else conteudo = `[Mídia] ${conteudo}`;
          }
          return `${remetente}: ${conteudo}`;
        });
    } catch (erro) {
      registrador.error(`[Whats] Erro ao obter histórico de mensagens: ${erro.message}`);
      return [];
    }
  };

  const deveResponderNoGrupo = async (msg, chat) => {
    const botId = cliente?.info?.wid?._serialized;
    if (typeof msg.body === 'string' && msg.body.startsWith('.')) return true;
    if (msg.hasMedia) return true;
    if (botId) {
      try {
        const mencoes = await msg.getMentions();
        if (mencoes.some(mencao => mencao.id?._serialized === botId)) return true;
      } catch (errorMencao) {
        registrador.error(`[Whats] Erro ao verificar menções: ${errorMencao.message}`);
        return false;
      }
    }
    if (msg.hasQuotedMsg) {
      try {
        const msgCitada = await msg.getQuotedMessage();
        if (msgCitada && msgCitada.fromMe) return true;
      } catch (errorCitacao) {
        registrador.error(`[Whats] Erro ao verificar msg citada: ${errorCitacao.message}`);
        return false;
      }
    }
    return false;
  };

  const reiniciarCompleto = async () => {
    registrador.info('[Whats] Iniciando reinicialização completa...');
    pronto = false;
    try {
      if (cliente && cliente.pupBrowser) {
        if (cliente.pupPage) await cliente.pupPage.close().catch(() => { });
        await cliente.pupBrowser.close().catch(() => { });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (cliente) await cliente.destroy().catch(() => { });
      await new Promise(resolve => setTimeout(resolve, 3000));
      cliente.removeAllListeners();
      inicializarCliente();
      registrador.info('[Whats] Reinicialização completa concluída.');
      return true;
    } catch (erro) {
      registrador.error(`[Whats] Erro grave na reinicialização: ${erro.message}`);
      return false;
    }
  };

  // Inicializa o cliente pela primeira vez
  inicializarCliente();

  return {
    on: eventos.on.bind(eventos),
    emit: eventos.emit.bind(eventos),
    estaProntoRealmente,
    enviarMensagem,
    salvarNotificacaoPendente,
    processarNotificacoesPendentes,
    obterHistoricoMensagens,
    deveResponderNoGrupo,
    reiniciarCompleto,
    getRawClient: () => cliente,
    getPronto: () => pronto,
    getUltimoEnvio: () => ultimoEnvio
  };
};

module.exports = { criarClienteWhatsApp };
