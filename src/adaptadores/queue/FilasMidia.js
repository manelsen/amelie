/**
 * FilasMidia - Módulo funcional para processamento assíncrono de filas de mídia
 * 
 * Implementa arquitetura funcional pura com composição, padrão Railway e imutabilidade.
 * Sem classes, apenas funções e composição.
 * 
 * @author Belle Utsch
 */

const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const _ = require('lodash/fp');
const { promisify } = require('util');

// Promisificar operações do fs para abordagem funcional
const existsAsync = promisify(fs.exists);
const unlinkAsync = promisify(fs.unlink);
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);

// Importação corrigida - caminho correto!
const { 
  obterInstrucaoPadrao, 
  obterInstrucaoImagem,
  obterInstrucaoImagemCurta,
  obterInstrucaoVideo,
  obterInstrucaoVideoCurta,
  obterPromptImagem,
  obterPromptImagemCurto,
  obterPromptVideo,
  obterPromptVideoCurto
} = require('../../config/InstrucoesSistema');

// Passei por aqui

console.log('🔍 Carregando FilasMidia.js');
console.log('📁 Diretório atual:', __dirname);
console.log('📄 Arquivo atual:', __filename);

// ===== PATTERN MATCHING PARA TRATAMENTO DE ERROS (Railway Pattern) =====

/**
 * Resultado - Pattern Matching para tratamento funcional de erros
 */
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

// ===== UTILITÁRIOS FUNCIONAIS =====

/**
 * Utilitários - Funções puras para operações comuns
 */
const Utilitarios = {
  /**
   * Gera um identificador único
   * @returns {string} Identificador hexadecimal
   */
  gerarId: () => crypto.randomBytes(8).toString('hex'),
  
  /**
   * Limpa arquivo temporário
   * @param {string} caminhoArquivo - Caminho para o arquivo
   * @returns {Promise<Resultado>} Resultado da operação
   */
  limparArquivo: async (caminhoArquivo) => {
    try {
      const existe = await existsAsync(caminhoArquivo);
      
      if (!existe) {
        return Resultado.sucesso(false);
      }
      
      await unlinkAsync(caminhoArquivo);
      return Resultado.sucesso(true);
    } catch (erro) {
      return Resultado.falha(erro);
    }
  },
  
  /**
   * Obtém uma mensagem de erro amigável
   * @param {string} tipoMidia - Tipo de mídia ('imagem' ou 'video')
   * @param {Error} erro - Objeto de erro
   * @returns {string} Mensagem amigável
   */
  obterMensagemErroAmigavel: _.curry((tipoMidia, erro) => {
    const mensagemErro = String(erro.message).toLowerCase();
    
    // Mensagens para erros específicos de imagem
    if (tipoMidia === 'imagem') {
      if (mensagemErro.includes('safety') || mensagemErro.includes('blocked'))
        return "Este conteúdo não pôde ser processado por questões de segurança.";
      
      if (mensagemErro.includes('too large') || mensagemErro.includes('tamanho'))
        return "Essa imagem é um pouco grande demais para eu processar agora. Pode enviar uma versão menor?";
    }
    
    // Mensagens para erros específicos de vídeo
    if (tipoMidia === 'video') {
      if (mensagemErro.includes('time out') || mensagemErro.includes('tempo'))
        return "Esse vídeo é tão complexo que acabei precisando de mais tempo! Poderia tentar um trecho menor?";
        
      if (mensagemErro.includes('forbidden') || mensagemErro.includes('403'))
        return "Encontrei um problema no acesso ao seu vídeo. Pode ser que ele seja muito complexo.";
    }
    
    // Mensagens comuns
    if (mensagemErro.includes('safety') || mensagemErro.includes('blocked'))
      return "Este conteúdo não pôde ser processado por questões de segurança.";
      
    if (mensagemErro.includes('too large') || mensagemErro.includes('tamanho'))
      return "Esse arquivo é um pouco grande demais para eu processar agora.";
      
    if (mensagemErro.includes('format') || mensagemErro.includes('mime'))
      return "Hmm, não consegui processar esse formato. Poderia tentar outro?";
      
    if (mensagemErro.includes('timeout') || mensagemErro.includes('time out'))
      return "Essa mídia é tão complexa que acabei precisando de mais tempo! Poderia tentar novamente?";
      
    if (mensagemErro.includes('rate limit') || mensagemErro.includes('quota'))
      return "Estou um pouquinho sobrecarregada agora. Podemos tentar daqui a pouco?";
      
    return "Tive um probleminha para processar essa mídia. Não desiste de mim, tenta de novo mais tarde?";
  }),
  
  /**
   * Identifica o tipo específico de erro
   * @param {Error} erro - Objeto de erro
   * @returns {string} Tipo de erro
   */
  identificarTipoErro: (erro) => {
    const mensagemErro = String(erro.message).toLowerCase();
    
    return _.cond([
      [msg => msg.includes('safety') || msg.includes('blocked'), _.constant('safety')],
      [msg => msg.includes('timeout') || msg.includes('time out'), _.constant('timeout')],
      [msg => msg.includes('forbidden') || msg.includes('403'), _.constant('access')],
      [msg => msg.includes('too large') || msg.includes('tamanho'), _.constant('size')],
      [msg => msg.includes('format') || msg.includes('mime'), _.constant('format')],
      [_.stubTrue, _.constant('general')]
    ])(mensagemErro);
  },
  
  /**
   * Tenta executar uma operação com tratamento de erro
   * @param {Function} operacao - Função assíncrona a executar
   * @param {Function} tratarErro - Função para tratar erros
   * @returns {Promise<Resultado>} Resultado da operação
   */
  tentarOperacao: function() {
    // Se for chamada com estilo curry (apenas primeiro argumento)
    if (arguments.length === 1 && typeof arguments[0] === 'function') {
      const operacao = arguments[0];
      // Retorna uma função que aceita o tratador de erro
      return async function(tratarErro) {
        try {
          const resultado = await operacao();
          return Resultado.sucesso(resultado);
        } catch (erro) {
          return tratarErro ? Resultado.falha(tratarErro(erro)) : Resultado.falha(erro);
        }
      };
    } 
    // Chamada direta sem curry
    else if (arguments.length >= 1) {
      const operacao = arguments[0];
      const tratarErro = arguments[1];
      return (async () => {
        try {
          const resultado = await operacao();
          return Resultado.sucesso(resultado);
        } catch (erro) {
          return tratarErro ? Resultado.falha(tratarErro(erro)) : Resultado.falha(erro);
        }
      })();
    }
    else {
      throw new Error("tentarOperacao precisa de pelo menos um argumento");
    }
  }
};

