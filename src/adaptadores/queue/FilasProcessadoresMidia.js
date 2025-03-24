// FilasProcessadoresMidia.js

/**
 * FilasProcessadoresMidia - Funções para processamento de mídias
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado, Trilho, ArquivoUtils } = require('../../utilitarios/Ferrovia');
const FilasUtilitarios = require('./FilasUtilitarios');

/**
 * ProcessadoresMidia - Funções puras para processamento de mídia
 */
const FilasProcessadoresMidia = {
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
      return Promise.resolve(Resultado.falha(new Error("Dados da imagem inválidos ou ausentes")));
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
      FilasUtilitarios.limparArquivo(caminhoArquivo);
      
      return Resultado.falha(erro);
    });
  })
};

module.exports = FilasProcessadoresMidia;