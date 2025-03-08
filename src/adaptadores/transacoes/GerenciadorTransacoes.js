/**
 * GerenciadorTransacoes - Gerencia transações de mensagens
 * 
 * Este módulo rastreia o ciclo de vida das mensagens para garantir
 * que todas sejam processadas corretamente e facilitar a recuperação
 * de falhas.
 */

const Datastore = require('nedb');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class GerenciadorTransacoes {
  /**
   * Cria uma instância do gerenciador de transações
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {string} diretorioDB - Diretório para os bancos de dados
   */
  constructor(registrador, diretorioDB = './db') {
    this.registrador = registrador;
    this.diretorioDB = diretorioDB;
    
    // Garantir que o diretório do banco de dados exista
    if (!fs.existsSync(this.diretorioDB)) {
      fs.mkdirSync(this.diretorioDB, { recursive: true });
      this.registrador.info('Diretório de banco de dados criado');
    }
    
    // Inicializar banco de dados de transações
    this.transacoesDb = new Datastore({ 
      filename: path.join(this.diretorioDB, 'transacoes.db'), 
      autoload: true 
    });
    
    // Configurar índices e limpeza automática
    this.transacoesDb.ensureIndex({ fieldName: 'dataCriacao' });
    this.transacoesDb.ensureIndex({ fieldName: 'status' });
    
    // Limpar transações antigas na inicialização
    this.limparTransacoesAntigas();
    
    // Programar limpeza periódica
    setInterval(() => this.limparTransacoesAntigas(), 24 * 60 * 60 * 1000); // Uma vez por dia
    
    this.registrador.info('Gerenciador de transações inicializado');
  }

  /**
   * Cria uma nova transação para uma mensagem
   * @param {Object} mensagem - Mensagem do WhatsApp
   * @param {Object} chat - Objeto do chat
   * @returns {Promise<Object>} Transação criada
   */
  async criarTransacao(mensagem, chat) {
    return new Promise((resolve, reject) => {
      const agora = new Date();
      const transacaoId = `tx_${agora.getTime()}_${crypto.randomBytes(4).toString('hex')}`;
      
      const novaTransacao = {
        id: transacaoId,
        messageId: mensagem.id._serialized,
        chatId: chat.id._serialized,
        from: mensagem.from,
        dataCriacao: agora,
        ultimaAtualizacao: agora,
        tipo: this.determinarTipoMensagem(mensagem),
        status: 'criada',
        tentativas: 0,
        historico: [{
          data: agora,
          status: 'criada',
          detalhes: 'Transação criada'
        }]
      };
      
      this.transacoesDb.insert(novaTransacao, (err, doc) => {
        if (err) {
          this.registrador.error(`Erro ao criar transação: ${err.message}`);
          reject(err);
        } else {
          this.registrador.debug(`Transação criada: ${transacaoId}`);
          resolve(doc);
        }
      });
    });
  }


/**
 * Adiciona dados essenciais de recuperação à transação
 * @param {string} transacaoId - ID da transação
 * @param {Object} dadosRecuperacao - Dados necessários para recuperação
 */
async adicionarDadosRecuperacao(transacaoId, dadosRecuperacao) {
  return new Promise((resolve, reject) => {
    const agora = new Date();
    
    this.transacoesDb.update(
      { id: transacaoId },
      { 
        $set: { 
          dadosRecuperacao: dadosRecuperacao,
          ultimaAtualizacao: agora
        },
        $push: {
          historico: {
            data: agora,
            status: 'dados_recuperacao_adicionados',
            detalhes: 'Dados para recuperação persistidos'
          }
        }
      },
      {},
      (err, numUpdated) => {
        if (err) {
          this.registrador.error(`Erro ao adicionar dados de recuperação: ${err.message}`);
          reject(err);
        } else if (numUpdated === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar dados de recuperação`);
          resolve(false);
        } else {
          this.registrador.debug(`Dados de recuperação adicionados à transação ${transacaoId}`);
          resolve(true);
        }
      }
    );
  });
}

/**
 * Recupera transações interrompidas após restart do sistema
 * @returns {Promise<number>} Número de transações recuperadas
 */
async recuperarTransacoesIncompletas() {
  return new Promise((resolve, reject) => {
    // Buscar transações em estados que precisam de recuperação
    this.transacoesDb.find({
      status: { $in: ['processando', 'resposta_gerada', 'falha_temporaria'] },
      resposta: { $exists: true }, // Tem resposta, mas não foi entregue
      dadosRecuperacao: { $exists: true } // Tem dados para recuperação
    }, async (err, transacoes) => {
      if (err) {
        this.registrador.error(`Erro ao buscar transações para recuperação: ${err.message}`);
        reject(err);
        return;
      }
      
      if (transacoes.length === 0) {
        this.registrador.info(`Nenhuma transação pendente para recuperação`);
        resolve(0);
        return;
      }
      
      this.registrador.info(`Recuperando ${transacoes.length} transações interrompidas...`);
      
      let recuperadas = 0;
      
      for (const transacao of transacoes) {
        try {
          // Emitir evento para permitir que módulos interessados possam processar a recuperação
          this.emit('transacao_para_recuperar', transacao);
          recuperadas++;
          
          // Atualizar histórico
          await this.atualizarStatusTransacao(
            transacao.id, 
            'recuperacao_em_andamento', 
            'Transação recuperada após restart do sistema'
          );
        } catch (erro) {
          this.registrador.error(`Erro ao recuperar transação ${transacao.id}: ${erro.message}`);
        }
      }
      
      this.registrador.info(`${recuperadas} transações enviadas para recuperação`);
      resolve(recuperadas);
    });
  });
}

  /**
   * Determina o tipo de uma mensagem
   * @param {Object} mensagem - Mensagem do WhatsApp
   * @returns {string} Tipo da mensagem
   */
  determinarTipoMensagem(mensagem) {
    if (!mensagem.hasMedia) return 'texto';
    
    if (mensagem.type) {
      if (mensagem.type === 'image') return 'imagem';
      if (mensagem.type === 'video') return 'video';
      if (mensagem.type === 'audio' || mensagem.type === 'ptt') return 'audio';
      return mensagem.type;
    }
    
    // Tentar inferir pelo mimetype se disponível
    if (mensagem._data && mensagem._data.mimetype) {
      const mimetype = mensagem._data.mimetype;
      if (mimetype.startsWith('image/')) return 'imagem';
      if (mimetype.startsWith('video/')) return 'video';
      if (mimetype.startsWith('audio/')) return 'audio';
    }
    
    return 'desconhecido';
  }

  /**
   * Marca uma transação como em processamento
   * @param {string} transacaoId - ID da transação
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async marcarComoProcessando(transacaoId) {
    return this.atualizarStatusTransacao(transacaoId, 'processando', 'Processamento iniciado');
  }

  /**
   * Adiciona a resposta gerada a uma transação
   * @param {string} transacaoId - ID da transação
   * @param {string} resposta - Texto da resposta
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async adicionarRespostaTransacao(transacaoId, resposta) {
    return new Promise((resolve, reject) => {
      const agora = new Date();
      
      this.transacoesDb.update(
        { id: transacaoId },
        { 
          $set: { 
            resposta: resposta,
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status: 'resposta_gerada',
              detalhes: 'Resposta gerada pela IA'
            }
          }
        },
        {},
        (err, numUpdated) => {
          if (err) {
            this.registrador.error(`Erro ao adicionar resposta à transação: ${err.message}`);
            reject(err);
          } else if (numUpdated === 0) {
            this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar resposta`);
            resolve(false);
          } else {
            this.registrador.debug(`Resposta adicionada à transação ${transacaoId}`);
            resolve(true);
          }
        }
      );
    });
  }

  /**
   * Marca uma transação como entregue com sucesso
   * @param {string} transacaoId - ID da transação
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async marcarComoEntregue(transacaoId) {
    return this.atualizarStatusTransacao(transacaoId, 'entregue', 'Mensagem entregue com sucesso');
  }

  /**
   * Registra uma falha na entrega de uma transação
   * @param {string} transacaoId - ID da transação
   * @param {string} erro - Descrição do erro
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async registrarFalhaEntrega(transacaoId, erro) {
    return new Promise((resolve, reject) => {
      const agora = new Date();
      
      // Primeiro, obter a transação atual
      this.transacoesDb.findOne({ id: transacaoId }, (err, transacao) => {
        if (err) {
          this.registrador.error(`Erro ao buscar transação: ${err.message}`);
          reject(err);
          return;
        }
        
        if (!transacao) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para registrar falha`);
          resolve(false);
          return;
        }
        
        // Incrementar tentativas e atualizar status
        const tentativas = (transacao.tentativas || 0) + 1;
        const novoStatus = tentativas >= 3 ? 'falha_permanente' : 'falha_temporaria';
        
        this.transacoesDb.update(
          { id: transacaoId },
          { 
            $set: { 
              status: novoStatus,
              ultimaAtualizacao: agora,
              tentativas: tentativas,
              ultimoErro: erro
            },
            $push: {
              historico: {
                data: agora,
                status: novoStatus,
                detalhes: `Falha na entrega: ${erro}`
              }
            }
          },
          {},
          (errUpdate, numUpdated) => {
            if (errUpdate) {
              this.registrador.error(`Erro ao registrar falha: ${errUpdate.message}`);
              reject(errUpdate);
            } else {
              this.registrador.warn(`Falha registrada para transação ${transacaoId}: ${erro}`);
              resolve(true);
            }
          }
        );
      });
    });
  }

  /**
   * Atualiza o status de uma transação
   * @param {string} transacaoId - ID da transação
   * @param {string} status - Novo status
   * @param {string} detalhes - Detalhes da atualização
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async atualizarStatusTransacao(transacaoId, status, detalhes) {
    return new Promise((resolve, reject) => {
      const agora = new Date();
      
      this.transacoesDb.update(
        { id: transacaoId },
        { 
          $set: { 
            status: status,
            ultimaAtualizacao: agora
          },
          $push: {
            historico: {
              data: agora,
              status: status,
              detalhes: detalhes
            }
          }
        },
        {},
        (err, numUpdated) => {
            if (err) {
                this.registrador.error(`Erro ao atualizar status da transação: ${err.message}`);
                reject(err);
              } else if (numUpdated === 0) {
                this.registrador.warn(`Transação ${transacaoId} não encontrada para atualização`);
                resolve(false);
              } else {
                this.registrador.debug(`Status da transação ${transacaoId} atualizado para ${status}`);
                resolve(true);
              }
            }
          );
        });
      }
    
      /**
       * Processa transações pendentes
       * @param {Object} clienteWhatsApp - Cliente WhatsApp para reenvio
       * @returns {Promise<number>} Número de transações processadas
       */
      async processarTransacoesPendentes(clienteWhatsApp) {
        return new Promise((resolve, reject) => {
          const limiteTempoFalha = new Date(Date.now() - 5 * 60 * 1000); // 5 minutos
          
          // Buscar transações com falha temporária
          this.transacoesDb.find({ 
            status: 'falha_temporaria',
            ultimaAtualizacao: { $lt: limiteTempoFalha },
            tentativas: { $lt: 3 }
          }, async (err, transacoes) => {
            if (err) {
              this.registrador.error(`Erro ao buscar transações pendentes: ${err.message}`);
              reject(err);
              return;
            }
            
            if (transacoes.length === 0) {
              resolve(0);
              return;
            }
            
            this.registrador.info(`Encontradas ${transacoes.length} transações pendentes para reprocessamento`);
            let processadas = 0;
            
            for (const transacao of transacoes) {
              try {
                if (!transacao.resposta) {
                  this.registrador.warn(`Transação ${transacao.id} sem resposta para reenviar`);
                  continue;
                }
                
                // Reenviar a mensagem
                await clienteWhatsApp.enviarMensagem(transacao.chatId, transacao.resposta);
                await this.marcarComoEntregue(transacao.id);
                processadas++;
                
                this.registrador.info(`Transação ${transacao.id} reprocessada com sucesso`);
              } catch (erro) {
                this.registrador.error(`Erro ao reprocessar transação ${transacao.id}: ${erro.message}`);
                await this.registrarFalhaEntrega(transacao.id, `Erro no reprocessamento: ${erro.message}`);
              }
            }
            
            resolve(processadas);
          });
        });
      }
    
      /**
       * Limpa transações antigas do banco de dados
       * @param {number} diasRetencao - Dias para manter transações
       * @returns {Promise<number>} Número de transações removidas
       */
      async limparTransacoesAntigas(diasRetencao = 7) {
        return new Promise((resolve, reject) => {
          const limiteData = new Date(Date.now() - diasRetencao * 24 * 60 * 60 * 1000);
          
          this.transacoesDb.remove({ 
            dataCriacao: { $lt: limiteData },
            status: { $in: ['entregue', 'falha_permanente'] }
          }, { multi: true }, (err, numRemoved) => {
            if (err) {
              this.registrador.error(`Erro ao limpar transações antigas: ${err.message}`);
              reject(err);
            } else {
              if (numRemoved > 0) {
                this.registrador.info(`Removidas ${numRemoved} transações antigas`);
              }
              resolve(numRemoved);
            }
          });
        });
      }
    
      /**
       * Obtém estatísticas sobre as transações
       * @returns {Promise<Object>} Estatísticas das transações
       */
      async obterEstatisticas() {
        const contarPorStatus = (status) => {
          return new Promise((resolve, reject) => {
            this.transacoesDb.count({ status }, (err, count) => {
              if (err) reject(err);
              else resolve(count);
            });
          });
        };
        
        try {
          const total = await new Promise((resolve, reject) => {
            this.transacoesDb.count({}, (err, count) => {
              if (err) reject(err);
              else resolve(count);
            });
          });
          
          const criadas = await contarPorStatus('criada');
          const processando = await contarPorStatus('processando');
          const entregues = await contarPorStatus('entregue');
          const falhasTemporarias = await contarPorStatus('falha_temporaria');
          const falhasPermanentes = await contarPorStatus('falha_permanente');
          
          return {
            total,
            criadas,
            processando,
            entregues,
            falhasTemporarias,
            falhasPermanentes,
            taxaSucesso: total > 0 ? (entregues / total * 100).toFixed(2) + '%' : '0%'
          };
        } catch (erro) {
          this.registrador.error(`Erro ao obter estatísticas de transações: ${erro.message}`);
          throw erro;
        }
      }

      /**
     * Obtém uma transação pelo ID
     * @param {string} transacaoId - ID da transação
     * @returns {Promise<Object>} Transação encontrada ou null se não existir
     */
    async obterTransacao(transacaoId) {
      return new Promise((resolve, reject) => {
        this.transacoesDb.findOne({ id: transacaoId }, (err, transacao) => {
          if (err) {
            this.registrador.error(`Erro ao buscar transação ${transacaoId}: ${err.message}`);
            reject(err);
          } else {
            resolve(transacao);
          }
        });
      });
    }
  }
    
    module.exports = GerenciadorTransacoes;