// ===== CONFIGURAÇÃO FUNCIONAL =====

/**
 * Configuracao - Funções puras para configuração do sistema
 */
const Configuracao = {
  /**
   * Cria configuração Redis
   * @returns {Object} Configuração do Redis
   */
  criarConfigRedis: () => ({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  }),
  
  /**
   * Cria configuração das filas
   * @param {Object} redisConfig - Configuração do Redis
   * @returns {Object} Configuração de filas
   */
  criarConfigFilas: _.curry((redisConfig) => ({
    redis: redisConfig,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000
      },
      removeOnComplete: true,
      removeOnFail: false
    }
  })),
  
  /**
   * Obtém configurações para processamento de mídia
   * @param {Object} gerenciadorConfig - Gerenciador de configurações
   * @param {Object} registrador - Logger
   * @param {string} chatId - ID do chat
   * @param {string} tipoMidia - Tipo de mídia
   * @returns {Promise<Resultado>} Configurações
   */
  obterConfig: _.curry(async (gerenciadorConfig, registrador, chatId, tipoMidia) => {
    try {
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Usar composição para selecionar a instrução correta
      const obterInstrucao = _.cond([
        [_.matches({tipo: 'imagem', modo: 'curto'}), _.constant(obterInstrucaoImagemCurta())],
        [_.matches({tipo: 'imagem', modo: 'longo'}), _.constant(obterInstrucaoImagem())],
        [_.matches({tipo: 'video', modo: 'curto'}), _.constant(obterInstrucaoVideoCurta())],
        [_.matches({tipo: 'video', modo: 'longo'}), _.constant(obterInstrucaoVideo())],
        [_.stubTrue, _.constant(null)]
      ]);
      
      const modoDescricao = config.modoDescricao || 'curto';
      registrador.debug(`Modo de descrição: ${modoDescricao} para ${tipoMidia} no chat ${chatId}`);
      
      const systemInstructions = obterInstrucao({tipo: tipoMidia, modo: modoDescricao});
      
      return Resultado.sucesso({
        temperature: config.temperature || 0.7,
        topK: config.topK || 1,
        topP: config.topP || 0.95,
        maxOutputTokens: config.maxOutputTokens || (tipoMidia === 'video' ? 1024 : 800),
        model: "gemini-2.0-flash",
        systemInstructions,
        modoDescricao
      });
    } catch (erro) {
      registrador.warn(`Erro ao obter configurações: ${erro.message}, usando padrão`);
      
      // Configuração padrão
      return Resultado.sucesso({
        temperature: 0.7,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: tipoMidia === 'video' ? 1024 : 800,
        model: "gemini-2.0-flash",
        modoDescricao: 'curto'
      });
    }
  }),
  
  /**
   * Prepara o prompt do usuário com base no modo
   * @param {Object} registrador - Logger
   * @param {string} tipoMidia - Tipo de mídia
   * @param {string} promptUsuario - Prompt original
   * @param {string} modoDescricao - Modo de descrição
   * @returns {string} Prompt processado
   */
  prepararPrompt: _.curry((registrador, tipoMidia, promptUsuario, modoDescricao) => {
    if (_.isEmpty(promptUsuario)) {
      // Usar composição para selecionar o prompt correto
      return _.cond([
        [_.matches({tipo: 'imagem', modo: 'longo'}), () => {
          registrador.debug('Usando prompt LONGO para imagem');
          return obterPromptImagem();
        }],
        [_.matches({tipo: 'imagem', modo: 'curto'}), () => {
          registrador.debug('Usando prompt CURTO para imagem');
          return obterPromptImagemCurto();
        }],
        [_.matches({tipo: 'video', modo: 'longo'}), () => {
          registrador.debug('Usando prompt LONGO para vídeo');
          return obterPromptVideo();
        }],
        [_.matches({tipo: 'video', modo: 'curto'}), () => {
          registrador.debug('Usando prompt CURTO para vídeo');
          return obterPromptVideoCurto();
        }],
        [_.stubTrue, _.constant(promptUsuario)]
      ])({tipo: tipoMidia, modo: modoDescricao});
    }
    
    return promptUsuario;
  })
};

// ===== CRIADORES DE FILA FUNCIONAIS =====

/**
 * CriadoresFilas - Funções puras para criar e configurar filas
 */
