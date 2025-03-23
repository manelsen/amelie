const EventEmitter = require('events');
const path = require('path');
const { Resultado } = require('../../bancodedados/Repositorio');

class GerenciadorTransacoes extends EventEmitter {
  constructor(registrador, diretorioDB = path.join(process.cwd(), 'db')) {
    super();
    this.registrador = registrador;
    this.diretorioDB = diretorioDB;

    // Usando a nova arquitetura internamente
    const FabricaRepositorio = require('../../bancodedados/FabricaRepositorio');
    this.fabricaRepositorio = new FabricaRepositorio(registrador, diretorioDB);
    this.repoTransacoes = this.fabricaRepositorio.obterRepositorioTransacoes();

    // Limpar transações antigas na inicialização
    this.limparTransacoesAntigas();

    // Programar limpeza periódica
    setInterval(() => this.limparTransacoesAntigas(), 24 * 60 * 60 * 1000);

    this.registrador.info('Gerenciador de transações inicializado');
  }

  async limparTransacoesIncompletas() {
    try {
      // Encontrar transações sem resposta ou que estão travadas
      const resultado = await this.repoTransacoes.encontrar({
        $or: [
          { resposta: { $exists: false }, status: { $ne: 'criada' } },
          { status: 'falha_permanente' }
        ]
      });

      const transacoes = resultado.sucesso ? resultado.dados : [];
      if (transacoes.length === 0) return 0;

      this.registrador.info(`Encontradas ${transacoes.length} transações incompletas para limpeza`);
      let limpas = 0;

      for (const transacao of transacoes) {
        try {
          await this.repoTransacoes.remover({ id: transacao.id });
          limpas++;
        } catch (erro) {
          this.registrador.error(`Erro ao remover transação incompleta ${transacao.id}: ${erro.message}`);
        }
      }

      this.registrador.info(`Limpas ${limpas} transações incompletas`);
      return limpas;
    } catch (erro) {
      this.registrador.error(`Erro ao limpar transações incompletas: ${erro.message}`);
      return 0;
    }
  }

