/**
 * GerenciadorNotificacoes - Módulo funcional para gerenciar notificações pendentes
 * 
 * Implementação seguindo o padrão Ferrovia para tratamento funcional de erros.
 */

const fs = require('fs');
const path = require('path');
const _ = require('lodash/fp');
const { Resultado, ArquivoUtils, Trilho } = require('../../utilitarios/Ferrovia');
const { criarDiretorio, salvarArquivoJson, listarArquivos, lerArquivoJson, removerArquivo } = ArquivoUtils;

/**
 * Fábrica para o Gerenciador de Notificações
 * @param {Object} registrador - Objeto logger para registro de eventos
 * @param {string} diretorioTemp - Diretório para armazenar notificações
 * @returns {Object} Instância funcional do gerenciador
 */
const criarGerenciadorNotificacoes = (registrador, diretorioTemp = '../temp') => {
  
  // Garantir que o diretório exista ao inicializar
  criarDiretorio(diretorioTemp)
    .then(resultado => {
      if (resultado.sucesso) {
        registrador.info(`[Notif] Diretório pronto: ${diretorioTemp}`);
      } else {
        registrador.error(`[Notif] Erro ao criar diretório: ${resultado.erro.message}`);
      }
    });

  /**
   * Método interno para processar uma notificação individual
   * @private
   */
  const processarNotificacaoIndividual = async (nomeArquivo, cliente) => {
    const caminhoArquivo = path.join(diretorioTemp, nomeArquivo);
    
    return Trilho.encadear(
      // Verificar idade do arquivo (ignorar muito recentes)
      async () => {
        const stats = await fs.promises.stat(caminhoArquivo).catch(() => null);
        if (!stats || (Date.now() - stats.mtime.getTime() < 5000)) {
          return Resultado.falha(new Error("Arquivo muito recente, ignorando"));
        }
        return Resultado.sucesso(caminhoArquivo);
      },
      
      // Ler conteúdo do arquivo
      () => lerArquivoJson(caminhoArquivo),
      
      // Enviar a mensagem
      async (dados) => {
        if (!dados.senderNumber || !dados.message) {
          return Resultado.falha(new Error("Dados de notificação incompletos"));
        }
        
        try {
          await cliente.sendMessage(dados.senderNumber, dados.message);
          registrador.info(`[Notif] ✅ Notificação pendente enviada.`);
          
          await removerArquivo(caminhoArquivo);
          return Resultado.sucesso(true);
        } catch (erroEnvio) {
          return Resultado.falha(erroEnvio);
        }
      }
    )()
    .catch(erro => {
      if (erro.message?.includes("Arquivo muito recente")) {
        return Resultado.sucesso(false);
      }
      
      registrador.error(`[Notif] Erro ao processar arquivo ${nomeArquivo}: ${erro.message}`);
      return Resultado.sucesso(false);
    });
  };

  return {
    /**
     * Salva uma notificação para ser entregue posteriormente
     */
    salvar: async (destinatario, mensagem) => {
      const nomeArquivo = `notificacao_${destinatario.replace(/[^0-9]/g, '')}_${Date.now()}.json`;
      const arquivoNotificacao = path.join(diretorioTemp, nomeArquivo);

      const dadosNotificacao = {
        senderNumber: destinatario,
        message: mensagem,
        timestamp: Date.now()
      };
      
      return Trilho.encadear(
        () => criarDiretorio(diretorioTemp),
        () => salvarArquivoJson(arquivoNotificacao, dadosNotificacao),
        (caminho) => {
          registrador.info(`[Notif] Notificação salva: ${caminho}`);
          return Resultado.sucesso(caminho);
        }
      )()
      .catch(erro => {
        registrador.error(`[Notif] Erro ao salvar notificação: ${erro.message}`);
        return Resultado.falha(erro);
      });
    },

    /**
     * Processa notificações pendentes
     */
    processar: async (cliente) => {
      if (!cliente) {
        return Resultado.falha(new Error("Cliente não fornecido para processamento de notificações"));
      }

      return Trilho.encadear(
        () => listarArquivos(diretorioTemp),
        (arquivos) => Resultado.sucesso(
          _.filter(arquivo => arquivo.startsWith('notificacao_') && arquivo.endsWith('.json'), arquivos)
        ),
        async (notificacoes) => {
          if (notificacoes.length === 0) return Resultado.sucesso(0);
          
          registrador.info(`[Notif] Encontradas ${notificacoes.length} notificações pendentes.`);
          let processadas = 0;
          
          for (const arquivo of notificacoes) {
            const resultado = await processarNotificacaoIndividual(arquivo, cliente);
            if (resultado.sucesso && resultado.dados) {
              processadas++;
            }
          }
          
          if (processadas > 0) {
            registrador.info(`[Notif] Processadas ${processadas} notificações pendentes.`);
          }
          
          return Resultado.sucesso(processadas);
        }
      )()
      .catch(erro => {
        registrador.error(`[Notif] Erro ao processar notificações pendentes: ${erro.message}`);
        return Resultado.sucesso(0);
      });
    },

    /**
     * Limpa notificações antigas
     */
    limparAntigas: async (diasAntiguidade = 7) => {
      const limiteAntiguidade = Date.now() - (diasAntiguidade * 24 * 60 * 60 * 1000);
      
      return Trilho.encadear(
        () => listarArquivos(diretorioTemp),
        (arquivos) => Resultado.sucesso(
          _.filter(arquivo => arquivo.startsWith('notificacao_') && arquivo.endsWith('.json'), arquivos)
        ),
        async (notificacoes) => {
          let removidas = 0;
          for (const arquivo of notificacoes) {
            const caminhoCompleto = path.join(diretorioTemp, arquivo);
            try {
              const stats = await fs.promises.stat(caminhoCompleto);
              if (stats.mtimeMs < limiteAntiguidade) {
                const resultado = await removerArquivo(caminhoCompleto);
                if (resultado.sucesso) removidas++;
              }
            } catch (err) {
              registrador.error(`Erro ao limpar notificação antiga ${arquivo}: ${err.message}`);
            }
          }
          if (removidas > 0) {
            registrador.info(`[Notif] Removidas ${removidas} notificações antigas.`);
          }
          return Resultado.sucesso(removidas);
        }
      )()
      .catch(erro => {
        registrador.error(`[Notif] Erro ao limpar notificações antigas: ${erro.message}`);
        return Resultado.sucesso(0);
      });
    }
  };
};

module.exports = { criarGerenciadorNotificacoes };
