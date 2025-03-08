/**
 * Amélie - Assistente Virtual de IA para WhatsApp
 * 
 * Arquivo principal que inicializa e integra os módulos do sistema.
 * Esta versão utiliza a arquitetura hexagonal para melhor organização.
 * 
 * @author Belle Utsch
 * @version 2.0.0
 * @license MIT
 */

const winston = require('winston');
const colors = require('colors/safe');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Carregar variáveis de ambiente
dotenv.config();

// Importar módulos da aplicação
const ConfigManager = require('./config/ConfigManager');

const ClienteWhatsApp = require('./adaptadores/whatsapp/ClienteWhatsApp');
const GerenciadorAI = require('./adaptadores/ai/GerenciadorAI');
const GerenciadorMensagens = require('./adaptadores/whatsapp/GerenciadorMensagens');
const GerenciadorNotificacoes = require('./adaptadores/whatsapp/GerenciadorNotificacoes');

const FilaProcessador = require('./adaptadores/queue/FilaProcessador');
const GerenciadorTransacoes = require('./adaptadores/transacoes/GerenciadorTransacoes');
const MonitorSaude = require('./monitoramento/MonitorSaude');

// Configurações
const BOT_NAME = process.env.BOT_NAME || 'Amélie';
const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';
const API_KEY = process.env.API_KEY;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '50');
const nivel_debug = process.env.LOG_LEVEL || 'info';

// Garantir que os diretórios essenciais existam
const diretorios = ['./db', './temp', './logs'];
for (const dir of diretorios) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Configuração de formato personalizado para o logger
 */
const meuFormato = winston.format.printf(({ timestamp, level, message, ...rest }) => {
  const dadosExtras = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
  
  // Usar expressões regulares para colorir apenas partes específicas
  let mensagemColorida = message;
  
  // Colorir apenas "Mensagem de [nome]" em verde
  mensagemColorida = mensagemColorida.replace(
    /(Mensagem de [^:]+):/g, 
    match => colors.green(match)
  );
  
  // Colorir apenas "Resposta:" em azul
  mensagemColorida = mensagemColorida.replace(
    /\b(Resposta):/g, 
    match => colors.blue(match)
  );
  
  return `${timestamp} [${colors.yellow(level)}]: ${mensagemColorida} ${dadosExtras}`;
});

/**
 * Configuração do logger com saída para console e arquivo
 */
const logger = winston.createLogger({
  level: nivel_debug,
  format: winston.format.combine(
    winston.format.timestamp(),
    meuFormato
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(
          {
            format: 'DD/MM/YYYY HH:mm:ss'
          }
        ),
        meuFormato
      )
    }),
    new winston.transports.File({ 
      filename: './logs/bot.log',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.uncolorize(), // Remove cores para o arquivo de log
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          const dadosExtras = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
          return `${timestamp} [${level}]: ${message} ${dadosExtras}`;
        })
      )
    }),
    new winston.transports.File({ 
      filename: './logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.uncolorize(),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          const dadosExtras = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
          return `${timestamp} [${level}]: ${message} ${dadosExtras}`;
        })
      )
    })
  ]
});

/**
 * Texto de ajuda com lista de comandos
 * @type {string}
 */
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

// Inicializar os componentes do sistema
logger.info('🤖 Iniciando Amélie - Assistente Virtual de IA para WhatsApp');

// 1. Inicializar gerenciador de configurações
const configManager = new ConfigManager(logger, './db');
logger.info('✅ Gerenciador de configurações inicializado');

// 2. Inicializar o cliente WhatsApp
const clienteWhatsApp = new ClienteWhatsApp(logger, {
  maxTentativasReconexao: 5,
  clienteId: 'principal',
  diretorioTemp: './temp'
});
logger.info('✅ Cliente WhatsApp inicializado');

// 3. Inicializar o gerenciador de notificações
const gerenciadorNotificacoes = new GerenciadorNotificacoes(logger, './temp');
logger.info('✅ Gerenciador de notificações inicializado');

// 4. Inicializar o gerenciador de IA
const gerenciadorAI = new GerenciadorAI(logger, API_KEY);
logger.info('✅ Gerenciador de IA inicializado');

// 5. Inicializar o gerenciador de transações
const gerenciadorTransacoes = new GerenciadorTransacoes(logger, './db');
logger.info('✅ Gerenciador de transações inicializado');

// 6. Inicializar o processador de filas
const filaProcessador = new FilaProcessador(
  logger, 
  gerenciadorAI, 
  clienteWhatsApp
);
logger.info('✅ Processador de filas inicializado');

// 7. Inicializar o gerenciador de mensagens
const gerenciadorMensagens = new GerenciadorMensagens(
  logger,
  clienteWhatsApp,
  configManager,
  gerenciadorAI,
  filaProcessador.videoQueue,
  gerenciadorTransacoes
);
logger.info('✅ Gerenciador de mensagens inicializado');