  async criarTransacao(mensagem, chat) {
    const resultado = await this.repoTransacoes.criarTransacao(mensagem, chat);

    return Resultado.dobrar(
      resultado,
      (documento) => {
        this.registrador.debug(`Transação criada: ${documento.id}`);
        return documento;
      },
      (erro) => {
        this.registrador.error(`Erro ao criar transação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async adicionarDadosRecuperacao(transacaoId, dadosRecuperacao) {
    const resultado = await this.repoTransacoes.adicionarDadosRecuperacao(transacaoId, dadosRecuperacao);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar dados de recuperação`);
          return false;
        }
        this.registrador.debug(`Dados de recuperação adicionados à transação ${transacaoId}`);
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao adicionar dados de recuperação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async recuperarTransacoesIncompletas() {
    const resultado = await this.repoTransacoes.buscarTransacoesIncompletas();

    return Resultado.dobrar(
      resultado,
      async (transacoes) => {
        if (transacoes.length === 0) {
          this.registrador.info(`Nenhuma transação pendente para recuperação`);
          return 0;
        }

        this.registrador.info(`Recuperando ${transacoes.length} transações interrompidas...`);

        const recuperadas = await transacoes.reduce(async (contadorPromise, transacao) => {
          const contador = await contadorPromise;
          try {
            this.emit('transacao_para_recuperar', transacao);

            await this.atualizarStatusTransacao(
              transacao.id,
              'recuperacao_em_andamento',
              'Transação recuperada após restart do sistema'
            );

            return contador + 1;
          } catch (erro) {
            this.registrador.error(`Erro ao recuperar transação ${transacao.id}: ${erro.message}`);
            return contador;
          }
        }, Promise.resolve(0));

        this.registrador.info(`${recuperadas} transações enviadas para recuperação`);
        return recuperadas;
      },
      (erro) => {
        this.registrador.error(`Erro ao buscar transações para recuperação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async marcarComoProcessando(transacaoId) {
    return this.atualizarStatusTransacao(transacaoId, 'processando', 'Processamento iniciado');
  }

  async adicionarRespostaTransacao(transacaoId, resposta) {
    const resultado = await this.repoTransacoes.adicionarResposta(transacaoId, resposta);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar resposta`);
          return false;
        }
        this.registrador.debug(`Resposta adicionada à transação ${transacaoId}`);
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao adicionar resposta à transação: ${erro.message}`);
        throw erro;
      }
    );
  }

  /**
 * Marca uma transação como entregue e a remove do banco de dados
 * @param {string} transacaoId - ID da transação
 * @returns {Promise<boolean>} Verdadeiro se operação bem-sucedida
 */
  async marcarComoEntregue(transacaoId) {
    try {
      // Usar repoTransacoes diretamente para ter mais controle
      const resultado = await this.repoTransacoes.atualizar(
        { id: transacaoId },
        {
          $set: {
            status: 'entregue',
            ultimaAtualizacao: new Date()
          },
          $push: {
            historico: {
              data: new Date(),
              status: 'entregue',
              detalhes: 'Mensagem entregue com sucesso'
            }
          }
        }
      );

      // Agora excluímos a transação após marcar como entregue
      if (resultado.sucesso) {
        await this.repoTransacoes.remover({ id: transacaoId });
        this.registrador.debug(`Transação ${transacaoId} removida após entrega`);
      }

      return true; // Simplificando o retorno para evitar erros
    } catch (erro) {
      // Log simples sem acessar propriedades do erro
      this.registrador.error(`Erro na transação ${transacaoId}: ${String(erro)}`);
      return false;
    }
  }

  async registrarFalhaEntrega(transacaoId, erro) {
    // Garantir que erro seja uma string
    const erroString = String(erro);

    const resultado = await this.repoTransacoes.registrarFalhaEntrega(transacaoId, erroString);

    return Resultado.dobrar(
      resultado,
      () => {
        this.registrador.warn(`Falha registrada para transação ${transacaoId}: ${erroString}`);
        return true;
      },
      (erroOperacao) => {
        // PROTEÇÃO: Usar String(erroOperacao) em vez de acessar .message
        this.registrador.error(`Erro ao registrar falha: ${String(erroOperacao)}`);
        throw erroOperacao;
      }
    );
  }

  async atualizarStatusTransacao(transacaoId, status, detalhes) {
    const resultado = await this.repoTransacoes.atualizarStatus(transacaoId, status, detalhes);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para atualização`);
          return false;
        }
        this.registrador.debug(`Status da transação ${transacaoId} atualizado para ${status}`);
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao atualizar status da transação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async processarTransacoesPendentes(clienteWhatsApp) {
    // Validar parâmetro de entrada
    if (!clienteWhatsApp) {
      this.registrador.error('Cliente WhatsApp não fornecido para processamento de transações');
      throw new Error('Cliente WhatsApp é necessário para processar transações');
    }

    // Definir função de processamento individual com proteção contra erros
    const processarTransacao = async (transacao) => {
      // Validar estrutura básica da transação
      if (!transacao || !transacao.id) {
        this.registrador.warn('Transação inválida encontrada no processamento');
        return false;
      }

      // Verificar se há resposta para enviar
      if (!transacao.resposta) {
        this.registrador.warn(`Transação ${transacao.id} sem resposta para reenviar`);
        return false;
      }

      // Validar dados necessários para envio
      if (!transacao.chatId) {
        this.registrador.warn(`Transação ${transacao.id} sem chatId definido`);
        return false;
      }

      try {
        // Tentar enviar a mensagem de forma direta e simples
        await clienteWhatsApp.enviarMensagem(transacao.chatId, transacao.resposta);

        // Marcar como entregue após envio bem-sucedido
        await this.marcarComoEntregue(transacao.id);

        this.registrador.info(`Transação ${transacao.id} reprocessada com sucesso`);
        return true;
      } catch (erro) {
        // PROTEÇÃO: Usar String(erro) em vez de acessar .message
        const mensagemErro = String(erro);
        this.registrador.error(`Erro ao processar transação ${transacao.id}: ${mensagemErro}`);

        // Registrar a falha na entrega com a nova abordagem segura
        await this.registrarFalhaEntrega(transacao.id, mensagemErro);
        return false;
      }
    };

    // Processar transações pendentes com tratamento de erro adequado
    const resultado = await this.repoTransacoes.processarTransacoesPendentes(processarTransacao);

    return Resultado.dobrar(
      resultado,
      (processadas) => {
        // Garantir que o retorno seja um número válido
        const numProcessadas = typeof processadas === 'number' ? processadas : 0;

        if (numProcessadas > 0) {
          this.registrador.info(`Processadas com sucesso ${numProcessadas} transações pendentes`);
        } else {
          this.registrador.debug('Nenhuma transação pendente para processar');
        }

        return numProcessadas;
      },
      (erro) => {
        // PROTEÇÃO: Usar String(erro) em vez de acessar .message
        this.registrador.error(`Erro ao processar transações pendentes: ${String(erro)}`);
        throw erro;
      }
    );
  }


  async limparTransacoesAntigas(diasRetencao = 7) {
    const resultado = await this.repoTransacoes.limparTransacoesAntigas(diasRetencao);

    return Resultado.dobrar(
      resultado,
      (numRemovidas) => numRemovidas,
      (erro) => {
        this.registrador.error(`Erro ao limpar transações antigas: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterEstatisticas() {
    const resultado = await this.repoTransacoes.obterEstatisticas();

    return Resultado.dobrar(
      resultado,
      (estatisticas) => estatisticas,
      (erro) => {
        this.registrador.error(`Erro ao obter estatísticas de transações: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterTransacao(transacaoId) {
    const resultado = await this.repoTransacoes.encontrarUm({ id: transacaoId });

    return Resultado.dobrar(
      resultado,
      (transacao) => transacao,
      (erro) => {
        this.registrador.error(`Erro ao buscar transação ${transacaoId}: ${erro.message}`);
        throw erro;
      }
    );
  }
}

module.exports = GerenciadorTransacoes;
