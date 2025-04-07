// src/db/RepositorioTransacoes.js
/**
 * RepositorioTransacoes - Repositório específico para transações
 * 
 * Adiciona métodos específicos de domínio para transações.
 */

const RepositorioNeDB = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');
const crypto = require('crypto');

class RepositorioTransacoes extends RepositorioNeDB {
  constructor(caminhoBanco, registrador) {
    super(caminhoBanco, registrador);
    
    // Criar índices para consultas comuns
    this.garantirIndice('id');
    this.garantirIndice('status');
    this.garantirIndice('dataCriacao');
    this.garantirIndice('messageId');
    this.garantirIndice('chatId');
  }

  /**
   * Cria uma nova transação para uma mensagem
   * @param {Object} mensagem - Mensagem do WhatsApp
   * @param {Object} chat - Objeto do chat
   * @returns {Promise<Resultado>} Resultado com a transação criada
   */
  async criarTransacao(dadosTransacao) { // Assinatura refatorada
    const agora = new Date();
    // Usa o ID da mensagem original se disponível, senão gera um novo ID único
    const idTransacao = dadosTransacao.id ? `tx_${dadosTransacao.id}` : `tx_${agora.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

    // Construir objeto de transação imutável usando dadosTransacao
    const transacao = {
      id: idTransacao,
      messageId: dadosTransacao.id, // ID original da mensagem
      chatId: dadosTransacao.chatId,
      senderId: dadosTransacao.senderId, // ID do remetente
      dataCriacao: agora,
      ultimaAtualizacao: agora,
      tipo: dadosTransacao.tipo, // Tipo já determinado pelo chamador
      status: 'criada',
      tentativas: 0,
      historico: [{
        data: agora,
        status: 'criada',
        detalhes: 'Transação criada'
      }],
      // Incluir outros dados relevantes de dadosTransacao, se houver
      ...(dadosTransacao.textoOriginal && { textoOriginal: dadosTransacao.textoOriginal }),
      ...(dadosTransacao.caption && { caption: dadosTransacao.caption }),
    };

    return this.inserir(transacao);
  }
  
  /**
   * Adiciona dados para recuperação à transação
   * @param {string} idTransacao - ID da transação
   * @param {Object} dadosRecuperacao - Dados para recuperação
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async adicionarDadosRecuperacao(idTransacao, dadosRecuperacao) {
    const agora = new Date();
    
    return this.atualizar(
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
  }
  
  /**
   * Atualiza o status de uma transação
   * @param {string} idTransacao - ID da transação
   * @param {string} status - Novo status
   * @param {string} detalhes - Detalhes da atualização
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async atualizarStatus(idTransacao, status, detalhes) {
    const agora = new Date();
    
    return this.atualizar(
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
  }
  
  /**
   * Adiciona a resposta à transação
   * @param {string} idTransacao - ID da transação
   * @param {string} resposta - Texto de resposta
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async adicionarResposta(idTransacao, resposta) {
    const agora = new Date();
    
    return this.atualizar(
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
  }
  
  /**
   * Registra falha de entrega
   * @param {string} idTransacao - ID da transação
   * @param {string} erro - Descrição do erro
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async registrarFalhaEntrega(idTransacao, erro) {
    // Refatorado: Simplificado para apenas chamar atualizarStatus.
    // A lógica de contagem de tentativas e status (temporária/permanente)
    // deve ser gerenciada pelo consumidor (GerenciadorTransacoes), se necessário.
    // Aqui, apenas registramos a falha no histórico via atualizarStatus.
    const detalhesErro = `Falha na entrega: ${String(erro)}`; // Garante que erro seja string
    // Assume 'falha_entrega' como um status genérico. O consumidor pode chamar de novo para 'falha_permanente'.
    return this.atualizarStatus(idTransacao, 'falha_entrega', detalhesErro);
  }
  
  /**
   * Busca transações para recuperação
   * @returns {Promise<Resultado>} Resultado com transações para recuperar
   */
  async buscarTransacoesIncompletas() {
    return this.encontrar({
      status: { $in: ['processando', 'resposta_gerada', 'falha_temporaria'] },
      resposta: { $exists: true },
      dadosRecuperacao: { $exists: true }
    });
  }
  
  // Método removido - Lógica movida para GerenciadorTransacoes
  // async processarTransacoesPendentes(processador) { ... }
  
  /**
   * Limpa transações antigas
   * @param {number} diasRetencao - Dias para retenção
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async limparTransacoesAntigas(diasRetencao = 7) {
    const dataLimite = new Date(Date.now() - diasRetencao * 24 * 60 * 60 * 1000);
    
    const resultado = await this.remover({ 
      dataCriacao: { $lt: dataLimite },
      status: { $in: ['entregue', 'falha_permanente'] }
    }, { multi: true });
    
    return Resultado.mapear(resultado, numRemovidos => {
      if (numRemovidos > 0) {
        this.registrador.info(`Removidas ${numRemovidos} transações antigas`);
      }
      return numRemovidos;
    });
  }
  
  /**
   * Obter estatísticas das transações
   * @returns {Promise<Resultado>} Resultado com estatísticas
   */
  async obterEstatisticas() {
    // Função para contar por status
    const contarPorStatus = async (status) => {
      const resultado = await this.contar({ status });
      return Resultado.mapear(resultado, contagem => ({ status, contagem }));
    };
    
    // Obter contagem total e por status
    const resultadoTotal = await this.contar({});
    const resultadoCriadas = await contarPorStatus('criada');
    const resultadoProcessando = await contarPorStatus('processando'); 
    const resultadoEntregues = await contarPorStatus('entregue');
    const resultadoFalhasTemp = await contarPorStatus('falha_temporaria');
    const resultadoFalhasPerm = await contarPorStatus('falha_permanente');
    
    // Combinar resultados de forma funcional
    return Resultado.encadear(resultadoTotal, total => 
      Resultado.encadear(resultadoCriadas, criadas => 
        Resultado.encadear(resultadoProcessando, processando => 
          Resultado.encadear(resultadoEntregues, entregues => 
            Resultado.encadear(resultadoFalhasTemp, falhasTemp => 
              Resultado.encadear(resultadoFalhasPerm, falhasPerm => {
                // Calcular taxa de sucesso
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
  }

  /**
   * Busca uma transação específica pelo seu ID de transação.
   * @param {string} idTransacao - O ID da transação a ser buscada.
   * @returns {Promise<Resultado<object | null>>} Resultado com a transação encontrada ou null.
   */
  async buscarTransacaoPorId(idTransacao) {
    return this.encontrarUm({ id: idTransacao });
  }

  /**
   * Remove uma transação específica pelo seu ID de transação.
   * @param {string} idTransacao - O ID da transação a ser removida.
   * @returns {Promise<Resultado<number>>} Resultado com o número de documentos removidos (0 ou 1).
   */
  async removerTransacaoPorId(idTransacao) {
    return this.remover({ id: idTransacao }, {}); // Opções vazias para remover apenas um
  }
  
  /**
   * Determina o tipo de uma mensagem
   * @param {Object} mensagem - Mensagem do WhatsApp
   * @returns {string} Tipo da mensagem
   * @private
   */
  _determinarTipoMensagem(mensagem) {
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
}

module.exports = RepositorioTransacoes;