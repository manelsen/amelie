const EventEmitter = require('events');
const path = require('path');
const { Resultado } = require('../../bancodedados/Repositorio');
const { criarFabricaRepositorio } = require('../../bancodedados/FabricaRepositorio');

/**
 * Cria um gerenciador de transações funcional
 * @param {Object} registrador - Objeto para registro de logs
 * @param {string} diretorioDB - Diretório base para os bancos de dados
 * @returns {Object} Instância funcional do gerenciador
 */
const criarGerenciadorTransacoes = (registrador, diretorioDB = path.join(process.cwd(), 'db')) => {
  const eventos = new EventEmitter();
  const fabricaRepositorio = criarFabricaRepositorio(registrador, diretorioDB);
  const repoTransacoes = fabricaRepositorio.obterRepositorioTransacoes();

  /**
   * Limpa transações antigas
   */
  const limparTransacoesAntigas = async (diasRetencao = 7) => {
    const resultado = await repoTransacoes.limparTransacoesAntigas(diasRetencao);

    return Resultado.dobrar(
      resultado,
      (numRemovidas) => numRemovidas,
      (erro) => {
        registrador.error(`Erro ao limpar transações antigas: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Limpa transações incompletas
   */
  const limparTransacoesIncompletas = async () => {
    const resultadoBusca = await repoTransacoes.buscarTransacoesIncompletas();

    return Resultado.dobrar(
      resultadoBusca,
      async (transacoes) => {
        if (!transacoes || transacoes.length === 0) {
          registrador.info('Nenhuma transação incompleta encontrada para limpeza.');
          return 0;
        }

        registrador.info(`Encontradas ${transacoes.length} transações incompletas para limpeza.`);
        let limpas = 0;

        for (const transacao of transacoes) {
          if (!transacao || !transacao.id) {
            registrador.warn('Transação incompleta sem ID encontrada durante a limpeza.');
            continue;
          }

          const resultadoRemocao = await repoTransacoes.removerTransacaoPorId(transacao.id);
          if (resultadoRemocao.sucesso && resultadoRemocao.dados > 0) {
            limpas++;
          } else if (!resultadoRemocao.sucesso) {
            registrador.error(`Erro ao remover transação incompleta ${transacao.id}: ${resultadoRemocao.erro.message}`);
          }
        }

        registrador.info(`Limpas ${limpas} de ${transacoes.length} transações incompletas encontradas.`);
        return limpas;
      },
      (erro) => {
        registrador.error(`Erro ao buscar transações incompletas para limpeza: ${erro.message}`);
        return 0;
      }
    );
  };

  /**
   * Atualiza o status de uma transação
   */
  const atualizarStatusTransacao = async (transacaoId, status, detalhes) => {
    const resultado = await repoTransacoes.atualizarStatus(transacaoId, status, detalhes);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          registrador.warn(`Transação ${transacaoId} não encontrada para atualização`);
          return false;
        }
        return true;
      },
      (erro) => {
        registrador.error(`Erro ao atualizar status da transação: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Marca uma transação como entregue e a remove
   */
  const marcarComoEntregue = async (transacaoId) => {
    const resultadoAtualizacao = await atualizarStatusTransacao(
      transacaoId,
      'entregue',
      'Mensagem entregue com sucesso'
    );

    if (!resultadoAtualizacao) {
        registrador.warn(`Falha ao atualizar status para 'entregue' na transação ${transacaoId}. Não será removida.`);
        return false;
    }

    const resultadoRemocao = await repoTransacoes.removerTransacaoPorId(transacaoId);

    return Resultado.dobrar(
      resultadoRemocao,
      (numRemovidos) => {
        if (numRemovidos > 0) {
          registrador.info(`Transação ${transacaoId} marcada como entregue e removida.`);
          return true;
        } else {
          registrador.warn(`Transação ${transacaoId} atualizada para 'entregue', mas não encontrada para remoção.`);
          return false;
        }
      },
      (erro) => {
        registrador.error(`Erro ao remover transação ${transacaoId} após marcar como entregue: ${erro.message}`);
        return false;
      }
    );
  };

  /**
   * Registra falha de entrega
   */
  const registrarFalhaEntrega = async (transacaoId, erro) => {
    const erroString = String(erro);
    const resultado = await repoTransacoes.registrarFalhaEntrega(transacaoId, erroString);

    return Resultado.dobrar(
      resultado,
      () => {
        registrador.warn(`Falha registrada para transação ${transacaoId}: ${erroString}`);
        return true;
      },
      (erroOperacao) => {
        registrador.error(`Erro ao registrar falha: ${String(erroOperacao)}`);
        throw erroOperacao;
      }
    );
  };

  /**
   * Cria uma nova transação
   */
  const criarTransacao = async (mensagem, chat) => {
    const dadosTransacao = {
      id: mensagem.id.id,
      chatId: chat.id._serialized,
      senderId: mensagem.id.remote,
      timestamp: new Date(mensagem.timestamp * 1000),
      tipo: mensagem.type,
    };
    const resultado = await repoTransacoes.criarTransacao(dadosTransacao);

    return Resultado.dobrar(
      resultado,
      (documento) => Resultado.sucesso(documento),
      (erro) => {
        registrador.error(`Erro ao criar transação: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Adiciona dados para recuperação
   */
  const adicionarDadosRecuperacao = async (transacaoId, dadosRecuperacao) => {
    const resultado = await repoTransacoes.adicionarDadosRecuperacao(transacaoId, dadosRecuperacao);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          registrador.warn(`Transação ${transacaoId} não encontrada para adicionar dados de recuperação`);
          return false;
        }
        return true;
      },
      (erro) => {
        registrador.error(`Erro ao adicionar dados de recuperação: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Recupera transações incompletas (emite eventos)
   */
  const recuperarTransacoesIncompletas = async () => {
    const resultado = await repoTransacoes.buscarTransacoesIncompletas();

    return Resultado.dobrar(
      resultado,
      async (transacoes) => {
        if (transacoes.length === 0) {
          registrador.info(`Nenhuma transação pendente para recuperação`);
          return 0;
        }

        registrador.info(`Recuperando ${transacoes.length} transações interrompidas...`);

        let recuperadas = 0;
        for (const transacao of transacoes) {
          try {
            eventos.emit('transacao_para_recuperar', transacao);

            await atualizarStatusTransacao(
              transacao.id,
              'recuperacao_em_andamento',
              'Transação recuperada após restart do sistema'
            );

            recuperadas++;
          } catch (erro) {
            registrador.error(`Erro ao recuperar transação ${transacao.id}: ${erro.message}`);
          }
        }

        registrador.info(`${recuperadas} transações enviadas para recuperação`);
        return recuperadas;
      },
      (erro) => {
        registrador.error(`Erro ao buscar transações para recuperação: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Adiciona a resposta à transação
   */
  const adicionarRespostaTransacao = async (transacaoId, resposta) => {
    const resultado = await repoTransacoes.adicionarResposta(transacaoId, resposta);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          registrador.warn(`Transação ${transacaoId} não encontrada para adicionar resposta`);
          return false;
        }
        return true;
      },
      (erro) => {
        registrador.error(`Erro ao adicionar resposta à transação: ${erro.message}`);
        throw erro;
      }
    );
  };

  /**
   * Processa transações pendentes enviando-as pelo WhatsApp
   */
  const processarTransacoesPendentes = async (clienteWhatsApp) => {
    if (!clienteWhatsApp) {
      registrador.error('Cliente WhatsApp não fornecido para processamento de transações');
      return Resultado.falha(new Error('Cliente WhatsApp é necessário para processar transações'));
    }

    const resultadoBusca = await repoTransacoes.buscarTransacoesIncompletas();

    if (!resultadoBusca.sucesso) {
      registrador.error(`Erro ao buscar transações pendentes para processamento: ${resultadoBusca.erro.message}`);
      return Resultado.falha(resultadoBusca.erro);
    }

    const transacoesPendentes = resultadoBusca.dados;

    if (!transacoesPendentes || transacoesPendentes.length === 0) {
      registrador.debug('Nenhuma transação pendente encontrada para processamento.');
      return Resultado.sucesso(0);
    }

    registrador.info(`Encontradas ${transacoesPendentes.length} transações pendentes para processamento.`);
    let processadasComSucesso = 0;

    for (const transacao of transacoesPendentes) {
       if (!transacao || !transacao.id || !transacao.resposta || !transacao.chatId) {
         registrador.warn(`Transação ${transacao?.id || 'sem-id'} inválida para reprocessamento`);
         continue;
       }

       try {
         await clienteWhatsApp.enviarMensagem(transacao.chatId, transacao.resposta);
         await marcarComoEntregue(transacao.id);
         registrador.info(`Transação ${transacao.id} reprocessada e marcada como entregue.`);
         processadasComSucesso++;
       } catch (erro) {
         const mensagemErro = String(erro);
         registrador.error(`Erro ao reprocessar transação ${transacao.id}: ${mensagemErro}`);
         await registrarFalhaEntrega(transacao.id, `Erro no reprocessamento: ${mensagemErro}`);
       }
    }

    registrador.info(`Processamento de transações pendentes concluído. Sucesso: ${processadasComSucesso}.`);
    return Resultado.sucesso(processadasComSucesso);
  };

  // Inicialização
  limparTransacoesAntigas();
  setInterval(() => limparTransacoesAntigas(), 24 * 60 * 60 * 1000);
  registrador.info('Gerenciador de transações inicializado');

  return {
    on: eventos.on.bind(eventos),
    emit: eventos.emit.bind(eventos),
    limparTransacoesIncompletas,
    criarTransacao,
    adicionarDadosRecuperacao,
    recuperarTransacoesIncompletas,
    marcarComoProcessando: (transacaoId) => atualizarStatusTransacao(transacaoId, 'processando', 'Processamento iniciado'),
    adicionarRespostaTransacao,
    marcarComoEntregue,
    registrarFalhaEntrega,
    atualizarStatusTransacao,
    processarTransacoesPendentes,
    limparTransacoesAntigas,
    obterEstatisticas: async () => {
      const resultado = await repoTransacoes.obterEstatisticas();
      return Resultado.dobrar(resultado, (est) => est, (e) => { throw e; });
    },
    obterTransacao: async (id) => {
      const resultado = await repoTransacoes.buscarTransacaoPorId(id);
      return Resultado.dobrar(resultado, (t) => t, (e) => { throw e; });
    }
  };
};

module.exports = { criarGerenciadorTransacoes };