// 8. Inicializar o monitor de saúde
const monitorSaude = new MonitorSaude(logger, clienteWhatsApp);
logger.info('✅ Monitor de saúde inicializado');

// Configurar eventos do cliente WhatsApp
clienteWhatsApp.on('pronto', async () => {
  logger.info('📱 Cliente WhatsApp pronto e conectado!');
  
  // Iniciar o monitor de saúde
  monitorSaude.iniciar();
  
  // Processar notificações pendentes
  const notificacoesProcessadas = await gerenciadorNotificacoes.processar(clienteWhatsApp.cliente);
  if (notificacoesProcessadas > 0) {
    logger.info(`Processadas ${notificacoesProcessadas} notificações pendentes na inicialização`);
  }
  
  // Processar transações pendentes
  const transacoesProcessadas = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp.cliente);
  if (transacoesProcessadas > 0) {
    logger.info(`Processadas ${transacoesProcessadas} transações pendentes na inicialização`);
  }
});

gerenciadorMensagens.registrarComoHandler(clienteWhatsApp);

// Verificação de saúde periódica para processar transações e notificações
setInterval(async () => {
  try {
    // Processar notificações pendentes
    const notificacoesProcessadas = await gerenciadorNotificacoes.processar(clienteWhatsApp.cliente);
    
    // Processar transações pendentes
    const transacoesProcessadas = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp.cliente);
    
    if (notificacoesProcessadas > 0 || transacoesProcessadas > 0) {
      logger.info(`Processamento periódico: ${notificacoesProcessadas} notificações, ${transacoesProcessadas} transações`);
    }
  } catch (erro) {
    logger.error(`Erro no processamento periódico: ${erro.message}`);
  }
}, 5000); // A cada cinco segundos

// Limpeza de recursos antigos
setInterval(async () => {
  try {
    // Limpar notificações antigas
    await gerenciadorNotificacoes.limparAntigas(7); // 7 dias
    
    // Limpar transações antigas
    await gerenciadorTransacoes.limparTransacoesAntigas(7); // 7 dias
    
    // Limpar trabalhos pendentes na fila
    await filaProcessador.limparTrabalhosPendentes();
  } catch (erro) {
    logger.error(`Erro na limpeza periódica: ${erro.message}`);
  }
}, 24 * 60 * 60 * 1000); // Uma vez por dia

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (erro) => {
  logger.error(`Uncaught Exception: ${erro.message}`, { erro });
  
  // Em produção, você pode querer reiniciar em vez de encerrar
  if (process.env.NODE_ENV === 'production') {
    logger.error('Erro crítico, reiniciando o processo em 5 segundos...');
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(1);
  }
});

// Mensagem final de inicialização
logger.info('🚀 Sistema iniciado com sucesso! Aguardando conexão do WhatsApp...');


// Monitoramento de memória para prevenir OOM Killer
logger.info('✅ Iniciando monitor de memória preventivo');
const LIMITE_MEMORIA_MB = 900; // 900MB

setInterval(() => {
  const usoMemoria = process.memoryUsage();
  const heapUsadoMB = Math.round(usoMemoria.heapUsed / 1024 / 1024);
  const rssMB = Math.round(usoMemoria.rss / 1024 / 1024);
  
  // Só logar quando estiver acima de 50% do limite para não encher os logs
  if (rssMB > LIMITE_MEMORIA_MB * 0.5) {
    logger.info(`📊 Memória atual: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);
  }
  
  // Se estiver acima de 80% do limite, forçar coleta de lixo
  if (rssMB > LIMITE_MEMORIA_MB * 0.8 && global.gc) {
    logger.warn(`🧹 Uso de memória alto (${rssMB}MB) - Executando coleta de lixo`);
    global.gc();
  }
  
  // Se ultrapassar o limite, agendar reinicialização
  if (rssMB > LIMITE_MEMORIA_MB) {
    logger.warn(`⚠️ ALERTA DE MEMÓRIA: ${rssMB}MB excede limite de ${LIMITE_MEMORIA_MB}MB`);
    
    // Verificar se não há uma reinicialização já agendada
    if (!global.reinicializacaoAgendada) {
      logger.warn('💤 Agendando reinicialização em 30 segundos...');
      global.reinicializacaoAgendada = true;
      
      setTimeout(async () => {
        try {
          logger.warn('🔄 Executando reinicialização de emergência');
          await clienteWhatsApp.reiniciarCompleto();
          logger.info('✅ Reinicialização concluída');
        } catch (err) {
          logger.error(`❌ Erro na reinicialização: ${err.message}`);
        } finally {
          global.reinicializacaoAgendada = false;
        }
      }, 30000); // 30 segundos de espera
    }
  }
}, 3 * 60 * 1000); // Verificar a cada 3 minutos
