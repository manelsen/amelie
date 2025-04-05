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
      registrador.info(`${resultado.tipo} ok - ${idTx}`);
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

    // Envolver adição à fila com tentativa
    // const addAnaliseImagemTentativa = Operacoes.tentar(filas.imagem.analise.add); // REMOVIDO TEMPORARIAMENTE

    return Trilho.encadear(
      // 1. Verificar dados da imagem
      async () => { // Tornar async para consistência
        registrador.debug(`[Imagem] Iniciando preparo da imagem para análise (Job ${job.id})`);
        if (!imageData || !imageData.data) {
          return Resultado.falha(new Error("Dados da imagem inválidos ou ausentes"));
        }
        return Resultado.sucesso(job.data); // Passar dados originais
      },

      // 2. Adicionar à fila de análise (com tentativa)
      async (dadosJob) => { // Renomeado para clareza
        let resultadoAdd;
        try {
          // Log removido
          const jobAdicionadoAnalise = await filas.imagem.analise.add('analise-imagem', { // Chamada direta
            // Usar dados de dadosJob
            imageData: dadosJob.imageData,
            chatId: dadosJob.chatId,
            messageId: dadosJob.messageId,
            mimeType: dadosJob.mimeType,
            userPrompt: dadosJob.userPrompt,
            senderNumber: dadosJob.senderNumber,
            transacaoId: dadosJob.transacaoId,
            remetenteName: dadosJob.remetenteName,
            uploadTimestamp: Date.now(),
            tipo: 'imagem'
          });
          resultadoAdd = Resultado.sucesso(jobAdicionadoAnalise);
          // Log removido
        } catch (erroDireto) {
          // Log removido
          resultadoAdd = Resultado.falha(erroDireto); // Manter a captura do erro
        }

        // Propagar falha se ocorrer
        if (!resultadoAdd.sucesso) return resultadoAdd;

        // Retornar sucesso simples
        return Resultado.sucesso({ success: true });
      }
    )() // Fim do Trilho.encadear
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

    // Funções auxiliares e wrappers 'tentar'
    const obterConfig = FilasConfiguracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = FilasConfiguracao.prepararPrompt(registrador);
    // processarImagem já retorna Resultado, mas vamos envolvê-la em tentar para capturar exceções inesperadas nela ou em gerenciadorAI
    const processarImagemTentativa = Operacoes.tentar(FilasProcessadoresMidia.processarImagem(gerenciadorAI, registrador));
    const processarResultadoTentativa = Operacoes.tentar(processarResultado); // Envolver callback

    return Trilho.encadear(
      // 1. Iniciar análise (etapa simples)
      async () => { // Tornar async para consistência
        registrador.debug(`[Imagem] Iniciando análise da imagem (Job ${job.id})`);
        // Passar dados originais para a próxima etapa
        return Resultado.sucesso(job.data);
      },

      // 2. Obter configuração (já retorna Resultado)
      async (dadosJob) => {
        const resultadoConfig = await obterConfig(chatId, 'imagem');
        let configFinal;
        if (!resultadoConfig.sucesso) {
          registrador.error(`[Imagem] Erro ao obter config: ${resultadoConfig.erro.message}, usando padrão`);
          // Definir config padrão
           configFinal = { /* definir config padrão para imagem aqui se necessário */ };
        } else {
          configFinal = resultadoConfig.dados;
        }
        // Passa dados + config
        return Resultado.sucesso({ dados: dadosJob, config: configFinal });
      },

      // 3. Preparar prompt e processar imagem (com tentativa)
      async (contexto) => {
        const { dados, config } = contexto;
        const promptFinal = prepararPrompt('imagem', dados.userPrompt, config.modoDescricao);

        // Chamar com tentativa
        const resultadoProcessar = await processarImagemTentativa(dados.imageData, promptFinal, config);

        // Se falhar, propaga o erro
        if (!resultadoProcessar.sucesso) return resultadoProcessar;

        // Passa contexto + resposta para a próxima etapa
        return Resultado.sucesso({ ...contexto, resposta: resultadoProcessar.dados });
      },

      // 4. Enviar resultado via callback (com tentativa)
      async (contextoComResposta) => {
        const { dados, resposta } = contextoComResposta;

        registrador.debug(`[Imagem] Análise concluída com sucesso (Job ${job.id})`);

        // Chamar callback com tentativa
        const resultadoCallback = await processarResultadoTentativa({
          resposta: resposta, // Passar a string de resposta
          chatId: dados.chatId,
          messageId: dados.messageId,
          senderNumber: dados.senderNumber,
          transacaoId: dados.transacaoId,
          remetenteName: dados.remetenteName,
          tipo: 'imagem'
        });

        // Logar erro do callback, mas não falhar o pipeline principal
        if (!resultadoCallback.sucesso) {
          // registrador.error(`[Imagem Análise] Falha ao executar callback de resultado: ${resultadoCallback.erro.message}`); // Log removido (já logado dentro do callback?)
        }

        return Resultado.sucesso({ success: true }); // Sucesso final do pipeline
      }
    )() // Fim do Trilho.encadear
    .catch(erro => { // Manter catch para Bull
      registrador.error(`[Imagem] Erro no pipeline de análise: ${erro.message}`, { erro, jobId: job.id });

      // Notificar erro usando os dados originais do job
      notificarErro('imagem', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });

      throw erro; // Rejeitar para Bull
    });
  }),

  /**
   * Criar processador principal de imagem (compatibilidade)
   */
  criarProcessadorPrincipalImagem: _.curry((registrador, filas, notificarErro) => async (job) => {
    // Log para inspecionar a fila antes de usá-la
    // MUDADO PARA INFO
    // Log removido

    const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;

    // Envolver adição à fila com tentativa
    // Verificar se a fila e o método add existem antes de criar o wrapper
    if (!filas?.imagem?.upload?.add) {
      registrador.error(`[Principal Imagem] ERRO CRÍTICO: filas.imagem.upload.add não está definido para Job ${job.id}!`);
      // Retornar falha imediatamente para evitar erro fatal
      return Resultado.falha(new Error("Instância da fila de upload de imagem inválida"));
    }
    // const addUploadImagemTentativa = Operacoes.tentar(filas.imagem.upload.add); // REMOVIDO TEMPORARIAMENTE

    return Trilho.encadear(
      // 1. Log inicial
      async () => { // Tornar async para consistência
        registrador.info(`Imagem na fila   - ${transacaoId || 'sem_id'}`);
        return Resultado.sucesso(job.data); // Passar dados originais
      },

      // 2. Redirecionar para a nova estrutura de fila (CHAMADA DIRETA)
      async (dadosJob) => { // Renomeado para clareza
        let resultadoAdd;
        try {
          // Log removido
          const jobAdicionadoBull = await filas.imagem.upload.add('upload-imagem', { // Chamada direta
            // Usar dados de dadosJob
            imageData: dadosJob.imageData,
            chatId: dadosJob.chatId,
            messageId: dadosJob.messageId,
            mimeType: dadosJob.mimeType,
            userPrompt: dadosJob.userPrompt,
            senderNumber: dadosJob.senderNumber,
            transacaoId: dadosJob.transacaoId,
            remetenteName: dadosJob.remetenteName,
            tipo: 'imagem'
          });
          // Se a chamada direta for bem-sucedida, encapsular em Resultado.sucesso
          resultadoAdd = Resultado.sucesso(jobAdicionadoBull);
        } catch (erroDireto) {
          // Se a chamada direta falhar, encapsular em Resultado.falha
          // registrador.error(`[Principal Imagem] Erro na chamada DIRETA de filas.imagem.upload.add para Job ${job.id}: ${erroDireto.message}`, erroDireto); // Log removido
          resultadoAdd = Resultado.falha(erroDireto); // Manter captura do erro
        }

        // Log para verificar o resultado da adição à fila
        // registrador.debug(`[Principal Imagem] Resultado de addUploadImagemTentativa para Job ${job.id}: ${JSON.stringify(resultadoAdd)}`); // Log removido

        // Propagar falha se ocorrer
        if (!resultadoAdd.sucesso) {
           // registrador.error(`[Principal Imagem] Falha ao adicionar Job ${job.id} à fila 'upload': ${resultadoAdd.erro?.message || 'Erro desconhecido'}`); // Log removido (erro já logado na captura)
           return resultadoAdd; // Retorna a falha
        }

        // Passar o job adicionado (resultado.dados) para a próxima etapa
        const jobAdicionado = resultadoAdd.dados;
        // registrador.info(`[Principal Imagem] Job ${job.id} redirecionado para fila 'upload'. Novo Job ID: ${jobAdicionado?.id}`); // Log removido
        return Resultado.sucesso(jobAdicionado);
      },

      // 3. Log de sucesso
      async (uploadJob) => { // Recebe o job adicionado
        registrador.debug(`[Imagem] Redirecionada com sucesso, job ID: ${uploadJob.id}`);
        // Retornar sucesso final com o ID do job redirecionado
        return Resultado.sucesso({ success: true, redirectedJobId: uploadJob.id });
      }
    )() // Fim do Trilho.encadear
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

    // Envolver chamadas externas com Operacoes.tentar para robustez
    // const uploadGoogleTentativa = Operacoes.tentar(gerenciadorAI.uploadArquivoGoogle); // REMOVIDO TEMPORARIAMENTE
    // const addFilaProcessamentoTentativa = Operacoes.tentar(filas.video.processamento.add); // REMOVIDO TEMPORARIAMENTE

    return Trilho.encadear(
      // 1. Verificar arquivo temporário
      async () => {
        registrador.debug(`[Vídeo] Iniciando upload: ${tempFilename} (Job ${job.id})`);
        const resultadoVerificacao = await ArquivoUtils.verificarArquivoExiste(tempFilename);
        // Se falhar ou arquivo não existir, encadear já propaga a falha
        if (!resultadoVerificacao.sucesso || !resultadoVerificacao.dados) {
          return Resultado.falha(new Error("Arquivo temporário do vídeo não encontrado ou inacessível"));
        }
        // Se sucesso, passa os dados originais do job para a próxima etapa
        return Resultado.sucesso(job.data);
      },

      // 2. Fazer upload para o Google AI (com tentativa)
      async (dadosJob) => { // Renomeado para clareza
        let resultadoUpload;
        try {
          registrador.debug(`[Upload Vídeo] Tentando chamar gerenciadorAI.uploadArquivoGoogle diretamente para Job ${job.id}`);
          // Chamada direta - uploadArquivoGoogle já retorna um Resultado
          resultadoUpload = await gerenciadorAI.uploadArquivoGoogle(tempFilename, {
            mimeType: mimeType || 'video/mp4',
            displayName: "Vídeo Enviado"
          });
          // Não precisamos encapsular em Resultado.sucesso aqui, pois uploadArquivoGoogle já faz isso.
          registrador.info(`[Upload Vídeo] Chamada direta para uploadArquivoGoogle retornou (sucesso=${resultadoUpload?.sucesso}) para Job ${job.id}`);
        } catch (erroDireto) {
          registrador.error(`[Upload Vídeo] Erro na chamada DIRETA de gerenciadorAI.uploadArquivoGoogle para Job ${job.id}: ${erroDireto.message}`, erroDireto);
          resultadoUpload = Resultado.falha(erroDireto);
        }

        // Se uploadGoogleTentativa falhar, o Resultado.falha será propagado automaticamente
        if (!resultadoUpload.sucesso) return resultadoUpload;

        // Log removido
        // registrador.info(`[Upload Vídeo] Objeto Resultado COMPLETO de uploadGoogleTentativa (sucesso) para Job ${job.id}: ${JSON.stringify(resultadoUpload)}`);

        // const respostaUpload = resultadoUpload.dados; // REMOVIDA variável intermediária

        // Adicionar verificação DETALHADA acessando diretamente resultadoUpload.dados
        // const check_resultadoUpload_dados = typeof resultadoUpload.dados; // Log removido
        // const check_resultadoUpload_dados_file = typeof resultadoUpload.dados?.file; // Log removido
        // const check_resultadoUpload_dados_file_name = typeof resultadoUpload.dados?.file?.name; // Log removido
        // const value_resultadoUpload_dados_file_name = resultadoUpload.dados?.file?.name; // Log removido
        // registrador.info(`[Upload Vídeo] Check Detalhado Job ${job.id}: resultadoUpload.dados=${check_resultadoUpload_dados}, keys=${Object.keys(resultadoUpload.dados || {})}, resultadoUpload.dados?.file=${check_resultadoUpload_dados_file}, resultadoUpload.dados?.file?.name=${check_resultadoUpload_dados_file_name}, value=${value_resultadoUpload_dados_file_name}`); // Log removido

        // CORRIGIDO: Verificar o caminho correto: resultadoUpload.dados.file.name
        if (!resultadoUpload.dados?.file?.name) {
          registrador.error(`[Upload Vídeo] Estrutura de resposta inesperada do upload para Job ${job.id}. 'file.name' ausente (verificado via !resultadoUpload.dados?.file?.name).`);
          return Resultado.falha(new Error("Resposta inesperada do upload do Google AI (file.name ausente)"));
        }
        // Usar diretamente resultadoUpload.dados.file.name
        registrador.debug(`[Vídeo] Upload concluído, nome do arquivo: ${resultadoUpload.dados.file.name}`); // Acesso corrigido

        // Passa os dados originais + infos do upload para a próxima etapa
        return Resultado.sucesso({
          ...dadosJob,
          fileName: resultadoUpload.dados.file.name, // Acesso corrigido
          fileUri: resultadoUpload.dados.file.uri   // Acesso corrigido
        });
      },

      // 3. Adicionar à fila de processamento (com chamada direta)
      async (dadosComUpload) => { // Renomeado para clareza
        // Log removido
        let resultadoAddFila;
        try {
          // Log removido
          const jobAdicionadoProc = await filas.video.processamento.add('processar-video', {
            fileName: dadosComUpload.fileName,
            fileUri: dadosComUpload.fileUri,
            tempFilename: dadosComUpload.tempFilename, // Garante que tempFilename está nos dados
            chatId: dadosComUpload.chatId,
            messageId: dadosComUpload.messageId,
            mimeType: dadosComUpload.mimeType,
            userPrompt: dadosComUpload.userPrompt,
            senderNumber: dadosComUpload.senderNumber,
            transacaoId: dadosComUpload.transacaoId,
            remetenteName: dadosComUpload.remetenteName,
            uploadTimestamp: Date.now(),
            tipo: 'video'
          });
          resultadoAddFila = Resultado.sucesso(jobAdicionadoProc);
          // Log removido
        } catch (erroDireto) {
          registrador.error(`[Upload Vídeo] Erro na chamada DIRETA de filas.video.processamento.add para Job ${job.id}: ${erroDireto.message}`, erroDireto); // Manter log de erro
          resultadoAddFila = Resultado.falha(erroDireto); // Manter captura do erro
        }

        // Se a adição falhar, o Resultado.falha será propagado
        if (!resultadoAddFila.sucesso) {
          // Log removido (erro já logado na captura)
          return resultadoAddFila; // Retorna a falha
        }

        // Retorna um sucesso simples indicando que a etapa foi concluída
        // O fileName pode ser útil para logs posteriores se necessário
        return Resultado.sucesso({ success: true, fileName: dadosComUpload.fileName });
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
    // Log removido
    // registrador.info(`[Processamento Vídeo - INÍCIO] Recebido Job ${job.id}. job.data: ${JSON.stringify(job.data)}`);

    const {
      fileName, fileUri, tempFilename, chatId, messageId,
      mimeType, userPrompt, senderNumber, transacaoId,
      uploadTimestamp, remetenteName, tentativas = 0
    } = job.data;

    // Log removido
    // registrador.info(`[Processamento Vídeo - INÍCIO] Job ${job.id}. Valor de 'tentativas' após destructuring: ${tentativas}`);

    // Envolver chamadas externas com Operacoes.tentar
    // const getArquivoGoogleTentativa = Operacoes.tentar(gerenciadorAI.getArquivoGoogle); // REMOVIDO TEMPORARIAMENTE
    // const addFilaProcessamentoTentativa = Operacoes.tentar(filas.video.processamento.add); // REMOVIDO NOVAMENTE
    // const addFilaAnaliseTentativa = Operacoes.tentar(filas.video.analise.add); // REMOVIDO TEMPORARIAMENTE
    const deleteArquivoGoogleTentativa = Operacoes.tentar(gerenciadorAI.deleteArquivoGoogle); // Para o catch

    return Trilho.encadear(
      // 1. Verificar tempo e tentativas
      async () => { // Tornar async para consistência, embora não precise
        registrador.debug(`[Vídeo] Verificando processamento: ${fileName} (Job ${job.id}), tentativa ${tentativas + 1}`);
        const tempoDecorrido = Date.now() - uploadTimestamp;
        if (tempoDecorrido > 120000 && tentativas > 3) {
          return Resultado.falha(new Error(`Arquivo provavelmente expirou após ${Math.round(tempoDecorrido / 1000)} segundos`));
        }
        return Resultado.sucesso(job.data);
      },

      // 2. Obter estado atual do arquivo (com tentativa)
      async (dadosJob) => {
        let resultadoGetArquivo;
        try {
          // registrador.debug(`[Processamento Vídeo] Tentando chamar gerenciadorAI.getArquivoGoogle diretamente para Job ${job.id}, arquivo ${fileName}`); // Log removido
          // Chamada direta - getArquivoGoogle já retorna um Resultado
          resultadoGetArquivo = await gerenciadorAI.getArquivoGoogle(fileName);
          // registrador.info(`[Processamento Vídeo] Chamada direta para getArquivoGoogle retornou (sucesso=${resultadoGetArquivo?.sucesso}) para Job ${job.id}`); // Log removido
        } catch (erroDireto) {
          registrador.error(`[Processamento Vídeo] Erro na chamada DIRETA de gerenciadorAI.getArquivoGoogle para Job ${job.id}: ${erroDireto.message}`, erroDireto);
          resultadoGetArquivo = Resultado.falha(erroDireto);
        }

        if (!resultadoGetArquivo.sucesso) {
          // Tratar erro específico de 403 aqui se desejado, ou deixar propagar
          if (resultadoGetArquivo.erro?.message?.includes('403 Forbidden')) {
            registrador.error(`[Processamento Vídeo] Erro 403 ao obter arquivo Google para Job ${job.id}`);
            return Resultado.falha(new Error("Arquivo de vídeo inacessível (acesso negado)"));
          }
          registrador.error(`[Processamento Vídeo] Falha ao obter arquivo Google para Job ${job.id}: ${resultadoGetArquivo.erro?.message}`);
          return resultadoGetArquivo; // Propaga a falha
        }
        // Adiciona o objeto 'arquivo' E 'tentativas' aos dados para a próxima etapa
        const dadosParaProximaEtapa = { ...dadosJob, arquivo: resultadoGetArquivo.dados, tentativas: dadosJob.tentativas || 0 }; // Inclui tentativas
        // registrador.info(`[Processamento Vídeo] Preparando para retornar sucesso da etapa 2 para Job ${job.id}. Dados: ${JSON.stringify(dadosParaProximaEtapa)}`); // Log removido
        return Resultado.sucesso(dadosParaProximaEtapa);
      },

      // 3. Verificar estado e agir conforme (reagendar ou adicionar à análise)
      async (dadosComArquivo) => { // Renomeado para clareza
        const { arquivo, tentativas: currentTentativas } = dadosComArquivo; // Usar 'currentTentativas' para evitar shadowing
        const maxTentativas = 10;

        if (arquivo.state === "PROCESSING") {
          if (currentTentativas < maxTentativas) {
            registrador.debug(`[Vídeo] Ainda em processamento, reagendando... (tentativa ${currentTentativas + 1})`); // Log restaurado
            const backoffDelay = Math.min(15000, 500 * Math.pow(2, currentTentativas));
            // Logs removidos

            let resultadoReagendar;
            try {
              // Chamada direta com try...catch
              const jobReagendado = await filas.video.processamento.add('processar-video', {
                ...job.data,
                tentativas: currentTentativas + 1
              }, { delay: backoffDelay });
              resultadoReagendar = Resultado.sucesso(jobReagendado);
            } catch (erroDireto) {
              registrador.error(`[Processamento Vídeo] ERRO no bloco CATCH ao tentar reagendar Job ${job.id} (chamada direta): ${erroDireto.message}`, erroDireto);
              resultadoReagendar = Resultado.falha(erroDireto);
            }

            // Se falhar ao reagendar, propaga o erro
            if (!resultadoReagendar.sucesso) return resultadoReagendar;

            // Retorna um sucesso indicando reagendamento
            return Resultado.sucesso({ success: true, status: "REAGENDADO", tentativas: currentTentativas + 1 });
          } else {
            return Resultado.falha(new Error("Tempo máximo de processamento excedido"));
          }
        } else if (arquivo.state === "FAILED") {
          return Resultado.falha(new Error("Falha no processamento do vídeo pelo Google AI"));
        }

        if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
          return Resultado.falha(new Error(`Estado inesperado do arquivo: ${arquivo.state}`));
        }

        registrador.debug(`[Vídeo] Processado com sucesso, estado: ${arquivo.state}`);

        let resultadoAddAnalise;
        try {
          // registrador.debug(`[Processamento Vídeo] Tentando chamar filas.video.analise.add diretamente para Job ${job.id}`); // Log removido
          const jobAdicionadoAnalise = await filas.video.analise.add('analise-video', { // Chamada direta
            // Passar dados relevantes de 'dadosComArquivo'
            fileName: dadosComArquivo.fileName,
            fileUri: arquivo.uri, // Usar URI atualizado do arquivo
            tempFilename: dadosComArquivo.tempFilename,
            chatId: dadosComArquivo.chatId,
            messageId: dadosComArquivo.messageId,
            mimeType: dadosComArquivo.mimeType,
            userPrompt: dadosComArquivo.userPrompt,
            senderNumber: dadosComArquivo.senderNumber,
            transacaoId: dadosComArquivo.transacaoId,
            fileState: arquivo.state,
            fileMimeType: arquivo.mimeType,
            remetenteName: dadosComArquivo.remetenteName,
            tipo: 'video'
          });
          resultadoAddAnalise = Resultado.sucesso(jobAdicionadoAnalise);
          // registrador.info(`[Processamento Vídeo] Job ${job.id} adicionado à fila 'analise'. Novo Job ID: ${jobAdicionadoAnalise?.id}`); // Log removido
        } catch (erroDireto) {
          // registrador.error(`[Processamento Vídeo] Erro na chamada DIRETA de filas.video.analise.add para Job ${job.id}: ${erroDireto.message}`, erroDireto); // Log removido
          resultadoAddAnalise = Resultado.falha(erroDireto); // Manter captura do erro
        }

        // Se falhar ao adicionar à análise, propaga o erro
        if (!resultadoAddAnalise.sucesso) return resultadoAddAnalise;

        // Retorna sucesso indicando que foi para análise
        return Resultado.sucesso({ success: true, status: "ENVIADO_ANALISE", fileState: arquivo.state });
      }
    )() // Fim do Trilho.encadear
    .catch(async (erro) => { // Manter o catch para Bull e cleanup
      registrador.error(`[Vídeo] Erro no pipeline de processamento: ${erro.message}`, { erro, jobId: job.id });

      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });

      FilasUtilitarios.limparArquivo(tempFilename);

      if (fileName) {
        registrador.warn(`[Vídeo] Tentando excluir arquivo Google ${fileName} após erro no processamento.`);
        // Usar a versão com tentativa para deletar
        const deleteResult = await deleteArquivoGoogleTentativa(fileName);
        if (!deleteResult.sucesso) {
            registrador.error(`[Vídeo] Falha ao tentar excluir arquivo Google ${fileName} após erro: ${deleteResult.erro.message}`);
        }
      }

      throw erro; // Rejeitar para Bull
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

    // Funções auxiliares e wrappers 'tentar'
    const obterConfig = FilasConfiguracao.obterConfig(gerenciadorConfig, registrador);
    const prepararPrompt = FilasConfiguracao.prepararPrompt(registrador);
    const gerarConteudoTentativa = Operacoes.tentar(gerenciadorAI.gerarConteudoDeArquivoUri);
    const limparArquivoTentativa = Operacoes.tentar(FilasUtilitarios.limparArquivo); // Envolver limpeza
    const deleteArquivoGoogleTentativa = Operacoes.tentar(gerenciadorAI.deleteArquivoGoogle); // Envolver delete
    const processarResultadoTentativa = Operacoes.tentar(processarResultado); // Envolver callback

    return Trilho.encadear(
      // 1. Iniciar análise (etapa simples)
      async () => { // Tornar async para consistência
        registrador.debug(`[Vídeo] Iniciando análise: ${fileName} (Job ${job.id})`);
        return Resultado.sucesso(job.data);
      },

      // 2. Obter configuração (já retorna Resultado)
      async (dadosJob) => {
        const resultadoConfig = await obterConfig(chatId, 'video');
        let configFinal;
        if (!resultadoConfig.sucesso) {
          registrador.error(`Erro ao obter config: ${resultadoConfig.erro.message}, usando padrão`);
          // Definir config padrão em caso de erro
          configFinal = {
            temperature: 0.9, topK: 1, topP: 0.95, maxOutputTokens: 1024,
            model: "gemini-2.0-flash", modoDescricao: 'curto'
          };
        } else {
          configFinal = resultadoConfig.dados;
        }
        // Passa os dados originais + config para a próxima etapa
        return Resultado.sucesso({ dados: dadosJob, config: configFinal });
      },

      // 3. Preparar prompt e analisar vídeo (com tentativa)
      async (contexto) => {
        const { dados, config } = contexto;
        const { fileUri, fileMimeType, userPrompt, remetenteName, transacaoId } = dados;

        const promptFinal = prepararPrompt('video', userPrompt, config.modoDescricao);
        const configComOrigem = {
          ...config,
          tipoMidia: 'video',
          dadosOrigem: { tipo: 'Fila Vídeo Análise', nome: remetenteName || 'Desconhecido', id: transacaoId || 'sem_id' }
        };

        // Chamar com tentativa
        const resultadoGerar = await gerarConteudoTentativa(
          fileUri, fileMimeType, promptFinal, configComOrigem
        );

        // Se falhar, propaga o erro
        if (!resultadoGerar.sucesso) return resultadoGerar;

        const respostaOuErro = resultadoGerar.dados;

        // Verificar resposta de erro padrão (agora dentro do sucesso de 'tentar')
        if (typeof respostaOuErro === 'string' && (respostaOuErro.startsWith("Desculpe,") || respostaOuErro.startsWith("Este conteúdo"))) {
          registrador.warn(`[Vídeo Análise] Erro funcional retornado por gerarConteudoDeArquivoUri: ${respostaOuErro}`);
          return Resultado.falha(new Error(respostaOuErro));
        }

        // Passa contexto + resposta para a próxima etapa
        return Resultado.sucesso({ ...contexto, resposta: respostaOuErro });
      },

      // 4. Limpar recursos e enviar resposta (com tentativas)
      async (contextoComResposta) => {
        const { dados, resposta } = contextoComResposta;
        const { tempFilename: currentTempFilename, fileName: currentFileName } = dados; // Usar nomes locais

        // Limpar arquivo temporário (com tentativa)
        const resultadoLimparTemp = await limparArquivoTentativa(currentTempFilename);
        if (!resultadoLimparTemp.sucesso) {
            registrador.warn(`[Vídeo Análise] Falha ao limpar arquivo temporário ${currentTempFilename}: ${resultadoLimparTemp.erro.message}`);
            // Continuar mesmo se a limpeza falhar? Sim, o importante é a análise.
        }

        // Limpar arquivo do Google (com tentativa)
        const resultadoDeleteGoogle = await deleteArquivoGoogleTentativa(currentFileName);
         if (!resultadoDeleteGoogle.sucesso) {
            registrador.warn(`[Vídeo Análise] Falha ao excluir arquivo Google ${currentFileName}: ${resultadoDeleteGoogle.erro.message}`);
            // Continuar mesmo se a exclusão falhar? Sim.
        }

        // Enviar resposta via callback (com tentativa)
        registrador.debug(`[Vídeo] Análise concluída com sucesso (Job ${job.id})`);
        const resultadoCallback = await processarResultadoTentativa({
          resposta,
          chatId: dados.chatId,
          messageId: dados.messageId,
          senderNumber: dados.senderNumber,
          transacaoId: dados.transacaoId,
          remetenteName: dados.remetenteName,
          tipo: 'video'
        });

        // Se o callback falhar, logar mas considerar o fluxo principal um sucesso
         if (!resultadoCallback.sucesso) {
             // registrador.error(`[Vídeo Análise] Falha ao executar callback de resultado: ${resultadoCallback.erro.message}`); // Log removido (já logado dentro do callback?)
             // Não retornar falha aqui, pois a análise em si foi um sucesso.
         }

        return Resultado.sucesso({ success: true }); // Sucesso final do pipeline
      }
    )() // Fim do Trilho.encadear
    .catch(async (erro) => { // Manter catch para Bull e cleanup de emergência
      registrador.error(`[Vídeo] Erro no pipeline de análise: ${erro.message}`, { erro, jobId: job.id });

      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });

      // Tentar limpar arquivos mesmo em caso de erro no pipeline (com tentativa)
      if (tempFilename) {
          const resLimpar = await limparArquivoTentativa(tempFilename);
          if (!resLimpar.sucesso) registrador.warn(`[Vídeo Análise Catch] Falha ao limpar temp ${tempFilename}: ${resLimpar.erro.message}`);
      }
      if (fileName) {
        registrador.warn(`[Vídeo Análise Catch] Tentando excluir arquivo Google ${fileName} após erro.`);
        const resDelete = await deleteArquivoGoogleTentativa(fileName);
        if (!resDelete.sucesso) registrador.error(`[Vídeo Análise Catch] Falha ao excluir Google ${fileName}: ${resDelete.erro.message}`);
      }

      throw erro; // Rejeitar para Bull
    });
  }),

  /**
   * Criar processador principal de vídeo (compatibilidade)
   */
  criarProcessadorPrincipalVideo: _.curry((registrador, filas, notificarErro) => async (job) => {
    const { tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;

    // Envolver adição à fila com tentativa
    // const addUploadVideoTentativa = Operacoes.tentar(filas.video.upload.add); // REMOVIDO TEMPORARIAMENTE

    return Trilho.encadear(
      // 1. Log inicial
      async () => { // Tornar async para consistência
        registrador.info(`Vídeo na fila    - ${transacaoId || 'sem_id'}`);
        return Resultado.sucesso(job.data); // Passar dados originais
      },

      // 2. Redirecionar para a nova estrutura de fila (com tentativa)
      async (dadosJob) => { // Renomeado para clareza
        // Log removido
        let resultadoAdd;
        try {
          // Log removido
          const jobAdicionadoUpload = await filas.video.upload.add('upload-video', { // Chamada direta
            // Usar dados de dadosJob
            tempFilename: dadosJob.tempFilename,
            chatId: dadosJob.chatId,
            messageId: dadosJob.messageId,
            mimeType: dadosJob.mimeType,
            userPrompt: dadosJob.userPrompt,
            senderNumber: dadosJob.senderNumber,
            transacaoId: dadosJob.transacaoId,
            remetenteName: dadosJob.remetenteName,
            tipo: 'video'
          });
          resultadoAdd = Resultado.sucesso(jobAdicionadoUpload);
          // Log removido
        } catch (erroDireto) {
          registrador.error(`[Principal Vídeo] Erro na chamada DIRETA de filas.video.upload.add para Job ${job.id}: ${erroDireto.message}`, erroDireto); // Manter log de erro
          resultadoAdd = Resultado.falha(erroDireto); // Manter captura do erro
        }

        // Propagar falha se ocorrer
        if (!resultadoAdd.sucesso) {
          // Log removido (erro já logado na captura)
          return resultadoAdd; // Retorna a falha
        }

        // Passar o job adicionado (resultado.dados) para a próxima etapa
        return Resultado.sucesso(resultadoAdd.dados);
      },

      // 3. Log de sucesso
      async (uploadJob) => { // Recebe o job adicionado
        registrador.debug(`[Vídeo] Redirecionado com sucesso, job ID: ${uploadJob.id}`);
        // Retornar sucesso final com o ID do job redirecionado
        return Resultado.sucesso({ success: true, redirectedJobId: uploadJob.id });
      }
    )() // Fim do Trilho.encadear
    .catch(erro => { // Manter catch para Bull
      registrador.error(`[Vídeo] Erro ao redirecionar: ${erro.message}`, { erro, jobId: job.id });

      notificarErro('video', erro, { chatId, messageId, senderNumber, transacaoId, remetenteName });

      throw erro; // Rejeitar para Bull
    });
  })
};

module.exports = FilasProcessadores;
