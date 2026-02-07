/**
 * Amélie - Assistente Virtual de IA para WhatsApp
 * 
 * Arquivo principal que inicializa e integra os módulos do sistema.
 * 
 * @author Belle Utsch
 * @version 3.0.0 (Funcional Total)
 * @license MIT
 */

const winston = require('winston');
const moment = require('moment-timezone');
const colors = require('colors/safe');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Carregar variáveis de ambiente
dotenv.config();

// Definir o fuso horário padrão para moment
moment.tz.setDefault("America/Sao_Paulo");

// Importar fábricas e módulos funcionais
const { criarConfigManager } = require('./config/ConfigManager');
const { criarClienteWhatsApp } = require('./adaptadores/whatsapp/ClienteWhatsApp');
const criarAdaptadorAI = require('./adaptadores/ai/GerenciadorAI');
const { criarAdaptadorGerenciadorMensagens } = require('./adaptadores/whatsapp/AdaptadorGerenciadorMensagens');
const { criarGerenciadorNotificacoes } = require('./adaptadores/whatsapp/GerenciadorNotificacoes');
const inicializarFilasMidia = require('./adaptadores/queue/FilasMidia');
const { criarGerenciadorTransacoes } = require('./adaptadores/transacoes/GerenciadorTransacoes');
const criarServicoMensagem = require('./servicos/ServicoMensagem');

// Configurações
const API_KEY = process.env.API_KEY;
const nivel_debug = process.env.LOG_LEVEL || 'info';

// Garantir que os diretórios essenciais existam
const diretorios = ['./db', './temp', './logs'];
for (const dir of diretorios) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Configuração de formato personalizado para o logger (com colunas)
 */
const meuFormato = winston.format.printf(({ timestamp, level, message }) => {
  const timestampFormatado = moment(timestamp).format('DD/MM/YYYY HH:mm:ss');
  const contextoMatch = message.match(/^\[([^\]]+)\]\s*/);
  const transacaoMatch = message.match(/\b(tx_\d+_[a-f0-9]+)\b/);

  let contexto = 'Geral';
  let mensagemPrincipal = message;
  let idTransacao = '';

  if (contextoMatch) {
    contexto = contextoMatch[1];
    mensagemPrincipal = mensagemPrincipal.replace(contextoMatch[0], '');
  }

  if (transacaoMatch) {
    idTransacao = transacaoMatch[1];
    mensagemPrincipal = mensagemPrincipal.replace(transacaoMatch[0], '');
  }

  mensagemPrincipal = mensagemPrincipal.replace(/\s*-\s*$/, '').trim().replace(/\s{2,}/g, ' ');

  const levelFormatado    = colors.yellow(`[${level}]`);
  const contextoFormatado = colors.green(`[${contexto}]`);

  let logString = `${timestampFormatado} ${levelFormatado} ${contextoFormatado} ${mensagemPrincipal}`;
  if (idTransacao) logString += ` (ID: ${idTransacao})`;

  return logString.trim();
});

const formatoArquivo = winston.format.printf(({ timestamp, level, message }) => {
  const timestampFormatado = moment(timestamp).format('DD/MM/YYYY HH:mm:ss');
  const contextoMatch = message.match(/^\[([^\]]+)\]\s*/);
  const transacaoMatch = message.match(/\b(tx_\d+_[a-f0-9]+)\b/);

  let contexto = 'Geral';
  let mensagemPrincipal = message;
  let idTransacao = '';

  if (contextoMatch) {
    contexto = contextoMatch[1];
    mensagemPrincipal = mensagemPrincipal.replace(contextoMatch[0], '');
  }

  if (transacaoMatch) {
    idTransacao = transacaoMatch[1];
    mensagemPrincipal = mensagemPrincipal.replace(transacaoMatch[0], '');
  }

  mensagemPrincipal = mensagemPrincipal.replace(/\s*-\s*$/, '').trim().replace(/\s{2,}/g, ' ');

  const levelFormatado = `[${level.toUpperCase()}]`;
  const contextoFormatado = `[${contexto}]`;

  let logString = `${timestampFormatado} ${levelFormatado} ${contextoFormatado} ${mensagemPrincipal}`;
  if (idTransacao) logString += ` (ID: ${idTransacao})`;

  return logString.trim();
});

const logger = winston.createLogger({
  level: nivel_debug,
  format: winston.format.combine(winston.format.timestamp(), meuFormato),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(meuFormato) }),
    new winston.transports.File({
      filename: './logs/bot.log',
      format: winston.format.combine(winston.format.uncolorize(), formatoArquivo)
    }),
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error',
      format: winston.format.combine(winston.format.uncolorize(), formatoArquivo)
    })
  ]
});

// Inicializar os componentes do sistema usando as fábricas
logger.info('🤖 Iniciando Amélie - Assistente Virtual de IA para WhatsApp (Versão Funcional)');

