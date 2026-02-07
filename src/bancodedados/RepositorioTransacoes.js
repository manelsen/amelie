// src/bancodedados/RepositorioTransacoes.js
/**
 * RepositorioTransacoes - Repositório funcional para transações
 */

const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');
const crypto = require('crypto');

const criarRepositorioTransacoes = (caminhoBanco, registrador) => {
  const base = criarRepositorioNeDB(caminhoBanco, registrador);

  // Inicialização (assíncrona, mas garantimos os índices)
  base.garantirIndice('id');
  base.garantirIndice('status');
  base.garantirIndice('dataCriacao');
  base.garantirIndice('messageId');
  base.garantirIndice('chatId');

  /**
   * Determina o tipo de uma mensagem
   * @private
   */
  const determinarTipoMensagem = (mensagem) => {
    if (!mensagem.hasMedia) return 'texto';
    
    if (mensagem.type) {
      if (mensagem.type === 'image') return 'imagem';
      if (mensagem.type === 'video') return 'video';
      if (mensagem.type === 'audio' || mensagem.type === 'ptt') return 'audio';
      return mensagem.type;
    }
    
    if (mensagem._data && mensagem._data.mimetype) {
      const mimetype = mensagem._data.mimetype;
      if (mimetype.startsWith('image/')) return 'imagem';
      if (mimetype.startsWith('video/')) return 'video';
      if (mimetype.startsWith('audio/')) return 'audio';
    }
    
    return 'desconhecido';
  };

  return {
    ...base,

    /**
     * Cria uma nova transação para uma mensagem
     */
    criarTransacao: async (dadosTransacao) => {
      const agora = new Date();
      const idTransacao = dadosTransacao.id ? `tx_${dadosTransacao.id}` : `tx_${agora.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

      const transacao = {
        id: idTransacao,
        messageId: dadosTransacao.id,
        chatId: dadosTransacao.chatId,
        senderId: dadosTransacao.senderId,
        dataCriacao: agora,
        ultimaAtualizacao: agora,
        tipo: dadosTransacao.tipo,
        status: 'criada',
        tentativas: 0,
        historico: [{
          data: agora,
          status: 'criada',
          detalhes: 'Transação criada'
        }],
        ...(dadosTransacao.textoOriginal && { textoOriginal: dadosTransacao.textoOriginal }),
        ...(dadosTransacao.caption && { caption: dadosTransacao.caption }),
      };

      return base.inserir(transacao);
    },
    
    /**
     * Adiciona dados para recuperação à transação
     */
    adicionarDadosRecuperacao: async (idTransacao, dadosRecuperacao) => {
      const agora = new Date();
      
      return base.atualizar(
        { id: idTransacao },
        { 
          $set: { 
            dadosRecuperacao,
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status: 'dados_recuperacao_adicionados',
              detalhes: 'Dados para recuperação persistidos'
            }
          }
        }
      );
    },
    
    /**
     * Atualiza o status de uma transação
     */
    atualizarStatus: async (idTransacao, status, detalhes) => {
      const agora = new Date();
      
      return base.atualizar(
        { id: idTransacao },
        { 
          $set: { 
            status,
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status,
              detalhes
            }
          }
        }
      );
    },
    
    /**
     * Adiciona a resposta à transação
     */
    adicionarResposta: async (idTransacao, resposta) => {
      const agora = new Date();
      
      return base.atualizar(
        { id: idTransacao },
        { 
          $set: { 
            resposta,
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status: 'resposta_gerada',
              detalhes: 'Resposta gerada pela IA'
            }
          }
        }
      );
    },
    
    /**
     * Registra falha de entrega
     */
    registrarFalhaEntrega: async (idTransacao, erro) => {
      const detalhesErro = `Falha na entrega: ${String(erro)}`;
      const agora = new Date();
      return base.atualizar(
        { id: idTransacao },
        { 
          $set: { 
            status: 'falha_entrega',
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status: 'falha_entrega',
              detalhes: detalhesErro
            }
          }
        }
      );
    },
    
    /**
     * Busca transações para recuperação
     */
    buscarTransacoesIncompletas: async () => {
      return base.encontrar({
        status: { $in: ['processando', 'resposta_gerada', 'falha_temporaria'] },
        resposta: { $exists: true },
        dadosRecuperacao: { $exists: true }
      });
    },
    
    /**
     * Limpa transações antigas
     */
    limparTransacoesAntigas: async (diasRetencao = 7) => {
      const dataLimite = new Date(Date.now() - diasRetencao * 24 * 60 * 60 * 1000);
      
      const resultado = await base.remover({ 
        dataCriacao: { $lt: dataLimite },
        status: { $in: ['entregue', 'falha_permanente'] }
      }, { multi: true });
      
      return Resultado.mapear(resultado, numRemovidos => {
        if (numRemovidos > 0) {
          registrador.info(`Removidas ${numRemovidos} transações antigas`);
        }
        return numRemovidos;
      });
    },
    
    /**
     * Obter estatísticas das transações
     */
    obterEstatisticas: async () => {
      const contarPorStatus = async (status) => {
        const resultado = await base.contar({ status });
        return Resultado.mapear(resultado, contagem => ({ status, contagem }));
      };
      
      const resultadoTotal = await base.contar({});
      const resultadoCriadas = await contarPorStatus('criada');
      const resultadoProcessando = await contarPorStatus('processando'); 
      const resultadoEntregues = await contarPorStatus('entregue');
      const resultadoFalhasTemp = await contarPorStatus('falha_temporaria');
      const resultadoFalhasPerm = await contarPorStatus('falha_permanente');
      
      return Resultado.encadear(resultadoTotal, total => 
        Resultado.encadear(resultadoCriadas, criadas => 
          Resultado.encadear(resultadoProcessando, processando => 
            Resultado.encadear(resultadoEntregues, entregues => 
              Resultado.encadear(resultadoFalhasTemp, falhasTemp => 
                Resultado.encadear(resultadoFalhasPerm, falhasPerm => {
                  const taxaSucesso = total > 0 
                    ? (entregues.contagem / total * 100).toFixed(2) + '%' 
                    : '0%';
                  
                  return Resultado.sucesso({
                    total,
                    criadas: criadas.contagem,
                    processando: processando.contagem,
                    entregues: entregues.contagem,
                    falhasTemporarias: falhasTemp.contagem,
                    falhasPermanentes: falhasPerm.contagem,
                    taxaSucesso
                  });
                })
              )
            )
          )
        )
      );
    },

    /**
     * Busca uma transação específica pelo seu ID de transação.
     */
    buscarTransacaoPorId: async (idTransacao) => {
      return base.encontrarUm({ id: idTransacao });
    },

    /**
     * Remove uma transação específica pelo seu ID de transação.
     */
    removerTransacaoPorId: async (idTransacao) => {
      return base.remover({ id: idTransacao }, {});
    }
  };
};

module.exports = { criarRepositorioTransacoes };
