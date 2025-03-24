// FilasMonitorador.js

/**
 * FilasMonitorador - Funções para monitoramento e limpeza de filas
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado, Trilho, ArquivoUtils } = require('../../utilitarios/Ferrovia');

/**
 * MonitoradorFilas - Funções para monitoramento de filas
 */
const FilasMonitorador = {
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

module.exports = FilasMonitorador;