const CriadoresFilas = {
  /**
   * Cria objetos de fila
   * @param {Object} configFilas - Configuração das filas
   * @returns {Resultado} Filas criadas
   */
  criarFilas: _.curry((configFilas) => {
    try {
      // Usar composição para criar as filas
      const filas = {
        imagem: {
          upload: new Queue('midia-upload-imagem', configFilas),
          analise: new Queue('midia-analise-imagem', configFilas),
          principal: new Queue('midia-principal-imagem', {
            ...configFilas,
            defaultJobOptions: {
              ...configFilas.defaultJobOptions,
              timeout: 60000 // 1 minuto
            }
          })
        },
        video: {
          upload: new Queue('midia-upload-video', configFilas),
          processamento: new Queue('midia-processamento-video', configFilas),
          analise: new Queue('midia-analise-video', configFilas),
          principal: new Queue('midia-principal-video', {
            ...configFilas,
            defaultJobOptions: {
              ...configFilas.defaultJobOptions,
              timeout: 300000 // 5 minutos
            }
          })
        },
        problemas: new Queue('midia-problemas', configFilas)
      };
      
      return Resultado.sucesso(filas);
    } catch (erro) {
      return Resultado.falha(erro);
    }
  }),
  
  /**
   * Configura eventos para uma fila
   * @param {Object} registrador - Logger
   * @param {Queue} fila - Fila a ser configurada
   * @param {string} nomeEtapa - Nome da etapa para logs
   * @param {Queue} filaProblemas - Fila para registrar problemas
   * @returns {Queue} Fila configurada
   */
  configurarEventos: _.curry((registrador, fila, nomeEtapa, filaProblemas) => {
    fila.on('active', (job) => {
      registrador.debug(`[${nomeEtapa}] Job ${job.id} iniciado`);
    });
    
    fila.on('progress', (job, progress) => {
      registrador.debug(`[${nomeEtapa}] Job ${job.id} progresso: ${progress}`);
    });
    
    fila.on('completed', (job, result) => {
      const duracao = Date.now() - (job.processedOn || job.timestamp);
      registrador.debug(`[${nomeEtapa}] Job ${job.id} concluído em ${duracao}ms`);
    });
    
    fila.on('failed', (job, error) => {
      const duracao = Date.now() - (job.processedOn || job.timestamp);
      registrador.error(`[${nomeEtapa}] Job ${job.id} falhou após ${duracao}ms: ${error.message}`);
      
      // Registrar falha para análise posterior
      filaProblemas.add('falha-job', {
        etapa: nomeEtapa,
        jobId: job.id,
        erro: error.message,
        stack: error.stack,
        data: job.data ? _.omit(['imageData', 'tempFilename'], job.data) : null,
        timestamp: Date.now()
      }).catch(err => {
        registrador.error(`Erro ao registrar falha: ${err.message}`);
      });
    });
    
    fila.on('error', (error) => {
      registrador.error(`[${nomeEtapa}] Erro na fila: ${error.message}`);
    });
    
    fila.on('stalled', (job) => {
      registrador.warn(`[${nomeEtapa}] Job ${job.id} travado - será reprocessado`);
    });
    
    return fila;
  }),
  
  /**
   * Configura todas as filas com seus respectivos eventos
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @returns {Object} Filas configuradas
   */
  configurarTodasFilas: _.curry((registrador, filas) => {
    // Usando composição para configurar todas as filas
    return _.pipe(
      // Configurar filas de imagem
      filas => ({
        ...filas,
        imagem: {
          upload: CriadoresFilas.configurarEventos(registrador, filas.imagem.upload, 'Upload-Imagem', filas.problemas),
          analise: CriadoresFilas.configurarEventos(registrador, filas.imagem.analise, 'Análise-Imagem', filas.problemas),
          principal: CriadoresFilas.configurarEventos(registrador, filas.imagem.principal, 'Principal-Imagem', filas.problemas)
        }
      }),
      // Configurar filas de vídeo
      filas => ({
        ...filas,
        video: {
          upload: CriadoresFilas.configurarEventos(registrador, filas.video.upload, 'Upload-Vídeo', filas.problemas),
          processamento: CriadoresFilas.configurarEventos(registrador, filas.video.processamento, 'Processamento-Vídeo', filas.problemas),
          analise: CriadoresFilas.configurarEventos(registrador, filas.video.analise, 'Análise-Vídeo', filas.problemas),
          principal: CriadoresFilas.configurarEventos(registrador, filas.video.principal, 'Principal-Vídeo', filas.problemas)
        }
      })
    )(filas);
  })
};

// ===== PROCESSADORES DE MÍDIA FUNCIONAIS =====

/**
 * ProcessadoresMidia - Funções puras para processamento de mídia
 */
