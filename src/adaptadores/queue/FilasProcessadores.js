// FilasProcessadores.js

/**
 * FilasProcessadores - Funções para processamento de jobs nas filas
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado, Trilho, ArquivoUtils, Operacoes } = require('../../utilitarios/Ferrovia');
const FilasUtilitarios = require('./FilasUtilitarios');
const FilasConfiguracao = require('./FilasConfiguracao');
const FilasProcessadoresMidia = require('./FilasProcessadoresMidia');

/**
 * ProcessadoresFilas - Funções para processamento de filas
 */
const FilasProcessadores = {
  /**
   * Cria handler para notificar erros
   * @param {Object} registrador - Logger
   * @param {Function} callbackResposta - Callback para enviar resultado
   * @returns {Function} Handler de notificação de erro
   */
  criarNotificadorErro: _.curry((registrador, callbackResposta, tipoMidia, erro, dados) => {
    const { chatId, messageId, senderNumber, transacaoId, remetenteName } = dados;

    // Obter mensagem de erro amigável
    const mensagemErro = FilasUtilitarios.obterMensagemErroAmigavel(tipoMidia, erro);
    const tipoErro = FilasUtilitarios.identificarTipoErro(erro);

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

    const obterConfig = FilasConfiguracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = FilasConfiguracao.prepararPrompt(registrador);
    const processarImagem = FilasProcessadoresMidia.processarImagem(gerenciadorAI, registrador);

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
      FilasUtilitarios.limparArquivo(tempFilename);
      
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
      FilasUtilitarios.limparArquivo(tempFilename);
      
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

    const obterConfig = FilasConfiguracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = FilasConfiguracao.prepararPrompt(registrador);

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
        await FilasUtilitarios.limparArquivo(tempFilename);
        
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
      FilasUtilitarios.limparArquivo(tempFilename);
      
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

module.exports = FilasProcessadores;