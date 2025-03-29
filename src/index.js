/**
 * Amélie - Assistente Virtual de IA para WhatsApp
 * 
 * Arquivo principal que inicializa e integra os módulos do sistema.
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
const criarAdaptadorAI = require('./adaptadores/ai/GerenciadorAI'); // Importar a fábrica
const GerenciadorMensagens = require('./adaptadores/whatsapp/AdaptadorGerenciadorMensagens');
const GerenciadorNotificacoes = require('./adaptadores/whatsapp/GerenciadorNotificacoes');
const inicializarFilasMidia = require('./adaptadores/queue/FilasMidia');
const GerenciadorTransacoes = require('./adaptadores/transacoes/GerenciadorTransacoes');
const criarServicoMensagem = require('./servicos/ServicoMensagem');


// Configurações
const BOT_NAME = process.env.BOT_NAME || 'Amélie';
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
const textoAjuda = `Olá! Eu sou a Amélie, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.

Comandos:

.cego - Aplica configurações para usuários com deficiência visual

.audio - Liga/desliga a transcrição de áudio

.video - Liga/desliga a interpretação de vídeo

.imagem - Liga/desliga a descrição de imagem

.longo - Usa descrição longa e detalhada

.curto - Usa descrição curta e concisa

.legenda - Ativa transcrição verbatim com timecode para vídeos (ideal para pessoas surdas)

.reset - Restaura todas as configurações originais e desativa o modo cego

.ajuda - Mostra esta mensagem de ajuda

Minha idealizadora é a Belle Utsch. 
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp
Meu repositório fica em https://github.com/manelsen/amelie`;

// Adicionar método para limpar transações em problemas
GerenciadorTransacoes.prototype.limparTransacoesIncompletas = async function() {
  try {
    // Encontrar transações sem resposta ou que estão travadas
    const resultado = await this.repoTransacoes.encontrar({
      $or: [
        { status: 'falha_temporaria' },
        { status: 'falha_permanente' }
      ]
    });

    if (!resultado.sucesso) {
      this.registrador.error(`Erro ao buscar transações incompletas: ${resultado.erro.message}`);
      return 0;
    }

    const transacoes = resultado.dados || [];
    if (transacoes.length === 0) return 0;

    this.registrador.info(`Encontradas ${transacoes.length} transações incompletas para limpeza`);
    let limpas = 0;

    for (const transacao of transacoes) {
      try {
        await this.repoTransacoes.remover({ id: transacao.id });
        this.registrador.info(`Transação ${transacao.id} removida com sucesso`);
        limpas++;
      } catch (erro) {
        this.registrador.error(`Erro ao remover transação ${transacao.id}: ${erro.message}`);
      }
    }

    this.registrador.info(`Limpas ${limpas} transações incompletas`);
    return limpas;
  } catch (erro) {
    this.registrador.error(`Erro ao limpar transações incompletas: ${erro.message}`);
    return 0;
  }
};

// Inicializar os componentes do sistema
logger.info('🤖 Iniciando Amélie - Assistente Virtual de IA para WhatsApp');

// 1. Inicializar gerenciador de configurações
const configManager = new ConfigManager(logger, path.join(process.cwd(), 'db'));
logger.info('⚙️ Gerenciador de configurações inicializado');

// 2. Inicializar o cliente WhatsApp
const clienteWhatsApp = new ClienteWhatsApp(logger, {
  maxTentativasReconexao: 5,
  clienteId: 'principal',
  diretorioTemp: './temp'
});
logger.info('📱 Cliente WhatsApp inicializado');

// 3. Inicializar o gerenciador de notificações
const gerenciadorNotificacoes = new GerenciadorNotificacoes(logger, './temp');
logger.info('🔔 Gerenciador de notificações inicializado');

// 4. Inicializar o gerenciador de IA usando a fábrica
const gerenciadorAI = criarAdaptadorAI({ registrador: logger, apiKey: API_KEY });
logger.info('🧠 Gerenciador de IA inicializado');

// 5. Inicializar o gerenciador de transações
const gerenciadorTransacoes = new GerenciadorTransacoes(logger, path.join(process.cwd(), 'db'));
logger.info('💼 Gerenciador de transações inicializado');

// 5.5 Inicializar o serviço de mensagens
const servicoMensagem = criarServicoMensagem(logger, clienteWhatsApp, gerenciadorTransacoes);
logger.info('💬 Serviço de mensagens inicializado');

// 8. Inicializar o monitor de saúde (mas não ativá-lo ainda)
const monitorSaude = require('./monitoramento/MonitorSaude').criar(logger, clienteWhatsApp);
logger.info('❤️‍🩹 Monitor de saúde inicializado');

// Variáveis para armazenar componentes que serão inicializados depois
let filasMidia = null;
let gerenciadorMensagens = null;

// Configurar eventos do cliente WhatsApp
clienteWhatsApp.on('pronto', async () => {
  logger.info('📱 Cliente WhatsApp pronto e conectado!');

  // 6. Agora que o cliente está pronto, inicializar o processador de filas de mídia
  filasMidia = inicializarFilasMidia(logger, gerenciadorAI, configManager, servicoMensagem);
  logger.info('🔄 Filas de mídia inicializadas');

  // 7. Inicializar o gerenciador de mensagens com as filas já inicializadas
  gerenciadorMensagens = new GerenciadorMensagens(
    logger,
    clienteWhatsApp,
    configManager,
    gerenciadorAI,
    filasMidia,
    gerenciadorTransacoes,
    servicoMensagem
  );
  logger.info('💬 Gerenciador de mensagens inicializado');

  // Registrar o gerenciador de mensagens como handler
  gerenciadorMensagens.registrarComoHandler(clienteWhatsApp);

  // Iniciar o monitor de saúde
  monitorSaude.parar(); // Garantir que esteja parado antes
  monitorSaude.iniciar();

  // Limpar transações problemáticas antes de processar
  await gerenciadorTransacoes.limparTransacoesIncompletas();

  // Processar notificações pendentes
  const resultadoNotificacoes = await gerenciadorNotificacoes.processar(clienteWhatsApp.cliente);
  const notificacoesProcessadas = resultadoNotificacoes.sucesso ? resultadoNotificacoes.dados : 0;

  // Processar transações pendentes
  const resultadoTransacoes = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp);
  const transacoesProcessadas = resultadoTransacoes.sucesso ? resultadoTransacoes.dados : 0;

  if (notificacoesProcessadas > 0 || transacoesProcessadas > 0) {
    logger.info(`Processamento periódico: ${notificacoesProcessadas} notificações, ${transacoesProcessadas} transações`);
  }
});

// Verificação de saúde periódica para processar transações e notificações
setInterval(async () => {
  // Só executar se o cliente estiver pronto e os componentes estiverem inicializados
  if (clienteWhatsApp.pronto && filasMidia && gerenciadorMensagens) {
    try {
      // Limpar transações problemáticas
      await gerenciadorTransacoes.limparTransacoesIncompletas();

      // Processar notificações pendentes
      const resultadoNotificacoes = await gerenciadorNotificacoes.processar(clienteWhatsApp.cliente);
      const notificacoesProcessadas = resultadoNotificacoes.sucesso ? resultadoNotificacoes.dados : 0;

      // Processar transações pendentes
      const resultadoTransacoes = await gerenciadorTransacoes.processarTransacoesPendentes(clienteWhatsApp);
      const transacoesProcessadas = resultadoTransacoes.sucesso ? resultadoTransacoes.dados : 0;

      if (notificacoesProcessadas > 0 || transacoesProcessadas > 0) {
        logger.info(`Processamento periódico: ${notificacoesProcessadas} notificações, ${transacoesProcessadas} transações`);
      }
    } catch (erro) {
      logger.error(`Erro no processamento periódico: ${erro.message}`);
    }
  }
}, 5000); // A cada cinco segundos

// Limpeza de recursos antigos
setInterval(async () => {
  // Só executar se o cliente estiver pronto
  if (clienteWhatsApp.pronto && filasMidia) {
    try {
      // Limpar notificações antigas
      await gerenciadorNotificacoes.limparAntigas(1); // 1 dia

      // Limpar transações antigas
      await gerenciadorTransacoes.limparTransacoesAntigas(1); // 1 dia

      // Limpar Transações Incompletas
      await gerenciadorTransacoes.limparTransacoesIncompletas();

      // Limpar trabalhos pendentes na fila
      await filasMidia.limparTrabalhosPendentes();
    } catch (erro) {
      logger.error(`Erro na limpeza periódica: ${erro.message}`);
    }
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