// 1. Inicializar gerenciador de configurações
const configManager = criarConfigManager(logger, path.join(process.cwd(), 'db'));
logger.info('⚙️ Gerenciador de configurações inicializado');

// 2. Inicializar o cliente WhatsApp
const clienteWhatsApp = criarClienteWhatsApp(logger, {
  maxTentativasReconexao: 5,
  clienteId: 'principal',
  diretorioTemp: './temp'
});
logger.info('📱 Cliente WhatsApp inicializado');

// 3. Inicializar o gerenciador de notificações
const gerenciadorNotificacoes = criarGerenciadorNotificacoes(logger, './temp');
logger.info('🔔 Gerenciador de notificações inicializado');

// 4. Inicializar o gerenciador de IA
const gerenciadorAI = criarAdaptadorAI({ registrador: logger, apiKey: API_KEY });
logger.info('🧠 Gerenciador de IA inicializado');

// 5. Inicializar o gerenciador de transações
const gerenciadorTransacoes = criarGerenciadorTransacoes(logger, path.join(process.cwd(), 'db'));
logger.info('💼 Gerenciador de transações inicializado');

// 6. Inicializar o serviço de mensagens
const servicoMensagem = criarServicoMensagem(logger, clienteWhatsApp, gerenciadorTransacoes);
logger.info('💬 Serviço de mensagens inicializado');

// 7. Inicializar o monitor de saúde
const monitorSaude = require('./monitoramento/MonitorSaude').criar(logger, clienteWhatsApp);
logger.info('❤️‍🩹 Monitor de saúde inicializado');

// Componentes inicializados assincronamente após conexão
let filasMidia = null;
let gerenciadorMensagens = null;

// Configurar eventos do cliente WhatsApp
clienteWhatsApp.on('pronto', async () => {
  logger.info('📱 Cliente WhatsApp pronto e conectado!');

  // 8. Inicializar filas de mídia
  filasMidia = inicializarFilasMidia(logger, gerenciadorAI, configManager, servicoMensagem);
  logger.info('🔄 Filas de mídia inicializadas');

  // 9. Inicializar gerenciador de mensagens
  gerenciadorMensagens = criarAdaptadorGerenciadorMensagens(
    logger,
    clienteWhatsApp,
    configManager,
    gerenciadorAI,
    filasMidia,
    gerenciadorTransacoes,
    servicoMensagem
  );
  logger.info('💬 Gerenciador de mensagens inicializado');

  // Registrar como handler
  gerenciadorMensagens.registrarComoHandler(clienteWhatsApp);

  // Iniciar o monitor de saúde
  monitorSaude.parar();
  monitorSaude.iniciar();

  // Limpar transações problemáticas antes de processar
  await gerenciadorTransacoes.limparTransacoesIncompletas();

  // Processar pendências
  const resultadoNotificacoes = await gerenciadorNotificacoes.processar(clienteWhatsApp.getRawClient());
  const notificacoesProcessadas = resultadoNotificacoes.sucesso ? resultadoNotificacoes.dados : 0;

  const resultadoTransacoes = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp);
  const transacoesProcessadas = resultadoTransacoes.sucesso ? resultadoTransacoes.dados : 0;

  if (notificacoesProcessadas > 0 || transacoesProcessadas > 0) {
    logger.info(`Processamento inicial: ${notificacoesProcessadas} notificações, ${transacoesProcessadas} transações`);
  }
});

// Verificação de saúde periódica
setInterval(async () => {
  if (clienteWhatsApp.getPronto() && filasMidia && gerenciadorMensagens) {
    try {
      await gerenciadorTransacoes.limparTransacoesIncompletas();
      const resNotif = await gerenciadorNotificacoes.processar(clienteWhatsApp.getRawClient());
      const resTrans = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp);

      if ((resNotif.sucesso && resNotif.dados > 0) || (resTrans.sucesso && resTrans.dados > 0)) {
        logger.info(`Processamento periódico: ${resNotif.dados || 0} notificações, ${resTrans.dados || 0} transações`);
      }
    } catch (erro) {
      logger.error(`Erro no processamento periódico: ${erro.message}`);
    }
  }
}, 30000); // A cada 30 segundos (reduzido para economizar recursos)

// Limpeza diária
setInterval(async () => {
  if (clienteWhatsApp.getPronto() && filasMidia) {
    try {
      await gerenciadorNotificacoes.limparAntigas(1);
      await gerenciadorTransacoes.limparTransacoesAntigas(1);
      await gerenciadorTransacoes.limparTransacoesIncompletas();
      await filasMidia.limparTrabalhosPendentes();
    } catch (erro) {
      logger.error(`Erro na limpeza periódica: ${erro.message}`);
    }
  }
}, 24 * 60 * 60 * 1000);

// Tratamento de erros globais
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (erro) => {
  logger.error(`Uncaught Exception: ${erro.message}`, { erro });
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(1);
  }
});

logger.info('🚀 Sistema iniciado com sucesso! Aguardando conexão do WhatsApp...');