const ProcessadoresMidia = {
  /**
   * Processa uma imagem com o modelo de IA
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} registrador - Logger
   * @param {Object} imageData - Dados da imagem
   * @param {string} prompt - Prompt para processamento
   * @param {Object} config - Configurações de processamento
   * @returns {Promise<Resultado>} Resultado do processamento
   */
  processarImagem: _.curry(async (gerenciadorAI, registrador, imageData, prompt, config) => {
    return Utilitarios.tentarOperacao(async () => {
      registrador.debug(`Processando imagem com modo ${config.modoDescricao}`);
      
      if (!imageData || !imageData.data) {
        throw new Error("Dados de imagem inválidos ou ausentes");
      }
      
      // Obter modelo com as configurações apropriadas
      const modelo = gerenciadorAI.obterOuCriarModelo({
        ...config,
        systemInstruction: config.systemInstructions
      });
      
      // Preparar componentes da requisição
      const parteImagem = {
        inlineData: {
          data: imageData.data,
          mimeType: imageData.mimetype
        }
      };
      
      const partesConteudo = [
        parteImagem,
        { text: prompt }
      ];
      
      // Adicionar timeout de 45 segundos
      const promessaResultado = modelo.generateContent(partesConteudo);
      const promessaTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Tempo esgotado na análise da imagem")), 45000)
      );
      
      // Aguardar o primeiro resultado (modelo ou timeout)
      const resultado = await Promise.race([promessaResultado, promessaTimeout]);
      let textoResposta = resultado.response.text();
      
      // Validar resposta
      if (!textoResposta) {
        throw new Error('Resposta vazia gerada pelo modelo');
      }
      
      // Limpar e retornar resposta
      return gerenciadorAI.limparResposta(textoResposta);
    }, erro => {
      registrador.error(`Erro ao processar imagem: ${erro.message}`);
      return erro;
    });
  }),
  
  /**
   * Processa um vídeo com o modelo de IA (incluindo upload e análise)
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} registrador - Logger
   * @param {string} caminhoArquivo - Caminho para o arquivo de vídeo
   * @param {string} prompt - Prompt para processamento
   * @param {Object} config - Configurações de processamento
   * @returns {Promise<Resultado>} Resultado do processamento
   */
  processarVideo: _.curry(async (gerenciadorAI, registrador, caminhoArquivo, prompt, config) => {
    // 1. Verificar arquivo
    const verificarArquivo = async () => {
      const existe = await existsAsync(caminhoArquivo);
      if (!existe) {
        throw new Error("Arquivo de vídeo não encontrado");
      }
      return caminhoArquivo;
    };
    
    // 2. Fazer upload para o Google AI
    const fazerUpload = async (caminhoVerificado) => {
      return await gerenciadorAI.gerenciadorArquivos.uploadFile(caminhoVerificado, {
        mimeType: config.mimeType || 'video/mp4',
        displayName: "Vídeo Enviado"
      });
    };
    
    // 3. Aguardar processamento
    const aguardarProcessamento = async (respostaUpload) => {
      let arquivo;
      let tentativas = 0;
      const maxTentativas = 10;
      
      while (tentativas < maxTentativas) {
        arquivo = await gerenciadorAI.gerenciadorArquivos.getFile(respostaUpload.file.name);
        
        if (arquivo.state === "SUCCEEDED" || arquivo.state === "ACTIVE") {
          return { arquivo, respostaUpload };
        }
        
        if (arquivo.state === "FAILED") {
          throw new Error("Falha no processamento do vídeo pelo Google AI");
        }
        
        // Ainda em processamento, aguardar
        registrador.info(`Vídeo ainda em processamento, aguardando... (tentativa ${tentativas + 1}/${maxTentativas})`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 segundos
        tentativas++;
      }
      
      throw new Error("Tempo máximo de processamento excedido");
    };
    
    // 4. Analisar o vídeo
    const analisarVideo = async ({ arquivo, respostaUpload }) => {
      // Obter modelo
      const modelo = gerenciadorAI.obterOuCriarModelo(config);
      
      // Preparar partes de conteúdo
      const partesConteudo = [
        {
          fileData: {
            mimeType: arquivo.mimeType,
            fileUri: arquivo.uri
          }
        },
        {
          text: prompt
        }
      ];
      
      // Adicionar timeout para a chamada à IA
      const promessaRespostaIA = modelo.generateContent(partesConteudo);
      const promessaTimeoutIA = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Tempo esgotado na análise de vídeo")), 60000)
      );
      
      // Processar o resultado
      const resultado = await Promise.race([promessaRespostaIA, promessaTimeoutIA]);
      let resposta = resultado.response.text();
      
      if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
        resposta = "Não consegui gerar uma descrição clara para este vídeo.";
      }
      
      // Limpar arquivo remoto
      try {
        await gerenciadorAI.gerenciadorArquivos.deleteFile(respostaUpload.file.name);
      } catch (erroLimpeza) {
        registrador.warn(`Erro ao limpar arquivo remoto: ${erroLimpeza.message}`);
      }
      
      return resposta;
    };
    
    // Compor as operações usando pipe e tratar erros
    return Utilitarios.tentarOperacao(async () => {
      return _.pipe(
        verificarArquivo,
        valor => fazerUpload(valor),
        valor => aguardarProcessamento(valor),
        valor => analisarVideo(valor)
      )();
    }, erro => {
      registrador.error(`Erro ao processar vídeo: ${erro.message}`);
      
      // Limpar arquivo local em caso de erro
      Utilitarios.limparArquivo(caminhoArquivo);
      
      return erro;
    });
  })
};

// ===== PROCESSADORES DE FILA FUNCIONAIS =====

/**
 * ProcessadoresFilas - Funções para processamento de filas
 */
