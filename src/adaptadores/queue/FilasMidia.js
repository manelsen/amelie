/**
 * FilasMidia - Módulo funcional para processamento assíncrono de filas de mídia
 * 
 * Implementa arquitetura funcional pura com composição, padrão Railway e imutabilidade.
 * Sem classes, apenas funções e composição.
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const Queue = require('bull');
const fs = require('fs');
const crypto = require('crypto');
const _ = require('lodash/fp');
const path = require('path');
const { Resultado, ArquivoUtils, Trilho, Operacoes } = require('../../utilitarios/Ferrovia');
const { verificarArquivoExiste, removerArquivo } = ArquivoUtils;

// Importação corrigida - caminho correto
const {
  obterInstrucaoPadrao,
  obterInstrucaoImagem,
  obterInstrucaoImagemCurta,
  obterInstrucaoVideo,
  obterInstrucaoVideoCurta,
  obterInstrucaoVideoLegenda,
  obterPromptImagem,
  obterPromptImagemCurto,
  obterPromptVideo,
  obterPromptVideoCurto,
  obterPromptVideoLegenda
} = require('../../config/InstrucoesSistema');

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
  limparArquivo: (caminhoArquivo) => {
    return verificarArquivoExiste(caminhoArquivo)
      .then(resultado => {
        if (!resultado.sucesso) {
          return Resultado.sucesso(false);
        }
        
        // Se arquivo não existe, não é um erro
        if (!resultado.dados) {
          return Resultado.sucesso(false);
        }
        
        // Remover o arquivo
        return removerArquivo(caminhoArquivo);
      });
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

      // Verificação explícita para legenda ativa
      if (config.usarLegenda === true && tipoMidia === 'video') {
        registrador.info(`🎬👂 Usando modo legenda para vídeo no chat ${chatId} (verificado em obterConfig)`);
        config.modoDescricao = 'legenda';
      }

      // Usar composição para selecionar a instrução correta
      const obterInstrucao = _.cond([
        [_.matches({ tipo: 'imagem', modo: 'curto' }), _.constant(obterInstrucaoImagemCurta())],
        [_.matches({ tipo: 'imagem', modo: 'longo' }), _.constant(obterInstrucaoImagem())],
        [_.matches({ tipo: 'video', modo: 'curto' }), _.constant(obterInstrucaoVideoCurta())],
        [_.matches({ tipo: 'video', modo: 'longo' }), _.constant(obterInstrucaoVideo())],
        [_.matches({ tipo: 'video', modo: 'legenda' }), _.constant(obterInstrucaoVideoLegenda())],
        [_.stubTrue, _.constant(null)]
      ]);

      const modoDescricao = config.modoDescricao || 'curto';
      registrador.debug(`Modo de descrição: ${modoDescricao} para ${tipoMidia} no chat ${chatId}`);

      const systemInstructions = obterInstrucao({ tipo: tipoMidia, modo: modoDescricao });

      return Resultado.sucesso({
        temperature: config.temperature || 0.7,
        topK: config.topK || 1,
        topP: config.topP || 0.95,
        maxOutputTokens: config.maxOutputTokens || (tipoMidia === 'video' ? 1024 : 800),
        model: "gemini-2.0-flash",
        systemInstructions,
        modoDescricao,
        usarLegenda: config.usarLegenda
      });
    } catch (erro) {
      registrador.warn(`Erro ao obter configurações: ${erro.message}, usando padrão`);

      // Configuração padrão
      return Resultado.sucesso({
        temperature: 0.9,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 1024,
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
      // Verificação mais explícita para o modo legenda
      if (tipoMidia === 'video' && modoDescricao === 'legenda') {
        registrador.info('🎬👂 Ativando modo LEGENDA para vídeo - acessibilidade para surdos');
        return obterPromptVideoLegenda();
      }

      // Resto do código com o cond original
      return _.cond([
        [_.matches({ tipo: 'imagem', modo: 'longo' }), () => {
          registrador.debug('Usando prompt LONGO para imagem');
          return obterPromptImagem();
        }],
        [_.matches({ tipo: 'imagem', modo: 'curto' }), () => {
          registrador.debug('Usando prompt CURTO para imagem');
          return obterPromptImagemCurto();
        }],
        [_.matches({ tipo: 'video', modo: 'longo' }), () => {
          registrador.debug('Usando prompt LONGO para vídeo');
          return obterPromptVideo();
        }],
        [_.matches({ tipo: 'video', modo: 'curto' }), () => {
          registrador.debug('Usando prompt CURTO para vídeo');
          return obterPromptVideoCurto();
        }],
        [_.matches({ tipo: 'video', modo: 'legenda' }), () => {
          registrador.debug('Usando prompt LEGENDA para vídeo');
          return obterPromptVideoLegenda();
        }],
        [_.stubTrue, _.constant(promptUsuario)]
      ])({ tipo: tipoMidia, modo: modoDescricao });
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
  processarImagem: _.curry((gerenciadorAI, registrador, imageData, prompt, config) => {
    // Validar dados de entrada
    if (!imageData || !imageData.data) {
      return Promise.resolve(Resultado.falha(new Error("Dados de imagem inválidos ou ausentes")));
    }
    
    registrador.debug(`Processando imagem com modo ${config.modoDescricao}`);
    
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
    
    // Adicionar timeout de 90 segundos
    const promessaResultado = modelo.generateContent(partesConteudo);
    const promessaTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tempo esgotado na análise da imagem")), 90000)
    );
    
    // Usar Trilho para transformar a Promise em Resultado
    return Trilho.dePromise(Promise.race([promessaResultado, promessaTimeout]))
      .then(resultado => {
        if (!resultado.sucesso) {
          return Resultado.falha(resultado.erro);
        }
        
        const textoResposta = resultado.dados.response.text();
        
        if (!textoResposta) {
          return Resultado.falha(new Error('Resposta vazia gerada pelo modelo'));
        }
        
        return Resultado.sucesso(gerenciadorAI.limparResposta(textoResposta));
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
  processarVideo: _.curry((gerenciadorAI, registrador, caminhoArquivo, prompt, config) => {
    // 1. Verificar arquivo
    return Trilho.encadear(
      // Verificar se o arquivo existe
      () => ArquivoUtils.verificarArquivoExiste(caminhoArquivo)
        .then(resultado => {
          if (!resultado.sucesso || !resultado.dados) {
            return Resultado.falha(new Error("Arquivo de vídeo não encontrado"));
          }
          return Resultado.sucesso(caminhoArquivo);
        }),
      
      // 2. Fazer upload para o Google AI
      (caminhoValido) => {
        return Trilho.dePromise(
          gerenciadorAI.gerenciadorArquivos.uploadFile(caminhoValido, {
            mimeType: config.mimeType || 'video/mp4',
            displayName: "Vídeo Enviado"
          })
        );
      },
      
      // 3. Aguardar processamento
      (respostaUpload) => {
        return Trilho.encadear(
          async () => {
            let arquivo;
            let tentativas = 0;
            const maxTentativas = 10;
            
            while (tentativas < maxTentativas) {
              arquivo = await gerenciadorAI.gerenciadorArquivos.getFile(respostaUpload.file.name);
              
              if (arquivo.state === "SUCCEEDED" || arquivo.state === "ACTIVE") {
                return Resultado.sucesso({ arquivo, respostaUpload });
              }
              
              if (arquivo.state === "FAILED") {
                return Resultado.falha(new Error("Falha no processamento do vídeo pelo Google AI"));
              }
              
              // Ainda em processamento, aguardar
              registrador.info(`Vídeo ainda em processamento, aguardando... (tentativa ${tentativas + 1}/${maxTentativas})`);
              await new Promise(resolve => setTimeout(resolve, 10000)); // 10 segundos
              tentativas++;
            }
            
            return Resultado.falha(new Error("Tempo máximo de processamento excedido"));
          }
        )();
      },
      
      // 4. Analisar o vídeo
      (dadosProcessados) => {
        const { arquivo, respostaUpload } = dadosProcessados;
        
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
          setTimeout(() => reject(new Error("Tempo esgotado na análise de vídeo")), 120000)
        );
        
        return Trilho.dePromise(Promise.race([promessaRespostaIA, promessaTimeoutIA]))
          .then(resultado => {
            if (!resultado.sucesso) {
              return Resultado.falha(resultado.erro);
            }
            
            let resposta = resultado.dados.response.text();
            
            if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
              resposta = "Não consegui gerar uma descrição clara para este vídeo.";
            }
            
            // Limpar arquivo remoto e retornar resposta
            return Trilho.dePromise(gerenciadorAI.gerenciadorArquivos.deleteFile(respostaUpload.file.name))
              .then(() => Resultado.sucesso(resposta))
              .catch(() => {
                // Se falhar ao limpar, ainda retornamos a resposta
                registrador.warn(`Não foi possível limpar arquivo remoto após processamento`);
                return Resultado.sucesso(resposta);
              });
          });
      }
    )()
    .catch(erro => {
      registrador.error(`Erro ao processar vídeo: ${erro.message}`);
      
      // Limpar arquivo local em caso de erro
      Utilitarios.limparArquivo(caminhoArquivo);
      
      return Resultado.falha(erro);
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
   * @param {Object} registrador - Objeto de log
   * @param {Object} callbacks - Mapa de callbacks por tipo de mídia
   * @returns {Function} Processador de resultado
   */
  criarProcessadorResultado: _.curry((registrador, callbacks, resultado) => {
    // Validar entrada e converter para padrão ferrovia
    const validarResultado = (resultado) => {
      if (!resultado || !resultado.senderNumber) {
        registrador.warn("Resultado de fila inválido ou incompleto");
        return Resultado.falha(new Error("Dados de resposta incompletos"));
      }
      return Resultado.sucesso(resultado);
    };

    // Registrar informação de conclusão
    const registrarConclusao = (resultado) => {
      // Verificar se o transacaoId já começa com tx_
      const idTx = resultado.transacaoId || 'sem_id';
      registrador.info(`Resposta de ${resultado.tipo} pronta - ${idTx}`);
      return Resultado.sucesso(resultado);
    };

    // Obter e validar callback
    const obterCallback = (resultado) => {
      const { tipo } = resultado;
      const callback = callbacks[tipo];

      if (!callback) {
        registrador.warn(`Sem callback para processar resultado do tipo ${tipo}`);
        return Resultado.falha(new Error(`Callback não encontrado para tipo ${tipo}`));
      }

      return Resultado.sucesso({ resultado, callback });
    };

    // Executar callback usando o utilitário já existente no código
    const executarCallback = ({ resultado, callback }) => {
      // Usando Operacoes.tentar
      return Operacoes.tentar(() => callback(resultado))().then(resultadoCallback => {
        if (!resultadoCallback.sucesso) {
          registrador.error(`Erro ao executar callback para ${resultado.tipo}: ${resultadoCallback.erro.message}`);
        }
        return resultadoCallback;
      });
    };

    // Compor o fluxo usando o padrão ferrovia
    return _.pipe(
      validarResultado,
      resultado => Resultado.encadear(resultado, registrarConclusao),
      resultado => Resultado.encadear(resultado, obterCallback),
      resultado => Resultado.encadear(resultado, executarCallback)
    )(resultado);
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

    return Trilho.encadear(
      // Verificar dados da imagem
      () => {
        registrador.debug(`[Imagem] Iniciando preparo da imagem para análise (Job ${job.id})`);
        
        if (!imageData || !imageData.data) {
          return Resultado.falha(new Error("Dados da imagem inválidos ou ausentes"));
        }
        
        return Resultado.sucesso(job.data);
      },
      
      // Adicionar à fila de análise
      (dados) => {
        return Trilho.dePromise(
          filas.imagem.analise.add('analise-imagem', {
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
          })
        ).then(() => Resultado.sucesso({ success: true }));
      }
    )()
    .catch(erro => {
      registrador.error(`[Imagem] Erro no preparo: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
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

    return Trilho.encadear(
      // Iniciar análise
      () => {
        registrador.debug(`[Imagem] Iniciando análise da imagem (Job ${job.id})`);
        return Resultado.sucesso(true);
      },
      
      // Obter configuração
      async () => await obterConfig(chatId, 'imagem'),
      
      // Preparar e processar imagem
      (config) => {
        // Preparar prompt
        const promptFinal = prepararPrompt('imagem', userPrompt, config.modoDescricao);
        
        // Processar imagem
        return processarImagem(imageData, promptFinal, config);
      },
      
      // Enviar resultado
      (resposta) => {
        // Enviar resultado bem-sucedido
        registrador.debug(`[Imagem] Análise concluída com sucesso (Job ${job.id})`);
        
        processarResultado({
          resposta,
          chatId,
          messageId,
          senderNumber,
          transacaoId,
          remetenteName,
          tipo: 'imagem'
        });
        
        return Resultado.sucesso({ success: true });
      }
    )()
    .catch(erro => {
      registrador.error(`[Imagem] Erro na análise: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
  }),

  /**
   * Criar processador principal de imagem (compatibilidade)
   */
  criarProcessadorPrincipalImagem: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;

    return Trilho.encadear(
      () => {
        // Adicionamos esta linha para log mais informativo
        registrador.info(`Imagem inserida na fila   - ${transacaoId || 'sem_id'}`);
        return Resultado.sucesso(job.data);
      },
      
      // Redirecionar para a nova estrutura de fila
      () => Trilho.dePromise(
        filas.imagem.upload.add('upload-imagem', {
          imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName, tipo: 'imagem'
        })
      ),
      
      (uploadJob) => {
        registrador.debug(`[Imagem] Redirecionada com sucesso, job ID: ${uploadJob.id}`);
        return Resultado.sucesso({ success: true, redirectedJobId: uploadJob.id });
      }
    )()
    .catch(erro => {
      registrador.error(`[Imagem] Erro ao redirecionar: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('imagem', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
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

    return Trilho.encadear(
      // Verificar arquivo
      () => {
        registrador.debug(`[Vídeo] Iniciando upload: ${tempFilename} (Job ${job.id})`);
        
        return ArquivoUtils.verificarArquivoExiste(tempFilename)
          .then(resultado => {
            if (!resultado.sucesso || !resultado.dados) {
              return Resultado.falha(new Error("Arquivo temporário do vídeo não encontrado"));
            }
            return Resultado.sucesso(job.data);
          });
      },
      
      // Fazer upload para o Google AI
      async (dados) => {
        const respostaUpload = await gerenciadorAI.gerenciadorArquivos.uploadFile(tempFilename, {
          mimeType: mimeType || 'video/mp4',
          displayName: "Vídeo Enviado"
        });
        
        registrador.debug(`[Vídeo] Upload concluído, nome do arquivo: ${respostaUpload.file.name}`);
        
        return Resultado.sucesso({
          ...dados,
          fileName: respostaUpload.file.name,
          fileUri: respostaUpload.file.uri
        });
      },
      
      // Adicionar à fila de processamento
      (dados) => {
        return Trilho.dePromise(
          filas.video.processamento.add('processar-video', {
            fileName: dados.fileName,
            fileUri: dados.fileUri,
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
          })
        ).then(() => Resultado.sucesso({ success: true, fileName: dados.fileName }));
      }
    )()
    .catch(erro => {
      registrador.error(`[Vídeo] Erro no upload: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      // Limpar arquivo temporário em caso de erro
      Utilitarios.limparArquivo(tempFilename);
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
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

    return Trilho.encadear(
      // Verificar processamento
      () => {
        registrador.debug(`[Vídeo] Verificando processamento: ${fileName} (Job ${job.id}), tentativa ${tentativas + 1}`);
        
        // Verificar se já passou tempo demais desde o upload
        const tempoDecorrido = Date.now() - uploadTimestamp;
        if (tempoDecorrido > 120000 && tentativas > 3) { // 2 minutos e já tentou algumas vezes
          return Resultado.falha(new Error(`Arquivo provavelmente expirou após ${Math.round(tempoDecorrido / 1000)} segundos`));
        }
        
        return Resultado.sucesso(job.data);
      },
      
      // Obter estado atual do arquivo
      async (dados) => {
        try {
          const arquivo = await gerenciadorAI.gerenciadorArquivos.getFile(fileName);
          return Resultado.sucesso({ ...dados, arquivo });
        } catch (erroAcesso) {
          if (erroAcesso.message.includes('403 Forbidden')) {
            return Resultado.falha(new Error("Arquivo de vídeo inacessível (acesso negado)"));
          }
          return Resultado.falha(erroAcesso);
        }
      },
      
      // Verificar estado e agir conforme
      (dados) => {
        const { arquivo } = dados;
        const maxTentativas = 10;
        
        // Se ainda está processando e não excedeu o limite de tentativas, reagendar
        if (arquivo.state === "PROCESSING") {
          if (tentativas < maxTentativas) {
            registrador.debug(`[Vídeo] Ainda em processamento, reagendando... (tentativa ${tentativas + 1})`);
            
            // Calcular delay com exponential backoff
            const backoffDelay = Math.min(15000, 500 * Math.pow(2, tentativas));
            
            // Reagendar
            return Trilho.dePromise(
              filas.video.processamento.add('processar-video', {
                ...job.data,
                tentativas: tentativas + 1
              }, { delay: backoffDelay })
            ).then(() => Resultado.sucesso({ success: true, status: "PROCESSING", tentativas: tentativas + 1 }));
          } else {
            return Resultado.falha(new Error("Tempo máximo de processamento excedido"));
          }
        } else if (arquivo.state === "FAILED") {
          return Resultado.falha(new Error("Falha no processamento do vídeo pelo Google AI"));
        }
        
        // Estados válidos para prosseguir: SUCCEEDED ou ACTIVE
        if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
          return Resultado.falha(new Error(`Estado inesperado do arquivo: ${arquivo.state}`));
        }
        
        registrador.debug(`[Vídeo] Processado com sucesso, estado: ${arquivo.state}`);
        
        // Adicionar à fila de análise
        return Trilho.dePromise(
          filas.video.analise.add('analise-video', {
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
          })
        ).then(() => Resultado.sucesso({ success: true, status: arquivo.state }));
      }
    )()
    .catch(erro => {
      registrador.error(`[Vídeo] Erro no processamento: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      // Limpar arquivo temporário
      Utilitarios.limparArquivo(tempFilename);
      
      // Tentar excluir o arquivo do Google AI
      if (fileName) {
        gerenciadorAI.gerenciadorArquivos.deleteFile(fileName)
          .catch(errDelete => {
            registrador.warn(`Não foi possível excluir o arquivo remoto: ${errDelete.message}`);
          });
      }
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
  }),

  /**
   * Criar processador de análise de vídeo
   */
  criarProcessadorAnaliseVideo: _.curry((registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro) => async (job) => {
    const {
      fileName, tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber,
      transacaoId, fileState, fileUri, fileMimeType, remetenteName
    } = job.data;

    const obterConfig = Configuracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = Configuracao.prepararPrompt(registrador);

    return Trilho.encadear(
      // Iniciar análise
      () => {
        registrador.debug(`[Vídeo] Iniciando análise: ${fileName} (Job ${job.id})`);
        return Resultado.sucesso(job.data);
      },
      
      // Obter configuração
      async () => {
        const resultadoConfig = await obterConfig(chatId, 'video');
        
        if (!resultadoConfig.sucesso) {
          registrador.error(`Erro ao obter config: ${resultadoConfig.erro.message}, usando padrão`);
          return Resultado.sucesso({
            dados: job.data,
            config: {
              temperature: 0.9,
              topK: 1,
              topP: 0.95,
              maxOutputTokens: 1024,
              model: "gemini-2.0-flash",
              modoDescricao: 'curto'
            }
          });
        }
        
        return Resultado.sucesso({
          dados: job.data,
          config: resultadoConfig.dados
        });
      },
      
      // Preparar prompt e analisar vídeo
      (contexto) => {
        const { dados, config } = contexto;
        
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
        
        return Trilho.dePromise(Promise.race([promessaRespostaIA, promessaTimeoutIA]))
          .then(resultado => {
            if (!resultado.sucesso) {
              return Resultado.falha(resultado.erro);
            }
            
            let resposta = resultado.dados.response.text();
            
            if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
              resposta = "Não consegui gerar uma descrição clara para este vídeo.";
            }
            
            return Resultado.sucesso({
              dados,
              config,
              resposta
            });
          });
      },
      
      // Limpar recursos e enviar resposta
      async (contexto) => {
        const { resposta } = contexto;
        
        // Limpar o arquivo temporário
        await Utilitarios.limparArquivo(tempFilename);
        
        // Limpar o arquivo do Google
        await gerenciadorAI.gerenciadorArquivos.deleteFile(fileName);
        
        // Enviar resposta via callback
        registrador.debug(`[Vídeo] Análise concluída com sucesso (Job ${job.id})`);
        
        processarResultado({
          resposta,
          chatId,
          messageId,
          senderNumber,
          transacaoId,
          remetenteName,
          tipo: 'video'
        });
        
        return Resultado.sucesso({ success: true });
      }
    )()
    .catch(erro => {
      registrador.error(`[Vídeo] Erro na análise: ${erro.message}`, { erro, jobId: job.id });
      
      // Notificar erro
      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      // Limpar arquivos
      Utilitarios.limparArquivo(tempFilename);
      
      if (fileName) {
        gerenciadorAI.gerenciadorArquivos.deleteFile(fileName)
          .catch(errDelete => {
            registrador.warn(`Não foi possível excluir o arquivo remoto: ${errDelete.message}`);
          });
      }
      
      throw erro; // Rejeitar promessa para que Bull considere o job como falha
    });
  }),

  /**
   * Criar processador principal de vídeo (compatibilidade)
   */
  criarProcessadorPrincipalVideo: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;

    return Trilho.encadear(
      () => {
        registrador.info(`Vídeo inserido na fila    - ${transacaoId || 'sem_id'}`);
        return Resultado.sucesso(job.data);
      },
      
      // Redirecionar para a nova estrutura de fila
      () => Trilho.dePromise(
        filas.video.upload.add('upload-video', {
          tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName, tipo: 'video'
        })
      ),
      
      (uploadJob) => {
        registrador.debug(`[Vídeo] Redirecionado com sucesso, job ID: ${uploadJob.id}`);
        return Resultado.sucesso({ success: true, redirectedJobId: uploadJob.id });
      }
    )()
    .catch(erro => {
      registrador.error(`[Vídeo] Erro ao redirecionar: ${erro.message}`, { erro, jobId: job.id });
      
      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });
      
      throw erro;
    });
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
    return Trilho.encadear(
      () => {
        registrador.info("🧹 Iniciando limpeza das filas de trabalhos antigos...");
        return Resultado.sucesso(filas);
      },
      
      // Mapear todas as filas para limpeza
      (filas) => {
        const listaFilas = [
          filas.imagem.upload,
          filas.imagem.analise,
          filas.imagem.principal,
          filas.video.upload,
          filas.video.processamento,
          filas.video.analise,
          filas.video.principal
        ];
        
        return Resultado.sucesso(listaFilas);
      },
      
      // Processar cada fila
      async (listaFilas) => {
        // Função para processar cada fila
        const processarFila = async (fila) => {
          const trabalhos = await fila.getJobs(['waiting', 'active', 'delayed']);
          let removidos = 0;
          
          for (const trabalho of trabalhos) {
            try {
              // Verificar se o arquivo existe (para trabalhos com tempFilename)
              if (trabalho.data && trabalho.data.tempFilename) {
                const { tempFilename } = trabalho.data;
                
                // Verificar se o arquivo existe
                const resultado = await ArquivoUtils.verificarArquivoExiste(tempFilename);
                if (resultado.sucesso && !resultado.dados) {
                  registrador.warn(`⚠️ Removendo trabalho fantasma: ${trabalho.id} (arquivo ${tempFilename} não existe)`);
                  await trabalho.remove();
                  removidos++;
                  continue;
                }
              }
              
              // Verificar se está travado há muito tempo
              if (trabalho.processedOn && Date.now() - trabalho.processedOn > 300000) { // 5 minutos
                registrador.warn(`⚠️ Removendo trabalho travado: ${trabalho.id} (processando há ${Math.round((Date.now() - trabalho.processedOn) / 1000)}s)`);
                await trabalho.remove();
                removidos++;
              }
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
        return Resultado.sucesso(totalRemovidos);
      }
    )()
    .catch(erro => {
      registrador.error(`❌ Erro ao limpar filas: ${erro.message}`);
      return Resultado.sucesso(0);
    });
  }),

  /**
   * Limpa todas as filas
   * @param {Object} registrador - Logger
   * @param {Object} filas - Estrutura de filas
   * @param {boolean} apenasCompletos - Se verdadeiro, limpa apenas trabalhos concluídos
   * @returns {Promise<Object>} Resultado da operação
   */
  limparFilas: _.curry(async (registrador, filas, apenasCompletos = true) => {
    return Trilho.encadear(
      () => {
        registrador.info(`🧹 Iniciando limpeza ${apenasCompletos ? 'de trabalhos concluídos' : 'COMPLETA'} das filas...`);
        return Resultado.sucesso(filas);
      },
      
      // Mapear todas as filas para limpeza
      (filas) => {
        const mapaFilas = [
          { nome: 'Img-Upload', fila: filas.imagem.upload },
          { nome: 'Img-Análise', fila: filas.imagem.analise },
          { nome: 'Img-Principal', fila: filas.imagem.principal },
          { nome: 'Vid-Upload', fila: filas.video.upload },
          { nome: 'Vid-Process', fila: filas.video.processamento },
          { nome: 'Vid-Análise', fila: filas.video.analise },
          { nome: 'Vid-Principal', fila: filas.video.principal }
        ];
        
        return Resultado.sucesso(mapaFilas);
      },
      
      // Processar cada fila
      async (mapaFilas) => {
        // Função para processar cada fila
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
        
        return Resultado.sucesso(resultadosObj);
      }
    )()
    .catch(erro => {
      registrador.error(`❌ Erro ao limpar filas: ${erro.message}`);
      return Resultado.falha(erro);
    });
  })
};

// ===== INICIALIZAÇÃO FUNCIONAL =====

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

  // Expor componentes internos para testes
  inicializarFilasMidia.Resultado = Resultado;
  inicializarFilasMidia.Utilitarios = Utilitarios;
  inicializarFilasMidia.Configuracao = Configuracao;
  inicializarFilasMidia.CriadoresFilas = CriadoresFilas;
  inicializarFilasMidia.ProcessadoresMidia = ProcessadoresMidia;
  inicializarFilasMidia.ProcessadoresFilas = ProcessadoresFilas;
  inicializarFilasMidia.MonitoradorFilas = MonitoradorFilas;

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

    return servicoMensagem.enviarResposta(mensagemSimulada, resultado.resposta, resultado.transacaoId);
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
  filas.imagem.upload.process('upload-imagem', 20,
    ProcessadoresFilas.criarProcessadorUploadImagem(registrador, filas, notificarErro));

  filas.imagem.analise.process('analise-imagem', 20,
    ProcessadoresFilas.criarProcessadorAnaliseImagem(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));

  filas.imagem.principal.process('processar-imagem', 20,
    ProcessadoresFilas.criarProcessadorPrincipalImagem(registrador, filas, notificarErro));

  // 2. Processadores de Vídeo
  filas.video.upload.process('upload-video', 10,
    ProcessadoresFilas.criarProcessadorUploadVideo(registrador, gerenciadorAI, filas, notificarErro));
  
    filas.video.processamento.process('processar-video', 10,
      ProcessadoresFilas.criarProcessadorProcessamentoVideo(registrador, gerenciadorAI, filas, notificarErro));
  
    filas.video.analise.process('analise-video', 10,
      ProcessadoresFilas.criarProcessadorAnaliseVideo(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));
  
    filas.video.principal.process('processar-video', 10,
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