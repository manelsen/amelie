// FilasCriadores.js

/**
 * FilasCriadores - Funções para criação e gerenciamento de filas
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const Queue = require('bull');
const _ = require('lodash/fp');
const { Resultado } = require('../../utilitarios/Ferrovia');

/**
 * CriadoresFilas - Funções puras para criar e configurar filas
 */
const FilasCriadores = {
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
          upload:        new Queue('midia-upload-imagem', configFilas),
          analise:       new Queue('midia-analise-imagem', configFilas),
          principal:     new Queue('midia-principal-imagem', {
            ...configFilas,
            defaultJobOptions: {
              ...configFilas.defaultJobOptions,
              timeout: 60000 // 1 minuto
            }
          })
        },
        video: {
          upload:        new Queue('midia-upload-video', configFilas),
          processamento: new Queue('midia-processamento-video', configFilas),
          analise:       new Queue('midia-analise-video', configFilas),
          principal:     new Queue('midia-principal-video', {
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
      
    });

    fila.on('progress', (job, progress) => {
      
    });

    fila.on('completed', (job, result) => {
      const duracao = Date.now() - (job.processedOn || job.timestamp);
      
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
          upload: FilasCriadores.configurarEventos(registrador, filas.imagem.upload, 'Upload-Imagem', filas.problemas),
          analise: FilasCriadores.configurarEventos(registrador, filas.imagem.analise, 'Análise-Imagem', filas.problemas),
          principal: FilasCriadores.configurarEventos(registrador, filas.imagem.principal, 'Principal-Imagem', filas.problemas)
        }
      }),
      // Configurar filas de vídeo
      filas => ({
        ...filas,
        video: {
          upload: FilasCriadores.configurarEventos(registrador, filas.video.upload, 'Upload-Vídeo', filas.problemas),
          processamento: FilasCriadores.configurarEventos(registrador, filas.video.processamento, 'Processamento-Vídeo', filas.problemas),
          analise: FilasCriadores.configurarEventos(registrador, filas.video.analise, 'Análise-Vídeo', filas.problemas),
          principal: FilasCriadores.configurarEventos(registrador, filas.video.principal, 'Principal-Vídeo', filas.problemas)
        }
      })
    )(filas);
  })
};

module.exports = FilasCriadores;