const ProcessadoresFilas = {
  /**
   * Cria handler para notificar erros
   * @param {Object} registrador - Logger
   * @param {Function} callbackResposta - Callback para enviar resultado
   * @returns {Function} Handler de notificação de erro
   */
  criarNotificadorErro: _.curry((registrador, callbackResposta, tipoMidia, erro, dados) => {
    const { chatId, messageId, senderNumber, transacaoId, remetenteName } = dados;
    
    // Obter mensagem de erro amigável
    const mensagemErro = Utilitarios.obterMensagemErroAmigavel(tipoMidia, erro);
    const tipoErro = Utilitarios.identificarTipoErro(erro);
    
    // Enviar notificação de erro
    if (callbackResposta) {
      callbackResposta({
        resposta: mensagemErro,
        chatId,
        messageId,
        senderNumber,
        transacaoId,
        remetenteName,
        isError: true,
        errorType: tipoErro,
        tipo: tipoMidia
      });
    } else {
      registrador.warn(`Sem callback para notificar erro de ${tipoMidia}`);
    }
  }),
  
  /**
   * Cria processador para enviar resultados
   * @param {Object} registrador - Logger
   * @param {Object} callbacks - Map de callbacks por tipo de mídia
   * @returns {Function} Processador de resultado
   */
  criarProcessadorResultado: _.curry((registrador, callbacks, resultado) => {
    // Validar resultado
    if (!resultado || !resultado.senderNumber) {
      registrador.warn("Resultado de fila inválido ou incompleto");
      return;
    }
    
    const { tipo } = resultado;
    const callback = callbacks[tipo];
    
    // Encaminhar para o callback correto
    if (callback) {
      callback(resultado);
    } else {
      registrador.warn(`Sem callback para processar resultado do tipo ${tipo}`);
    }
  }),
  
  /**
   * Criar processador de upload de imagem
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorUploadImagem: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
    
    try {
      registrador.debug(`[Imagem] Iniciando preparo da imagem para análise (Job ${job.id})`);
      
      // Verificar se temos dados da imagem válidos
      if (!imageData || !imageData.data) {
        throw new Error("Dados da imagem inválidos ou ausentes");
      }
      
      // Adicionar à fila de análise
      await filas.imagem.analise.add('analise-imagem', {
        imageData,
        chatId,
        messageId,
        mimeType,
        userPrompt,
        senderNumber,
        transacaoId,
        remetenteName,
        uploadTimestamp: Date.now(),
        tipo: 'imagem'
      });
      
      return { success: true };
    } catch (erro) {
      registrador.error(`[Imagem] Erro no preparo: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador de análise de imagem
   * @param {Object} registrador - Logger
   * @param {Object} gerenciadorConfig - Gerenciador de configurações
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Function} processarResultado - Função para processar resultado
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorAnaliseImagem: _.curry((registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro) => async (job) => {
    const { 
      imageData, chatId, messageId, mimeType, userPrompt, 
      senderNumber, transacaoId, remetenteName 
    } = job.data;
    
    const obterConfig = Configuracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = Configuracao.prepararPrompt(registrador);
    const processarImagem = ProcessadoresMidia.processarImagem(gerenciadorAI, registrador);
    
    try {
      registrador.debug(`[Imagem] Iniciando análise da imagem (Job ${job.id})`);
      
      // Obter configuração
      const resultadoConfig = await obterConfig(chatId, 'imagem');
      
      // Extrair config ou usar padrão em caso de erro
      const config = Resultado.dobrar(
        resultadoConfig,
        config => config,
        erro => {
          registrador.error(`Erro ao obter config: ${erro.message}, usando padrão`);
          return {
            temperature: 0.7,
            topK: 1,
            topP: 0.95,
            maxOutputTokens: 800,
            model: "gemini-2.0-flash",
            modoDescricao: 'curto'
          };
        }
      );
      
      // Preparar prompt
      const promptFinal = prepararPrompt('imagem', userPrompt, config.modoDescricao);
      
      // Processar imagem
      const resultadoProcessamento = await processarImagem(imageData, promptFinal, config);
      
      // Processar resultado
      return Resultado.dobrar(
        resultadoProcessamento,
        resposta => {
          // Enviar resultado bem-sucedido
          processarResultado({
            resposta,
            chatId,
            messageId,
            senderNumber,
            transacaoId,
            remetenteName,
            tipo: 'imagem'
          });
          
          return { success: true };
        },
        erro => {
          // Processar erro
          notificarErro('imagem', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
          throw erro;
        }
      );
    } catch (erro) {
      registrador.error(`[Imagem] Erro na análise: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador principal de imagem (compatibilidade)
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorPrincipalImagem: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
    
    try {
      registrador.info(`[Imagem] Redirecionando pela fila principal (Job ${job.id})`);
      
      // Redirecionar para a nova estrutura de fila
      const uploadJob = await filas.imagem.upload.add('upload-imagem', {
        imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName, tipo: 'imagem'
      });
      
      registrador.debug(`[Imagem] Redirecionada com sucesso, job ID: ${uploadJob.id}`);
      
      return { success: true, redirectedJobId: uploadJob.id };
    } catch (erro) {
      registrador.error(`[Imagem] Erro ao redirecionar: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador de upload de vídeo
   * @param {Object} registrador - Logger
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} filas - Estrutura de filas
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorUploadVideo: _.curry((registrador, gerenciadorAI, filas, notificarErro) => async (job) => {
    const { tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
    
    try {
      registrador.debug(`[Vídeo] Iniciando upload: ${tempFilename} (Job ${job.id})`);
      
      // Verificar se o arquivo existe
      const existe = await existsAsync(tempFilename);
      if (!existe) {
        throw new Error("Arquivo temporário do vídeo não encontrado");
      }
      
      // Fazer upload para o Google AI
      const respostaUpload = await gerenciadorAI.gerenciadorArquivos.uploadFile(tempFilename, {
        mimeType: mimeType || 'video/mp4',
        displayName: "Vídeo Enviado"
      });
      
      registrador.debug(`[Vídeo] Upload concluído, nome do arquivo: ${respostaUpload.file.name}`);
      
      // Adicionar à fila de processamento
      await filas.video.processamento.add('processar-video', {
        fileName: respostaUpload.file.name,
        fileUri: respostaUpload.file.uri,
        tempFilename,
        chatId,
        messageId,
        mimeType,
        userPrompt,
        senderNumber,
        transacaoId,
        remetenteName,
        uploadTimestamp: Date.now(),
        tipo: 'video'
      });
      
      return { success: true, fileName: respostaUpload.file.name };
    } catch (erro) {
      registrador.error(`[Vídeo] Erro no upload: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      // Limpar arquivo temporário em caso de erro
      await Utilitarios.limparArquivo(tempFilename);
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador de processamento de vídeo
   * @param {Object} registrador - Logger
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} filas - Estrutura de filas
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorProcessamentoVideo: _.curry((registrador, gerenciadorAI, filas, notificarErro) => async (job) => {
    const { 
      fileName, fileUri, tempFilename, chatId, messageId, 
      mimeType, userPrompt, senderNumber, transacaoId, 
      uploadTimestamp, remetenteName, tentativas = 0 
    } = job.data;
    
    try {
      registrador.debug(`[Vídeo] Verificando processamento: ${fileName} (Job ${job.id}), tentativa ${tentativas + 1}`);
      
      // Verificar se já passou tempo demais desde o upload
      const tempoDecorrido = Date.now() - uploadTimestamp;
      if (tempoDecorrido > 120000 && tentativas > 3) { // 2 minutos e já tentou algumas vezes
        throw new Error(`Arquivo provavelmente expirou após ${Math.round(tempoDecorrido/1000)} segundos`);
      }
      
      // Obter estado atual do arquivo
      let arquivo;
      try {
        arquivo = await gerenciadorAI.gerenciadorArquivos.getFile(fileName);
      } catch (erroAcesso) {
        if (erroAcesso.message.includes('403 Forbidden')) {
          throw new Error("Arquivo de vídeo inacessível (acesso negado)");
        }
        throw erroAcesso;
      }
      
      const maxTentativas = 10;
      
      // Verificar o estado do arquivo
      if (arquivo.state === "PROCESSING") {
        // Se ainda está processando e não excedeu o limite de tentativas, reagendar
        if (tentativas < maxTentativas) {
          registrador.debug(`[Vídeo] Ainda em processamento, reagendando... (tentativa ${tentativas + 1})`);
          
          // Calcular delay com exponential backoff
          const backoffDelay = Math.min(15000, 500 * Math.pow(2, tentativas));
          
          // Reagendar
          await filas.video.processamento.add('processar-video', {
            ...job.data,
            tentativas: tentativas + 1
          }, { delay: backoffDelay });
          
          return { success: true, status: "PROCESSING", tentativas: tentativas + 1 };
        } else {
          throw new Error("Tempo máximo de processamento excedido");
        }
      } else if (arquivo.state === "FAILED") {
        throw new Error("Falha no processamento do vídeo pelo Google AI");
      } 
      
      // Estados válidos para prosseguir: SUCCEEDED ou ACTIVE
      if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
        throw new Error(`Estado inesperado do arquivo: ${arquivo.state}`);
      }
      
      registrador.debug(`[Vídeo] Processado com sucesso, estado: ${arquivo.state}`);
      
      // Adicionar à fila de análise
      await filas.video.analise.add('analise-video', {
        fileName,
        fileUri: arquivo.uri,
        tempFilename,
        chatId,
        messageId,
        mimeType,
        userPrompt,
        senderNumber,
        transacaoId,
        fileState: arquivo.state,
        fileMimeType: arquivo.mimeType,
        remetenteName,
        tipo: 'video'
      });
      
      return { success: true, status: arquivo.state };
    } catch (erro) {
      registrador.error(`[Vídeo] Erro no processamento: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      // Limpar arquivo temporário
      await Utilitarios.limparArquivo(tempFilename);
      
      // Tentar excluir o arquivo do Google AI
      try {
        if (fileName) {
          await gerenciadorAI.gerenciadorArquivos.deleteFile(fileName);
        }
      } catch (errDelete) {
        registrador.warn(`Não foi possível excluir o arquivo remoto: ${errDelete.message}`);
      }
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador de análise de vídeo
   * @param {Object} registrador - Logger
   * @param {Object} gerenciadorConfig - Gerenciador de configurações
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Function} processarResultado - Função para processar resultado
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorAnaliseVideo: _.curry((registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro) => async (job) => {
    const { 
      fileName, tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, 
      transacaoId, fileState, fileUri, fileMimeType, remetenteName
    } = job.data;
    
    const obterConfig = Configuracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = Configuracao.prepararPrompt(registrador);
    
    try {
      registrador.debug(`[Vídeo] Iniciando análise: ${fileName} (Job ${job.id})`);
      
      // Obter configuração
      const resultadoConfig = await obterConfig(chatId, 'video');
      
      // Extrair config ou usar padrão em caso de erro
      const config = Resultado.dobrar(
        resultadoConfig,
        config => config,
        erro => {
          registrador.error(`Erro ao obter config: ${erro.message}, usando padrão`);
          return {
            temperature: 0.9,
            topK: 1,
            topP: 0.95,
            maxOutputTokens: 1024,
            model: "gemini-2.0-flash",
            modoDescricao: 'curto'
          };
        }
      );
      
      // Preparar prompt
      const promptFinal = prepararPrompt('video', userPrompt, config.modoDescricao);
      
      // Obter modelo
      const modelo = gerenciadorAI.obterOuCriarModelo(config);
      
      // Preparar partes de conteúdo
      const partesConteudo = [
        {
          fileData: {
            mimeType: fileMimeType,
            fileUri: fileUri
          }
        },
        {
          text: promptFinal
        }
      ];
      
      // Adicionar timeout para a chamada à IA
      const promessaRespostaIA = modelo.generateContent(partesConteudo);
      const promessaTimeoutIA = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Tempo esgotado na análise de vídeo")), 120000)
      );
      
      const resultado = await Promise.race([promessaRespostaIA, promessaTimeoutIA]);
      let resposta = resultado.response.text();
      
      if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
        resposta = "Não consegui gerar uma descrição clara para este vídeo.";
      }
      
      // Limpar o arquivo temporário
      await Utilitarios.limparArquivo(tempFilename);
      
      // Limpar o arquivo do Google
      await gerenciadorAI.gerenciadorArquivos.deleteFile(fileName);
      
      // Enviar resposta via callback
      processarResultado({
        resposta,
        chatId,
        messageId,
        senderNumber,
        transacaoId,
        remetenteName,
        tipo: 'video'
      });
      
      return { success: true };
    } catch (erro) {
      registrador.error(`[Vídeo] Erro na análise: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      // Limpar arquivos
      await Utilitarios.limparArquivo(tempFilename);
      
      try {
        await gerenciadorAI.gerenciadorArquivos.deleteFile(fileName);
      } catch (errDelete) {
        registrador.warn(`Não foi possível excluir o arquivo remoto: ${errDelete.message}`);
      }
      
      throw erro;
    }
  }),
  
  /**
   * Criar processador principal de vídeo (compatibilidade)
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @param {Function} notificarErro - Função para notificar erros
   * @returns {Function} Função processadora
   */
  criarProcessadorPrincipalVideo: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
    
    try {
      registrador.info(`[Vídeo] Redirecionando pela fila principal (Job ${job.id})`);
      
      // Redirecionar para a nova estrutura de fila
      const uploadJob = await filas.video.upload.add('upload-video', {
        tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName, tipo: 'video'
      });
      
      registrador.debug(`[Vídeo] Redirecionado com sucesso, job ID: ${uploadJob.id}`);
      
      return { success: true, redirectedJobId: uploadJob.id };
    } catch (erro) {
      registrador.error(`[Vídeo] Erro ao redirecionar: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, {chatId, messageId, senderNumber, transacaoId, remetenteName});
      
      throw erro;
    }
  })
};

// ===== MONITORAMENTO DE FILAS FUNCIONAL =====

/**
 * MonitoradorFilas - Funções para monitoramento de filas
 */
const MonitoradorFilas = {
  /**
   * Obtém o status de todas as filas
   * @param {Object} filas - Estrutura de filas
   * @returns {Promise<Object>} Status das filas
   */
  obterStatusFilas: async (filas) => {
    // Mapear todas as filas para facilitar iteração
    const mapaFilas = {
      'Img-Upload': filas.imagem.upload,
      'Img-Análise': filas.imagem.analise,
      'Img-Principal': filas.imagem.principal,
      'Vid-Upload': filas.video.upload,
      'Vid-Process': filas.video.processamento,
      'Vid-Análise': filas.video.analise,
      'Vid-Principal': filas.video.principal
    };
    
    // Estrutura para contagens
    const contagens = {
      total: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0
      }
    };
    
    // Coletar contagens de trabalhos por fila
    for (const [nome, fila] of Object.entries(mapaFilas)) {
      const contagensFila = await fila.getJobCounts();
      contagens[nome] = contagensFila;
      
      // Acumular totais
      contagens.total.waiting += contagensFila.waiting || 0;
      contagens.total.active += contagensFila.active || 0;
      contagens.total.completed += contagensFila.completed || 0;
      contagens.total.failed += contagensFila.failed || 0;
      contagens.total.delayed += contagensFila.delayed || 0;
    }
    
    // Obter trabalhos ativos e com falha para análise
    const obterJobs = async (estadoJobs, limite = 10) => {
      let jobsColetados = [];
      
      for (const [nome, fila] of Object.entries(mapaFilas)) {
        const jobs = await fila.getJobs([estadoJobs], 0, limite);
        
        jobsColetados = jobsColetados.concat(
          jobs.map(j => ({
            id: j.id,
            fila: nome,
            processedOn: j.processedOn,
            failedReason: j.failedReason,
            tentativas: j.attemptsMade
          }))
        );
      }
      
      return jobsColetados;
    };
    
    // Coletar trabalhos ativos e com falha para análise
    const trabalhos = {
      ativos: await obterJobs('active'),
      falhas: await obterJobs('failed')
    };
    
    return { contagens, trabalhos };
  },
  
    /**
   * Limpa trabalhos pendentes que possam causar problemas
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @returns {Promise<number>} Número de trabalhos limpos
   */
  limparTrabalhosPendentes: _.curry(async (registrador, filas) => {
    try {
      registrador.info("🧹 Iniciando limpeza das filas de trabalhos antigos...");
      
      // Mapear todas as filas para limpeza
      const listaFilas = [
        filas.imagem.upload,
        filas.imagem.analise,
        filas.imagem.principal,
        filas.video.upload,
        filas.video.processamento,
        filas.video.analise,
        filas.video.principal
      ];
      
      // Usar composição para processar cada fila
      const processarFila = async (fila) => {
        const trabalhos = await fila.getJobs(['waiting', 'active', 'delayed']);
        let removidos = 0;
        
        for (const trabalho of trabalhos) {
          // Função para verificar e remover trabalho
          const verificarTrabalho = async () => {
            if (trabalho.data && trabalho.data.tempFilename) {
              const { tempFilename } = trabalho.data;
              
              // Verificar se o arquivo existe
              const existe = await existsAsync(tempFilename);
              if (!existe) {
                registrador.warn(`⚠️ Removendo trabalho fantasma: ${trabalho.id} (arquivo ${tempFilename} não existe)`);
                await trabalho.remove();
                return 1;
              }
            }
            
            // Verificar se está travado há muito tempo
            if (trabalho.processedOn && Date.now() - trabalho.processedOn > 300000) { // 5 minutos
              registrador.warn(`⚠️ Removendo trabalho travado: ${trabalho.id} (processando há ${Math.round((Date.now() - trabalho.processedOn)/1000)}s)`);
              await trabalho.remove();
              return 1;
            }
            
            return 0;
          };
          
          try {
            removidos += await verificarTrabalho();
          } catch (erroTrabalho) {
            registrador.error(`Erro ao processar trabalho ${trabalho.id}: ${erroTrabalho.message}`);
          }
        }
        
        return removidos;
      };
      
      // Executar para cada fila e somar os resultados
      const resultados = await Promise.all(listaFilas.map(processarFila));
      const totalRemovidos = resultados.reduce((a, b) => a + b, 0);
      
      registrador.info(`✅ Limpeza concluída! ${totalRemovidos} trabalhos problemáticos removidos.`);
      return totalRemovidos;
    } catch (erro) {
      registrador.error(`❌ Erro ao limpar filas: ${erro.message}`);
      return 0;
    }
  }),
  
  /**
   * Limpa todas as filas
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @param {boolean} apenasCompletos - Se verdadeiro, limpa apenas trabalhos concluídos
   * @returns {Promise<Object>} Resultado da operação
   */
  limparFilas: _.curry(async (registrador, filas, apenasCompletos = true) => {
    try {
      registrador.info(`🧹 Iniciando limpeza ${apenasCompletos ? 'de trabalhos concluídos' : 'COMPLETA'} das filas...`);
      
      // Mapear todas as filas para limpeza
      const mapaFilas = [
        { nome: 'Img-Upload', fila: filas.imagem.upload },
        { nome: 'Img-Análise', fila: filas.imagem.analise },
        { nome: 'Img-Principal', fila: filas.imagem.principal },
        { nome: 'Vid-Upload', fila: filas.video.upload },
        { nome: 'Vid-Process', fila: filas.video.processamento },
        { nome: 'Vid-Análise', fila: filas.video.analise },
        { nome: 'Vid-Principal', fila: filas.video.principal }
      ];
      
      // Usar composição para processar cada fila
      const processarFila = async ({ nome, fila }) => {
        if (apenasCompletos) {
          const removidosCompletos = await fila.clean(30000, 'completed');
          const removidosFalhas = await fila.clean(30000, 'failed');
          return { 
            nome,
            resultados: { 
              completos: removidosCompletos.length,
              falhas: removidosFalhas.length 
            }
          };
        } else {
          await fila.empty();
          return { 
            nome,
            resultados: 'Fila completamente esvaziada!' 
          };
        }
      };
      
      // Executar para cada fila
      const resultados = await Promise.all(mapaFilas.map(processarFila));
      
      // Transformar resultados em um objeto
      const resultadosObj = resultados.reduce((acc, { nome, resultados }) => {
        acc[nome] = resultados;
        return acc;
      }, {});
      
      const mensagem = apenasCompletos
        ? `✅ Limpeza de filas concluída! Removidos trabalhos concluídos e com falha.`
        : `⚠️ TODAS as filas foram completamente esvaziadas!`;
        
      registrador.info(mensagem);
      
      return resultadosObj;
    } catch (erro) {
      registrador.error(`❌ Erro ao limpar filas: ${erro.message}`);
      throw erro;
    }
  })
};

// ===== INICIALIZAÇÃO FUNCIONAL =====

// Modificar o inicializarFilasMidia para usar ServicoMensagem com paradigma funcional

/**
 * Inicializa o sistema de filas de mídia
 * @param {Object} registrador - Logger para registro
 * @param {Object} gerenciadorAI - Gerenciador de IA
 * @param {Object} gerenciadorConfig - Gerenciador de configurações
 * @param {Object} servicoMensagem - Serviço centralizado de mensagens
 * @returns {Object} Sistema de filas inicializado
 */
const inicializarFilasMidia = (registrador, gerenciadorAI, gerenciadorConfig, servicoMensagem) => {
  registrador.info('✨ Inicializando sistema funcional de filas de mídia...');
  
  // Criar configuração do Redis
  const redisConfig = Configuracao.criarConfigRedis();
  
  // Criar configuração das filas
  const configFilas = Configuracao.criarConfigFilas(redisConfig);
  
  // Criar estrutura de filas
  const resultadoFilas = CriadoresFilas.criarFilas(configFilas);
  
  if (!resultadoFilas.sucesso) {
    throw resultadoFilas.erro;
  }
  
  // Configurar todas as filas com eventos
  const filas = CriadoresFilas.configurarTodasFilas(registrador, resultadoFilas.dados);
  
  // Definir callbacks funcionais padrão usando Railway Pattern
  const criarCallbackPadrao = (tipo) => (resultado) => {
    if (!resultado || !resultado.senderNumber) {
      registrador.warn(`Resultado de fila ${tipo} inválido ou incompleto`);
      return Resultado.falha(new Error(`Dados de resposta ${tipo} incompletos`));
    }
    
    registrador.debug(`Processando resultado de ${tipo} com callback padrão: ${resultado.transacaoId || 'sem_id'}`);
    
    // Criar mensagem simulada mais completa
    const mensagemSimulada = {
      from: resultado.senderNumber,
      id: { _serialized: resultado.messageId || `msg_${Date.now()}` },
      body: resultado.userPrompt || '',
      
      // Método getChat simplificado
      getChat: async () => ({
        id: { _serialized: `${resultado.chatId || resultado.senderNumber}` },
        sendSeen: async () => true,
        isGroup: resultado.chatId ? resultado.chatId.includes('@g.us') : false,
        name: resultado.chatName || 'Chat'
      }),
      
      // Não implementamos reply - o servicoMensagem lidará com isso
      hasMedia: true,
      type: tipo,
      
      _data: {
        notifyName: resultado.remetenteName || 'Usuário'
      }
    };
    
    // Prepara texto contextualizado para mídias
    const textoContextualizado = `[Resposta para ${tipo === 'imagem' ? '📷 imagem' : '🎥 vídeo'} enviada por ${resultado.remetenteName || 'você'}]\n\n${resultado.resposta}`;
    
    return servicoMensagem.enviarResposta(mensagemSimulada, textoContextualizado, resultado.transacaoId);
  };
  
  // Objeto para armazenar callbacks
  const callbacks = {
    imagem: criarCallbackPadrao('imagem'),
    video: criarCallbackPadrao('video')
  };
  
  // Criar funções utilitárias com contexto
  const notificarErro = ProcessadoresFilas.criarNotificadorErro(registrador, (resultado) => {
    const callback = callbacks[resultado.tipo];
    if (callback) callback(resultado);
    else registrador.warn(`Sem callback para notificar erro de ${resultado.tipo}`);
  });
  
  const processarResultado = ProcessadoresFilas.criarProcessadorResultado(registrador, callbacks);
  
  // Configurar todos os processadores de fila
  
  // 1. Processadores de Imagem
  filas.imagem.upload.process('upload-imagem', 5,
    ProcessadoresFilas.criarProcessadorUploadImagem(registrador, filas, notificarErro));
  
  filas.imagem.analise.process('analise-imagem', 5,
    ProcessadoresFilas.criarProcessadorAnaliseImagem(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));
  
  filas.imagem.principal.process('processar-imagem', 5,
    ProcessadoresFilas.criarProcessadorPrincipalImagem(registrador, filas, notificarErro));
  
  // 2. Processadores de Vídeo
  filas.video.upload.process('upload-video', 3,
    ProcessadoresFilas.criarProcessadorUploadVideo(registrador, gerenciadorAI, filas, notificarErro));
  
  filas.video.processamento.process('processar-video', 3,
    ProcessadoresFilas.criarProcessadorProcessamentoVideo(registrador, gerenciadorAI, filas, notificarErro));
  
  filas.video.analise.process('analise-video', 3,
    ProcessadoresFilas.criarProcessadorAnaliseVideo(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));
  
  filas.video.principal.process('processar-video', 3,
    ProcessadoresFilas.criarProcessadorPrincipalVideo(registrador, filas, notificarErro));
  
  // Limpar tarefas antigas ou problemáticas
  MonitoradorFilas.limparTrabalhosPendentes(registrador, filas)
    .catch(erro => registrador.error(`Erro ao limpar trabalhos pendentes: ${erro.message}`));
  
  // Retornar API pública funcionalmente composta
  return {
    // Setters para callbacks
    setCallbackRespostaImagem: (callback) => {
      callbacks.imagem = callback;
      registrador.info('✅ Callback de resposta para imagens configurado');
    },
    
    setCallbackRespostaVideo: (callback) => {
      callbacks.video = callback;
      registrador.info('✅ Callback de resposta para vídeos configurado');
    },
    
    setCallbackRespostaUnificado: (callback) => {
      callbacks.imagem = callback;
      callbacks.video = callback;
      registrador.info('✅ Callback de resposta unificado configurado');
    },
    
    // Adição de trabalhos às filas
    adicionarImagem: async (dados) => {
      return filas.imagem.principal.add('processar-imagem', {
        ...dados,
        tipo: 'imagem'
      });
    },
    
    adicionarVideo: async (dados) => {
      return filas.video.principal.add('processar-video', {
        ...dados,
        tipo: 'video'
      });
    },
    
    // Limpeza de filas
    limparFilas: (apenasCompletos = true) => 
      MonitoradorFilas.limparFilas(registrador, filas, apenasCompletos),
    
    limparTrabalhosPendentes: () => 
      MonitoradorFilas.limparTrabalhosPendentes(registrador, filas),
    
    // Finalização e liberação de recursos
    finalizar: () => {
      registrador.info('Sistema de filas de mídia finalizado');
    }
  };
};

// Exportar a função de inicialização
module.exports = inicializarFilasMidia;